//! Ciclo de vida: janela, bandeja, instância única, fechar/minimizar e atualização automática
//! (seções 2 e 14 de docs/REGRAS-DE-NEGOCIO.md).

use crate::config::load_config;
use crate::state::AppState;
use crate::util::*;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// Traz a janela principal para a frente (restaura se minimizada/escondida).
fn mostrar_janela(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // Ao minimizar, a janela é escondida JÁ minimizada: só show() a deixa só na barra de tarefas.
        // Por isso: mostra, tira do estado minimizado e só então traz para a frente.
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_always_on_top(true);
        let _ = w.set_always_on_top(false);
        let _ = w.set_focus();
    }
}

fn criar_bandeja(app: &AppHandle) -> tauri::Result<()> {
    let abrir = MenuItem::with_id(app, "abrir", "Abrir Painel", true, None::<&str>)?;
    let sair = MenuItem::with_id(app, "sair", "Sair ExeBoard", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&abrir, &PredefinedMenuItem::separator(app)?, &sair])?;
    let mut b = TrayIconBuilder::with_id("principal")
        .tooltip("ExeBoard - Gerenciador")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            "abrir" => mostrar_janela(app),
            "sair" => {
                app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| match ev {
            TrayIconEvent::DoubleClick { .. } => mostrar_janela(tray.app_handle()),
            // Clique simples também abre o painel (antes só chamava show() e a janela ficava minimizada)
            TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
                mostrar_janela(tray.app_handle())
            }
            _ => {}
        });
    if let Some(icone) = app.default_window_icon() {
        b = b.icon(icone.clone());
    }
    b.build(app)?;
    Ok(())
}

/// Verifica atualização em silêncio, baixa e avisa a tela (`update-downloaded`). Em build de desenvolvimento
/// não verifica (a menos que EXEBOARD_UPDATER=1).
fn verificar_atualizacao(app: AppHandle) {
    if cfg!(debug_assertions) && std::env::var("EXEBOARD_UPDATER").is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        log_info("Verificando atualizações...");
        // Só em build de desenvolvimento: EXEBOARD_UPDATE_URL aponta o atualizador para um servidor de teste
        // (a release nunca aceita endereço vindo de variável de ambiente).
        let teste_url = if cfg!(debug_assertions) { std::env::var("EXEBOARD_UPDATE_URL").ok() } else { None };
        let updater = match teste_url {
            Some(u) => match u.parse().ok().and_then(|url| app.updater_builder().endpoints(vec![url]).ok()).map(|b| b.build()) {
                Some(Ok(up)) => up,
                Some(Err(e)) => {
                    log_warn(&format!("Atualizador de teste indisponível: {e}"));
                    return;
                }
                None => {
                    log_warn("EXEBOARD_UPDATE_URL inválida");
                    return;
                }
            },
            None => match app.updater() {
                Ok(u) => u,
                Err(e) => {
                    log_warn(&format!("Atualizador indisponível: {e}"));
                    return;
                }
            },
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let nova = update.version.clone();
                log_info(&format!("Atualização disponível: {nova}"));
                match update.download(|_, _| {}, || {}).await {
                    Ok(bytes) => {
                        log_info(&format!("Atualização baixada: {nova}"));
                        let atual = app.package_info().version.to_string();
                        *app.state::<AppState>().pending_update.lock().await = Some((update, bytes));
                        let _ = app.emit("update-downloaded", json!({ "currentVersion": atual, "newVersion": nova }));
                    }
                    Err(e) => log_error(&format!("Erro ao baixar a atualização: {e}")),
                }
            }
            Ok(None) => log_info("Nenhuma atualização disponível."),
            // sem internet etc.: só registra (nunca vira erro na tela)
            Err(e) => log_warn(&format!("Não foi possível verificar atualizações (provavelmente sem conexão): {e}")),
        }
    });
}

pub fn run() {
    std::panic::set_hook(Box::new(|info| {
        log_error(&format!("FATAL: panic: {info}"));
    }));
    log_info("=== ExeBoard Iniciado ===");

    let janela_mostrada = std::sync::Arc::new(AtomicBool::new(false));

    let r = tauri::Builder::default()
        // Instância única: a segunda tentativa traz a janela existente para a frente e avisa a tela
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            mostrar_janela(app);
            let _ = app.emit("show-instance-warning", ());
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            crate::config::read_config,
            crate::config::save_config,
            crate::config::save_config_section,
            crate::services::check_admin,
            crate::services::check_status,
            crate::services::detectar_tipo,
            crate::services::get_windows_services,
            crate::services::manage_server,
            crate::services::kill_process,
            crate::branch::validate_branch,
            crate::branch::check_exe_age,
            crate::branch::get_branch_version,
            crate::branch::get_path_suggestions,
            crate::copy::build_queue,
            crate::copy::execute_copy_files,
            crate::copy::cancel_copy,
            crate::ui_cmds::open_folder_dialog,
            crate::ui_cmds::open_file_get_folder,
            crate::ui_cmds::open_multi_files,
            crate::ui_cmds::execute_external,
            crate::ui_cmds::open_external_url,
            crate::ui_cmds::get_app_version,
            crate::ui_cmds::get_default_config,
            crate::ui_cmds::restart_app,
            crate::bitbucket::list_branches,
            crate::bitbucket::verify_bitbucket,
            crate::bitbucket::extract_bitbucket,
            crate::bitbucket::pr_base_branch,
            crate::ui_cmds::folder_open_in_explorer,
        ])
        .setup(|app| {
            log_info(&format!("Versão: {}", app.package_info().version));
            if let Ok(exe) = std::env::current_exe() {
                log_info(&format!("Caminho Executável: {}", exe.display()));
            }
            // Carrega a configuração ANTES da interface (a bandeja e o minimizar dependem dela)
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async { load_config(&handle.state::<AppState>().config).await });
            if let Err(e) = criar_bandeja(app.handle()) {
                log_error(&format!("Erro fatal ao carregar a Bandeja do Sistema: {e}"));
            }
            crate::copy::limpar_temporarios(app.handle().clone()); // sem esperar: não atrasa a abertura
            Ok(())
        })
        // A janela nasce escondida e só aparece quando a página termina de carregar (sem "flash" branco)
        .on_page_load(move |webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) && !janela_mostrada.swap(true, Ordering::SeqCst) {
                let w = webview.window();
                let _ = w.center();
                let _ = w.show();
                let _ = w.maximize();
                let _ = w.set_focus();
                verificar_atualizacao(webview.app_handle().clone());
            }
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let st = app.state::<AppState>();
            match event {
                // Minimizar: com a bandeja habilitada a janela vai para a bandeja
                WindowEvent::Resized(_) => {
                    if window.is_minimized().unwrap_or(false) && st.config.tray_habilitado() {
                        let _ = window.hide();
                    }
                }
                // O X sempre encerra o app. Com cópia em andamento pede confirmação antes.
                WindowEvent::CloseRequested { api, .. } => {
                    if !st.quitting.load(Ordering::SeqCst) && st.copy_in_progress.load(Ordering::SeqCst) {
                        api.prevent_close();
                        if st.close_confirm_open.swap(true, Ordering::SeqCst) {
                            return;
                        }
                        let (app2, w) = (app.clone(), window.clone());
                        app.dialog()
                            .message("Há uma cópia de arquivos em andamento.\n\nSe sair agora, a cópia será interrompida e os arquivos que estavam sendo copiados podem ficar incompletos.")
                            .title("Cópia em andamento")
                            .kind(MessageDialogKind::Warning)
                            .buttons(MessageDialogButtons::OkCancelCustom("Sair mesmo assim".into(), "Continuar copiando".into()))
                            .show(move |sair| {
                                let st = app2.state::<AppState>();
                                st.close_confirm_open.store(false, Ordering::SeqCst);
                                if sair {
                                    st.copy_cancel.store(true, Ordering::SeqCst);
                                    st.quitting.store(true, Ordering::SeqCst);
                                    let _ = w.close();
                                }
                            });
                    } else {
                        st.quitting.store(true, Ordering::SeqCst);
                        log_info("Janela fechando definitivamente");
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!());

    if let Err(e) = r {
        log_error(&format!("Erro ao executar o aplicativo: {e}"));
    }
}
