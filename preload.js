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

    buildQueue: (data) => ipcRenderer.invoke('build-queue', data),
    executarCopia: (fila) => ipcRenderer.invoke('execute-copy-files', fila),
    cancelarCopia: () => ipcRenderer.send('cancel-copy'),

    // Logs
    onLogMessage: (callback) => ipcRenderer.on('log-message', (_event, data) => callback(data))
});
