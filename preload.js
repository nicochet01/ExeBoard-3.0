const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    readIni: () => ipcRenderer.invoke('read-ini'),
    saveIni: (data) => ipcRenderer.invoke('save-ini', data),
    checkAdmin: () => ipcRenderer.invoke('check-admin'),
    
    // Status Polling & IA
    checkStatus: (srv) => ipcRenderer.invoke('check-status', srv),
    detectarTipo: (nome) => ipcRenderer.invoke('detectar-tipo', nome),
    getWindowsServices: () => ipcRenderer.invoke('get-windows-services'),
    
    // Controle
    manageServer: (payload) => ipcRenderer.invoke('manage-server', payload),
    
    // Diretórios GUI
    openFolder: (defaultPath) => ipcRenderer.invoke('open-folder-dialog', defaultPath),
    openFileGetFolder: () => ipcRenderer.invoke('open-file-get-folder'),
    getPathSuggestions: (partial) => ipcRenderer.invoke('get-path-suggestions', partial),
    openMultiFiles: (defaultPath) => ipcRenderer.invoke('open-multi-files', defaultPath),
    executeExternal: (path) => ipcRenderer.invoke('execute-external', path),
    openExternal: (url) => ipcRenderer.invoke('open-external-url', url),
    extractBitbucket: (config) => ipcRenderer.invoke('extract-bitbucket', config),
    saveIniSection: (section, data) => ipcRenderer.invoke('save-ini-section', section, data),
    listBranches: (config) => ipcRenderer.invoke('list-branches', config),

    buildQueue: (data) => ipcRenderer.invoke('build-queue', data),
    executarCopia: (fila) => ipcRenderer.invoke('execute-copy-files', fila),
    cancelarCopia: () => ipcRenderer.send('cancel-copy'),

    // Item 2 & 3: Kill processes e Validação de Branch
    killProcess: (name) => ipcRenderer.invoke('kill-process', name),
    validateBranch: (data) => ipcRenderer.invoke('validate-branch', data),

    // Logs
    onLogMessage: (callback) => ipcRenderer.on('log-message', (_event, data) => callback(data)),

    // Mensagem de aviso
    onInstanceWarning: (callback) => ipcRenderer.on('show-instance-warning', callback),

    // Auto Updater
    onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (_event, data) => callback(data)),
    restartApp: () => ipcRenderer.invoke('restart-app'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
});

