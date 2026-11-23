// Ponte entre a interface (renderer.js, escrita para o Electron) e o backend em Rust.
// Expõe o MESMO `window.api` que o preload.js do Electron expunha — assim a tela não muda.
// Convenção do Tauri: os argumentos de `invoke` chegam ao Rust em snake_case (defaultPath -> default_path).
(function () {
    'use strict';
    const tauri = window.__TAURI__;
    if (!tauri || !tauri.core || !tauri.event) {
        console.error('[ExeBoard] API do Tauri indisponível (withGlobalTauri desligado?).');
        return;
    }
    const invoke = tauri.core.invoke;
    const listen = tauri.event.listen;

    window.api = {
        // Configuração
        readConfig: () => invoke('read_config'),
        saveConfig: (data) => invoke('save_config', { data }),
        saveConfigSection: (section, data) => invoke('save_config_section', { section, data }),
        checkAdmin: () => invoke('check_admin'),
        getAppVersion: () => invoke('get_app_version'),
        getDefaultConfig: () => invoke('get_default_config'),

        // Status Polling & detecção
        checkStatus: (srv) => invoke('check_status', { srv }),
        detectarTipo: (nome) => invoke('detectar_tipo', { nome }),
        getWindowsServices: () => invoke('get_windows_services'),

        // Controle de serviços/processos
        manageServer: (payload) => invoke('manage_server', { srv: payload.srv, action: payload.action }),
        killProcess: (name) => invoke('kill_process', { name }),

        // Diretórios / diálogos
        openFolder: (defaultPath) => invoke('open_folder_dialog', { defaultPath: defaultPath || null }),
        openFileGetFolder: (defaultPath) => invoke('open_file_get_folder', { defaultPath: defaultPath || null }),
        openMultiFiles: (defaultPath) => invoke('open_multi_files', { defaultPath: defaultPath || null }),
        getPathSuggestions: (partial) => invoke('get_path_suggestions', { partial }),
        executeExternal: (alvo) => invoke('execute_external', { alvo }),
        openExternal: (url) => invoke('open_external_url', { url }),

        // Bitbucket
        listBranches: (config) => invoke('list_branches', { config }),
        verifyBitbucket: (config) => invoke('verify_bitbucket', { config }),
        extractBitbucket: (config) => invoke('extract_bitbucket', { config }),
        prBaseBranch: (config) => invoke('pr_base_branch', { config }),
        checkBitbucketToken: (config) => invoke('check_bitbucket_token', { config }),
        folderOpenInExplorer: (caminho) => invoke('folder_open_in_explorer', { caminho }),

        // Cópia
        buildQueue: (data) => invoke('build_queue', { reqs: data.reqs, branchRoot: data.branchRoot }),
        executarCopia: (fila) => invoke('execute_copy_files', { fila }),
        cancelarCopia: () => { invoke('cancel_copy'); },

        // Validações da branch
        validateBranch: (data) => invoke('validate_branch', { branchPath: data.branchPath, fileNames: data.fileNames }),
        checkExeAge: (data) => invoke('check_exe_age', { branchPath: data.branchPath, fileNames: data.fileNames }),
        getBranchVersion: (data) => invoke('get_branch_version', { branchPath: data.branchPath, fileNames: data.fileNames }),

        // Eventos do backend -> tela
        onLogMessage: (callback) => { listen('log-message', (e) => callback(e.payload)); },
        onCopyProgress: (callback) => { listen('copy-progress', (e) => callback(e.payload)); },
        onInstanceWarning: (callback) => { listen('show-instance-warning', () => callback()); },
        onUpdateDownloaded: (callback) => { listen('update-downloaded', (e) => callback(e.payload)); },

        // Atualização
        restartApp: () => invoke('restart_app'),
    };
})();
