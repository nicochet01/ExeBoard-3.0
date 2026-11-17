const { app, BrowserWindow, ipcMain, Tray, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { createReadStream, createWriteStream } = require('fs');
const ini = require('ini');
const { execFile } = require('child_process'); // sempre execFile (sem shell): ver nomeSeguro()
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

// Em desenvolvimento, isola o userData para evitar colisão de lock com o ExeBoard instalado
if (!app.isPackaged) {
    const devUserData = path.join(app.getPath('appData'), 'ExeBoard-Dev');
    fs.ensureDirSync(devUserData);
    const prodConfig = path.join(app.getPath('appData'), 'ExeBoard', 'configuracoes.json');
    const devConfig = path.join(devUserData, 'configuracoes.json');
    if (!fs.existsSync(devConfig) && fs.existsSync(prodConfig)) {
        try {
            fs.copyFileSync(prodConfig, devConfig);
        } catch (e) { }
    }
    app.setPath('userData', devUserData);
}

// Caminho unificado: AppData (userData) é a única fonte de verdade
const userDataPath = app.getPath('userData');
const activeJsonPath = path.join(userDataPath, 'configuracoes.json');
const legacyIniPath = path.join(userDataPath, 'Inicializar.ini');
let copyCancelToken = false;
let copyInProgress = false; // true enquanto execute-copy-files roda (usado pra confirmar o fechamento da janela)
const EXE_AGE_WARN_DAYS = 10; // executáveis da Branch mais velhos que isso geram aviso na tela
let configCache = { GERAL: { HABILITAR_TRAY: '0' } }; // Cache local para regras de negócio

const COPY_BUFFER_SIZE = 1048576; // 1MB
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

// Garante o sufixo .exe de forma case-insensitive (evita duplicar em nomes como "Servico.EXE")
const ensureExeSuffix = (name) => (name && !name.toLowerCase().endsWith('.exe')) ? name + '.exe' : name;

// Nomes de serviço/processo vêm da configuração e viram argumento de sc/taskkill. Todos os comandos usam
// execFile (sem shell), então não há injeção; esta guarda barra o que ainda poderia ter efeito indevido:
// curingas do taskkill (/IM *), caminhos (\\servidor-remoto no sc), aspas e caracteres de controle.
const nomeSeguro = (nome) => typeof nome === 'string'
    && nome.length > 0 && nome.length <= 256
    && !/[\\/"*?<>|\r\n\t\0]/.test(nome);

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
            spellcheck: false, // sem corretor ortográfico: menos memória e nenhum uso pra ele aqui
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

        
        // Verifica atualizações silenciosamente. Sem internet a promessa é rejeitada: o evento 'error' já
        // registra o motivo, então aqui só evitamos o "Unhandled Rejection" no log.
        autoUpdater.checkForUpdatesAndNotify().catch((err) => {
            log.warn('Não foi possível verificar atualizações (provavelmente sem conexão):', err && err.message);
        });



    });

    // COMPORTAMENTO DE MINIMIZAR: Vai para bandeja apenas quando o evento de minimização de fato ocorrer
    mainWindow.on('minimize', (event) => {
        const trayEnabled = configCache.GERAL && configCache.GERAL.HABILITAR_TRAY === '1';
        if (trayEnabled) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    // COMPORTAMENTO DE FECHAR: o X sempre encerra o app. Ir pra bandeja é só ao MINIMIZAR
    // (com a opção ativa) — tratado no evento 'minimize' acima. Se houver cópia em andamento,
    // pede confirmação antes, pra não deixar arquivos pela metade.
    let closeConfirmOpen = false;
    mainWindow.on('close', (event) => {
        if (!app.isQuiting && copyInProgress) {
            event.preventDefault();
            if (closeConfirmOpen) return;
            closeConfirmOpen = true;
            dialog.showMessageBox(mainWindow, {
                type: 'warning',
                buttons: ['Continuar copiando', 'Sair mesmo assim'],
                defaultId: 0,
                cancelId: 0,
                title: 'Cópia em andamento',
                message: 'Há uma cópia de arquivos em andamento.',
                detail: 'Se sair agora, a cópia será interrompida e os arquivos que estavam sendo copiados podem ficar incompletos.'
            }).then(({ response }) => {
                closeConfirmOpen = false;
                if (response === 1 && mainWindow && !mainWindow.isDestroyed()) {
                    copyCancelToken = true;
                    app.isQuiting = true;
                    mainWindow.close();
                }
            });
            return;
        }

        app.isQuiting = true;
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

// Limpeza dos temporários ÓRFÃOS deixados por uma cópia interrompida (queda de energia, processo morto).
// A cópia grava em "<destino>.tmp" (ex.: AgroX.exe.tmp). Só apaga o que for claramente do ExeBoard:
//  - nome no formato "<nome>.<extensão>.tmp" (um .tmp comum de outro programa não tem a extensão original);
//  - parado há mais de 1 hora (uma cópia em andamento escreve o tempo todo, e o app só roda uma instância).
// Varre só as 3 pastas de destino configuradas, com teto de entradas para não pesar numa árvore enorme.
const TMP_ORFAO_IDADE_MS = 60 * 60 * 1000;
const TMP_LIMITE_ENTRADAS = 50000;
const ehTmpDoExeBoard = (nome) => /\.[A-Za-z0-9]{1,8}\.tmp$/i.test(nome);

async function limparArquivosTemporarios() {
    try {
        const c = configCache && configCache.CAMINHOS;
        if (!c) return;
        const raizes = [c.PASTA_CLIENT, c.PASTA_SERVER, c.PASTA_DADOS]
            .filter((p) => p && typeof p === 'string' && !p.includes('Informe'));
        const vistas = new Set();
        let visitadas = 0;
        let removidos = 0;
        for (const raiz of raizes) {
            const chave = path.normalize(raiz).toLowerCase();
            if (vistas.has(chave) || !(await fs.pathExists(raiz))) continue;
            vistas.add(chave);

            const pilha = [raiz];
            while (pilha.length > 0 && visitadas < TMP_LIMITE_ENTRADAS) {
                const dir = pilha.pop();
                const entradas = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
                for (const e of entradas) {
                    visitadas++;
                    const full = path.join(dir, e.name);
                    if (e.isDirectory()) { pilha.push(full); continue; }
                    if (!e.isFile() || !ehTmpDoExeBoard(e.name)) continue;
                    const st = await fs.stat(full).catch(() => null);
                    if (!st || Date.now() - st.mtimeMs < TMP_ORFAO_IDADE_MS) continue;
                    await fs.unlink(full).then(() => {
                        removidos++;
                        log.info(`Arquivo temporário órfão removido: ${full}`);
                    }).catch(() => {});
                }
            }
        }
        if (removidos > 0) sendLog(`Limpeza: ${removidos} arquivo(s) temporário(s) órfão(s) de cópias interrompidas removido(s).`, '#cba6f7', 'copiar');
    } catch (e) {
        log.warn('Aviso ao limpar arquivos temporários:', e.message);
    }
}

app.whenReady().then(async () => {
    await loadConfig(); // Carrega configs antes de criar a UI
    console.log('Config JSON Carregada. Tray Ativo:', configCache.GERAL?.HABILITAR_TRAY);
    createWindow();
    createTray();
    limparArquivosTemporarios(); // sem await: varrer as pastas de destino não deve atrasar a abertura da janela

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
    // Fechar pelo X (isQuiting) ou ter o tray desativado encerra o app de verdade
    const trayEnabled = configCache.GERAL && configCache.GERAL.HABILITAR_TRAY === '1';
    if (!trayEnabled || app.isQuiting) {
        log.info('Encerrando app.');
        app.quit();
    }
});


// Helper de envio de mensagens
function sendLog(msg, color = 'gray', target = 'copiar') {
    if (mainWindow) mainWindow.webContents.send('log-message', { msg, color, target });
}

// ==== Token do Bitbucket protegido pelo Windows (DPAPI, escopo do usuário atual) ====
// Em disco o token vai cifrado em BITBUCKET.PASSWORD_ENC ("dpapi:" + base64); em memória e na tela continua
// em BITBUCKET.PASSWORD. Só o mesmo usuário do Windows consegue decifrar (copiar o arquivo não vaza o token).
// Formato aberto: qualquer linguagem lê com CryptUnprotectData (escopo CurrentUser, sem entropia extra).
const PREFIXO_DPAPI = 'dpapi:';
const cacheDpapi = { cifrado: new Map(), aberto: new Map() }; // evita abrir um PowerShell a cada leitura/gravação

const dpapi = (modo, texto) => new Promise((resolve) => {
    const script = modo === 'proteger'
        ? "Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes($env:EXEBOARD_SEG); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))"
        : "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:EXEBOARD_SEG); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
        { env: { ...process.env, EXEBOARD_SEG: texto }, timeout: 20000, windowsHide: true },
        (err, stdout) => resolve(err ? null : ((stdout || '').trim() || null)));
});

// Cópia da config pronta para o disco (token cifrado). Se não conseguir cifrar, mantém o token legível
// em vez de perdê-lo — e avisa no log.
async function tokenParaDisco(cfg) {
    const bb = cfg && cfg.BITBUCKET;
    if (!bb || typeof bb !== 'object') return cfg;
    const copia = { ...cfg, BITBUCKET: { ...bb } };
    const senha = typeof bb.PASSWORD === 'string' ? bb.PASSWORD : '';
    delete copia.BITBUCKET.PASSWORD_ENC;
    if (senha === '') { delete copia.BITBUCKET.PASSWORD; return copia; }
    let cifrado = cacheDpapi.cifrado.get(senha);
    if (!cifrado) {
        cifrado = await dpapi('proteger', senha);
        if (cifrado) { cacheDpapi.cifrado.set(senha, cifrado); cacheDpapi.aberto.set(cifrado, senha); }
    }
    if (!cifrado) {
        log.warn('Não foi possível proteger o token do Bitbucket com o Windows; mantido sem cifra neste salvamento.');
        return copia; // PASSWORD continua em texto
    }
    delete copia.BITBUCKET.PASSWORD;
    copia.BITBUCKET.PASSWORD_ENC = PREFIXO_DPAPI + cifrado;
    return copia;
}

// Decifra em memória (cfg é alterado). Retorna true se o arquivo tinha o token legível (legado) e precisa ser regravado cifrado.
async function tokenDoDisco(cfg) {
    const bb = cfg && cfg.BITBUCKET;
    if (!bb || typeof bb !== 'object') return false;
    if (typeof bb.PASSWORD_ENC === 'string' && bb.PASSWORD_ENC.startsWith(PREFIXO_DPAPI)) {
        const cifrado = bb.PASSWORD_ENC.slice(PREFIXO_DPAPI.length);
        let aberto = cacheDpapi.aberto.get(cifrado);
        if (aberto === undefined) {
            aberto = await dpapi('abrir', cifrado);
            if (aberto) { cacheDpapi.aberto.set(cifrado, aberto); cacheDpapi.cifrado.set(aberto, cifrado); }
        }
        delete bb.PASSWORD_ENC;
        if (aberto) bb.PASSWORD = aberto;
        else {
            bb.PASSWORD = '';
            log.warn('Token do Bitbucket não pôde ser aberto (salvo por outro usuário do Windows?). Informe-o novamente.');
        }
        return false;
    }
    return typeof bb.PASSWORD === 'string' && bb.PASSWORD !== '';
}

// Gravações em fila: duas gravações quase simultâneas (ex.: sair de dois campos do Bitbucket) nunca se cruzam,
// e a última sempre grava o estado mais recente de configCache.
let filaGravacao = Promise.resolve();
const gravarConfig = () => {
    filaGravacao = filaGravacao.catch(() => { }).then(async () => {
        await fs.ensureDir(userDataPath);
        const paraDisco = await tokenParaDisco(configCache);
        await fs.writeFile(activeJsonPath, JSON.stringify(paraDisco, null, 2), 'utf-8');
    });
    return filaGravacao;
};

async function loadConfig() {
    try {
        await fs.ensureDir(userDataPath);

        // === REGRA 1: Se o JSON já existe, usa ele (fonte de verdade) ===
        if (fs.existsSync(activeJsonPath)) {
            const content = await fs.readFile(activeJsonPath, 'utf-8');
            configCache = JSON.parse(content);
            const tokenLegivel = await tokenDoDisco(configCache);
            if (tokenLegivel) {
                // arquivo antigo com o token em texto puro: regrava já cifrado
                await gravarConfig().catch((e) => log.warn('Não foi possível cifrar o token existente:', e.message));
                log.info('Token do Bitbucket migrado para armazenamento protegido.');
            }
            log.info('Config carregada do configuracoes.json.');
            return;
        }

        // === REGRA 2: Migração automática do INI legado ===
        // Procura no AppData e na raiz do projeto (bundled)
        let iniToMigrate = null;
        if (fs.existsSync(legacyIniPath)) {
            iniToMigrate = legacyIniPath;
        } else {
            const bundledIniPath = path.join(__dirname, 'Inicializar.ini');
            if (fs.existsSync(bundledIniPath)) iniToMigrate = bundledIniPath;
        }

        if (iniToMigrate) {
            log.info(`Migrando INI legado para JSON: ${iniToMigrate}`);
            const iniContent = await fs.readFile(iniToMigrate, 'utf-8');
            configCache = ini.parse(iniContent);

            // Salva no novo formato JSON
            await gravarConfig();
            log.info('Migração concluída: configuracoes.json criado com sucesso.');

            // Apaga o INI antigo do AppData (se existir lá)
            if (fs.existsSync(legacyIniPath)) {
                await fs.unlink(legacyIniPath);
                log.info('INI legado removido do AppData após migração.');
            }
            return;
        }

        // === REGRA 3: Nenhum arquivo encontrado — cria JSON zerado ===
        log.warn('Nenhuma configuração encontrada. Criando configuracoes.json padrão.');
        configCache = { GERAL: { HABILITAR_TRAY: '0' } };
        await gravarConfig();

    } catch (err) {
        log.error('Erro ao carregar configurações:', err);
        configCache = { GERAL: { HABILITAR_TRAY: '0' } };
    }
}

// ==== IPC CONFIG (JSON Nativo) ====
ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('read-config', async () => {
    await loadConfig();
    return { success: true, data: configCache };
});

ipcMain.handle('save-config', async (event, dataToSave) => {
    try {
        configCache = dataToSave; // Atualiza o cache do backend (o token segue legível só em memória)
        await gravarConfig();
        return { success: true };
    } catch (err) {
        return { error: err.message };
    }
});

// Salva apenas uma seção da config sem sobrescrever o resto
ipcMain.handle('save-config-section', async (event, sectionName, sectionData) => {
    try {
        configCache[sectionName] = sectionData;
        await gravarConfig();
        return { success: true };
    } catch (err) {
        return { error: err.message };
    }
});

// (a listagem de branches do Bitbucket fica na seção "BITBUCKET", mais abaixo)

// Verifica se o processo tem privilégios administrativos (Técnica Silenciosa e Assíncrona)
ipcMain.handle('check-admin', async () => {
    return new Promise((resolve) => {
        execFile('fltmc', [], { windowsHide: true }, (error) => {
            resolve(!error);
        });
    });
});


// ==== IPC Servidores e Processos ====

// Verifica o status de um item (Polling)
ipcMain.handle('check-status', async (event, srv) => {
    return new Promise((resolve) => {
        if (!srv || !nomeSeguro(srv.Nome)) return resolve('not_found');
        if (srv.Tipo === 'Servico') {
            // execFile (sem shell): não abre um cmd.exe a cada consulta de status
            execFile('sc', ['query', srv.Nome], (err, stdout) => {
                stdout = stdout || '';
                if (stdout.includes('RUNNING')) resolve('running');
                else if (stdout.includes('STOPPED')) resolve('stopped');
                else if (stdout.includes('PENDING')) resolve('transition');
                else resolve('not_found'); // 1060 não especificado
            });
        } else {
            // Processo App (.exe)
            const procName = ensureExeSuffix(srv.Nome);
            execFile('tasklist', ['/FI', `IMAGENAME eq ${procName}`, '/NH'], (err, stdout) => {
                if ((stdout || '').includes(procName)) resolve('running');
                else resolve('stopped'); // não detecta transição em .exe normal por tasklist simple
            });
        }
    });
});

// IA Leve de auto-serviço
ipcMain.handle('detectar-tipo', async (event, nome) => {
    return new Promise(resolve => {
        if (!nomeSeguro(nome)) return resolve('Aplicacao');
        execFile('sc', ['query', nome], { windowsHide: true }, (err) => {
            if (err && err.code !== 0) resolve('Aplicacao');
            else resolve('Servico');
        });
    });
});

// Helper para aguardar status de serviço (polling mais rápido: 400ms em vez de 1s,
// pra não somar latência desnecessária no start/stop/restart de cada serviço)
const waitForServiceStatus = (name, targetStatus, timeoutMs = 20000) => {
    return new Promise(resolve => {
        const start = Date.now();
        const check = () => {
            execFile('sc', ['query', name], (err, stdout) => {
                if ((stdout || '').includes(targetStatus)) return resolve(true);
                if (Date.now() - start > timeoutMs) return resolve(false);
                setTimeout(check, 400);
            });
        };
        check();
    });
};

// Verifica se um processo (pelo nome do .exe) ainda está de pé — via tasklist, não via status do SCM
// (o SCM pode reportar "STOPPED" antes do processo liberar de fato o handle do arquivo)
const isProcessRunning = (exeName) => new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH'], (err, stdout) => {
        resolve(!!stdout && stdout.toLowerCase().includes(exeName.toLowerCase()));
    });
});

// Detecta "acesso negado" ao controlar serviços/processos (sc/taskkill exigem privilégio de Administrador)
const isAccessDeniedError = (error, stdout, stderr) => {
    const text = `${stdout || ''} ${stderr || ''} ${error ? error.message : ''}`.toLowerCase();
    return (error && error.code === 5) || text.includes('acesso negado') || text.includes('access is denied') || text.includes('access denied');
};

// Controle explícito
ipcMain.handle('manage-server', async (event, { srv, action }) => {
    return new Promise((resolve) => {
        const sendUiLog = (text, c = '#a6adc8') => { sendLog(text, c, 'servidores'); };
        if (!srv || !nomeSeguro(srv.Nome)) {
            sendUiLog(`ERRO: nome de serviço/aplicação inválido (${srv && srv.Nome}).`, '#f38ba8');
            return resolve(false);
        }
        const procName = ensureExeSuffix(srv.Nome);
        const pureName = srv.Nome;

        if (action === 'start') {
            if (srv.Tipo === 'Servico') {
                execFile('sc', ['start', pureName], { windowsHide: true }, async (error, stdout, stderr) => {
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
                execFile('sc', ['stop', pureName], { windowsHide: true }, async (error, stdout, stderr) => {
                    let out = (stdout || stderr || '').trim();

                    if (isAccessDeniedError(error, stdout, stderr)) {
                        const msg = `Acesso negado ao parar "${pureName}". Feche o ExeBoard e abra-o novamente como Administrador (clique com o botão direito > Executar como administrador) antes de copiar.`;
                        sendUiLog(msg, '#f38ba8');
                        sendLog(`ERRO: ${msg}`, '#f38ba8', 'copiar');
                        resolve(false);
                        return;
                    }

                    if (error && !out.includes("1062")) {
                        sendUiLog(`Aviso STOP ${pureName}: ${out || error.message}`, '#fab387');
                    }
                    // Aguarda o stop "oficial" do SCM
                    await waitForServiceStatus(pureName, 'STOPPED', 10000);

                    // Confirma via tasklist que o processo realmente não está mais de pé (o SCM pode
                    // reportar STOPPED antes do handle do arquivo ser liberado) e, caso o serviço tenha
                    // uma ação de recuperação configurada para reiniciar sozinho, mata de novo — repete
                    // por alguns segundos até o processo ficar de fato parado.
                    let deniedOnKill = false;
                    for (let i = 0; i < 8; i++) {
                        const running = await isProcessRunning(procName);
                        if (!running) break;
                        const killResult = await new Promise((res) => execFile('taskkill', ['/F', '/IM', procName], { windowsHide: true }, (e, so, se) => res({ e, so, se })));
                        if (isAccessDeniedError(killResult.e, killResult.so, killResult.se)) {
                            deniedOnKill = true;
                            break;
                        }
                        await new Promise(r => setTimeout(r, 500));
                    }

                    if (deniedOnKill) {
                        const msg = `Acesso negado ao encerrar "${procName}". Execute o ExeBoard como Administrador antes de copiar.`;
                        sendUiLog(msg, '#f38ba8');
                        sendLog(`ERRO: ${msg}`, '#f38ba8', 'copiar');
                        resolve(false);
                        return;
                    }

                    if (action === 'stop') sendUiLog(`${pureName} parado.`, '#f38ba8');
                    resolve(true);
                });
            } else {
                execFile('taskkill', ['/F', '/IM', procName], { windowsHide: true }, (error, stdout, stderr) => {
                    if (isAccessDeniedError(error, stdout, stderr)) {
                        const msg = `Acesso negado ao encerrar "${procName}". Execute o ExeBoard como Administrador antes de copiar.`;
                        sendUiLog(msg, '#f38ba8');
                        sendLog(`ERRO: ${msg}`, '#f38ba8', 'copiar');
                        resolve(false);
                        return;
                    }
                    sendUiLog(`KILL enviado para ${procName}`, '#f38ba8');
                    resolve(true);
                });
            }
        }
    });
});

// ==== NOVO MOTOR DE CÓPIA SEGURO (Transacional com Native Copy) ====

// Acima deste tamanho, usa cópia em stream (mais lenta) em vez de fs.copyFile nativo, pois
// fs.copyFile não pode ser interrompido no meio — um clique em "Cancelar" só faria efeito
// depois que o arquivo inteiro terminasse de copiar.
const LARGE_FILE_STREAM_THRESHOLD = 200 * 1024 * 1024; // 200MB

// Cópia em stream que respeita copyCancelToken durante a transferência (chunk a chunk)
const streamCopyWithCancel = (src, tempDest) => new Promise((resolve, reject) => {
    const readStream = createReadStream(src, { highWaterMark: COPY_BUFFER_SIZE });
    const writeStream = createWriteStream(tempDest);
    let cancelled = false;
    let settled = false;

    const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
    };

    readStream.on('data', () => {
        if (!cancelled && copyCancelToken) {
            cancelled = true;
            readStream.destroy();
            writeStream.destroy();
        }
    });

    readStream.on('error', finish);
    writeStream.on('error', finish);
    writeStream.on('finish', () => finish(cancelled ? new Error('CANCELLED') : null));

    readStream.pipe(writeStream);
});

const secureCopyFile = async (src, dest) => {
    let attempts = 0;
    while (attempts < MAX_RETRIES) {
        if (copyCancelToken) return 'cancelled';

        const tempDest = dest + '.tmp';
        try {
            // Remove ReadOnly se existir no destino
            if (await fs.pathExists(dest)) {
                await fs.chmod(dest, 0o666).catch(() => { });
            }

            const stats = await fs.stat(src).catch(() => null);
            if (stats && stats.size > LARGE_FILE_STREAM_THRESHOLD) {
                // Arquivo grande: cópia em stream, cancelável durante a transferência
                await streamCopyWithCancel(src, tempDest);
            } else {
                // Cópia nativa direta no nível de kernel do SO (mais rápida para o caso comum)
                await fs.copyFile(src, tempDest);
            }

            if (copyCancelToken) {
                await fs.unlink(tempDest).catch(() => { });
                return 'cancelled';
            }

            // Swap Atômico: move do temporário para o destino final
            await fs.move(tempDest, dest, { overwrite: true });
            return 'ok';

        } catch (err) {
            await fs.unlink(tempDest).catch(() => { });
            if (copyCancelToken || err.message === 'CANCELLED') return 'cancelled';

            attempts++;
            const isLockError = err.code === 'EPERM' || err.code === 'EBUSY';

            if (attempts < MAX_RETRIES) {
                sendLog(`Tentativa ${attempts} falhou p/ ${path.basename(dest)}. Falha física ou arquivo preso. Retentando...`, '#fab387', 'copiar');

                // EPERM/EBUSY no destino normalmente significa que o processo ainda está de pé
                // (não terminou a tempo do "Parar Serviço/App" inicial, ou é reiniciado por um watchdog).
                // Antes de tentar de novo, força o encerramento pelo nome do executável de destino.
                if (isLockError) {
                    const destExeName = path.basename(dest);
                    if (destExeName.toLowerCase().endsWith('.exe') && nomeSeguro(destExeName)) {
                        await new Promise((resolve) => execFile('taskkill', ['/F', '/IM', destExeName], { windowsHide: true }, () => resolve()));
                    }
                }

                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            } else {
                // Esgotou as tentativas: se for erro de lock/permissão e nenhum processo com esse nome
                // estiver rodando, é provável falta de privilégio de Administrador — deixa isso claro,
                // mas sem pular retries antes (podia ser um lock transitório de outro processo/serviço,
                // ex: um motor de banco de dados segurando um .fdb com um nome de processo diferente).
                if (isLockError && !(await isProcessRunning(path.basename(dest)))) {
                    const msg = `Falha persistente ao gravar em "${dest}" mesmo sem nenhum processo travando o arquivo pelo nome. Se o problema persistir, feche o ExeBoard e abra-o novamente como Administrador.`;
                    sendLog(`ERRO: ${msg}`, '#f38ba8', 'copiar');
                }
                throw err;
            }
        }
    }
};

// Pastas ignoradas para varredura ultrarrápida (metadados e controle de versão)
const IGNORED_SCAN_DIRS = new Set(['.git', '.svn', '.vs', '.idea', '.vscode', 'node_modules', '__pycache__']);

// Indexador Otimizado Stack-based (Arquivos e Pastas com Stat Paralelo)
const indexarDiretorio = async (startDir) => {
    const fileMap = new Map(); // Key: fileName.toLowerCase(), Value: { fullPath, mtime, size }
    const dirMap = new Map();  // Key: dirName/relPath, Value: { fullPath }
    const ambiguousDirNames = new Set(); // Nomes de pasta (sem prefixo) que existem em mais de um lugar da árvore
    const stack = [startDir];

    while (stack.length > 0) {
        const currentDir = stack.pop();
        let entries;
        try {
            entries = await fs.readdir(currentDir, { withFileTypes: true });
        } catch (e) {
            sendLog(`Aviso: Pasta ignorada (Acesso Negado): ${currentDir}`, '#fe640b', 'copiar');
            continue;
        }

        const fileEntries = [];

        for (const entry of entries) {
            try {
                const name = entry.name.toLowerCase();
                const fullPath = path.join(currentDir, entry.name);

                if (entry.isDirectory()) {
                    if (IGNORED_SCAN_DIRS.has(name)) continue;
                    stack.push(fullPath);

                    const relPath = path.relative(startDir, fullPath).toLowerCase().replace(/\//g, '\\');
                    if (!dirMap.has(name)) {
                        dirMap.set(name, { fullPath });
                    } else if (dirMap.get(name).fullPath !== fullPath) {
                        ambiguousDirNames.add(name);
                    }
                    if (!dirMap.has(relPath)) dirMap.set(relPath, { fullPath });
                } else {
                    fileEntries.push({ name, fullPath });
                }
            } catch (e) {
                sendLog(`Aviso: Item ignorado dentro de ${currentDir}: ${entry.name}`, '#fe640b', 'copiar');
            }
        }

        // Processa stats dos arquivos em lotes paralelos de 25
        const BATCH_SIZE = 25;
        for (let i = 0; i < fileEntries.length; i += BATCH_SIZE) {
            const batch = fileEntries.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (file) => {
                try {
                    const stats = await fs.stat(file.fullPath);
                    const mtime = stats.mtimeMs;
                    const existing = fileMap.get(file.name);
                    if (!existing || mtime > existing.mtime) {
                        fileMap.set(file.name, { fullPath: file.fullPath, mtime, size: stats.size });
                    }
                } catch (e) { }
            }));
        }
    }
    return { fileMap, dirMap, ambiguousDirNames };
};

// Uma pasta com MUITAS subpastas no primeiro nível (ex.: a ERP, com ~1000 branches) não é uma branch:
// varrê-la leria todas as branches e o "exe mais novo" de cada nome viria de uma branch qualquer.
const MAX_SUBPASTAS_BRANCH = 100;
const ehRaizDeBranches = async (dir) => {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.filter(e => e.isDirectory()).length > MAX_SUBPASTAS_BRANCH;
    } catch (e) {
        return false;
    }
};

// Cache de indexação para unificar varredura (validate-branch + build-queue usam mesmo scan).
// TTL curto: o objetivo é só evitar escanear a árvore duas vezes dentro do mesmo clique em
// "Copiar Dados" (validate-branch seguido de build-queue) — não sobreviver a retentativas do
// usuário depois de alterar/rebuildar a Branch.
const BRANCH_CACHE_TTL_MS = 8000;
let branchScanCache = { path: '', timestamp: 0, data: null };
let branchScanPending = null;      // varredura em andamento (reaproveitada por quem pedir a mesma pasta)
let branchScanPendingPath = '';

const getCachedBranchIndex = async (dirPath) => {
    const normalized = path.normalize(dirPath).toLowerCase();
    if (branchScanCache.data &&
        branchScanCache.path === normalized &&
        (Date.now() - branchScanCache.timestamp < BRANCH_CACHE_TTL_MS)) {
        return branchScanCache.data;
    }
    // Conferência de idade e de versão pedem o índice ao mesmo tempo: uma varredura só do Drive
    if (branchScanPending && branchScanPendingPath === normalized) return branchScanPending;

    const varredura = indexarDiretorio(dirPath)
        .then((result) => {
            branchScanCache = { path: normalized, timestamp: Date.now(), data: result };
            return result;
        })
        .finally(() => {
            if (branchScanPending === varredura) { branchScanPending = null; branchScanPendingPath = ''; }
        });
    branchScanPending = varredura;
    branchScanPendingPath = normalized;
    return varredura;
};

// ==== MOTOR RECURSIVO PARA AS PASTAS DOS .CDS (BD) ====
const copyFolderRecursive = async (src, dest) => {
    if (copyCancelToken) return 'cancelled';

    try {
        const stats = await fs.stat(src);
        if (!stats.isDirectory()) return 'error_not_dir';

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
                await secureCopyFile(sPath, dPath);
            }
        }
        return 'ok';
    } catch (err) {
        throw err;
    }
};

// Motor de Cópia Concorrente com 4 Trabalhadores Simultâneos e Barra de Progresso
ipcMain.handle('execute-copy-files', async (event, queueData) => {
    copyCancelToken = false;
    let errors = 0;
    let news = 0;
    let skipped = 0;
    let completedCount = 0;
    const total = queueData.length;

    const emitProgress = (fileName) => {
        const percent = total > 0 ? Math.round((completedCount / total) * 100) : 0;
        if (mainWindow) {
            mainWindow.webContents.send('copy-progress', {
                current: completedCount,
                total,
                percent,
                fileName: fileName || ''
            });
        }
    };

    emitProgress('');

    const CONCURRENCY = 4;
    let taskIndex = 0;

    const processTask = async (task) => {
        if (copyCancelToken) return;

        try {
            const srcExists = await fs.pathExists(task.origem);
            if (!srcExists) {
                sendLog(`PULANDO: Origem não encontrada [${task.origem}]`, '#bac2de', 'copiar');
                skipped++;
                return;
            }

            const isNew = !(await fs.pathExists(task.destino));

            if (task.type === 'bd') {
                // Cópia Recursiva de Pasta
                const res = await copyFolderRecursive(task.origem, task.destino);
                if (res === 'cancelled') { skipped++; return; }
                news++;
                sendLog(`PASTA ATUALIZADA: ${path.basename(task.destino)}`, '#40a02b', 'copiar');
            } else {
                // Cópia de Arquivo Único
                await fs.ensureDir(path.dirname(task.destino));
                const res = await secureCopyFile(task.origem, task.destino);
                if (res === 'cancelled') { skipped++; return; }

                news++;
                if (isNew) {
                    sendLog(`NOVO ARQUIVO (Instalação Limpa): ${path.basename(task.destino)}`, '#d65d0e', 'copiar');
                } else {
                    sendLog(`ATUALIZADO: ${task.destino}`, '#40a02b', 'copiar');
                }
            }
        } catch (err) {
            errors++;
            sendLog(`ERRO FATAL em ${task.origem}: ${err.message}`, '#f38ba8', 'copiar');
        } finally {
            completedCount++;
            emitProgress(path.basename(task.destino));
        }
    };

    copyInProgress = true; // antes de criar os workers: eles começam a copiar assim que nascem
    const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
        while (taskIndex < total) {
            if (copyCancelToken) break;
            const currentTask = queueData[taskIndex++];
            await processTask(currentTask);
        }
    });

    try {
        await Promise.all(workers);
    } finally {
        copyInProgress = false;
    }

    return { status: copyCancelToken ? 'cancelled' : 'completed', errors, news, skipped };
});

// Build-queue com Mapeamento Unificado e Resolução de Caminhos
ipcMain.handle('build-queue', async (event, { reqs, branchRoot }) => {
    const queue = [];
    const learnedPaths = []; // [{type, name, subFolder}]
    if (!reqs || reqs.length === 0) return { queue, learnedPaths };

    try {
        sendLog(`Mapeando Branch: ${branchRoot}`, '#89b4fa', 'copiar');

        // 1. Mapeia a Branch usando Cache Unificado
        const indexingResults = await getCachedBranchIndex(branchRoot);
        const sourceFileMap = indexingResults.fileMap;
        const sourceDirMap = indexingResults.dirMap;
        const ambiguousDirNames = indexingResults.ambiguousDirNames || new Set();
        const claimedDestinos = new Set(); // Evita que dois itens da fila apontem para o mesmo destino (corrida na cópia concorrente)

        if (sourceFileMap.size === 0 && sourceDirMap.size === 0) {
            sendLog('AVISO: Nenhum arquivo ou pasta encontrado na Branch.', '#f38ba8', 'copiar');
            return { queue, learnedPaths };
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
                // Lógica das Pastas dos .cds (bancos) com Fallback Inteligente
                const cleanBdName = pureName.replace(/^(bd|dados)[\\\/]/i, '').trim();
                const pureNorm = pureName.replace(/\//g, '\\');
                // 1) caminhos inequívocos: o que foi cadastrado já com caminho (bd\x, a\b) ou bd\<nome> / dados\<nome>
                let sourceFolder = (pureNorm.includes('\\') ? sourceDirMap.get(pureNorm) : null) ||
                                   sourceDirMap.get('bd\\' + cleanBdName) ||
                                   sourceDirMap.get('dados\\' + cleanBdName);

                // 2) pelo nome puro. Só é seguro quando a pasta está no primeiro nível da Branch ou quando existe UMA
                // única pasta com esse nome na árvore inteira — com duas em lugares diferentes poderíamos copiar os
                // dados da pasta errada, então avisa e pula (antes o aviso nunca era alcançado para nomes simples).
                if (!sourceFolder) {
                    const porNome = sourceDirMap.get(cleanBdName);
                    if (porNome) {
                        const noPrimeiroNivel = !path.relative(branchRoot, porNome.fullPath).includes(path.sep);
                        if (ambiguousDirNames.has(cleanBdName) && !noPrimeiroNivel) {
                            sendLog(`X Ambíguo: existem várias pastas chamadas "${cleanBdName}" na Branch. Organize-a em bd\\${cleanBdName} ou dados\\${cleanBdName} para evitar copiar a pasta errada.`, '#f38ba8', 'copiar');
                            continue;
                        }
                        sourceFolder = porNome;
                    }
                }

                if (!sourceFolder) {
                    sendLog(`X Pasta dos .cds não encontrada na Branch: ${pureName}`, '#bac2de', 'copiar');
                    continue;
                }

                const destino = path.join(req.destDir, path.basename(sourceFolder.fullPath));
                if (claimedDestinos.has(destino)) {
                    sendLog(`X Destino duplicado ignorado (já reivindicado por outro item selecionado): ${destino}`, '#f38ba8', 'copiar');
                    continue;
                }
                claimedDestinos.add(destino);

                queue.push({
                    origem: sourceFolder.fullPath,
                    destino,
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

                if (claimedDestinos.has(finalDest)) {
                    sendLog(`X Destino duplicado ignorado (já reivindicado por outro item selecionado): ${finalDest}`, '#f38ba8', 'copiar');
                    continue;
                }
                claimedDestinos.add(finalDest);

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
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Service | Select-Object Name, DisplayName, Status | ConvertTo-Json'],
            { maxBuffer: 1024 * 1024 * 5, windowsHide: true }, (err, stdout) => {
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

ipcMain.handle('open-file-get-folder', async (event, defaultPath) => {
    const opts = { properties: ['openFile'] };
    if (defaultPath) {
        try {
            const cleanPath = defaultPath.replace(/Informe.*/, '').trim();
            if (cleanPath && await fs.pathExists(cleanPath)) opts.defaultPath = cleanPath;
        } catch (e) { }
    }
    const res = await dialog.showOpenDialog(mainWindow, opts);
    if (res.filePaths && res.filePaths.length > 0) return path.dirname(res.filePaths[0]);
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

// Abre uma pasta, arquivo ou endereço web com o programa padrão do Windows. Não passa por shell (nada de
// montar "start ..." com texto vindo de fora): endereço http(s) vai ao navegador; o resto, ao shell do SO.
ipcMain.handle('execute-external', async (event, alvo) => {
    if (typeof alvo !== 'string' || !alvo.trim()) return;
    try {
        if (/^https?:\/\//i.test(alvo)) {
            await shell.openExternal(alvo);
        } else {
            const erro = await shell.openPath(alvo); // string vazia = sucesso
            if (erro) throw new Error(erro);
        }
        sendLog(`Programa ${alvo} iniciado na nuvem de Processos.`, '#a6adc8', 'copiar');
    } catch (err) {
        sendLog(`Erro ao executar ${alvo}: ${err.message}`, '#f38ba8', 'copiar');
    }
});

ipcMain.handle('open-external-url', async (event, url) => {
    // só endereços web: impede abrir file:, ms-msdt: e outros protocolos a partir da tela
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url);
});

// ==== ITEM 2: Fechar processos clientes antes da cópia ====
ipcMain.handle('kill-process', async (event, processName) => {
    return new Promise((resolve) => {
        const name = ensureExeSuffix(processName);
        if (!nomeSeguro(name)) return resolve({ killed: false, msg: 'Nome de processo inválido.' });
        execFile('taskkill', ['/F', '/IM', name], { windowsHide: true }, (err, stdout, stderr) => {
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

        if (await ehRaizDeBranches(branchPath)) {
            return { valid: false, scenario: 'root_branches' };
        }

        if (!fileNames || fileNames.length === 0) {
            return { valid: true };
        }

        const { fileMap } = await getCachedBranchIndex(branchPath);

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

// ==== Aviso de executáveis antigos na pasta da Branch ====
// Reaproveita o índice da branch (cache curto) — só consulta a data de modificação (mtime) dos
// executáveis cadastrados que existem na pasta. Na pasta do Google Drive a data de CRIAÇÃO costuma
// ser a do sincronismo, não a do build; a de modificação é a que reflete quando o exe foi gerado.
ipcMain.handle('check-exe-age', async (event, { branchPath, fileNames } = {}) => {
    const vazio = { checked: 0, old: [], warnDays: EXE_AGE_WARN_DAYS };
    try {
        if (!branchPath || !Array.isArray(fileNames) || fileNames.length === 0) return vazio;
        if (!(await fs.pathExists(branchPath))) return vazio;
        if (await ehRaizDeBranches(branchPath)) return vazio; // pasta com todas as branches (ERP): não é uma branch, não varre

        const { fileMap } = await getCachedBranchIndex(branchPath);
        const now = Date.now();
        const found = [];
        for (const nome of fileNames) {
            const exe = ensureExeSuffix(nome);
            const entry = fileMap.get(exe.toLowerCase());
            if (!entry) continue;
            found.push({ name: exe, ageDays: Math.floor((now - entry.mtime) / 86400000) });
        }
        const old = found.filter(f => f.ageDays > EXE_AGE_WARN_DAYS).sort((a, b) => b.ageDays - a.ageDays);
        return { checked: found.length, old, warnDays: EXE_AGE_WARN_DAYS };
    } catch (err) {
        log.warn('check-exe-age falhou:', err.message);
        return vazio;
    }
});

// ==== Versão dos executáveis -> perfil (733 = versão 4.x, 734 = versão 5.x) ====
// Lê a versão (FileVersion) de UM exe da pasta da branch, via Windows (FileVersionInfo). O resultado
// fica em cache por arquivo+data+tamanho, então a pasta do Drive só é lida uma vez por build.
const versaoExeCache = new Map();
const lerVersaoExe = (fullPath) => new Promise((resolve) => {
    execFile('powershell',
        ['-NoProfile', '-NonInteractive', '-Command', '[System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:EXEBOARD_ARQ).FileVersion'],
        { env: { ...process.env, EXEBOARD_ARQ: fullPath }, timeout: 30000, windowsHide: true },
        (err, stdout) => resolve(err ? null : ((stdout || '').trim() || null)));
});
const perfilDaVersao = (versao) => {
    const m = /^(\d+)\./.exec(versao || '');
    if (!m) return null;
    if (m[1] === '4') return '733';
    if (m[1] === '5') return '734';
    return null; // outra versão: não sugere perfil
};

ipcMain.handle('get-branch-version', async (event, { branchPath, fileNames } = {}) => {
    const vazio = { version: null, file: null, perfil: null };
    try {
        if (!branchPath || !Array.isArray(fileNames) || fileNames.length === 0) return vazio;
        if (!(await fs.pathExists(branchPath))) return vazio;
        if (await ehRaizDeBranches(branchPath)) return vazio; // pasta com todas as branches: não é uma branch

        const { fileMap } = await getCachedBranchIndex(branchPath);
        // Alguns exes (ex.: stubs) têm versão tipo 1.0.0.0: ignora os que não indicam um lote e tenta o
        // próximo, examinando no máximo 4 exes para não ler a pasta do Drive à toa.
        let primeiro = null;
        let examinados = 0;
        for (const nome of fileNames) {
            if (examinados >= 4) break;
            const exe = ensureExeSuffix(nome);
            const entry = fileMap.get(exe.toLowerCase());
            if (!entry) continue;
            examinados++;
            const chave = `${entry.fullPath}|${entry.mtime}|${entry.size}`;
            let versao = versaoExeCache.get(chave);
            if (versao === undefined) {
                versao = await lerVersaoExe(entry.fullPath);
                versaoExeCache.set(chave, versao);
            }
            if (!versao) continue; // sem versão legível
            const perfil = perfilDaVersao(versao);
            if (perfil) return { version: versao, file: exe, perfil };
            if (!primeiro) primeiro = { version: versao, file: exe, perfil: null };
        }
        return primeiro || vazio;
    } catch (err) {
        log.warn('get-branch-version falhou:', err.message);
        return vazio;
    }
});

// ==== Configuração padrão (primeira instalação) ====
// Os valores ficam em config-padrao.json (na raiz do app), separados do código, pra poderem
// ser ajustados sem mexer em JavaScript.
ipcMain.handle('get-default-config', async () => {
    try {
        return { data: await fs.readJson(path.join(__dirname, 'config-padrao.json')) };
    } catch (err) {
        return { error: err.message };
    }
});

// ==== BITBUCKET (listagem de branches, verificação e extração) ====
// Toda a comunicação com a API fica aqui no backend (a tela só chama os comandos): assim não depende de
// CORS/CSP do navegador embutido e os erros chegam à tela com o motivo real.
const BB_API = 'https://api.bitbucket.org/2.0';
const bbHeaders = (user, token) => ({ 'Authorization': 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64') });

// Valor entre aspas numa consulta BbQL (name = "...")
const bbq = (valor) => String(valor).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// Mensagem amigável para uma resposta de erro da API (ex.: 403 por falta de 2FA não pode virar "nenhuma branch")
async function bbMensagemErro(res, contexto) {
    let detalhe = '';
    try {
        const txt = await res.text();
        try {
            const j = JSON.parse(txt);
            detalhe = (j.error && (j.error.message || j.error.detail)) || j.message || '';
        } catch (e) { detalhe = txt.slice(0, 200); }
    } catch (e) { /* sem corpo */ }

    let motivo;
    if (res.status === 401) motivo = 'usuário ou API Token inválido (401). Confira o e-mail e o token.';
    else if (res.status === 403) motivo = `acesso negado (403)${detalhe ? ': ' + detalhe : ''}. Confira se a conta tem a verificação em duas etapas ativa e se o token tem permissão de leitura do repositório.`;
    else if (res.status === 404) motivo = 'workspace ou repositório não encontrado (404). Confira os nomes.';
    else if (res.status === 429) motivo = 'muitas requisições ao Bitbucket (429). Aguarde um instante e tente de novo.';
    else motivo = `erro ${res.status}${detalhe ? ': ' + detalhe : ''}`;
    return contexto ? `${contexto}: ${motivo}` : motivo;
}

const bbErroRede = (err) => `Sem conexão com o Bitbucket (${err && err.message ? err.message : err}). Verifique a internet/VPN.`;

// Lista branches para o autocomplete. Devolve { branches, error }: erro real em vez de lista vazia.
ipcMain.handle('list-branches', async (event, config) => {
    const { workspace, repo, user, appPassword, searchTerm } = config || {};
    if (!workspace || !repo || !user || !appPassword) {
        return { branches: [], error: 'Preencha Workspace, Repositório, Usuário e API Token acima para listar as branches.' };
    }
    try {
        let url = `${BB_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/refs/branches?sort=-target.date&pagelen=20`;
        if (searchTerm) url += `&q=${encodeURIComponent(`name ~ "${bbq(searchTerm)}"`)}`;
        const res = await fetch(url, { headers: bbHeaders(user, appPassword) });
        if (!res.ok) return { branches: [], error: await bbMensagemErro(res, 'Não foi possível listar as branches') };
        const data = await res.json();
        return { branches: (data.values || []).map(b => b.name), error: null };
    } catch (err) {
        return { branches: [], error: bbErroRede(err) };
    }
});

// Arquivos alterados entre a branch da tarefa e a base (diffstat), seguindo TODAS as páginas da API.
// Devolve { ok:true, tasks:[{path, branchUrl, baseUrl}] } ou { ok:false, msg }.
async function bbListarAlterados({ workspace, repo, user, appPassword, base, branch }) {
    const headers = bbHeaders(user, appPassword);
    const repoUrl = `${BB_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}`;

    const getHash = async (bName) => {
        const res = await fetch(`${repoUrl}/refs/branches?q=${encodeURIComponent(`name = "${bbq(bName)}"`)}`, { headers });
        if (!res.ok) throw new Error(await bbMensagemErro(res, `Erro na API ao buscar a branch "${bName}"`));
        const d = await res.json();
        if (!d.values || d.values.length === 0) return null;
        return d.values[0].target.hash;
    };

    const baseHash = await getHash(base);
    if (!baseHash) return { ok: false, msg: `Branch base '${base}' não encontrada.`, detalhe: `A branch base '${base}' não foi encontrada no repositório.` };
    const branchHash = await getHash(branch);
    if (!branchHash) return { ok: false, msg: `Branch da tarefa '${branch}' não encontrada.`, detalhe: `A branch da tarefa '${branch}' não foi encontrada no repositório.` };

    const tasks = [];
    const vistos = new Set();
    let url = `${repoUrl}/diffstat/${branchHash}..${baseHash}`;
    for (let pagina = 0; url && pagina < 100; pagina++) { // teto de 100 páginas: nunca entra em laço infinito
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(await bbMensagemErro(res, 'Falha no DiffStat'));
        const data = await res.json();
        for (const item of (data.values || [])) {
            if (item.status === 'removed') continue;
            const filePath = (item.new && item.new.path) || (item.old && item.old.path);
            if (!filePath || vistos.has(filePath)) continue;
            vistos.add(filePath);
            tasks.push({
                path: filePath,
                branchUrl: item.new && item.new.links && item.new.links.self && item.new.links.self.href,
                baseUrl: item.old && item.old.links && item.old.links.self && item.old.links.self.href
            });
        }
        url = data.next || null;
    }
    return { ok: true, tasks, branchHash, baseHash };
}

// "Verificar Arquivos": só lista o que seria baixado
ipcMain.handle('verify-bitbucket', async (event, config) => {
    try {
        const r = await bbListarAlterados(config || {});
        if (!r.ok) return { success: false, msg: r.detalhe || r.msg };
        return { success: true, files: r.tasks.map(t => path.basename(t.path)) };
    } catch (err) {
        return { success: false, msg: (err && err.message && !/fetch failed/i.test(err.message)) ? err.message : bbErroRede(err) };
    }
});

// ==== MOTOR DE EXTRAÇÃO BITBUCKET ====
ipcMain.handle('extract-bitbucket', async (event, config) => {
    const { workspace, repo, user, appPassword, base, branch, targetDir } = config;
    const headers = bbHeaders(user, appPassword);

    try {
        sendLog('Iniciando comunicação com Bitbucket API...', '#89b4fa', 'copiar');

        // 1. Branches e DiffStat (todas as páginas)
        const lista = await bbListarAlterados(config);
        if (!lista.ok) {
            sendLog(`ERRO: ${lista.detalhe}`, '#f38ba8', 'copiar');
            return { success: false, msg: lista.msg };
        }
        sendLog(`Branches localizadas. Hashes: ${lista.branchHash.substring(0, 7)}..${lista.baseHash.substring(0, 7)}`, '#a6adc8', 'copiar');

        const downloadTasks = lista.tasks;
        if (downloadTasks.length === 0) {
            sendLog('Nenhum arquivo modificado encontrado entre as branches.', '#f38ba8', 'copiar');
            return { success: false, msg: 'Sem alterações' };
        }
        sendLog(`DiffStat concluído: ${downloadTasks.length} arquivo(s) modificado(s).`, '#a6adc8', 'copiar');

        // 2. Preparar Diretórios (Nova Estrutura Achatada)
        // Raiz: {targetDir}/{repo}
        const extractRoot = path.join(targetDir, repo);
        // Subpasta fixa: branch
        const dirBranch = path.join(extractRoot, 'branch');
        // Subpasta dinâmica: nome da base higienizado (barras viram hifens)
        const baseSafe = base.replace(/\//g, '-').replace(/[<>:"\\|?*]/g, '_');
        const dirBase = path.join(extractRoot, baseSafe);

        // Garante que as pastas existam E estejam vazias para evitar mistura de arquivos antigos
        await fs.emptyDir(dirBranch);
        await fs.emptyDir(dirBase);

        sendLog(`Estrutura limpa/criada em: ${extractRoot}`, '#a6adc8', 'copiar');

        // 3. Download Concorrente (Lotes de 5) — Flatten + Nomenclatura Dinâmica
        const ausentesBase = [];
        let concluido = 0;

        const downloadFlatUrl = async (url, originalFilePath, targetFolder, renameFn) => {
            if (!url) return false;

            const res = await fetch(url, { headers });

            if (!res.ok) {
                throw new Error(await bbMensagemErro(res));
            }

            // Flatten: usa apenas o basename do arquivo, sem recriar diretórios
            const originalName = path.basename(originalFilePath);
            const finalName = renameFn ? renameFn(originalName) : originalName;
            const destPath = path.join(targetFolder, finalName);

            const buffer = await res.arrayBuffer();
            await fs.writeFile(destPath, Buffer.from(buffer));
            return true;
        };

        // Função de renomeação para arquivos da Base: arquivo(base).ext
        const renameForBase = (originalName) => {
            const parsed = path.parse(originalName);
            return `${parsed.name}(${baseSafe})${parsed.ext}`;
        };

        for (let i = 0; i < downloadTasks.length; i += 5) {
            const batch = downloadTasks.slice(i, i + 5);
            await Promise.allSettled(batch.map(async (task) => {
                const { path: filePath, branchUrl, baseUrl } = task;
                const baseFilename = path.basename(filePath);

                // Download Branch (nome original, achatado)
                if (branchUrl) {
                    try {
                        await downloadFlatUrl(branchUrl, filePath, dirBranch, null);
                    } catch (e) {
                        sendLog(`[ERRO] Falha ao baixar ${baseFilename} (Tarefa): ${e.message}`, '#f87171', 'copiar');
                    }
                }

                // Download Base (nome com sufixo da base, achatado)
                if (baseUrl) {
                    try {
                        await downloadFlatUrl(baseUrl, filePath, dirBase, renameForBase);
                    } catch (e) {
                        sendLog(`[ERRO] Falha ao baixar ${baseFilename} (Base): ${e.message}`, '#f87171', 'copiar');
                        ausentesBase.push(filePath);
                    }
                } else {
                    ausentesBase.push(filePath);
                }

                concluido++;
                sendLog(`Progresso: [${concluido}/${downloadTasks.length}] ${baseFilename}`, '#a6adc8', 'copiar');
            }));
        }

        // 4. Fechamento e Log de Ausentes
        if (ausentesBase.length > 0) {
            await fs.writeFile(path.join(dirBase, 'arquivos_ausentes.txt'), ausentesBase.join('\n'));
            sendLog(`Aviso: ${ausentesBase.length} arquivo(s) novo(s) ignorado(s) na pasta ${baseSafe} (registrados em txt).`, '#fbbf24', 'copiar');
        }

        sendLog('🎉 Extração Concluída com Sucesso!', '#4ade80', 'copiar');
        return { success: true, root: extractRoot };

    } catch (err) {
        const msg = (err && err.message && !/fetch failed/i.test(err.message)) ? err.message : bbErroRede(err);
        sendLog(`Erro Crítico na Extração: ${msg}`, '#f38ba8', 'copiar');
        return { success: false, msg };
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
