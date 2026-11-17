//! Comandos de interface: diálogos de pasta/arquivo, abrir pasta/URL, versão, configuração padrão e atualização.

use crate::state::AppState;
use crate::util::*;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Diálogo de PASTA → caminho escolhido (ou null).
#[tauri::command]
pub async fn open_folder_dialog(app: AppHandle, default_path: Option<String>) -> Result<Option<String>, String> {
    let janela = app.get_webview_window("main");
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = app.dialog().file();
        if let Some(p) = default_path.as_deref().and_then(clean_default_path) {
            d = d.set_directory(p);
        }
        if let Some(j) = &janela {
            d = d.set_parent(j);
        }
        d.blocking_pick_folder().and_then(|f| f.into_path().ok()).map(|p| path_str(&p))
    })
    .await
    .map_err(|e| e.to_string())
}

/// Diálogo de ARQUIVO → a PASTA do arquivo escolhido (o usuário "vê" os exes dentro da branch).
#[tauri::command]
pub async fn open_file_get_folder(app: AppHandle, default_path: Option<String>) -> Result<Option<String>, String> {
    let janela = app.get_webview_window("main");
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = app.dialog().file();
        if let Some(p) = default_path.as_deref().and_then(clean_default_path) {
            d = d.set_directory(p);
        }
        if let Some(j) = &janela {
            d = d.set_parent(j);
        }
        d.blocking_pick_file()
            .and_then(|f| f.into_path().ok())
            .and_then(|p| p.parent().map(|x| path_str(x)))
    })
    .await
    .map_err(|e| e.to_string())
}

/// Diálogo de vários `.exe` → lista de caminhos (vazia se cancelar).
#[tauri::command]
pub async fn open_multi_files(app: AppHandle, default_path: Option<String>) -> Result<Vec<String>, String> {
    let janela = app.get_webview_window("main");
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = app.dialog().file().add_filter("Executables", &["exe"]);
        if let Some(p) = default_path.as_deref().and_then(clean_default_path) {
            d = d.set_directory(p);
        }
        if let Some(j) = &janela {
            d = d.set_parent(j);
        }
        d.blocking_pick_files()
            .map(|v| v.into_iter().filter_map(|f| f.into_path().ok()).map(|p| path_str(&p)).collect())
            .unwrap_or_default()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Abre pasta, arquivo ou endereço web com o programa padrão do Windows (sem shell, sem montar `start "" "..."`).
#[tauri::command]
pub async fn execute_external(app: AppHandle, alvo: Option<String>) -> Result<(), String> {
    let alvo = alvo.unwrap_or_default();
    if alvo.trim().is_empty() {
        return Ok(());
    }
    let eh_web = alvo.to_lowercase().starts_with("http://") || alvo.to_lowercase().starts_with("https://");
    // Caminho que não existe: o shell do Windows abriria uma janela de erro (e pode demorar numa unidade de rede
    // fora do ar). Avisa no log e não chama o shell.
    if !eh_web && !std::path::Path::new(&alvo).exists() {
        send_log(&app, &format!("Erro ao executar {alvo}: caminho não encontrado."), "#f38ba8", "copiar");
        return Ok(());
    }
    let r = if eh_web {
        app.opener().open_url(&alvo, None::<&str>)
    } else {
        app.opener().open_path(&alvo, None::<&str>)
    };
    match r {
        Ok(_) => send_log(&app, &format!("Programa {alvo} iniciado na nuvem de Processos."), "#a6adc8", "copiar"),
        Err(e) => send_log(&app, &format!("Erro ao executar {alvo}: {e}"), "#f38ba8", "copiar"),
    }
    Ok(())
}

/// Só endereços web (impede abrir `file:`, `ms-msdt:` e outros protocolos a partir da tela).
#[tauri::command]
pub async fn open_external_url(app: AppHandle, url: Option<String>) -> Result<(), String> {
    let url = url.unwrap_or_default();
    let l = url.to_lowercase();
    if l.starts_with("http://") || l.starts_with("https://") {
        let _ = app.opener().open_url(&url, None::<&str>);
    }
    Ok(())
}

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Configuração padrão da primeira instalação. O arquivo `config-padrao.json` acompanha o app (pode ser ajustado sem
/// recompilar); se não for achado, usa a cópia embutida na compilação.
#[tauri::command]
pub async fn get_default_config(app: AppHandle) -> Result<Value, String> {
    let mut candidatos: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(r) = app.path().resource_dir() {
        candidatos.push(r.join("config-padrao.json"));
    }
    if let Ok(e) = std::env::current_exe() {
        if let Some(p) = e.parent() {
            candidatos.push(p.join("config-padrao.json"));
        }
    }
    for c in candidatos {
        if let Ok(texto) = tokio::fs::read_to_string(&c).await {
            match serde_json::from_str::<Value>(texto.trim_start_matches('\u{feff}')) {
                Ok(v) => return Ok(json!({ "data": v })),
                Err(e) => return Ok(json!({ "error": e.to_string() })),
            }
        }
    }
    match serde_json::from_str::<Value>(include_str!("../../../config-padrao.json").trim_start_matches('\u{feff}')) {
        Ok(v) => Ok(json!({ "data": v })),
        Err(e) => Ok(json!({ "error": e.to_string() })),
    }
}

/// "Reiniciar e Atualizar": instala a atualização já baixada (o instalador reabre o app no fim).
#[tauri::command]
pub async fn restart_app(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    log_info("Solicitação de Reinício para Instalação (restart-app)");
    state.quitting.store(true, std::sync::atomic::Ordering::SeqCst);
    let pendente = state.pending_update.lock().await.take();
    match pendente {
        Some((update, bytes)) => {
            // pequeno atraso para o SO liberar travas de arquivo antes do instalador sobrescrever
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
            log_info("Invocando a instalação da atualização...");
            if let Err(e) = update.install(bytes) {
                log_error(&format!("Falha ao instalar a atualização: {e}"));
                return Ok(json!({ "error": e.to_string() }));
            }
            app.exit(0);
            Ok(json!({ "success": true }))
        }
        None => Ok(json!({ "error": "Nenhuma atualização baixada." })),
    }
}
