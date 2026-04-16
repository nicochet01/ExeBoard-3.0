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
    clientList.forEach((cli, idx) => cfgC.innerHTML += `<div class="list-item"><label class="custom-checkbox"><input type="checkbox" class="cfg-del-cli" value="${idx}"><span class="checkmark"></span><span>${cli.Nome}</span></label></div>`);

    const cfgS = document.getElementById('cfgServidores'); cfgS.innerHTML = '';
    serverList.forEach((srv, idx) => cfgS.innerHTML += `<div class="list-item"><label class="custom-checkbox"><input type="checkbox" class="cfg-del-srv" value="${idx}"><span class="checkmark"></span><span>${srv.Nome}</span></label></div>`);

    const cfgA = document.getElementById('cfgAtualizadores'); cfgA.innerHTML = '';
    bdList.forEach((bd, idx) => cfgA.innerHTML += `<div class="list-item"><label class="custom-checkbox"><input type="checkbox" class="cfg-del-bd" value="${idx}"><span class="checkmark"></span><span>${bd}</span></label></div>`);
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
                AppServidora: srvBase[`AppServidora${i}`] === 'Sim' || srvBase[`AppServidora${i}`] === undefined // Default true para legado
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

    isCopying = true;
    btn.textContent = "Cancelar Cópia";
    btn.style.background = LOG_COLORS.error;
    
    // UI Lock: Bloqueia botões e o acesso à Aba de Configurações
    document.querySelector('[data-tab="configuracoes"]').style.display = 'none';
    document.getElementById('btnCriarConexao').disabled = true;
    document.getElementById('btnBuscarPath').disabled = true;
    document.getElementById('btnAbrirAtualizador').disabled = true;
    document.querySelectorAll('.btn-icon').forEach(b => b.disabled = true);
    
    await window.saveConfig(); 

    const automacao = document.getElementById('cbModoAutomacao').checked;
    const baseBranch = document.getElementById('edtCaminhoBranch').value;
    const finalPath = calculateSourcePath(baseBranch, automacao);

    if (automacao) appendLog(`MODO AUTOMAÇÃO: Redirecionando para ${finalPath}`, LOG_COLORS.automation, 'copiar');

    let reqs = [];
    document.querySelectorAll('.chk-client:checked').forEach(c => reqs.push({destDir: document.getElementById('txtDestinoClientes').value, type:'client', itemData: JSON.parse(c.value)}));
    document.querySelectorAll('.chk-server:checked').forEach(c => reqs.push({destDir: document.getElementById('txtDestinoServidores').value, type:'server', itemData: JSON.parse(c.value)}));
    document.querySelectorAll('.chk-bd:checked').forEach(c => reqs.push({destDir: document.getElementById('txtDestinoAtualizadores').value, type:'bd', itemData: { Nome: c.value }}));

    const checkedServers = Array.from(document.querySelectorAll('.chk-server:checked')).map(c=>JSON.parse(c.value));
    
    appendLog('Parando serviços/apps selecionados...', LOG_COLORS.info, 'copiar');
    for(let srv of checkedServers) await window.api.manageServer({ srv, action: 'stop' });

    try {
        const queue = await window.api.buildQueue({ reqs, branchRoot: baseBranch });
        const block = await window.api.executarCopia(queue);

        if (block.status === 'completed') {
            appendLog(`Cópia finalizada. ${block.news} arquivos novos colados.`, LOG_COLORS.success, 'copiar');
            
            for(let srv of checkedServers) {
                if (srv.Tipo === 'Servico') await window.api.manageServer({ srv, action: 'start' });
                else appendLog(`Aviso: ${srv.Nome} é Aplicação e deve ser iniciada manualmente.`, '#bac2de', 'copiar');
            }
        } else {
            appendLog(`Operação cancelada ou interrompida. Erros: ${block.errors}`, LOG_COLORS.error, 'copiar');
        }
    } catch (err) {
        appendLog(`ERRO CRÍTICO na comunicação: ${err.message}`, LOG_COLORS.error, 'copiar');
    }

    isCopying = false;
    btn.textContent = "Copiar Dados";
    btn.style.background = 'var(--accent)';
    document.querySelector('[data-tab="configuracoes"]').style.display = 'block';
    document.getElementById('btnCriarConexao').disabled = false;
    document.getElementById('btnBuscarPath').disabled = false;
    document.getElementById('btnAbrirAtualizador').disabled = false;
    document.querySelectorAll('.btn-icon').forEach(b => b.disabled = false);
});

// Mocking actions
document.getElementById('btnBuscarPath').addEventListener('click', async () => {
    let current = document.getElementById('edtCaminhoBranch').value;
    const p = await window.api.openFolder(current);
    if(p) { document.getElementById('edtCaminhoBranch').value = p; markUnsaved(); }
});

window.selectFolderDest = async (inputId) => {
    let def = document.getElementById(inputId).value;
    
    // Fallback de Lupa: Se vazio ou informe o caminho, tenta INI ou Padrões
    if (!def || def.startsWith('Informe')) {
        const map = {
            'txtDestinoAtualizadores': 'C:\\Viasoft\\Dados',
            'txtDestinoClientes': 'C:\\Viasoft\\Client',
            'txtDestinoServidores': 'C:\\Viasoft\\Server'
        };
        def = map[inputId] || '';
    }

    const f = await window.api.openFolder(def);
    if(f) { document.getElementById(inputId).value = f; markUnsaved(); }
};

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

    serverList.push({ Nome: name, Tipo: 'Servico', IsPureService: true, AppServidora: false });
    renderLists(); markUnsaved();
    document.getElementById('modalSelectService').style.display = 'none';
};

window.addServerManual = async () => { 
    const def = document.getElementById('txtDestinoServidores').value;
    const exes = await window.api.openMultiFiles(def); 
    if(exes && exes.length > 0) {
        const modal = document.getElementById('modalConfirmExes');
        const list = document.getElementById('confirmExesList');
        modal.style.display = 'flex';
        list.innerHTML = '';

        for(let exe of exes) {
            let raw = exe.replace('.exe','');
            const type = await window.api.detectarTipo(raw);
            const isSrv = type === 'Servico';
            list.innerHTML += `
                <div class="service-list-item">
                    <label class="custom-checkbox">
                        <input type="checkbox" class="chk-confirm-srv" value="${raw}" ${isSrv ? 'checked' : ''}>
                        <span class="checkmark"></span>
                    </label>
                    <span>${exe}</span>
                </div>`;
        }

        document.getElementById('btnFinalizeExes').onclick = () => {
            document.querySelectorAll('.chk-confirm-srv').forEach(chk => {
                const name = chk.value;
                if(!serverList.find(s => s.Nome === name)) {
                    serverList.push({ 
                        Nome: name, 
                        Tipo: chk.checked ? 'Servico' : 'Aplicacao',
                        IsPureService: false,
                        AppServidora: true
                    });
                }
            });
            renderLists(); markUnsaved();
            modal.style.display = 'none';
        };
    }
}
window.addClientRow = async () => { 
    const def = document.getElementById('txtDestinoClientes').value;
    const exes = await window.api.openMultiFiles(def); 
    if(exes && exes.length > 0) {
        exes.forEach(exe => {
            if(clientList.find(c => c.Nome === exe)) return; // Unicidade

            let guessFolder = '';
            let similar = clientList.find(c => c.Nome.substring(0,3) === exe.substring(0,3));
            if(similar) guessFolder = similar.SubDiretorios;
            clientList.push({Nome: exe, SubDiretorios: guessFolder});
        });
        renderLists(); markUnsaved();
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
        if (s.IsPureService) fullConfig.APLICACOES_SERVIDORAS[`IsPureService${i}`] = "Sim";
        if (s.AppServidora) fullConfig.APLICACOES_SERVIDORAS[`AppServidora${i}`] = "Sim";
    });

    fullConfig.BANCO_DE_DADOS = { Count: bdList.length };
    bdList.forEach((b, i) => { fullConfig.BANCO_DE_DADOS[`BancoDados${i}`] = b; });
    
    // Geral
    if(!fullConfig.GERAL) fullConfig.GERAL = {};
    fullConfig.GERAL.HABILITAR_TRAY = document.getElementById('chkHabilitarTray').checked ? '1' : '0';

    await window.api.saveIni(fullConfig);
    unsavedChanges = false;
    document.getElementById('lblUnsaved').textContent = '(Salvo com Sucesso!)';
    setTimeout(()=>{document.getElementById('lblUnsaved').textContent=''}, 2000);
}

// ==== Custom Modals e UI Utilities ====
window.showCustomModal = (title, text, type = 'info') => {
    const modal = document.getElementById('customModal');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');
    const btnOk = document.getElementById('modalBtnOk');
    const btnCancel = document.getElementById('modalBtnCancel');

    titleEl.textContent = title;
    bodyEl.textContent = text;
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

document.addEventListener('DOMContentLoaded', () => {
    init();
    if(document.getElementById('chkHabilitarTray')) {
        document.getElementById('chkHabilitarTray').onchange = markUnsaved;
    }
});
