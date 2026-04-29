const { app, BrowserWindow, ipcMain, Tray, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { createReadStream, createWriteStream } = require('fs');
const ini = require('ini');
const { exec, execSync } = require('child_process');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// Configuração do Electron Log (Caixa Preta)
log.transports.file.level = 'info';
log.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'logs', 'main.log');
Object.assign(console, log.functions); // Hook global do console

log.info('=== ExeBoard Iniciado ===');
log.info('Versão:', app.getVersion());
log.info('Caminho Executável:', app.getPath('exe'));

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

app.isQuiting = false; // Inicializa a flag de fechamento real


// ==== TRAVA DE INSTÂNCIA ÚNICA ====
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    // Se o app já estiver aberto, a nova tentativa simplesmente morre aqui
    app.quit();
} else {
    // O aplicativo original que já estava rodando "escuta" a nova tentativa
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();

            // Manda um sinal para o frontend (index.html) exibir o modal
            mainWindow.webContents.send('show-instance-warning');
        }
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 800,
        minWidth: 1000,
        minHeight: 700,
        show: false, // Inicia oculta para configurar a janela antes de exibir
        autoHideMenuBar: true, // Esconde o menu superior (File, Edit, View...)
        icon: path.join(__dirname, 'assets', 'LOGO_EXEBOARD.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js') // Isso faz os dados voltarem a carregar!
        }
    });

    mainWindow.loadFile('index.html');

    // Monitora se a tela (Renderer) "morreu" ou travou
    mainWindow.webContents.on('render-process-gone', (event, details) => {
        log.error(`CRASH: O processo de renderização sumiu! Motivo: ${details.reason}, ExitCode: ${details.exitCode}`);
    });

    mainWindow.webContents.on('unresponsive', () => {
        log.warn('AVISO: A janela do aplicativo parou de responder.');
    });


    // Sempre garantir que inicie visível, centrada e focada, ignorando minimização acidental de atalhos
    mainWindow.once('ready-to-show', () => {
        mainWindow.center();
        mainWindow.show();
        mainWindow.maximize();
        mainWindow.focus();

        // Configurações de estabilidade do Updater
        autoUpdater.disableDifferentialDownload = true;
        autoUpdater.allowDowngrade = false; // Bloqueia volta para versões antigas em produção
        autoUpdater.disableWebInstaller = true; // Silencia o warning de Web Installer

        
        // Verifica atualizações silenciosamente
        autoUpdater.checkForUpdatesAndNotify();



    });

    // COMPORTAMENTO DE MINIMIZAR: Vai para bandeja apenas quando o evento de minimização de fato ocorrer
    mainWindow.on('minimize', (event) => {
        const trayEnabled = configCache.GERAL && configCache.GERAL.HABILITAR_TRAY === '1';
        if (trayEnabled) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    // COMPORTAMENTO DE FECHAR: Se tiver tray, esconde. Se for quit real, fecha.
    mainWindow.on('close', (event) => {
        const trayEnabled = configCache.GERAL && configCache.GERAL.HABILITAR_TRAY === '1';
        
        if (!app.isQuiting && trayEnabled) {
            event.preventDefault();
            mainWindow.hide();
            log.info('Janela escondida (Tray ativo)');
            return false;
        }
        
        log.info('Janela fechando definitivamente');
        if (tray) tray.destroy();
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
            {
                label: 'Abrir Painel', click: () => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.show();
                        mainWindow.setAlwaysOnTop(true);
                        mainWindow.setAlwaysOnTop(false);
                        mainWindow.focus();
                    }
                }
            },
            { type: 'separator' },
            {
                label: 'Sair ExeBoard', click: () => {
                    app.isQuiting = true;
                    app.quit();
                }
            }
        ]);

        tray.setToolTip('ExeBoard - Gerenciador');
        tray.setContextMenu(contextMenu);

        tray.on('double-click', () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.show();
                mainWindow.setAlwaysOnTop(true);
                mainWindow.setAlwaysOnTop(false);
                mainWindow.focus();
            }
        });

        tray.on('click', () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.show();
            }
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

// ==== AUTO UPDATER ====
autoUpdater.on('update-downloaded', (info) => {
    log.info('Atualização baixada:', info.version);
    if (mainWindow) {
        mainWindow.webContents.send('update-downloaded', {
            currentVersion: app.getVersion(),
            newVersion: info.version
        });
    }
});

autoUpdater.on('error', (err) => {
    log.error('Erro no Auto-Updater:', err);
});

autoUpdater.on('checking-for-update', () => {
    log.info('Verificando atualizações...');
});

autoUpdater.on('update-available', (info) => {
    log.info('Atualização disponível:', info.version);
});

autoUpdater.on('update-not-available', (info) => {
    log.info('Nenhuma atualização disponível.');
});


ipcMain.handle('restart-app', () => {
    log.info('Solicitação de Reinício para Instalação (restart-app)');
    
    // Garante o encerramento completo para o NSIS poder sobrescrever os arquivos
    app.isQuiting = true; 
    
    if (tray) {
        log.info('Destruindo Tray antes do Update...');
        tray.destroy();
        tray = null;
    }

    // Fecha todas as janelas antes de instalar
    const windows = BrowserWindow.getAllWindows();
    log.info(`Fechando ${windows.length} janelas...`);
    windows.forEach(win => {
        if (!win.isDestroyed()) win.close();
    });

    // Pequeno delay para garantir que o SO liberou locks de arquivos
    log.info('Invocando quitAndInstall...');
    setTimeout(() => {
        autoUpdater.quitAndInstall(false, true);
    }, 1000);
});


// ==== MONITORAMENTO DE SAÍDA ====
app.on('before-quit', (event) => {
    log.info(`SINAL: App recebeu pedido de fechamento (before-quit). Flag isQuiting: ${app.isQuiting}`);
});

app.on('will-quit', () => {
    log.info('SINAL: App está prestes a encerrar (will-quit).');
});

app.on('window-all-closed', () => {
    log.info('EVENTO: Todas as janelas foram fechadas.');
    // Mantém vivo na bandeja apenas se o tray estiver ativo
    const trayEnabled = configCache.GERAL && configCache.GERAL.HABILITAR_TRAY === '1';
    if (!trayEnabled) {
        log.info('Encerrando app pois Tray está desativado.');
        app.quit();
    }
});


// Helper de envio de mensagens
function sendLog(msg, color = 'gray', target = 'copiar') {
    if (mainWindow) mainWindow.webContents.send('log-message', { msg, color, target });
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
                } catch (e) { }
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
ipcMain.handle('get-app-version', () => app.getVersion());

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

// Verifica se o processo tem privilégios administrativos (Técnica Silenciosa e Assíncrona)
ipcMain.handle('check-admin', async () => {
    return new Promise((resolve) => {
        exec('fltmc', (error) => {
            resolve(!error);
        });
    });
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
        const sendUiLog = (text, c = '#a6adc8') => { sendLog(text, c, 'servidores'); };
        const procName = srv.Nome.endsWith('.exe') ? srv.Nome : srv.Nome + '.exe';
        const pureName = srv.Nome;

        if (action === 'start') {
            if (srv.Tipo === 'Servico') {
                exec(`sc start "${pureName}"`, async (error, stdout, stderr) => {
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
                exec(`sc stop "${pureName}"`, async (error, stdout, stderr) => {
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
            if (fs.existsSync(dest)) await fs.chmod(dest, 0o666).catch(() => { });

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
                } catch (errItem) { }
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
                    await fs.unlink(task.destino + '.tmp').catch(() => { });
                    break;
                }

                news++; // Contabiliza cada arquivo processado com sucesso
                if (isNew) {
                    sendLog(`NOVO ARQUIVO (Instalação Limpa): ${path.basename(task.destino)}`, '#d65d0e', 'copiar');
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
    const learnedPaths = []; // [{type, name, subFolder}]
    if (!reqs || reqs.length === 0) return { queue, learnedPaths };

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

        // 2. Busca Híbrida Seletiva (Scan apenas se houver itens sem subpasta definida)
        const itemsToDiscover = reqs.filter(r => r.type !== 'bd' && (!r.itemData.SubDiretorios || r.itemData.SubDiretorios === '' || r.itemData.SubDiretorios === '\\'));
        const rootsToScan = [...new Set(itemsToDiscover.map(r => r.destDir))];
        const destMappingResults = new Map();
        
        for (const root of rootsToScan) {
            sendLog(`MODO DETETIVE: Localizando subpastas em ${path.basename(root)}...`, '#cba6f7', 'copiar');
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

                // FIDELIDADE DE NOME: Usa o nome EXATO do INI/Interface para o destino
                const finalFileName = req.itemData.Nome.toLowerCase().endsWith('.exe') ? req.itemData.Nome : req.itemData.Nome + '.exe';

                // Lógica de Resolução de Caminho
                let sub = (req.itemData.SubDiretorios || '').replace(/\\+$/, '');
                let finalDest;

                // Se a subpasta estiver vazia, tenta o Auto-Discovery (Scan Seletivo)
                if (!sub || sub === '' || sub === '\\') {
                    const destMapObj = destMappingResults.get(req.destDir);
                    const existingInDest = destMapObj ? destMapObj.fileMap.get(exeName) : null;

                    if (existingInDest) {
                        // Calcula a subpasta relativa real encontrada no HD
                        const rootNorm = req.destDir.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
                        const foundPathNorm = path.dirname(existingInDest.fullPath).toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
                        
                        let realSub = '';
                        if (foundPathNorm.startsWith(rootNorm)) {
                            realSub = foundPathNorm.substring(rootNorm.length);
                            if (realSub !== '' && !realSub.startsWith('\\')) realSub = '\\' + realSub;
                        }

                        sub = realSub;
                        sendLog(`-> DESCOBERTO: ${finalFileName} está em ${sub || 'Raiz'}`, '#cba6f7', 'copiar');
                        learnedPaths.push({
                            type: req.type,
                            name: req.itemData.Nome,
                            subFolder: sub
                        });
                    }
                }

                finalDest = path.join(req.destDir, sub, finalFileName);

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

    return { queue, learnedPaths };
});

// Corrigindo interrupção de cópia
ipcMain.on('cancel-copy', () => {
    copyCancelToken = true;
    sendLog('Solicitação de cancelamento recebida pelo Motor.', '#f38ba8', 'copiar');
});

ipcMain.handle('open-folder-dialog', async (event, defaultPath) => {
    const opts = { properties: ['openDirectory'] };
    if (defaultPath) {
        try {
            const cleanPath = defaultPath.replace(/Informe.*/, '').trim();
            if (cleanPath && await fs.pathExists(cleanPath)) opts.defaultPath = cleanPath;
        } catch (e) { }
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
                    } catch (e) { }
                }
                if (folders.length > 15) break; // Limit suggestions
            }
            return folders;
        }
    } catch (err) { }
    return [];
});

ipcMain.handle('open-multi-files', async (event, defaultPath) => {
    const opts = { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Executables', extensions: ['exe'] }] };
    if (defaultPath) {
        try {
            const cleanPath = defaultPath.replace(/Informe.*/, '').trim();
            if (cleanPath && await fs.pathExists(cleanPath)) opts.defaultPath = cleanPath;
        } catch (e) { }
    }
    const res = await dialog.showOpenDialog(mainWindow, opts);
    return res.filePaths;
});

ipcMain.handle('execute-external', async (event, exePath) => {
    exec(`start "" "${exePath}"`, (err) => {
        if (err) sendLog(`Erro ao executar ${exePath}: ${err.message}`, '#f38ba8', 'copiar');
        else sendLog(`Programa ${exePath} iniciado na nuvem de Processos.`, '#a6adc8', 'copiar');
    });
});

ipcMain.handle('open-external-url', async (event, url) => {
    shell.openExternal(url);
});

// ==== ITEM 2: Fechar processos clientes antes da cópia ====
ipcMain.handle('kill-process', async (event, processName) => {
    return new Promise((resolve) => {
        const name = processName.endsWith('.exe') ? processName : processName + '.exe';
        exec(`taskkill /F /IM "${name}"`, (err, stdout, stderr) => {
            if (err) {
                resolve({ killed: false, msg: (stderr || err.message).trim() });
            } else {
                resolve({ killed: true, msg: (stdout || '').trim() });
            }
        });
    });
});

// ==== ITEM 3: Validação inteligente da Branch ====
ipcMain.handle('validate-branch', async (event, { branchPath, fileNames }) => {
    try {
        const exists = await fs.pathExists(branchPath);
        if (!exists) {
            return { valid: false, scenario: 'not_found' };
        }

        if (!fileNames || fileNames.length === 0) {
            return { valid: true };
        }

        const { fileMap } = await indexarDiretorio(branchPath);

        const missing = [];
        for (const name of fileNames) {
            let searchName = name.toLowerCase();
            if (!searchName.endsWith('.exe')) searchName += '.exe';
            if (!fileMap.has(searchName)) {
                missing.push(name);
            }
        }

        if (missing.length > 0) {
            return { valid: false, scenario: 'missing_files', missing };
        }

        return { valid: true };
    } catch (err) {
        return { valid: false, scenario: 'error', msg: err.message };
    }
});

// Impede que o app feche se houver um erro inesperado
process.on('uncaughtException', (err) => {
    const errorMsg = `FATAL: Uncaught Exception: ${err.message}\nStack: ${err.stack}`;
    log.error(errorMsg);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
        sendLog(`Erro Crítico: Verifique os logs em AppData.`, '#f38ba8', 'copiar');
    }
});

process.on('unhandledRejection', (reason, promise) => {
    const errorMsg = `FATAL: Unhandled Rejection at: ${promise}, reason: ${reason}`;
    log.error(errorMsg);
});
