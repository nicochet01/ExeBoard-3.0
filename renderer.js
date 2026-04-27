// API Proxy Injection mock check
if (!window.api && typeof require !== 'undefined') {
    window.api = require('electron').ipcRenderer; // mock fallback just in case
}

// ==== Tabs Navigation ====
document.querySelectorAll('.nav-links li').forEach(item => {
    item.addEventListener('click', () => {
        document.querySelectorAll('.nav-links li').forEach(li => li.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
        item.classList.add('active');
        document.getElementById(item.dataset.tab).classList.add('active');
    });
});

let fullConfig = {};
let serverList = [];
let clientList = [];
let bdList = [];
let pollingTimer = null;
let isCopying = false;

// Memória de Logs para Filtragem
let logMemory = [];
const LOG_COLORS = {
    info: '#89b4fa', // Blue
    automation: '#cba6f7', // Purple
    success: '#40a02b', // Dark Green
    new: '#fe640b', // Dark Orange
    retry: '#fab387', // Light Orange
    error: '#f38ba8' // Red
};

// Escuta o aviso do sistema de que o app já estava aberto
if (window.api && window.api.onInstanceWarning) {
    window.api.onInstanceWarning(() => {
        const modal = document.getElementById('customModal');
        const title = document.getElementById('modalTitle');
        const body = document.getElementById('modalBody');
        const btnOk = document.getElementById('modalBtnOk');
        const btnCancel = document.getElementById('modalBtnCancel');

        // Configura os textos do seu modal existente
        title.innerText = '🚀 Aviso do Sistema';
        body.innerHTML = '<b>O ExeBoard já está aberto!</b><br><br>O aplicativo já está em execução no seu computador. Esta janela foi trazida para a frente.';
        
        // Esconde o botão cancelar, pois é só um aviso
        if (btnCancel) btnCancel.style.display = 'none';
        
        // Exibe o modal
        modal.style.display = 'flex';

        // Fecha o modal ao clicar em Entendido
        btnOk.onclick = () => {
            modal.style.display = 'none';
        };
    });
}

// ==== Logs ====
function appendLog(data, colorParam, targetParam) {
    let msg, color, target;
    
    if (data && typeof data === 'object' && data.msg !== undefined) {
        msg = data.msg;
        color = data.color || LOG_COLORS.info;
        target = data.target || 'copiar';
    } else {
        msg = data;
        color = colorParam || LOG_COLORS.info;
        target = targetParam || 'copiar';
    }

    const entry = {
        time: new Date().toLocaleTimeString('pt-BR'),
        msg: String(msg),
        color: color,
        target: target
    };
    logMemory.push(entry);

    renderLogEntry(entry);
}

function renderLogEntry(entry) {
    const box = entry.target === 'servidores' ? document.getElementById('rtbLogServidores') : document.getElementById('rtbLog');
    if(!box) return;

    const div = document.createElement('div');
    div.className = 'log-entry';
    div.style.color = entry.color;
    div.textContent = `[${entry.time}] ${entry.msg}`;
    
    // Identifica tipo para filtro rápido
    if (entry.color === LOG_COLORS.success) div.dataset.type = 'ok';
    else if (entry.color === LOG_COLORS.error) div.dataset.type = 'err';
    else div.dataset.type = 'info';

    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

window.filterLogs = (type, target = 'copiar') => {
    const boxId = target === 'servidores' ? 'rtbLogServidores' : 'rtbLog';
    const box = document.getElementById(boxId);
    box.innerHTML = '';
    const filtered = logMemory.filter(e => {
        if (e.target !== target) return false;
        if (type === 'all') return true;
        if (type === 'ok') return e.color === LOG_COLORS.success;
        if (type === 'err') return e.color === LOG_COLORS.error;
        return false;
    });
    filtered.forEach(renderLogEntry);
};

if(window.api && window.api.onLogMessage) window.api.onLogMessage(appendLog);

function markUnsaved() {
    document.getElementById('lblUnsaved').textContent = '(Existem alterações não salvas. Vá descendo e salve as configs!)';
}

// ==== Renders ====
function renderLists() {
    // Sort Alphabetical
    clientList.sort((a,b)=>a.Nome.localeCompare(b.Nome));
    serverList.sort((a,b)=>a.Nome.localeCompare(b.Nome));
    bdList.sort((a,b)=>a.localeCompare(b));

    // Aba 1 - Copiar Dados
    const cCont = document.getElementById('clbClientes'); cCont.innerHTML = '';
    clientList.forEach((cli) => {
        const payload = JSON.stringify(cli).replace(/'/g, "&apos;");
        cCont.innerHTML += `<div class="list-item"><label class="custom-checkbox">
            <input type="checkbox" checked value='${payload}' class="chk-client">
            <span class="checkmark"></span><span>${cli.Nome}</span></label></div>`;
    });

    const sCont = document.getElementById('clbServidores'); sCont.innerHTML = '';
    const actCont = document.getElementById('server-actions-list'); actCont.innerHTML = '';
    
    serverList.forEach((srv, idx) => {
        const payload = JSON.stringify(srv).replace(/'/g, "&apos;");
        
        // Na Aba 1 (Copiar Dados), mostramos apenas quem NÃO é Serviço Puro 
        // ou quem é AppServidora (marcado pelo botão Adicionar Exe)
        const showInAba1 = !srv.IsPureService || srv.AppServidora;

        if (showInAba1) {
            sCont.innerHTML += `<div class="list-item"><label class="custom-checkbox">
                <input type="checkbox" checked value='${payload}' class="chk-server">
                <span class="checkmark"></span><span>${srv.Nome}</span></label></div>`;
        }

        // Aba 2 - Sempre mostramos todos OS SERVIÇOS
        if (srv.Tipo === 'Servico') {
            actCont.innerHTML += `
                <div class="server-item" data-type="${srv.Tipo}">
                     <label class="custom-checkbox">
                        <input type="checkbox" value='${payload}' class="chk-batch-server">
                        <span class="checkmark"></span>
                     </label>
                     <span>${srv.Nome}</span>
                     <div class="indicator" id="ind_${idx}"></div>
                </div>`;
        }
    });

    const bCont = document.getElementById('clbAtualizadores'); bCont.innerHTML = '';
    bdList.forEach((bd) => {
        bCont.innerHTML += `<div class="list-item"><label class="custom-checkbox">
            <input type="checkbox" checked value='${bd}' class="chk-bd">
            <span class="checkmark"></span><span>${bd}</span></label></div>`;
    });

    // Aba 3 - Configurações
    const cfgC = document.getElementById('cfgClientes'); cfgC.innerHTML = '';
    clientList.forEach((cli, idx) => {
        cfgC.innerHTML += `
            <div class="list-item" style="display:flex; justify-content: space-between; width: 100%;">
                <label class="custom-checkbox">
                    <input type="checkbox" class="cfg-del-cli" value="${idx}">
                    <span class="checkmark"></span>
                    <span>${cli.Nome}</span>
                </label>
                <div style="display:flex; align-items:center; gap:8px;">
                    <span class="subfolder-tag" title="Subpasta de destino">${cli.SubDiretorios || '\\'}</span>
                    <button class="btn-icon-sm btn-edit-client" data-index="${idx}" title="Editar Subpasta">
                         <svg style="pointer-events:none" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                </div>
            </div>`;
    });

    const cfgS = document.getElementById('cfgServidores'); cfgS.innerHTML = '';
    serverList.forEach((srv, idx) => {
        const isNative = srv.IsPureService;
        cfgS.innerHTML += `
            <div class="list-item" style="display:flex; justify-content: space-between; width: 100%;">
                <label class="custom-checkbox">
                    <input type="checkbox" class="cfg-del-srv" value="${idx}">
                    <span class="checkmark"></span>
                    <span>${srv.Nome}</span>
                </label>
                <div style="display:flex; align-items:center; gap:8px;">
                    ${isNative ? 
                        `<span class="service-tag-native" title="Serviço Gerenciado pelo Windows">Serviço Nativo</span>` : 
                        `<span class="subfolder-tag" title="Subpasta de destino">${srv.SubDiretorios || '\\'}</span>`
                    }
                    ${!isNative ? `
                    <button class="btn-icon-sm btn-edit-server" data-index="${idx}" title="Editar Subpasta">
                         <svg style="pointer-events:none" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>` : ''}
                </div>
            </div>`;
    });

    const cfgA = document.getElementById('cfgAtualizadores'); cfgA.innerHTML = '';
    bdList.forEach((bd, idx) => cfgA.innerHTML += `<div class="list-item"><label class="custom-checkbox"><input type="checkbox" class="cfg-del-bd" value="${idx}"><span class="checkmark"></span><span>${bd}</span></label></div>`);

    // Atrela eventos de edição
    document.querySelectorAll('.btn-edit-client').forEach(btn => {
        btn.onclick = () => window.editSubfolder('client', parseInt(btn.dataset.index));
    });
    document.querySelectorAll('.btn-edit-server').forEach(btn => {
        btn.onclick = () => window.editSubfolder('server', parseInt(btn.dataset.index));
    });

    // Tutorial Progression: Check list lengths
    if (tutorialStep === 5 && bdList.length >= 1) updateTutorial(6);
    else if (tutorialStep === 6 && clientList.length >= 1) updateTutorial(7);
    else if (tutorialStep === 7 && serverList.length >= 1) updateTutorial(8);
}

window.editSubfolder = (type, index, onFinish) => {
    const list = type === 'client' ? clientList : serverList;
    const item = list[index];
    const rootPath = type === 'client' ? 
        document.getElementById('txtDestinoClientes').value : 
        document.getElementById('txtDestinoServidores').value;

    const modal = document.getElementById('modalEditSubfolder');
    const input = document.getElementById('edtSubfolderValue');
    const label = document.getElementById('labelSubfolderInfo');
    const btnBrowse = document.getElementById('btnBrowseSubfolder');
    const btnConfirm = document.getElementById('btnConfirmSubfolder');

    label.textContent = `Definindo destino para: ${item.Nome}`;
    input.value = item.SubDiretorios || '\\';
    modal.style.display = 'flex';

    btnBrowse.onclick = async () => {
        const folder = await window.api.openFolder(rootPath);
        if (folder) {
            let relative = getRelativeSubfolder(folder, rootPath);
            if (relative === '' && !folder.toLowerCase().replace(/\//g,'\\').startsWith(rootPath.toLowerCase().replace(/\//g,'\\'))) {
                showCustomModal("Aviso", "A pasta selecionada deve estar dentro da pasta Raiz configurada.", "info");
                return;
            }
            input.value = relative || '\\';
        }
    };

    btnConfirm.onclick = () => {
        let clean = input.value.trim();
        if (clean !== '' && clean !== '\\' && !clean.startsWith('\\')) clean = '\\' + clean;
        if (clean === '\\') clean = '';
        
        item.SubDiretorios = clean;
        modal.style.display = 'none';
        markUnsaved();
        renderLists();
        if (onFinish) onFinish();
    };
};

// Gerenciador de fila de configuração (para adições da Branch)
let pendingConfigs = [];
function processNextPendingConfig() {
    if (pendingConfigs.length === 0) return;
    const item = pendingConfigs.shift();
    window.editSubfolder(item.type, item.index, processNextPendingConfig);
}

// ==== Setup Inicial ====
async function init() {
    if(!window.api) return;
    
    // Reset lists to avoid duplication
    serverList = [];
    clientList = [];
    bdList = [];

    const res = await window.api.readIni();
    if(res.error) { appendLog(res.error, '#f38ba8', 'copiar'); return; }
    fullConfig = res.data;

    let cfg = fullConfig.CAMINHOS || {};
    document.getElementById('edtCaminhoBranch').value = cfg.DE || '';
    document.getElementById('txtDestinoClientes').value = cfg.PASTA_CLIENT || '';
    document.getElementById('txtDestinoServidores').value = cfg.PASTA_SERVER || '';
    document.getElementById('txtDestinoAtualizadores').value = cfg.PASTA_DADOS || '';

    let cliBase = fullConfig.APLICACOES_CLIENTE || {};
    for(let i=0; i<(cliBase.Count||0); i++) {
        if(cliBase[`Cliente${i}`]) clientList.push({Nome: cliBase[`Cliente${i}`], SubDiretorios: cliBase[`SubDiretorios${i}`]||''});
    }

    let srvBase = fullConfig.APLICACOES_SERVIDORAS || {};
    for(let i=0; i<(srvBase.Count||0); i++) {
        if(srvBase[`Servidor${i}`]) {
            serverList.push({
                Nome: srvBase[`Servidor${i}`], 
                Tipo: srvBase[`Tipo${i}`]||'Servico',
                IsPureService: srvBase[`IsPureService${i}`] === 'Sim',
                AppServidora: srvBase[`AppServidora${i}`] === 'Sim' || srvBase[`AppServidora${i}`] === undefined,
                SubDiretorios: srvBase[`SubDiretorios${i}`] || '' // Suporte a subpastas em servidores
            });
        }
    }

    let bdBase = fullConfig.BANCO_DE_DADOS || {};
    for (let i = 0; i < (bdBase.Count || 0); i++) {
        let n = bdBase[`Banco${i}`] || bdBase[`BancoDados${i}`];
        if (n) bdList.push(n);
    }
    
    // Configurações Gerais
    if(document.getElementById('chkHabilitarTray')) {
        document.getElementById('chkHabilitarTray').checked = (fullConfig.GERAL?.HABILITAR_TRAY === '1');
    }

    clientList.sort((a,b)=>a.Nome.localeCompare(b.Nome));
    serverList.sort((a,b)=>a.Nome.localeCompare(b.Nome));
    
    renderLists();
    startPolling();
    
    const isAdmin = await window.api.checkAdmin();
    if (!isAdmin) {
        appendLog('AVISO: O ExeBoard não está como Administrador. Algumas funções de servidores podem falhar.', 'var(--warning)', 'copiar');
        appendLog('Para corrigir, clique com o botão direito no programa e selecione "Executar como Administrador".', 'var(--warning)', 'servidores');
    }

    appendLog('CopiarExes aberto', '#a6adc8', 'copiar');

    // Carregar tema salvo
    const savedTheme = fullConfig.GERAL?.TEMA || 'dark';
    applyTheme(savedTheme);

    // Detecção de primeira vez (nenhum exe/serviço configurado)
    if (clientList.length === 0 && serverList.length === 0 && bdList.length === 0) {
        updateTutorial(1);
    }
}

// ==== Polling & Aba Servidores ====
function startPolling() {
    if(pollingTimer) clearInterval(pollingTimer);
    pollingTimer = setInterval(async () => {
        for(let i=0; i<serverList.length; i++) {
            const status = await window.api.checkStatus(serverList[i]);
            const ind = document.getElementById(`ind_${i}`);
            if(ind) {
                ind.className = 'indicator ' + status;
                ind.parentElement.dataset.status = status;
            }
        }
        filterServersView();
    }, 2000);
}

window.selectAllByStatus = (id, isChecked) => {
    const isRun = id === 'chkFilterRun';
    document.querySelectorAll('.server-item').forEach(item => {
        const stat = item.dataset.status || 'not_found';
        const chk = item.querySelector('.chk-batch-server');
        if (isRun && stat === 'running') chk.checked = isChecked;
        if (!isRun && stat !== 'running') chk.checked = isChecked;
    });
};

window.batchServerAction = async (action) => {
    const chks = document.querySelectorAll('.chk-batch-server:checked');
    if(chks.length === 0) return showCustomModal("Erro", "Selecione algum servidor na lista.", "error");
    
    // No Electron, event pode sumir se não interceptado rápido. 
    // Vamos garantir que desativamos o botão que foi clicado.
    const blockBtn = window.event ? window.event.target : null;
    if (blockBtn) blockBtn.disabled = true;

    for(let i=0; i<chks.length; i++) {
        const c = chks[i];
        const srv = JSON.parse(c.value);
        if(action === 'restart') {
            const cbId = c.closest('.server-item');
            if (cbId) {
                cbId.dataset.status = 'transition';
                cbId.querySelector('.indicator').className = 'indicator transition';
            }
            appendLog(`Reiniciando ${srv.Nome}...`, LOG_COLORS.retry, 'servidores');
            await window.api.manageServer({ srv, action: 'stop' });
            await window.api.manageServer({ srv, action: 'start' });
        } else {
            const color = action === 'start' ? LOG_COLORS.info : LOG_COLORS.error;
            appendLog(`${action === 'start' ? 'Iniciando' : 'Parando'} ${srv.Nome}...`, color, 'servidores');
            await window.api.manageServer({ srv, action });
        }
    }
    if (blockBtn) blockBtn.disabled = false;
};

// ==== Start Copy ====
// ==== LÓGICA DE NAVEGAÇÃO DE DIRETÓRIO (Check Automacao) ====
function calculateSourcePath(base, automacao) {
    let clean = base.trim();
    if (clean.endsWith('\\')) clean = clean.slice(0, -1);
    
    const parts = clean.split('\\');
    const last = parts[parts.length - 1].toLowerCase();

    // Se a pasta terminar com Exes, ExesAutomacao ou BD, sobe um nível
    if (last === 'exes' || last === 'exesautomacao' || last === 'bd') {
        parts.pop();
        clean = parts.join('\\');
    }

    const finalSuffix = automacao ? 'ExesAutomacao' : 'Exes';
    return clean + '\\' + finalSuffix;
}

document.getElementById('btnCopiarDados').addEventListener('click', async () => {
    const btn = document.getElementById('btnCopiarDados');
    
    if(isCopying) {
        window.api.cancelarCopia();
        btn.textContent = "Cancelamento Enviado...";
        return;
    }

    // 1. Validação de Destinos (Aba Copiar Dados)
    const destCli = document.getElementById('txtDestinoClientes').value;
    const destSrv = document.getElementById('txtDestinoServidores').value;
    const destAtu = document.getElementById('txtDestinoAtualizadores').value;

    if (!destCli.trim() || !destSrv.trim() || !destAtu.trim() || 
        destCli.includes('Informe') || destSrv.includes('Informe') || destAtu.includes('Informe')) {
        showCustomModal("Caminhos Obrigatórios", "Por favor, informe os caminhos de destino (Clientes, Servidores e Atualizadores) na aba 'Copiar Dados' antes de iniciar a cópia.", "info");
        return;
    }

    isCopying = true;
    toggleUILock(true);
    btn.textContent = "Cancelar Cópia";
    btn.style.background = LOG_COLORS.error;
    
    await window.saveConfig(); 

    const automacao = document.getElementById('cbModoAutomacao').checked;
    const baseBranch = document.getElementById('edtCaminhoBranch').value;
    const finalPath = calculateSourcePath(baseBranch, automacao);

    if (automacao) appendLog(`MODO AUTOMAÇÃO: Redirecionando para ${finalPath}`, LOG_COLORS.automation, 'copiar');

    let reqs = [];
    document.querySelectorAll('.chk-client:checked').forEach(c => reqs.push({destDir: document.getElementById('txtDestinoClientes').value, type:'client', itemData: JSON.parse(c.value)}));
    document.querySelectorAll('.chk-server:checked').forEach(c => reqs.push({destDir: document.getElementById('txtDestinoServidores').value, type:'server', itemData: JSON.parse(c.value)}));
    document.querySelectorAll('.chk-bd:checked').forEach(c => reqs.push({destDir: document.getElementById('txtDestinoAtualizadores').value, type:'bd', itemData: { Nome: c.value }}));

    // === ITEM 3: Validação Inteligente da Branch ===
    const fileNamesToCheck = [];
    reqs.forEach(r => {
        if (r.type === 'client' || r.type === 'server') {
            let name = r.itemData.Nome;
            if (!name.toLowerCase().endsWith('.exe')) name += '.exe';
            fileNamesToCheck.push(name);
        }
    });

    appendLog('Validando pasta da Branch...', LOG_COLORS.info, 'copiar');
    const validation = await window.api.validateBranch({ branchPath: baseBranch, fileNames: fileNamesToCheck });
    
    if (!validation.valid) {
        if (validation.scenario === 'not_found') {
            showCustomModal(
                "Pasta não encontrada",
                "A pasta da Branch não foi encontrada. Verifique se o caminho está correto ou se o build da tarefa já foi finalizado.",
                "error"
            );
        } else if (validation.scenario === 'missing_files') {
            showCustomModal(
                "Arquivos não encontrados",
                `Atenção: Os seguintes arquivos selecionados não foram encontrados na Branch:<br><br><ul style="margin-left:20px">${validation.missing.map(f => '<li>' + f + '</li>').join('')}</ul>`,
                "error",
                true
            );
        } else {
            showCustomModal("Erro de Validação", validation.msg || "Erro desconhecido ao validar a Branch.", "error");
        }
        isCopying = false;
        toggleUILock(false);
        btn.textContent = "Copiar Dados";
        btn.style.background = 'var(--accent)';
        return;
    }
    appendLog('Branch validada com sucesso.', LOG_COLORS.success, 'copiar');

    // === ITEM 2: Fechar Clientes antes da cópia ===
    const checkedClients = Array.from(document.querySelectorAll('.chk-client:checked')).map(c => JSON.parse(c.value));
    if (checkedClients.length > 0) {
        appendLog('Encerrando aplicativos clientes selecionados...', LOG_COLORS.info, 'copiar');
        for (const cli of checkedClients) {
            let procName = cli.Nome;
            if (!procName.toLowerCase().endsWith('.exe')) procName += '.exe';
            const result = await window.api.killProcess(procName);
            if (result.killed) {
                appendLog(`Processo ${procName} encerrado.`, LOG_COLORS.success, 'copiar');
            }
        }
    }

    const checkedServers = Array.from(document.querySelectorAll('.chk-server:checked')).map(c=>JSON.parse(c.value));
    
    appendLog('Parando serviços/apps selecionados...', LOG_COLORS.info, 'copiar');
    for(let srv of checkedServers) await window.api.manageServer({ srv, action: 'stop' });

    try {
        const buildResult = await window.api.buildQueue({ reqs, branchRoot: baseBranch });
        const queue = buildResult.queue;
        const learnedPaths = buildResult.learnedPaths || [];

        // Auto-Aprendizado: Atualiza as subpastas nas listas se o Main descobriu novos caminhos
        if (learnedPaths.length > 0) {
            learnedPaths.forEach(learned => {
                const list = learned.type === 'client' ? clientList : serverList;
                const item = list.find(i => i.Nome.toLowerCase() === learned.name.toLowerCase());
                if (item) item.SubDiretorios = learned.subFolder;
            });
            await window.saveConfig(); // Persiste no INI o aprendizado
            appendLog(`[MEMÓRIA] ${learnedPaths.length} caminhos foram aprendidos e salvos no INI.`, LOG_COLORS.automation, 'copiar');
            renderLists();
        }

        const block = await window.api.executarCopia(queue);

        if (block.status === 'completed') {
            appendLog(`Cópia finalizada. ${block.news} arquivos processados.`, LOG_COLORS.success, 'copiar');
            
            for(let srv of checkedServers) {
                if (srv.Tipo === 'Servico') await window.api.manageServer({ srv, action: 'start' });
            }
        } else {
            appendLog(`Operação cancelada ou interrompida. Erros: ${block.errors}`, LOG_COLORS.error, 'copiar');
        }
    } catch (err) {
        appendLog(`ERRO CRÍTICO na comunicação: ${err.message}`, LOG_COLORS.error, 'copiar');
    }

    isCopying = false;
    toggleUILock(false);
    btn.textContent = "Copiar Dados";
    btn.style.background = 'var(--accent)';
});

// Helper: Trava de Interface
function toggleUILock(lock) {
    // Inputs de Caminhos
    document.getElementById('edtCaminhoBranch').disabled = lock;
    document.getElementById('txtDestinoClientes').disabled = lock;
    document.getElementById('txtDestinoServidores').disabled = lock;
    document.getElementById('txtDestinoAtualizadores').disabled = lock;
    document.getElementById('cbModoAutomacao').disabled = lock;

    // Checkboxes das Listas
    document.querySelectorAll('.chk-client, .chk-server, .chk-bd').forEach(cb => cb.disabled = lock);

    // Botões de Ação na Aba Principal
    document.getElementById('btnCriarConexao').disabled = lock;
    document.getElementById('btnBuscarPath').disabled = lock;
    document.getElementById('btnAbrirAtualizador').disabled = lock;
    document.querySelectorAll('.btn-icon').forEach(b => b.disabled = lock);

    // Botões da Aba Configurações (Prevenção extra)
    const configBtns = ["btnRemoveSelected", "btnCancelChanges", "btnSaveConfig"];
    configBtns.forEach(id => {
        const el = document.getElementById(id);
        if(el) el.disabled = lock;
    });
}

// Mocking actions
document.getElementById('btnBuscarPath').addEventListener('click', async () => {
    let current = document.getElementById('edtCaminhoBranch').value;
    const p = await window.api.openFolder(current);
    if(p) { 
        document.getElementById('edtCaminhoBranch').value = p; 
        markUnsaved(); 
        // Finalização do Tutorial no Passo 9
        if (typeof tutorialStep !== 'undefined' && tutorialStep === 9) updateTutorial(0);
    }
});




window.openAtualizadoresModal = () => {
    const lst = document.getElementById('listAtualizadoresModal');
    lst.innerHTML = '';
    bdList.forEach(bd => {
       lst.innerHTML += `<div class="list-item"><label class="custom-checkbox"><input type="radio" name="rdAtualizador" value="${bd}"><span class="checkmark"></span><span style="font-size:12px; margin-left:3px">${bd}</span></label></div>`;
    });
    document.getElementById('modalAtualizadores').style.display = 'flex';
};

window.execAtualizadorModal = () => {
    const sel = document.querySelector('input[name="rdAtualizador"]:checked');
    if(!sel) return showCustomModal("Erro", "Selecione um atualizador", "error");
    
    let pathBase = document.getElementById('txtDestinoAtualizadores').value;
    let combined = pathBase.endsWith('\\') ? pathBase + sel.value : pathBase + '\\' + sel.value;
    
    window.api.executeExternal(combined);
    document.getElementById('modalAtualizadores').style.display = 'none';
};

// Helper: Seleção de Pasta de Destino (Configurações)
window.selectFolderDest = async (inputId) => {
    let current = document.getElementById(inputId).value;
    const p = await window.api.openFolder(current);
    if (p) {
        document.getElementById(inputId).value = p;
        markUnsaved();

        // Progressão do Tutorial
        if (typeof tutorialStep !== 'undefined') {
            if (tutorialStep === 2 && inputId === 'txtDestinoAtualizadores') updateTutorial(3);
            else if (tutorialStep === 3 && inputId === 'txtDestinoClientes') updateTutorial(4);
            else if (tutorialStep === 4 && inputId === 'txtDestinoServidores') updateTutorial(5);
        }
    }
};

// Helper: Escolha de Origem
async function requestFilesWithOrigin(type) {
    // Atalho Inteligente para o Tutorial (Regra 3 do Documento)
    if (typeof tutorialStep !== 'undefined' && tutorialStep > 0) {
        let localPath = "";
        if (type === 'client') localPath = document.getElementById('txtDestinoClientes').value;
        if (type === 'server') localPath = document.getElementById('txtDestinoServidores').value;
        const files = await window.api.openMultiFiles(localPath);
        return { files, origin: 'local' };
    }

    return new Promise((resolve) => {
        const modal = document.getElementById('modalOriginChoice');
        const btnBranch = document.getElementById('btnOriginBranch');
        const btnLocal = document.getElementById('btnOriginLocal');
        
        modal.style.display = 'flex';
        
        btnBranch.onclick = async () => {
            modal.style.display = 'none';
            const branchPath = document.getElementById('edtCaminhoBranch').value;
            if(!branchPath || branchPath.toLowerCase().includes('informe')) {
                showCustomModal("Aviso", "Por favor, informe o caminho da Branch na primeira aba antes de extrair arquivos.", "info");
                resolve(null);
                return;
            }
            const files = await window.api.openMultiFiles(branchPath);
            resolve({ files, origin: 'branch' });
        };
        
        btnLocal.onclick = async () => {
            modal.style.display = 'none';
            let localPath = "";
            if (type === 'client') localPath = document.getElementById('txtDestinoClientes').value;
            if (type === 'server') localPath = document.getElementById('txtDestinoServidores').value;
            
            const files = await window.api.openMultiFiles(localPath);
            resolve({ files, origin: 'local' });
        };
    });
}

// Helper: Extrair Subpasta Relativa
function getRelativeSubfolder(fullPath, rootPath) {
    if (!fullPath || !rootPath) return '';
    
    // Normaliza caminhos
    let f = fullPath.replace(/\//g, '\\').replace(/\\+$/, '');
    let r = rootPath.replace(/\//g, '\\').replace(/\\+$/, '');

    // Se for um arquivo (exe), remove o nome do arquivo para pegar só a pasta
    if (f.toLowerCase().endsWith('.exe')) {
        f = f.substring(0, f.lastIndexOf('\\'));
    }
    
    let fLow = f.toLowerCase();
    let rLow = r.toLowerCase();

    // Se a pasta selecionada for exatamente a raiz
    if (fLow === rLow) return '';

    // Se a pasta estiver dentro da raiz
    if (fLow.startsWith(rLow)) {
        let relative = f.substring(r.length);
        // Garante que comece com \
        if (relative !== '' && !relative.startsWith('\\')) relative = '\\' + relative;
        return relative;
    }
    return '';
}


// Helper: Dedução Lógica (Efeito Manada)
function getMostFrequentSubfolder(list) {
    if (!list || list.length === 0) return '';
    
    const counts = {};
    let maxCount = 0;
    let winner = '';
    
    list.forEach(item => {
        const sub = (item.SubDiretorios || '').trim();
        if (sub && sub !== '') {
            counts[sub] = (counts[sub] || 0) + 1;
            if (counts[sub] > maxCount) {
                maxCount = counts[sub];
                winner = sub;
            }
        }
    });
    
    // Se não houver padrão claro ou todos vazios, retorna raiz
    return winner;
}

// ==== Aba Configurações Adders ====
let allWindowsServices = [];
window.addServerAutoDetect = async () => {
    const modal = document.getElementById('modalSelectService');
    const list = document.getElementById('serviceListContainer');
    const search = document.getElementById('txtSearchService');
    const btn = document.getElementById('btnConfirmService');
    
    modal.style.display = 'flex';
    list.innerHTML = `<div class="loading-overlay"><div class="spinner"></div><span>Coletando serviços...</span></div>`;
    search.value = '';
    btn.disabled = true;

    allWindowsServices = await window.api.getWindowsServices();
    renderServiceList(allWindowsServices);

    search.oninput = () => {
        const query = search.value.toLowerCase();
        const filtered = allWindowsServices.filter(s => s.Name.toLowerCase().includes(query) || s.DisplayName.toLowerCase().includes(query));
        renderServiceList(filtered);
    };
}

function renderServiceList(data) {
    const list = document.getElementById('serviceListContainer');
    list.innerHTML = '';
    data.forEach(s => {
        const item = document.createElement('div');
        item.className = 'service-list-item';
        item.innerHTML = `<div class="indicator ${s.Status === 4 ? 'running' : 'stopped'}" style="margin:0"></div>
                          <div><div class="service-name">${s.Name}</div><div class="service-display">${s.DisplayName}</div></div>`;
        item.dataset.selected = s.Name;
        item.onclick = () => {
            document.querySelectorAll('.service-list-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            selectedService = s;
            document.getElementById('btnConfirmService').disabled = false;
        };
        list.appendChild(item);
    });
}

document.getElementById('btnConfirmService').onclick = () => {
    const sel = document.querySelector('.service-list-item.selected');
    if(!sel) return;
    const name = sel.dataset.selected;
    
    // Unicidade
    if(serverList.find(s => s.Nome === name)) {
        showCustomModal("Aviso", `O serviço ${name} já existe na configuração.`, "info");
        return;
    }

    serverList.push({ 
        Nome: name, 
        Tipo: 'Servico', 
        IsPureService: true, 
        AppServidora: false,
        SubDiretorios: '' // Serviços Windows não possuem subpasta de destino no ExeBoard
    });
    
    document.getElementById('modalSelectService').style.display = 'none';
    markUnsaved();
    renderLists();
};

window.addServerManual = async () => { 
    const result = await requestFilesWithOrigin('server'); 
    if(!result || !result.files || result.files.length === 0) return;
    const { files, origin } = result;

    // STEP: Dedução Lógica se for Branch
    let inferredSub = '';
    if (origin === 'branch') {
        inferredSub = getMostFrequentSubfolder(serverList);
    }

    // STEP 3: Checagem em background
    const allServices = await window.api.getWindowsServices();
    const uncertainExes = [];

    const newItems = [];
    for(let fullPath of files) {
        let exe = fullPath.split(/[\\/]/).pop();
        let raw = exe.replace('.exe','');

        let subToUse = inferredSub;
        if (origin === 'local') {
            subToUse = getRelativeSubfolder(fullPath, document.getElementById('txtDestinoServidores').value);
        }

        const match = allServices.find(s => 
            s.Name.toLowerCase() === raw.toLowerCase() || 
            s.DisplayName.toLowerCase().toLowerCase() === raw.toLowerCase()
        );

        if(match) {
            if(!serverList.find(s => s.Nome === match.Name)) {
                serverList.push({ 
                    Nome: match.Name, Tipo: 'Servico', IsPureService: false, 
                    AppServidora: true, SubDiretorios: subToUse
                });
                if (origin === 'branch') newItems.push({ type: 'server', index: serverList.length - 1 });
            }
        } else {
            uncertainExes.push({ path: fullPath, name: raw });
        }
    }

    if(uncertainExes.length > 0) {
        const modal = document.getElementById('modalConfirmExes');
        const list = document.getElementById('confirmExesList');
        modal.style.display = 'flex'; list.innerHTML = '';

        for(let obj of uncertainExes) {
            let exe = obj.path.split(/[\\/]/).pop();
            const type = await window.api.detectarTipo(obj.name);
            const isSrv = type === 'Servico';
            list.innerHTML += `
                <div class="service-list-item">
                    <label class="custom-checkbox">
                        <input type="checkbox" class="chk-confirm-srv" data-path="${obj.path}" value="${obj.name}" ${isSrv ? 'checked' : ''}>
                        <span class="checkmark"></span>
                    </label>
                    <div style="display:flex; flex-direction:column">
                        <span>${exe}</span>
                        <small style="font-size:10px; opacity:0.6">${obj.path}</small>
                    </div>
                </div>`;
        }

        document.getElementById('btnFinalizeExes').onclick = () => {
            document.querySelectorAll('.chk-confirm-srv').forEach(chk => {
                const name = chk.value;
                const pathSelected = chk.dataset.path;
                if(!serverList.find(s => s.Nome === name)) {
                    let subFinal = inferredSub;
                    if (origin === 'local') subFinal = getRelativeSubfolder(pathSelected, document.getElementById('txtDestinoServidores').value);

                    serverList.push({ 
                        Nome: name, Tipo: chk.checked ? 'Servico' : 'Aplicacao',
                        IsPureService: false, AppServidora: true, SubDiretorios: subFinal
                    });
                    if (origin === 'branch') newItems.push({ type: 'server', index: serverList.length - 1 });
                }
            });
            modal.style.display = 'none';
            renderLists(); markUnsaved();
            if (newItems.length > 0) {
                pendingConfigs = pendingConfigs.concat(newItems);
                processNextPendingConfig();
            }
        };
    } else {
        renderLists(); markUnsaved();
        if (newItems.length > 0) {
            pendingConfigs = pendingConfigs.concat(newItems);
            processNextPendingConfig();
        }
    }
}
window.addClientRow = async () => { 
    const result = await requestFilesWithOrigin('client'); 
    if(!result || !result.files || result.files.length === 0) return;
    const { files, origin } = result;

    let inferredSub = '';
    if (origin === 'branch') inferredSub = getMostFrequentSubfolder(clientList);

    const newItems = [];
    files.forEach(fullPath => {
        let exe = fullPath.split(/[\\/]/).pop();
        if(clientList.find(c => c.Nome === exe)) return; 

        let subToUse = inferredSub;
        if (origin === 'local') {
            subToUse = getRelativeSubfolder(fullPath, document.getElementById('txtDestinoClientes').value);
        } else if (!subToUse) {
            let similar = clientList.find(c => c.Nome.substring(0,3) === exe.substring(0,3));
            if(similar) subToUse = similar.SubDiretorios;
        }

        clientList.push({Nome: exe, SubDiretorios: subToUse});
        if (origin === 'branch') newItems.push({ type: 'client', index: clientList.length - 1 });
    });
    
    renderLists(); markUnsaved();
    if (newItems.length > 0) {
        pendingConfigs = pendingConfigs.concat(newItems);
        processNextPendingConfig();
    }
}

window.addDatabaseRow = async () => { 
    const def = document.getElementById('txtDestinoAtualizadores').value;
    const f = await window.api.openFolder(def); 
    if(f) { 
        const name = f.split(/[\\/]/).pop() || f;
        if(bdList.includes(name)) {
            showCustomModal("Aviso", `O atualizador ${name} já existe.`, "info");
            return;
        }
        bdList.push(name); 
        renderLists(); 
        markUnsaved(); 
    } 
}


window.removeSelectedConfigs = () => {
    // Sort reverse to splice array safely
    const delCb = Array.from(document.querySelectorAll('.cfg-del-cli:checked')).map(n => parseInt(n.value)).sort((a,b)=>b-a);
    const delSrv = Array.from(document.querySelectorAll('.cfg-del-srv:checked')).map(n => parseInt(n.value)).sort((a,b)=>b-a);
    const delBd = Array.from(document.querySelectorAll('.cfg-del-bd:checked')).map(n => parseInt(n.value)).sort((a,b)=>b-a);
    
    let total = delCb.length + delSrv.length + delBd.length;
    if (total === 0) return;

    showConfirmModal("Confirmar Exclusão", `Temos a intenção de apagar permanentemente ${total} registros de sua configuração atual. Deseja excluir?`, () => {
        delCb.forEach(i => clientList.splice(i, 1));
        delSrv.forEach(i => serverList.splice(i, 1));
        delBd.forEach(i => bdList.splice(i, 1));
        
        markUnsaved();
        renderLists();
    });
};

window.cancelChanges = () => {
    init();
    document.getElementById('lblUnsaved').textContent = '(Alterações Descartadas)';
    setTimeout(()=>{document.getElementById('lblUnsaved').textContent=''}, 2000);
}

window.saveConfig = async () => {
    if(!fullConfig.CAMINHOS) fullConfig.CAMINHOS = {};
    fullConfig.CAMINHOS.DE = document.getElementById('edtCaminhoBranch').value;
    fullConfig.CAMINHOS.PASTA_CLIENT = document.getElementById('txtDestinoClientes').value;
    fullConfig.CAMINHOS.PASTA_SERVER = document.getElementById('txtDestinoServidores').value;
    fullConfig.CAMINHOS.PASTA_DADOS = document.getElementById('txtDestinoAtualizadores').value;

    fullConfig.APLICACOES_CLIENTE = { Count: clientList.length };
    clientList.forEach((c, i) => { fullConfig.APLICACOES_CLIENTE[`Cliente${i}`] = c.Nome; if(c.SubDiretorios) fullConfig.APLICACOES_CLIENTE[`SubDiretorios${i}`] = c.SubDiretorios;});

    fullConfig.APLICACOES_SERVIDORAS = { Count: serverList.length };
    serverList.forEach((s, i) => { 
        fullConfig.APLICACOES_SERVIDORAS[`Servidor${i}`] = s.Nome; 
        fullConfig.APLICACOES_SERVIDORAS[`Tipo${i}`] = s.Tipo; 
        fullConfig.APLICACOES_SERVIDORAS[`Replicar${i}`] = "Sim";
        fullConfig.APLICACOES_SERVIDORAS[`IsPureService${i}`] = s.IsPureService ? "Sim" : "Não";
        fullConfig.APLICACOES_SERVIDORAS[`AppServidora${i}`] = s.AppServidora ? "Sim" : "Não";
        if (s.SubDiretorios) fullConfig.APLICACOES_SERVIDORAS[`SubDiretorios${i}`] = s.SubDiretorios;
    });

    fullConfig.BANCO_DE_DADOS = { Count: bdList.length };
    bdList.forEach((b, i) => { fullConfig.BANCO_DE_DADOS[`BancoDados${i}`] = b; });
    
    // Geral
    if(!fullConfig.GERAL) fullConfig.GERAL = {};
    fullConfig.GERAL.HABILITAR_TRAY = document.getElementById('chkHabilitarTray').checked ? '1' : '0';
    fullConfig.GERAL.TEMA = document.body.classList.contains('light-theme') ? 'light' : 'dark';

    await window.api.saveIni(fullConfig);
    unsavedChanges = false;
    document.getElementById('lblUnsaved').textContent = '(Salvo com Sucesso!)';
    setTimeout(()=>{document.getElementById('lblUnsaved').textContent=''}, 2000);

    // Intercepção do Tutorial (Passo 8 -> 9): Verificação do Google Drive
    if (tutorialStep === 8) {
        document.getElementById('modalSettings').style.display = 'none';
        
        const modal = document.getElementById('customModal');
        const titleEl = document.getElementById('modalTitle');
        const bodyEl = document.getElementById('modalBody');
        const btnOk = document.getElementById('modalBtnOk');
        const btnCancel = document.getElementById('modalBtnCancel');

        titleEl.textContent = "Sincronização Necessária";
        titleEl.style.color = 'var(--accent)';
        bodyEl.textContent = "Você já possui o aplicativo do Google Drive instalado e sincronizado neste computador?";
        
        btnOk.textContent = "Sim";
        btnCancel.textContent = "Não";
        btnCancel.style.display = 'block';
        modal.style.display = 'flex';

        btnOk.onclick = () => {
            modal.style.display = 'none';
            updateTutorial(9);
        };

        btnCancel.onclick = () => {
            modal.style.display = 'none';
            window.api.executeExternal("https://www.google.com/drive/download/");
            updateTutorial(0); // Encerra o tutorial
        };
    }
}


// ==== Custom Modals e UI Utilities ====
window.showCustomModal = (title, text, type = 'info', useHtml = false) => {
    const modal = document.getElementById('customModal');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');
    const btnOk = document.getElementById('modalBtnOk');
    const btnCancel = document.getElementById('modalBtnCancel');

    titleEl.textContent = title;
    if (useHtml) bodyEl.innerHTML = text;
    else bodyEl.textContent = text;
    btnCancel.style.display = 'none';
    btnOk.textContent = 'Entendido';
    
    // Cores baseadas no tipo
    if (type === 'error') titleEl.style.color = 'var(--danger)';
    else if (type === 'success') titleEl.style.color = 'var(--success)';
    else titleEl.style.color = 'var(--accent)';

    modal.style.display = 'flex';
    
    const close = () => { modal.style.display = 'none'; btnOk.removeEventListener('click', close); };
    btnOk.onclick = close;
};

window.showConfirmModal = (title, text, callback) => {
    const modal = document.getElementById('customModal');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');
    const btnOk = document.getElementById('modalBtnOk');
    const btnCancel = document.getElementById('modalBtnCancel');

    titleEl.textContent = title;
    bodyEl.textContent = text;
    titleEl.style.color = 'var(--warning)';
    
    btnCancel.style.display = 'block';
    btnOk.textContent = 'Confirmar';
    modal.style.display = 'flex';

    btnOk.onclick = () => {
        modal.style.display = 'none';
        callback();
    };
    btnCancel.onclick = () => {
        modal.style.display = 'none';
    };
};

// ==== PATH Suggestion Logic (Custom Dark UI) ====
const inputBranch = document.getElementById('edtCaminhoBranch');
const suggestBox = document.getElementById('path-suggestions-custom');
let currentSuggestions = [];
let selectedIndex = -1;

inputBranch.addEventListener('input', async () => {
    const val = inputBranch.value;
    if (!val || val.length < 2) { suggestBox.style.display = 'none'; return; }
    
    currentSuggestions = await window.api.getPathSuggestions(val);
    if (currentSuggestions.length > 0) {
        renderSuggestions(currentSuggestions);
        suggestBox.style.display = 'block';
        selectedIndex = -1;
    } else {
        suggestBox.style.display = 'none';
    }
});

function renderSuggestions(list) {
    suggestBox.innerHTML = '';
    list.forEach((s, idx) => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        item.textContent = s;
        item.onclick = () => {
            inputBranch.value = s;
            suggestBox.style.display = 'none';
            markUnsaved();
        };
        suggestBox.appendChild(item);
    });
}

inputBranch.addEventListener('keydown', (e) => {
    const items = suggestBox.querySelectorAll('.suggestion-item');
    if (suggestBox.style.display === 'block' && items.length > 0) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = (selectedIndex + 1) % items.length;
            updateSelection(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = (selectedIndex - 1 + items.length) % items.length;
            updateSelection(items);
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            items[selectedIndex].click();
        } else if (e.key === 'Escape') {
            suggestBox.style.display = 'none';
        }
    }
});

function updateSelection(items) {
    items.forEach((it, idx) => {
        if (idx === selectedIndex) {
            it.classList.add('selected');
            it.scrollIntoView({ block: 'nearest' });
        } else it.classList.remove('selected');
    });
}

document.addEventListener('click', (e) => {
    if (e.target !== inputBranch) suggestBox.style.display = 'none';
});

// ==== CONTEXT MENU (Check All / Uncheck All) ====
let activeContextMenuList = null;
window.showListContextMenu = (e, className) => {
    e.preventDefault();
    activeContextMenuList = className;
    const menu = document.getElementById('listContextMenu');
    menu.style.display = 'block';
    menu.style.left = e.pageX + 'px';
    menu.style.top = e.pageY + 'px';
};

window.bulkCheck = (check) => {
    if(!activeContextMenuList) return;
    document.querySelectorAll('.' + activeContextMenuList).forEach(cb => cb.checked = check);
    document.getElementById('listContextMenu').style.display = 'none';
};

document.addEventListener('click', () => {
    document.getElementById('listContextMenu').style.display = 'none';
});

// ==== Tema ====
function applyTheme(theme) {
    if (theme === 'light') {
        document.body.classList.add('light-theme');
        document.getElementById('btnToggleTheme').textContent = '☀️';
    } else {
        document.body.classList.remove('light-theme');
        document.getElementById('btnToggleTheme').textContent = '🌙';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    init();
    if(document.getElementById('chkHabilitarTray')) {
        document.getElementById('chkHabilitarTray').onchange = markUnsaved;
    }

    // Engrenagem abre modal de Configurações
    document.getElementById('btnOpenSettings').addEventListener('click', () => {
        document.getElementById('modalSettings').style.display = 'flex';
        if (tutorialStep === 1) updateTutorial(2);
    });
    document.getElementById('btnCloseSettings').addEventListener('click', () => {
        document.getElementById('modalSettings').style.display = 'none';
        // Se o tutorial estiver ativo e o usuário fechar o modal, precisamos decidir o que fazer.
        // O usuário pediu "guie o usuário de forma obrigatória", então talvez resetar para o passo 1 se fechar?
        // Mas por enquanto vamos apenas esconder o modal.
    });

    // Theme Toggle (Dark / Light)
    document.getElementById('btnToggleTheme').addEventListener('click', () => {
        const isLight = document.body.classList.toggle('light-theme');
        document.getElementById('btnToggleTheme').textContent = isLight ? '☀️' : '🌙';
        if(!fullConfig.GERAL) fullConfig.GERAL = {};
        fullConfig.GERAL.TEMA = isLight ? 'light' : 'dark';
        window.api.saveIni(fullConfig);
    });

});

// ==== Interactive Tutorial (Onboarding) ====
let tutorialStep = 0;

function updateTutorial(step) {
    tutorialStep = step;
    const title = document.getElementById('onboardingTitle');
    const text = document.getElementById('onboardingText');
    const spotlight = document.getElementById('onboardingSpotlight');
    const arrow = document.getElementById('onboardingArrow');

    // Remove previous highlights
    document.querySelectorAll('.spotlight-highlight').forEach(el => el.classList.remove('spotlight-highlight'));
    
    if (step === 0) {
        document.body.classList.remove('onboarding-active');
        // Unlock inputs
        document.getElementById('txtDestinoAtualizadores').readOnly = false;
        document.getElementById('txtDestinoClientes').readOnly = false;
        document.getElementById('txtDestinoServidores').readOnly = false;
        document.getElementById('edtCaminhoBranch').readOnly = false;
        // Reset modal z-index override
        document.querySelectorAll('.modal-overlay').forEach(m => m.style.zIndex = '');
        return;
    }

    if (step === 2) {
        // Pequeno delay para garantir que o modal abriu e os elementos têm posição
        setTimeout(() => updateTutorialLogic(step), 150);
    } else {
        updateTutorialLogic(step);
    }
}

function updateTutorialLogic(step) {
    const title = document.getElementById('onboardingTitle');
    const text = document.getElementById('onboardingText');
    const spotlight = document.getElementById('onboardingSpotlight');
    const arrow = document.getElementById('onboardingArrow');

    document.body.classList.add('onboarding-active');

    let targetId = '';
    let arrowChar = '↑';
    let position = 'bottom'; 

    switch(step) {
        case 1:
            targetId = 'btnOpenSettings';
            title.innerText = '👋 Bem-vindo ao ExeBoard!';
            text.innerHTML = 'Esta é sua primeira vez aqui. Clique na ⚙️ <b>Configurações</b> acima para começar a configuração.';
            arrowChar = '↑';
            position = 'bottom-right';
            break;
        case 2:
            targetId = 'btnLupaOnboarding1';
            title.innerText = 'Passo 1/6: Caminhos Base';
            text.innerHTML = 'Lembre-se de sempre selecionar o diretório raiz das suas pastas (Ex: C:\\Pasta\\Aplicacoes). Clique na lupa e selecione a pasta dos <b>Atualizadores/Bancos</b>.';
            arrowChar = '↑';
            position = 'bottom-left';
            // Lock inputs
            document.getElementById('txtDestinoAtualizadores').readOnly = true;
            document.getElementById('txtDestinoClientes').readOnly = true;
            document.getElementById('txtDestinoServidores').readOnly = true;
            document.getElementById('edtCaminhoBranch').readOnly = true;
            break;
        case 3:
            targetId = 'btnLupaOnboarding2';
            title.innerText = 'Passo 2/6: Excelente!';
            text.innerHTML = 'Agora selecione a pasta base das aplicações <b>Clientes</b>.';
            arrowChar = '↑';
            position = 'bottom-center';
            break;
        case 4:
            targetId = 'btnLupaOnboarding3';
            title.innerText = 'Passo 3/6: Quase lá...';
            text.innerHTML = 'Por fim, selecione a pasta base onde ficam os <b>Servidores</b>.';
            arrowChar = '↑';
            position = 'bottom-right';
            break;
        case 5:
            targetId = 'btnAddAtualizador';
            title.innerText = 'Passo 4/6: Itens Obrigatórios';
            text.innerHTML = 'Muito bem. Agora adicione pelo menos um <b>Atualizador/Banco</b> na sua lista.';
            arrowChar = '↑';
            position = 'bottom-left';
            break;
        case 6:
            targetId = 'btnAddCliente';
            title.innerText = 'Passo 5/6: Quase terminando';
            text.innerHTML = 'Agora adicione pelo menos um <b>Executável Cliente</b>.';
            arrowChar = '↑';
            position = 'bottom-center';
            break;
        case 7:
            targetId = 'btnAddExeServidor';
            title.innerText = 'Passo 6/6: Último item';
            text.innerHTML = 'Para terminar, adicione pelo menos um <b>Executável Servidor</b>.';
            arrowChar = '↑';
            position = 'bottom-right';
            break;
        case 8:
            targetId = 'btnSaveConfig';
            title.innerText = 'Tudo pronto! 🎉';
            text.innerHTML = 'Sua configuração base foi criada com sucesso. Clique em <b>Salvar</b> para finalizar.';
            arrowChar = '↓';
            position = 'top-right';
            break;
        case 9:
            targetId = 'btnBuscarPath';
            title.innerText = 'Último passo! 💡';
            text.innerHTML = 'Para definir o caminho da sua Branch, certifique-se de que o Google Drive está instalado e sincronizado. Clique no botão <b>Procurar</b> em destaque e selecione a pasta da sua tarefa.';
            arrowChar = '↑';
            position = 'bottom-right';
            break;
    }

    const target = document.getElementById(targetId);
    if (target) {
        target.classList.add('spotlight-highlight');
        const rect = target.getBoundingClientRect();
        
        spotlight.style.flexDirection = 'column';
        if (position.startsWith('bottom')) {
            spotlight.style.top = (rect.bottom + 15) + 'px';
            spotlight.style.bottom = 'auto';
            arrow.innerText = '↑';
            if (position.endsWith('right')) {
                spotlight.style.left = 'auto';
                spotlight.style.right = (window.innerWidth - rect.right) + 'px';
                spotlight.style.alignItems = 'flex-end';
            } else if (position.endsWith('left')) {
                spotlight.style.right = 'auto';
                spotlight.style.left = rect.left + 'px';
                spotlight.style.alignItems = 'flex-start';
            } else {
                spotlight.style.left = (rect.left + rect.width/2 - 170) + 'px';
                spotlight.style.right = 'auto';
                spotlight.style.alignItems = 'center';
            }
        } else if (position.startsWith('top')) {
            spotlight.style.top = 'auto';
            spotlight.style.bottom = (window.innerHeight - rect.top + 15) + 'px';
            arrow.innerText = '↓';
            spotlight.style.flexDirection = 'column-reverse';
            if (position.endsWith('right')) {
                spotlight.style.left = 'auto';
                spotlight.style.right = (window.innerWidth - rect.right) + 'px';
                spotlight.style.alignItems = 'flex-end';
            }
        }
    }
}
