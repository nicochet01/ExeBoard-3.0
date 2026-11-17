//! Utilidades compartilhadas: pastas do app, log em arquivo, execução de comandos do Windows sem janela
//! e validação de nomes. Regras: docs/REGRAS-DE-NEGOCIO.md (seções 2.6, 8.3).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Impede que `sc`, `taskkill` etc. abram uma janela de console a cada chamada.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Nomes de serviço/processo viram argumento de `sc`/`taskkill`. Sem shell não há injeção, mas esta guarda
/// barra o que ainda teria efeito indevido: curinga do taskkill (`/IM *`), `\\maquina-remota` no `sc`,
/// aspas e caracteres de controle.
pub fn nome_seguro(nome: &str) -> bool {
    let n = nome.chars().count();
    n > 0
        && n <= 256
        && !nome
            .chars()
            .any(|c| matches!(c, '\\' | '/' | '"' | '*' | '?' | '<' | '>' | '|' | '\r' | '\n' | '\t' | '\0'))
}

/// Garante o sufixo `.exe` sem diferenciar maiúsculas (evita "Servico.EXE.exe").
pub fn ensure_exe_suffix(nome: &str) -> String {
    if nome.is_empty() || nome.to_lowercase().ends_with(".exe") {
        nome.to_string()
    } else {
        format!("{nome}.exe")
    }
}

// ---------- pastas e log ----------

static USER_DATA: OnceLock<PathBuf> = OnceLock::new();

/// `%APPDATA%\ExeBoard` (a MESMA pasta do app Electron, para os testadores não perderem a configuração).
/// Em build de desenvolvimento usa `%APPDATA%\ExeBoard-Dev` e copia a configuração de produção se ainda não existir.
pub fn user_data_dir() -> &'static PathBuf {
    USER_DATA.get_or_init(|| {
        let appdata = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        if cfg!(debug_assertions) {
            let dev = appdata.join("ExeBoard-Dev");
            let _ = std::fs::create_dir_all(&dev);
            let prod = appdata.join("ExeBoard").join("configuracoes.json");
            let dev_cfg = dev.join("configuracoes.json");
            if !dev_cfg.exists() && prod.exists() {
                let _ = std::fs::copy(&prod, &dev_cfg);
            }
            dev
        } else {
            let prod = appdata.join("ExeBoard");
            let _ = std::fs::create_dir_all(&prod);
            prod
        }
    })
}

/// Log em arquivo (`userData\logs\main.log`), com rotação simples em 1 MB (`main.old.log`).
pub fn log(level: &str, msg: &str) {
    use std::io::Write;
    let dir = user_data_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("main.log");
    if let Ok(meta) = std::fs::metadata(&file) {
        if meta.len() > 1_048_576 {
            let _ = std::fs::rename(&file, dir.join("main.old.log"));
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(
            f,
            "[{}] [{}] {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
            level,
            msg
        );
    }
}
pub fn log_info(m: &str) {
    log("info", m)
}
pub fn log_warn(m: &str) {
    log("warn", m)
}
pub fn log_error(m: &str) {
    log("error", m)
}

/// Envia uma linha ao "Log de Atividades" da tela (`target`: "copiar" ou "servidores").
pub fn send_log(app: &AppHandle, msg: &str, color: &str, target: &str) {
    let _ = app.emit("log-message", json!({ "msg": msg, "color": color, "target": target }));
}

// ---------- comandos do Windows ----------

pub struct CmdOut {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub spawned: bool,
}

impl CmdOut {
    pub fn ok(&self) -> bool {
        self.spawned && self.code == Some(0)
    }
    /// stdout + stderr, para procurar mensagens
    pub fn texto(&self) -> String {
        format!("{} {}", self.stdout, self.stderr)
    }
}

/// Roda um programa (SEM shell, argumentos separados, SEM janela) e devolve saída e código de saída.
pub async fn run_cmd(cmd: &str, args: &[&str]) -> CmdOut {
    let mut c = tokio::process::Command::new(cmd);
    c.args(args)
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true);
    match tokio::time::timeout(Duration::from_secs(60), c.output()).await {
        Ok(Ok(o)) => CmdOut {
            code: o.status.code(),
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
            spawned: true,
        },
        Ok(Err(e)) => CmdOut { code: None, stdout: String::new(), stderr: e.to_string(), spawned: false },
        Err(_) => CmdOut { code: None, stdout: String::new(), stderr: "tempo esgotado".into(), spawned: true },
    }
}

/// "Acesso negado" ao controlar serviços/processos (sc/taskkill exigem Administrador).
pub fn is_access_denied(out: &CmdOut) -> bool {
    if out.code == Some(5) {
        return true;
    }
    let t = out.texto().to_lowercase();
    t.contains("acesso negado") || t.contains("access is denied") || t.contains("access denied")
}

/// O processo `nome.exe` está de pé? (via tasklist, não via estado do SCM: o SCM pode dizer "parado" antes de o
/// arquivo ser liberado.)
pub async fn is_process_running(exe: &str) -> bool {
    let filtro = format!("IMAGENAME eq {exe}");
    let out = run_cmd("tasklist", &["/FI", &filtro, "/NH"]).await;
    out.stdout.to_lowercase().contains(&exe.to_lowercase())
}

// ---------- caminhos ----------

/// Ponto de partida de um diálogo: o valor do campo, sem o placeholder legado "Informe…", só se existir.
pub fn clean_default_path(p: &str) -> Option<PathBuf> {
    let cortado = match p.find("Informe") {
        Some(i) => &p[..i],
        None => p,
    };
    let t = cortado.trim();
    if t.is_empty() {
        return None;
    }
    let pb = PathBuf::from(t);
    if pb.exists() {
        Some(pb)
    } else {
        None
    }
}

/// `destino + subpasta + arquivo`. A subpasta cadastrada começa com `\` ("\Agro"): `Path::join` trataria isso como
/// caminho raiz e jogaria fora o destino, então os separadores iniciais são removidos antes.
pub fn join_sub(dest: &str, sub: &str, nome: &str) -> PathBuf {
    let mut p = PathBuf::from(dest);
    let s = sub.trim_matches(|c| c == '\\' || c == '/');
    if !s.is_empty() {
        p.push(s);
    }
    p.push(nome);
    p
}

/// Normaliza para comparar caminhos: minúsculas, `\`, sem barra final.
pub fn norm_path(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

pub fn str_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

pub fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
