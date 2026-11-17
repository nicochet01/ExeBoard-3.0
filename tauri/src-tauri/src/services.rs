//! Serviços e processos do Windows — seção 8 de docs/REGRAS-DE-NEGOCIO.md.
//! Tudo roda SEM shell (argumentos separados) e SEM janela de console.

use crate::util::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const VERMELHO: &str = "#f38ba8";
const LARANJA: &str = "#fab387";
const VERDE: &str = "#40a02b";

/// É administrador? (`fltmc` só funciona elevado)
#[tauri::command]
pub async fn check_admin() -> Result<bool, String> {
    Ok(run_cmd("fltmc", &[]).await.ok())
}

/// Status de um item para o polling: running | stopped | transition | not_found.
#[tauri::command]
pub async fn check_status(srv: Value) -> Result<String, String> {
    let nome = str_of(&srv, "Nome");
    if !nome_seguro(&nome) {
        return Ok("not_found".into());
    }
    if str_of(&srv, "Tipo") == "Servico" {
        let out = run_cmd("sc", &["query", &nome]).await;
        let s = &out.stdout;
        let r = if s.contains("RUNNING") {
            "running"
        } else if s.contains("STOPPED") {
            "stopped"
        } else if s.contains("PENDING") {
            "transition"
        } else {
            "not_found"
        };
        Ok(r.to_string())
    } else {
        let proc = ensure_exe_suffix(&nome);
        Ok(if is_process_running(&proc).await { "running" } else { "stopped" }.to_string())
    }
}

/// O nome é um serviço do Windows? → "Servico", senão "Aplicacao".
#[tauri::command]
pub async fn detectar_tipo(nome: String) -> Result<String, String> {
    if !nome_seguro(&nome) {
        return Ok("Aplicacao".into());
    }
    let out = run_cmd("sc", &["query", &nome]).await;
    Ok(if out.ok() { "Servico" } else { "Aplicacao" }.to_string())
}

/// Todos os serviços: `[{Name, DisplayName, Status}]` (Status numérico: 4 = em execução).
#[tauri::command]
pub async fn get_windows_services() -> Result<Value, String> {
    let script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Service | Select-Object Name, DisplayName, Status | ConvertTo-Json -Compress";
    let out = run_cmd("powershell", &["-NoProfile", "-NonInteractive", "-Command", script]).await;
    if !out.ok() {
        return Ok(json!([]));
    }
    let texto = out.stdout.trim_start_matches('\u{feff}').trim();
    Ok(match serde_json::from_str::<Value>(texto) {
        Ok(Value::Array(a)) => Value::Array(a),
        Ok(v @ Value::Object(_)) => json!([v]), // Get-Service devolve objeto único se houver só 1
        _ => json!([]),
    })
}

/// Espera o serviço chegar ao estado (`RUNNING`/`STOPPED`), consultando a cada 400 ms.
async fn wait_for_service_status(nome: &str, alvo: &str, timeout_ms: u64) -> bool {
    let inicio = Instant::now();
    loop {
        let out = run_cmd("sc", &["query", nome]).await;
        if out.stdout.contains(alvo) {
            return true;
        }
        if inicio.elapsed() > Duration::from_millis(timeout_ms) {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

fn saida_ou_erro(out: &CmdOut) -> String {
    let s = if !out.stdout.trim().is_empty() { out.stdout.trim() } else { out.stderr.trim() };
    if s.is_empty() {
        out.code.map(|c| format!("código {c}")).unwrap_or_else(|| "sem resposta".into())
    } else {
        s.to_string()
    }
}

/// Iniciar / parar / encerrar um serviço ou aplicação. Devolve `false` quando não deu certo
/// (acesso negado, aplicação que não se inicia daqui, nome inválido).
#[tauri::command]
pub async fn manage_server(app: AppHandle, srv: Value, action: String) -> Result<bool, String> {
    let ui = |texto: &str, cor: &str| send_log(&app, texto, cor, "servidores");
    let nome = str_of(&srv, "Nome");
    if !nome_seguro(&nome) {
        ui(&format!("ERRO: nome de serviço/aplicação inválido ({nome})."), VERMELHO);
        return Ok(false);
    }
    let proc = ensure_exe_suffix(&nome);
    let eh_servico = str_of(&srv, "Tipo") == "Servico";

    if action == "start" {
        if !eh_servico {
            ui(&format!("Ação: {nome} é Aplicação. Inicie manualmente pela pasta."), "#bac2de");
            return Ok(false);
        }
        let out = run_cmd("sc", &["start", &nome]).await;
        if !out.ok() {
            ui(&format!("ERRO ao iniciar {nome}: {}", saida_ou_erro(&out)), VERMELHO);
        } else if wait_for_service_status(&nome, "RUNNING", 20_000).await {
            ui(&format!("Sucesso: {nome} INICIADO."), VERDE);
        } else {
            ui(&format!("Aviso: {nome} demorando para responder..."), LARANJA);
        }
        return Ok(true);
    }

    if action != "stop" && action != "kill" {
        return Ok(false);
    }

    let negado = |app: &AppHandle, msg: String| {
        send_log(app, &msg, VERMELHO, "servidores");
        send_log(app, &format!("ERRO: {msg}"), VERMELHO, "copiar");
    };

    if eh_servico {
        let out = run_cmd("sc", &["stop", &nome]).await;
        if is_access_denied(&out) {
            negado(&app, format!("Acesso negado ao parar \"{nome}\". Feche o ExeBoard e abra-o novamente como Administrador (clique com o botão direito > Executar como administrador) antes de copiar."));
            return Ok(false);
        }
        let texto = saida_ou_erro(&out);
        // 1062 = serviço já estava parado: não é problema
        if !out.ok() && !texto.contains("1062") {
            ui(&format!("Aviso STOP {nome}: {texto}"), LARANJA);
        }
        // Espera o stop "oficial" do SCM
        wait_for_service_status(&nome, "STOPPED", 10_000).await;

        // Confirma pelo PROCESSO (o SCM pode dizer "parado" antes de liberar o arquivo) e, se o serviço tiver
        // recuperação automática que o religa, mata de novo — por até 8 rodadas.
        let mut negado_ao_matar = false;
        for _ in 0..8 {
            if !is_process_running(&proc).await {
                break;
            }
            let k = run_cmd("taskkill", &["/F", "/IM", &proc]).await;
            if is_access_denied(&k) {
                negado_ao_matar = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        if negado_ao_matar {
            negado(&app, format!("Acesso negado ao encerrar \"{proc}\". Execute o ExeBoard como Administrador antes de copiar."));
            return Ok(false);
        }
        if action == "stop" {
            ui(&format!("{nome} parado."), VERMELHO);
        }
        Ok(true)
    } else {
        let k = run_cmd("taskkill", &["/F", "/IM", &proc]).await;
        if is_access_denied(&k) {
            negado(&app, format!("Acesso negado ao encerrar \"{proc}\". Execute o ExeBoard como Administrador antes de copiar."));
            return Ok(false);
        }
        ui(&format!("KILL enviado para {proc}"), VERMELHO);
        Ok(true)
    }
}

/// Fecha um cliente (`taskkill /F /IM nome.exe`) → `{killed, msg}`.
#[tauri::command]
pub async fn kill_process(name: String) -> Result<Value, String> {
    let nome = ensure_exe_suffix(&name);
    if !nome_seguro(&nome) {
        return Ok(json!({ "killed": false, "msg": "Nome de processo inválido." }));
    }
    let out = run_cmd("taskkill", &["/F", "/IM", &nome]).await;
    Ok(if out.ok() {
        json!({ "killed": true, "msg": out.stdout.trim() })
    } else {
        json!({ "killed": false, "msg": saida_ou_erro(&out) })
    })
}
