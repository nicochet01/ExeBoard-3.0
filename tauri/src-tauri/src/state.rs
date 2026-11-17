//! Estado compartilhado do app (equivale às variáveis globais do `main.js` do Electron).

use crate::config::ConfigState;
use crate::index::Index;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub struct AppState {
    pub config: ConfigState,
    /// Índice da última branch varrida (cache curto de 8 s; o lock também unifica varreduras simultâneas)
    pub index_cache: tokio::sync::Mutex<Option<(String, Instant, Arc<Index>)>>,
    /// Token de cancelamento da cópia em andamento
    pub copy_cancel: AtomicBool,
    /// true enquanto `execute_copy_files` roda (usado para confirmar o fechamento da janela)
    pub copy_in_progress: AtomicBool,
    /// Fechamento "de verdade" já decidido (não pede confirmação de novo)
    pub quitting: AtomicBool,
    pub close_confirm_open: AtomicBool,
    /// Versão do exe por `caminho|mtime|tamanho` (a pasta do Drive só é lida uma vez por build)
    pub version_cache: Mutex<HashMap<String, Option<String>>>,
    /// Atualização já baixada, aguardando o usuário escolher "Reiniciar e Atualizar"
    pub pending_update: tokio::sync::Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            config: ConfigState::new(),
            index_cache: tokio::sync::Mutex::new(None),
            copy_cancel: AtomicBool::new(false),
            copy_in_progress: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            close_confirm_open: AtomicBool::new(false),
            version_cache: Mutex::new(HashMap::new()),
            pending_update: tokio::sync::Mutex::new(None),
        }
    }
}
