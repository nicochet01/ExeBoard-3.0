const { app, BrowserWindow, ipcMain, Tray, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { createReadStream, createWriteStream } = require('fs');
const ini = require('ini');
const { exec, execSync } = require('child_process');

let mainWindow;
let tray;

// Nova estratégia: AppData (Roaming) para um executável limpo
const userDataPath = app.getPath('userData');
const roamingIniPath = path.join(userDataPath, 'Inicializar.ini');
const localIniPath = path.join(app.getPath('exe'), '..', 'Inicializar.ini');
const devIniPath = path.join(__dirname, 'Inicializar.ini');

let activeIniPath = roamingIniPath; // Por padrão, salva no Roaming
let copyCancelToken = false;
let configCache = { GERAL: { HABILITAR_TRAY: '0' } }; // Cache local para regras de negócio

const COPY_BUFFER_SIZE = 1048576; // 1MB
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 750,
        title: "ExeBoard",
        icon: path.join(__dirname, 'assets', 'LOGO_EXEBOARD.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true,
        backgroundColor: '#1e1e2e'
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('close', (event) => {
        const trayEnabled = configCache.GERAL && configCache.GERAL.HABILITAR_TRAY === '1';
        if (!app.isQuiting && trayEnabled) {
            event.preventDefault();
            mainWindow.hide();
        }
        return false;
    });

    mainWindow.on('minimize', (event) => {
        const trayEnabled = configCache.GERAL && configCache.GERAL.HABILITAR_TRAY === '1';
        if (trayEnabled) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

function createTray() {
    try {
        if (tray) tray.destroy(); 

        const { nativeImage } = require('electron');
        const iconPath = path.join(__dirname, 'assets', 'LOGO_EXEBOARD.ico');
        
        // nativeImage é muito mais seguro para ler arquivos de dentro do .asar
        const trayIcon = nativeImage.createFromPath(iconPath);
        
        tray = new Tray(trayIcon);
        
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Abrir Painel', click: () => {
                mainWindow.show();
                mainWindow.setAlwaysOnTop(true);
                mainWindow.setAlwaysOnTop(false);
                mainWindow.focus();
            }},
            { type: 'separator' },
            { label: 'Sair ExeBoard', click: () => {
                app.isQuiting = true;
                app.quit();
            }}
        ]);
        
        tray.setToolTip('ExeBoard - Gerenciador');
        tray.setContextMenu(contextMenu);
        
        tray.on('double-click', () => {
            mainWindow.show();
            mainWindow.setAlwaysOnTop(true);
            mainWindow.setAlwaysOnTop(false);
            mainWindow.focus();
        });
        
        tray.on('click', () => {
            mainWindow.show();
        });
    } catch (err) {
        console.error("Erro fatal ao carregar a Bandeja do Sistema:", err);
    }
}

app.whenReady().then(async () => {
    await loadConfig(); // Carrega configs antes de criar a UI
    console.log('INI Carregado. Tray Ativo:', configCache.GERAL?.HABILITAR_TRAY);
    createWindow();
    createTray();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    // Mantém vivo na bandeja
});

// Helper de envio de mensagens
function sendLog(msg, color='gray', target='copiar') {
    if(mainWindow) mainWindow.webContents.send('log-message', { msg, color, target });
}

async function loadConfig() {
    // Lista de pastas possíveis geradas por nomes de produtos anteriores
    const possiblePaths = [
        roamingIniPath,
        path.join(app.getPath('appData'), 'ExeCockpit', 'Inicializar.ini'),
        path.join(app.getPath('appData'), 'ExeBoard Cockpit', 'Inicializar.ini'),
        path.join(app.getPath('appData'), 'exeboard', 'Inicializar.ini'),
        localIniPath
    ];

    // 1. Tenta encontrar a primeira que existe e migra para a oficial (roamingIniPath)
    for (let p of possiblePaths) {
        if (p && fs.existsSync(p)) {
            if (p !== roamingIniPath) {
                try {
                    await fs.ensureDir(userDataPath);
                    await fs.copy(p, roamingIniPath);
                } catch(e) {}
            }
            activeIniPath = roamingIniPath;
            break;
        }
    }

    // Fallback para desenvolvimento
    if (!fs.existsSync(activeIniPath) && fs.existsSync(devIniPath)) {
        activeIniPath = devIniPath;
    }

    if (fs.existsSync(activeIniPath)) {
        try {
            const content = await fs.readFile(activeIniPath, 'utf-8');
            configCache = ini.parse(content);
        } catch (err) {
            console.error('Erro ao ler INI:', err);
        }
    } else {
        activeIniPath = roamingIniPath;
    }
}

// ==== IPC INI ====
ipcMain.handle('read-ini', async () => {
    await loadConfig();
    return { success: true, data: configCache };
});

ipcMain.handle('save-ini', async (event, dataToSave) => {
    try {
        await fs.ensureDir(userDataPath);
        const parsed = ini.stringify(dataToSave);
        await fs.writeFile(roamingIniPath, parsed, 'utf-8');
        configCache = dataToSave; // Atualiza o cache do backend
        return { success: true };
    } catch (err) {
        return { error: err.message };
    }
});

// Verifica se o processo tem privilégios administrativos
ipcMain.handle('check-admin', async () => {
    try {
        execSync('net session', { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
});

// ==== IPC Servidores e Processos ====

// Verifica o status de um item (Polling)
ipcMain.handle('check-status', async (event, srv) => {
    return new Promise((resolve) => {
        if (srv.Tipo === 'Servico') {
            exec(`sc query "${srv.Nome}"`, (err, stdout) => {
                if (stdout.includes('RUNNING')) resolve('running');
                else if (stdout.includes('STOPPED')) resolve('stopped');
                else if (stdout.includes('PENDING')) resolve('transition');
                else resolve('not_found'); // 1060 não especificado
            });
        } else {
            // Processo App (.exe)
            const procName = srv.Nome.endsWith('.exe');
            exec(`tasklist /FI "IMAGENAME eq ${procName}" /NH`, (err, stdout) => {
                if (stdout.includes(procName)) resolve('running');
                else resolve('stopped'); // não detecta transição em .exe normal por tasklist simple
            });
        }
    });
});

// IA Leve de auto-serviço
ipcMain.handle('detectar-tipo', async (event, nome) => {
    return new Promise(resolve => {
        exec(`sc query "${nome}"`, (err) => {
            if (err && err.code !== 0) resolve('Aplicacao');
            else resolve('Servico');
        });
    });
});

// Helper para aguardar status de serviço
const waitForServiceStatus = (name, targetStatus, timeoutMs = 20000) => {
    return new Promise(resolve => {
        const start = Date.now();
        const check = () => {
            exec(`sc query "${name}"`, (err, stdout) => {
                if (stdout.includes(targetStatus)) return resolve(true);
                if (Date.now() - start > timeoutMs) return resolve(false);
                setTimeout(check, 1000);
            });
        };
        check();
    });
};

// Controle explícito
ipcMain.handle('manage-server', async (event, { srv, action }) => {
    return new Promise((resolve) => {
        const sendUiLog = (text, c='#a6adc8') => { sendLog(text, c, 'servidores'); };
        const procName = srv.Nome.endsWith('.exe') ? srv.Nome : srv.Nome + '.exe';
        const pureName = srv.Nome;

        if (action === 'start') {
            if (srv.Tipo === 'Servico') {
                exec(`net start "${pureName}"`, async (error, stdout, stderr) => {
                    if (error) {
                        const out = (stdout || stderr || '').trim();
                        sendUiLog(`ERRO ao iniciar ${pureName}: ${out || error.message}`, '#f38ba8');
                    } else {
                        const ok = await waitForServiceStatus(pureName, 'RUNNING');
                        if (ok) sendUiLog(`Sucesso: ${pureName} INICIADO.`, '#40a02b');
                        else sendUiLog(`Aviso: ${pureName} demorando para responder...`, '#fab387');
                    }
                    resolve(true);
                });
            } else {
                sendUiLog(`Ação: ${pureName} é Aplicação. Inicie manualmente pela pasta.`, '#bac2de');
                resolve(false);
            }
        } else if (action === 'stop' || action === 'kill') {
            if (srv.Tipo === 'Servico') {
                exec(`net stop "${pureName}"`, async (error, stdout, stderr) => {
                    let out = (stdout || stderr || '').trim();
                    if (error && !out.includes("1062")) {
                        sendUiLog(`Aviso STOP ${pureName}: ${out || error.message}`, '#fab387');
                    }
                    // Aguarda o stop ou força kill
                    await waitForServiceStatus(pureName, 'STOPPED', 10000);
                    exec(`taskkill /F /IM "${procName}"`, () => {
                        if (action === 'stop') sendUiLog(`${pureName} parado.`, '#f38ba8');
                        resolve(true);
                    });
                });
            } else {
                exec(`taskkill /F /IM "${procName}"`, () => {
                    sendUiLog(`KILL enviado para ${procName}`, '#f38ba8');
                    resolve(true); 
                });
            }
        }
    });
});

// ==== NOVO MOTOR DE CÓPIA SEGURO (Transacional) ====

const secureCopyFile = async (src, dest) => {
    let attempts = 0;
    while (attempts < MAX_RETRIES) {
        if (copyCancelToken) return 'cancelled';
        
        try {
            // Remove ReadOnly se existir no destino
            if (fs.existsSync(dest)) await fs.chmod(dest, 0o666).catch(()=>{});

            const tempDest = dest + '.tmp';
            await new Promise((resolve, reject) => {
                const readStream = createReadStream(src, { highWaterMark: COPY_BUFFER_SIZE });
                const writeStream = createWriteStream(tempDest);
                
                readStream.on('error', reject);
                writeStream.on('error', reject);
                writeStream.on('finish', resolve);

                readStream.on('data', () => {
                    if (copyCancelToken) {
                        readStream.destroy();
                        writeStream.destroy();
                        reject(new Error('CANCELLED'));
                    }
                });

                readStream.pipe(writeStream);
            });

            // Swap Inteligente: Move do temporário para o destino. 
            // fs.move lida com EXDEV (movimentação entre discos/volumes diferentes)
            if (fs.existsSync(dest)) await fs.unlink(dest);
            await fs.move(tempDest, dest, { overwrite: true });
            return 'ok';

        } catch (err) {
            if (err.message === 'CANCELLED') return 'cancelled';
            attempts++;
            if (attempts < MAX_RETRIES) {
                sendLog(`Tentativa ${attempts} falhou p/ ${path.basename(dest)}. Falha física ou arquivo preso. Retentando...`, '#fab387', 'copiar');
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            } else {
                throw err;
            }
        }
    }
};

// Indexador Stack-based (Arquivo e Pastas)
const indexarDiretorio = async (startDir) => {
    const fileMap = new Map(); // Key: fileName.toLowerCase(), Value: { fullPath, mtime }
    const dirMap = new Map();  // Key: dirName.toLowerCase(), Value: { fullPath }
    const stack = [startDir];

    while (stack.length > 0) {
        const currentDir = stack.pop();
        try {
            const entries = await fs.readdir(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                try {
                    const fullPath = path.join(currentDir, entry.name);
                    const name = entry.name.toLowerCase();

                    if (entry.isDirectory()) {
                        stack.push(fullPath);
                        // No Smart Mapping, a pasta mais recente ou primeira encontrada? 
                        // Geralmente pastas de BD não duplicam nomes na branch.
                        if (!dirMap.has(name)) dirMap.set(name, { fullPath });
                    } else {
                        const stats = await fs.stat(fullPath);
                        const mtime = stats.mtimeMs;
                        if (!fileMap.has(name) || mtime > fileMap.get(name).mtime) {
                            fileMap.set(name, { fullPath, mtime });
                        }
                    }
                } catch (errItem) {}
            }
        } catch (e) {
            sendLog(`Aviso: Pasta ignorada (Acesso Negado): ${currentDir}`, '#fe640b', 'copiar');
        }
    }
    return { fileMap, dirMap };
};

// ==== MOTOR RECURSIVO PARA ATUALIZADORES (BD) ====
const copyFolderRecursive = async (src, dest) => {
    if (copyCancelToken) return 'cancelled';

    try {
        const stats = await fs.stat(src);
        if (!stats.isDirectory()) return 'error_not_dir';

        // Passo B: Cria o molde
        if (!fs.existsSync(dest)) {
            await fs.ensureDir(dest);
            sendLog(`Criado diretório: ${path.basename(dest)}`, '#bac2de', 'copiar');
        }

        const entries = await fs.readdir(src, { withFileTypes: true });
        for (const entry of entries) {
            if (copyCancelToken) break;

            const sPath = path.join(src, entry.name);
            const dPath = path.join(dest, entry.name);

            if (entry.isDirectory()) {
                await copyFolderRecursive(sPath, dPath);
            } else {
                // Passo C: Sobrescrita de arquivos (.cds, .xml, .sql)
                await secureCopyFile(sPath, dPath);
            }
        }
        return 'ok';
    } catch (err) {
        throw err;
    }
};

ipcMain.handle('execute-copy-files', async (event, queueData) => {
    copyCancelToken = false;
    let errors = 0;
    let news = 0;

    for (const task of queueData) {
        if (copyCancelToken) break;

        try {
            const srcExists = await fs.pathExists(task.origem);
            if (!srcExists) {
                sendLog(`PULANDO: Origem não encontrada [${task.origem}]`, '#bac2de', 'copiar');
                continue;
            }

            const isNew = !(await fs.pathExists(task.destino));
            
            if (task.type === 'bd') {
                // Cópia Recursiva de Pasta
                const res = await copyFolderRecursive(task.origem, task.destino);
                if (res === 'cancelled') break;
                news++; // Cada tarefa de pasta conta como 1
                sendLog(`PASTA ATUALIZADA: ${path.basename(task.destino)}`, '#40a02b', 'copiar');
            } else {
                // Cópia de Arquivo Único
                await fs.ensureDir(path.dirname(task.destino));
                const res = await secureCopyFile(task.origem, task.destino);
                if (res === 'cancelled') {
                    await fs.unlink(task.destino + '.tmp').catch(()=>{});
                    break;
                }

                news++; // Contabiliza cada arquivo processado com sucesso
                if (isNew) {
                    sendLog(`NOVO ARQUIVO: ${task.destino}`, '#fe640b', 'copiar');
                } else {
                    sendLog(`ATUALIZADO: ${task.destino}`, '#40a02b', 'copiar');
                }
            }

        } catch (err) {
            errors++;
            sendLog(`ERRO FATAL em ${task.origem}: ${err.message}`, '#f38ba8', 'copiar');
        }
    }

    return { status: copyCancelToken ? 'cancelled' : 'completed', errors, news };
});

// Novo build-queue com Inteligência de Mapeamento (Fire and Forget)
ipcMain.handle('build-queue', async (event, { reqs, branchRoot }) => {
    const queue = [];
    if (!reqs || reqs.length === 0) return queue;

    try {
        sendLog(`Mapeando Branch: ${branchRoot}`, '#89b4fa', 'copiar');
        
        // 1. Mapeia a Branch Inteira (Origem) usando a RAIZ fornecida
        const indexingResults = await indexarDiretorio(branchRoot);
        const sourceFileMap = indexingResults.fileMap;
        const sourceDirMap = indexingResults.dirMap;
        
        if (sourceFileMap.size === 0 && sourceDirMap.size === 0) {
            sendLog('AVISO: Nenhum arquivo ou pasta encontrado na Branch.', '#f38ba8', 'copiar');
            return queue;
        }

        // 2. Mapeia as Raízes de Destino Únicas
        const destRoots = [...new Set(reqs.map(r => r.destDir))];
        const destMappingResults = new Map();
        for (const root of destRoots) {
            sendLog(`Mapeando destino: ${path.basename(root)}...`, '#89b4fa', 'copiar');
            destMappingResults.set(root, await indexarDiretorio(root));
        }

        sendLog('Cruzando dados e resolvendo caminhos finais...', '#89b4fa', 'copiar');

        // 3. Monta a Fila Cruzando Dados
        for (const req of reqs) {
            let pureName = (req.type === 'client' || req.type === 'server' ? req.itemData.Nome : req.itemData.Nome || req.itemData).toLowerCase();
            
            if (req.type === 'bd') {
                // Lógica de Atualizadores (Pastas)
                let sourceFolder = sourceDirMap.get(pureName);
                if (!sourceFolder) {
                    // Tenta Fallback para \BD\Nome
                    sourceFolder = sourceDirMap.get('bd\\' + pureName) || sourceDirMap.get('dados\\' + pureName);
                }

                if (!sourceFolder) {
                    sendLog(`X Pasta de Atualizador não encontrada: ${pureName}`, '#bac2de', 'copiar');
                    continue;
                }

                queue.push({
                    origem: sourceFolder.fullPath,
                    destino: path.join(req.destDir, path.basename(sourceFolder.fullPath)),
                    type: 'bd'
                });
            } else {
                // Lógica de Arquivos (Clientes e Servidores)
                if (pureName.endsWith('.exe')) pureName = pureName.slice(0, -4);
                const exeName = pureName + '.exe';
                
                let sourceFile = sourceFileMap.get(exeName) || sourceFileMap.get(pureName);
                if (!sourceFile) {
                    sendLog(`X Não encontrado na Branch: ${pureName}`, '#bac2de', 'copiar');
                    continue;
                }

                const destMapObj = destMappingResults.get(req.destDir);
                const existingInDest = destMapObj ? destMapObj.fileMap.get(exeName) : null;

                let finalDest;
                if (existingInDest) {
                    finalDest = existingInDest.fullPath;
                    sendLog(`-> Aprendido: ${exeName} vai para subpasta existente.`, '#cba6f7', 'copiar');
                } else {
                    const sub = req.itemData.SubDiretorios || '';
                    finalDest = path.join(req.destDir, sub, path.basename(sourceFile.fullPath));
                }

                queue.push({
                    origem: sourceFile.fullPath,
                    destino: finalDest,
                    type: req.type
                });
            }
        }
    } catch (err) {
        sendLog(`ERRO CRÍTICO no Mapeamento: ${err.message}`, '#f38ba8', 'copiar');
    }

    return queue;
});

ipcMain.handle('open-folder-dialog', async (event, defaultPath) => {
    const opts = { properties: ['openDirectory'] };
    if (defaultPath) {
        try { 
            const cleanPath = defaultPath.replace(/Informe.*/, '').trim();
            if (cleanPath && await fs.pathExists(cleanPath)) opts.defaultPath = cleanPath; 
        } catch(e){}
    }
    const res = await dialog.showOpenDialog(mainWindow, opts);
    return res.filePaths[0] || null;
});

ipcMain.handle('get-windows-services', async () => {
    return new Promise(resolve => {
        // Coleta serviços usando PowerShell em formato JSON para fácil parse
        const cmd = `powershell "Get-Service | Select-Object Name, DisplayName, Status | ConvertTo-Json"`;
        exec(cmd, { maxBuffer: 1024 * 1024 * 5 }, (err, stdout) => {
            if (err) return resolve([]);
            try {
                const data = JSON.parse(stdout);
                // Normaliza para array (Get-Service pode retornar objeto único se houver só 1)
                const list = Array.isArray(data) ? data : [data];
                resolve(list);
            } catch (e) {
                resolve([]);
            }
        });
    });
});

ipcMain.handle('open-file-get-folder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
    if (res.filePaths.length > 0) return path.dirname(res.filePaths[0]);
    return null;
});

ipcMain.handle('get-path-suggestions', async (event, partialPath) => {
    if (!partialPath || partialPath.length < 2) return [];
    try {
        let lookupDir = partialPath;
        let filter = '';

        if (!fs.existsSync(partialPath) || !fs.statSync(partialPath).isDirectory()) {
            lookupDir = path.dirname(partialPath);
            filter = path.basename(partialPath).toLowerCase();
        }

        if (fs.existsSync(lookupDir) && fs.statSync(lookupDir).isDirectory()) {
            const children = await fs.readdir(lookupDir);
            const folders = [];
            for (const name of children) {
                if (name.toLowerCase().startsWith(filter)) {
                    try {
                        const full = path.join(lookupDir, name);
                        if ((await fs.stat(full)).isDirectory()) {
                            folders.push(full);
                        }
                    } catch (e) {}
                }
                if (folders.length > 15) break; // Limit suggestions
            }
            return folders;
        }
    } catch (err) {}
    return [];
});

ipcMain.handle('open-multi-files', async (event, defaultPath) => {
    const opts = { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Executables', extensions: ['exe'] }] };
    if (defaultPath) {
        try { 
            const cleanPath = defaultPath.replace(/Informe.*/, '').trim();
            if (cleanPath && await fs.pathExists(cleanPath)) opts.defaultPath = cleanPath; 
        } catch(e){}
    }
    const res = await dialog.showOpenDialog(mainWindow, opts);
    return res.filePaths.map(p => path.basename(p));
});

ipcMain.handle('execute-external', async (event, exePath) => {
    exec(`start "" "${exePath}"`, (err) => {
        if(err) sendLog(`Erro ao executar ${exePath}: ${err.message}`, '#f38ba8', 'copiar');
        else sendLog(`Programa ${exePath} iniciado na nuvem de Processos.`, '#a6adc8', 'copiar');
    });
});
