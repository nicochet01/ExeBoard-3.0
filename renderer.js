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
        if (item.dataset.tab === 'servidores') pollServersOnce(); // status fresco ao abrir a aba
    });
});

let fullConfig = {};
let serverList = [];
let clientList = [];
let bdList = [];
let pollingTimer = null;
let isCopying = false;
let selectedService = null;   // serviço escolhido na janela "Selecionar Serviço Windows"
let unsavedChanges = false;   // há alterações de configuração ainda não salvas

// Perfil (lote) ativo: "733" (versão 4.x) ou "734" (versão 5.x). Itens sem perfil, ou "Ambos" ('*'),
// aparecem nos dois perfis.
let perfilAtivo = '734';
const perfilVisivel = (item) => !item.Perfil || item.Perfil === '*' || item.Perfil === perfilAtivo;
const rotuloPerfil = (p) => (p === '733' || p === '734') ? p : 'Ambos';
const classePerfil = (p) => p === '733' ? 'p733' : p === '734' ? 'p734' : 'pamb';

// Memória de Logs para Filtragem (Limite de 500 entradas para proteção de memória)
let logMemory = [];
const MAX_LOG_ENTRIES = 500;
const LOG_COLORS = {
    info: '#89b4fa', // Blue
    automation: '#cba6f7', // Purple
    success: '#40a02b', // Dark Green
    new: '#fe640b', // Dark Orange
    retry: '#fab387', // Light Orange
    error: '#f38ba8' // Red
};

// Tipo de uma linha de log para os filtros Sucesso/Erros. Os filtros usam a cor da mensagem; o backend e o
// Extrator Cloud usam verdes/vermelhos diferentes dos da tela, então todos entram na mesma conta.
const CORES_SUCESSO = new Set([LOG_COLORS.success, '#4ade80', 'var(--success)']);
const CORES_ERRO = new Set([LOG_COLORS.error, '#f87171', 'var(--danger)']);
function tipoDoLog(color) {
    if (CORES_SUCESSO.has(color)) return 'ok';
    if (CORES_ERRO.has(color)) return 'err';
    return 'info';
}

// Garante o sufixo .exe de forma case-insensitive (evita duplicar em nomes como "Servico.EXE")
function ensureExeSuffix(name) {
    return (name && !name.toLowerCase().endsWith('.exe')) ? name + '.exe' : name;
}

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

// Escuta evento de Atualização Baixada
if (window.api && window.api.onUpdateDownloaded) {
    window.api.onUpdateDownloaded((info) => {
        const modalUpdate = document.getElementById('modalAutoUpdate');
        if (modalUpdate) {
            // Atualiza o texto do modal com as versões (UX Dinâmica)
            const bodyP = modalUpdate.querySelector('.modal-body p');
            if (bodyP && info) {
                bodyP.innerHTML = `Uma nova versão foi baixada com sucesso (de <b>v${info.currentVersion}</b> para <b>v${info.newVersion}</b>).<br><br>Deseja reiniciar a aplicação agora para aplicar a atualização?`;
            }
            modalUpdate.style.display = 'flex';
        }
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

    // Trava de Memória: Remove entradas antigas quando ultrapassar o limite
    if (logMemory.length > MAX_LOG_ENTRIES) {
        logMemory.shift();
    }

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
    div.dataset.type = tipoDoLog(entry.color);

    box.appendChild(div);

    // Trava de Memória Visual: Remove a linha mais antiga do DOM quando ultrapassar o limite
    while (box.childElementCount > MAX_LOG_ENTRIES) {
        box.removeChild(box.firstChild);
    }

    box.scrollTop = box.scrollHeight;
}

window.filterLogs = (type, target = 'copiar') => {
    const boxId = target === 'servidores' ? 'rtbLogServidores' : 'rtbLog';
    const box = document.getElementById(boxId);
    box.innerHTML = '';
    const filtered = logMemory.filter(e => {
        if (e.target !== target) return false;
        if (type === 'all') return true;
        return tipoDoLog(e.color) === type;
    });
    filtered.forEach(renderLogEntry);
};

// "Limpar log": esvazia a tela E a memória daquele log (senão um filtro traria as linhas de volta)
window.limparLog = (target = 'copiar') => {
    logMemory = logMemory.filter(e => e.target !== target);
    const box = document.getElementById(target === 'servidores' ? 'rtbLogServidores' : 'rtbLog');
    if (box) box.innerHTML = '';
};

// Seletor de filtro do log (Todos / Sucesso / Erros): marca o botão e aplica o filtro
window.setLogFilter = (btn, type) => {
    btn.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    filterLogs(type);
};

if(window.api && window.api.onLogMessage) window.api.onLogMessage(appendLog);

function markUnsaved() {
    document.getElementById('lblUnsaved').textContent = '(Existem alterações não salvas. Vá descendo e salve as configs!)';
}

// ==== Renders ====
// Texto de orientação mostrado quando uma lista está vazia (só strings fixas do app, sem dados do usuário)
const emptyHint = (html) => `<div class="empty-hint">${html}</div>`;

// Memória das marcações das listas da aba Copiar Dados. Redesenhar as listas (trocar de perfil, adicionar,
// editar ou remover item) apagava o que a pessoa tinha desmarcado e remarcava tudo. Agora o estado de cada
// item é guardado antes de redesenhar e restaurado depois; item que nunca foi visto vem marcado.
const marcacoes = new Map(); // "cli:Nome" | "srv:Nome" | "bd:Nome" -> marcado?
function guardarMarcacoes() {
    const ler = (seletor, prefixo, nomeDe) => document.querySelectorAll(seletor).forEach(cb => {
        try { marcacoes.set(prefixo + nomeDe(cb), cb.checked); } catch (e) { /* valor inesperado: ignora */ }
    });
    ler('.chk-client', 'cli:', cb => JSON.parse(cb.value).Nome);
    ler('.chk-server', 'srv:', cb => JSON.parse(cb.value).Nome);
    ler('.chk-bd', 'bd:', cb => cb.value);
}
const marcadoNaLista = (chave) => marcacoes.has(chave) ? marcacoes.get(chave) : true;

function renderLists() {
    guardarMarcacoes();

    // Sort Alphabetical
    clientList.sort((a,b)=>a.Nome.localeCompare(b.Nome));
    serverList.sort((a,b)=>a.Nome.localeCompare(b.Nome));
    bdList.sort((a,b)=>a.localeCompare(b));

    // Aba 1 - Copiar Dados
    const cCont = document.getElementById('clbClientes'); cCont.innerHTML = '';
    clientList.forEach((cli) => {
        if (!perfilVisivel(cli)) return; // só os itens do perfil ativo (e os "Ambos")
        const payload = JSON.stringify(cli).replace(/'/g, "&apos;");
        cCont.innerHTML += `<div class="list-item"><label class="custom-checkbox">
            <input type="checkbox" ${marcadoNaLista('cli:' + cli.Nome) ? 'checked' : ''} value='${payload}' class="chk-client">
            <span class="checkmark"></span><span>${cli.Nome}</span></label></div>`;
    });

    const sCont = document.getElementById('clbServidores'); sCont.innerHTML = '';
    const actCont = document.getElementById('server-actions-list'); actCont.innerHTML = '';
    
    serverList.forEach((srv, idx) => {
        if (!perfilVisivel(srv)) return; // idx continua sendo o índice real na lista (usado pelo polling)
        const payload = JSON.stringify(srv).replace(/'/g, "&apos;");
        
        // Na Aba 1 (Copiar Dados), mostramos apenas quem NÃO é Serviço Puro 
        // ou quem é AppServidora (marcado pelo botão Adicionar Exe)
        const showInAba1 = !srv.IsPureService || srv.AppServidora;

        if (showInAba1) {
            sCont.innerHTML += `<div class="list-item"><label class="custom-checkbox">
                <input type="checkbox" ${marcadoNaLista('srv:' + srv.Nome) ? 'checked' : ''} value='${payload}' class="chk-server">
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
            <input type="checkbox" ${marcadoNaLista('bd:' + bd) ? 'checked' : ''} value='${bd}' class="chk-bd">
            <span class="checkmark"></span><span>${bd}</span></label></div>`;
    });

    // Dicas nas listas vazias (orientam quem acabou de instalar)
    if (!cCont.innerHTML.trim()) cCont.innerHTML = emptyHint('Nenhum cliente cadastrado.<br>Abra a ⚙️ e use <b>Adicionar Exes</b> ou <b>Usar configuração padrão</b>.');
    if (!sCont.innerHTML.trim()) sCont.innerHTML = emptyHint('Nenhum servidor cadastrado.<br>Abra a ⚙️ e use <b>Adicionar Exe</b> ou <b>Usar configuração padrão</b>.');
    if (!bCont.innerHTML.trim()) bCont.innerHTML = emptyHint('Nenhuma pasta dos .cds cadastrada.<br>Abra a ⚙️ e use <b>Adicionar Pasta dos .cds</b> ou <b>Usar configuração padrão</b>.');
    if (!actCont.innerHTML.trim()) actCont.innerHTML = emptyHint('Nenhum serviço cadastrado.<br>Abra a ⚙️ em <b>Copiar Dados</b> e use <b>Adicionar Serviço</b> para escolher um serviço do Windows.');

    // Contagens nos títulos das listas e resumo do perfil ativo
    const nCli = cCont.querySelectorAll('.chk-client').length;
    const nSrv = sCont.querySelectorAll('.chk-server').length;
    const setTxt = (id, valor) => { const el = document.getElementById(id); if (el) el.textContent = valor; };
    setTxt('cntCds', bdList.length);
    setTxt('cntClientes', nCli);
    setTxt('cntServidores', nSrv);
    setTxt('perfilResumo', `${nCli} cliente(s) · ${nSrv} servidor(es) neste perfil`);

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
                    <span class="perfil-tag ${classePerfil(cli.Perfil)}" title="Perfil (lote) em que aparece">${rotuloPerfil(cli.Perfil)}</span>
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
                        `<span class="perfil-tag ${classePerfil(srv.Perfil)}" title="Perfil (lote) em que aparece">${rotuloPerfil(srv.Perfil)}</span><span class="subfolder-tag" title="Subpasta de destino">${srv.SubDiretorios || '\\'}</span>`
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

    if (!cfgC.innerHTML.trim()) cfgC.innerHTML = emptyHint('Nenhum executável cliente.<br>Clique em <b>Adicionar Exes</b> abaixo.');
    if (!cfgS.innerHTML.trim()) cfgS.innerHTML = emptyHint('Nenhum servidor.<br>Use <b>Adicionar Serviço</b> (serviço do Windows) ou <b>Adicionar Exe</b>.');
    if (!cfgA.innerHTML.trim()) cfgA.innerHTML = emptyHint('Nenhuma pasta dos .cds.<br>Clique em <b>Adicionar Pasta dos .cds</b> abaixo.');

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

    // Perfil (lote) em que o item aparece na tela principal
    let perfilEdit = item.Perfil || '*';
    const botoesPerfil = document.querySelectorAll('#perfilEditSwitch button');
    const marcarPerfil = () => botoesPerfil.forEach(b => b.classList.toggle('active', b.dataset.perfil === perfilEdit));
    botoesPerfil.forEach(b => { b.onclick = () => { perfilEdit = b.dataset.perfil; marcarPerfil(); }; });
    marcarPerfil();

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
        item.Perfil = perfilEdit;
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

// Seções de clientes/servidores no formato do arquivo de configuração
function montarSecaoClientes() {
    const secao = { Count: clientList.length };
    clientList.forEach((c, i) => {
        secao[`Cliente${i}`] = c.Nome;
        if (c.SubDiretorios) secao[`SubDiretorios${i}`] = c.SubDiretorios;
        if (c.Perfil) secao[`Perfil${i}`] = c.Perfil;
    });
    return secao;
}

function montarSecaoServidores() {
    const secao = { Count: serverList.length };
    serverList.forEach((s, i) => {
        secao[`Servidor${i}`] = s.Nome;
        secao[`Tipo${i}`] = s.Tipo;
        secao[`Replicar${i}`] = "Sim";
        secao[`IsPureService${i}`] = s.IsPureService ? "Sim" : "Não";
        secao[`AppServidora${i}`] = s.AppServidora ? "Sim" : "Não";
        if (s.SubDiretorios) secao[`SubDiretorios${i}`] = s.SubDiretorios;
        if (s.Perfil) secao[`Perfil${i}`] = s.Perfil;
    });
    return secao;
}

// Itens de listas antigas (sem perfil) recebem o perfil do config-padrao.json. O que o padrão não conhece
// continua sem perfil (aparece nos dois e se ajusta no lápis). Só grava quando classifica algo novo —
// e grava só as duas listas (não o tema/caminhos, que ainda não foram aplicados nesta altura da abertura).
async function classificarItensSemPerfil() {
    try {
        const r = await window.api.getDefaultConfig();
        const d = r && r.data;
        if (!d) return 0;
        let n = 0;
        const aplicar = (lista, padrao) => (padrao || []).forEach(p => {
            const item = lista.find(x => x.Nome.toLowerCase() === p.Nome.toLowerCase());
            if (item && !item.Perfil && p.Perfil) { item.Perfil = p.Perfil; n++; }
        });
        aplicar(clientList, d.CLIENTES);
        aplicar(serverList, d.SERVIDORES);
        if (n > 0) {
            fullConfig.APLICACOES_CLIENTE = montarSecaoClientes();
            fullConfig.APLICACOES_SERVIDORAS = montarSecaoServidores();
            await window.api.saveConfigSection('APLICACOES_CLIENTE', fullConfig.APLICACOES_CLIENTE);
            await window.api.saveConfigSection('APLICACOES_SERVIDORAS', fullConfig.APLICACOES_SERVIDORAS);
            appendLog(`${n} item(ns) classificado(s) por perfil (733/734) com base no padrão.`, LOG_COLORS.automation, 'copiar');
        }
        return n;
    } catch (e) {
        return 0;
    }
}

// ==== Setup Inicial ====
// ==== Setup Inicial ====
async function init() {
    if(!window.api) return;
    appendLog('Iniciando carregamento da interface...', '#89b4fa', 'copiar');

    // Carrega e exibe a versão do app na aba Sobre
    if (window.api.getAppVersion) {
        const ver = await window.api.getAppVersion();
        const verEl = document.getElementById('app-version-text');
        if (verEl) verEl.textContent = ver;
        appendLog(`Versão detectada no renderer: ${ver}`, '#89b4fa', 'copiar');
    }
    
    // Reset lists to avoid duplication
    serverList = [];
    clientList = [];
    bdList = [];

    appendLog('Lendo configurações...', '#89b4fa', 'copiar');
    const res = await window.api.readConfig();
    if(res.error) { 
        appendLog('Erro ao ler configurações: ' + res.error, '#f38ba8', 'copiar'); 
        return; 
    }
    fullConfig = res.data;
    appendLog('Configurações carregadas com sucesso.', '#40a02b', 'copiar');

    let cfg = fullConfig.CAMINHOS || {};
    document.getElementById('edtCaminhoBranch').value = cfg.DE || '';
    document.getElementById('txtDestinoClientes').value = cfg.PASTA_CLIENT || '';
    document.getElementById('txtDestinoServidores').value = cfg.PASTA_SERVER || '';
    document.getElementById('txtDestinoAtualizadores').value = cfg.PASTA_DADOS || '';

    // Load Bitbucket Config
    let bb = fullConfig.BITBUCKET || {};
    if(document.getElementById('bbWorkspace')) document.getElementById('bbWorkspace').value = bb.WORKSPACE || '';
    if(document.getElementById('bbRepo')) document.getElementById('bbRepo').value = bb.REPO || '';
    if(document.getElementById('bbUser')) document.getElementById('bbUser').value = bb.USER || '';
    if(document.getElementById('bbPassword')) document.getElementById('bbPassword').value = bb.PASSWORD || '';
    if(document.getElementById('bbTargetDir')) document.getElementById('bbTargetDir').value = bb.TARGET_DIR || '';


    let cliBase = fullConfig.APLICACOES_CLIENTE || {};
    for(let i=0; i<(cliBase.Count||0); i++) {
        if(cliBase[`Cliente${i}`]) clientList.push({Nome: cliBase[`Cliente${i}`], SubDiretorios: cliBase[`SubDiretorios${i}`]||'', Perfil: cliBase[`Perfil${i}`]||''});
    }

    let srvBase = fullConfig.APLICACOES_SERVIDORAS || {};
    for(let i=0; i<(srvBase.Count||0); i++) {
        if(srvBase[`Servidor${i}`]) {
            serverList.push({
                Nome: srvBase[`Servidor${i}`], 
                Tipo: srvBase[`Tipo${i}`]||'Servico',
                IsPureService: srvBase[`IsPureService${i}`] === 'Sim',
                AppServidora: srvBase[`AppServidora${i}`] === 'Sim' || srvBase[`AppServidora${i}`] === undefined,
                SubDiretorios: srvBase[`SubDiretorios${i}`] || '', // Suporte a subpastas em servidores
                Perfil: srvBase[`Perfil${i}`] || ''
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
    
    // Listas de antes dos perfis: classifica sozinho os itens que o padrão conhece (3C = 733, X = 734...)
    await classificarItensSemPerfil();

    // Perfil ativo (o último usado); ausente ou inválido -> 734
    const perfilSalvo = fullConfig.GERAL && fullConfig.GERAL.PERFIL_ATIVO;
    perfilAtivo = (perfilSalvo === '733' || perfilSalvo === '734') ? perfilSalvo : '734';
    atualizarSeletorPerfil();

    appendLog('Renderizando listas...', '#89b4fa', 'copiar');
    renderLists();
    if (fullConfig.ULTIMA_COPIA) {
        applySavedSelection(fullConfig.ULTIMA_COPIA);
        appendLog('Última seleção de executáveis restaurada.', '#cba6f7', 'copiar');
    }
    startPolling();
    
    appendLog('Verificando privilégios de Administrador...', '#89b4fa', 'copiar');
    const isAdmin = await window.api.checkAdmin();
    if (!isAdmin) {
        appendLog('AVISO: O ExeBoard não está como Administrador. Algumas funções de servidores podem falhar.', 'var(--warning)', 'copiar');
        appendLog('Para corrigir, clique com o botão direito no programa e selecione "Executar como Administrador".', 'var(--warning)', 'servidores');
    } else {
        appendLog('Privilégios de Administrador confirmados.', '#40a02b', 'copiar');
    }

    appendLog('ExeBoard pronto para uso.', '#40a02b', 'copiar');

    // Carregar tema salvo
    const savedTheme = fullConfig.GERAL?.TEMA || 'dark';
    applyTheme(savedTheme);

    // Detecção de primeira vez (nenhum exe/serviço configurado e tutorial ainda não concluído/pulado)
    if (clientList.length === 0 && serverList.length === 0 && bdList.length === 0
        && fullConfig.GERAL?.TUTORIAL_CONCLUIDO !== '1') {
        updateTutorial(1);
    }

    // Se a pasta da Branch já veio preenchida da última sessão, confere a idade dos executáveis
    checkBranchExeAge();
}


// ==== Polling & Aba Servidores (Anti-Avalanche: Verificação Sequencial) ====
// Cada consulta de status dispara processos do Windows (sc/tasklist). Por isso só consultamos
// quando a aba Servidores está à vista e a janela visível — antes rodava o tempo todo, inclusive
// com o app na bandeja ou na aba Copiar Dados, onde os indicadores nem aparecem.
let isPolling = false;
const POLL_INTERVAL_MS = 3000;

function shouldPoll() {
    const tab = document.getElementById('servidores');
    return !document.hidden && !!tab && tab.classList.contains('active');
}

async function pollServersOnce() {
    if (isPolling) return; // Proteção contra encavalamento
    isPolling = true;
    try {
        for (let i = 0; i < serverList.length; i++) {
            // Só serviços têm indicador na aba Servidores — não gasta processo com o resto
            if (!document.getElementById(`ind_${i}`)) continue;
            const status = await window.api.checkStatus(serverList[i]);
            const ind = document.getElementById(`ind_${i}`);
            if (ind) {
                ind.className = 'indicator ' + status;
                ind.parentElement.dataset.status = status;
            }
        }
    } catch (err) {
        // Proteção: Se o check falhar, não trava o ciclo
    } finally {
        isPolling = false;
    }
}

function startPolling() {
    if (pollingTimer) clearTimeout(pollingTimer);
    scheduleNextPoll();
}

function scheduleNextPoll() {
    pollingTimer = setTimeout(async () => {
        if (shouldPoll()) await pollServersOnce();
        scheduleNextPoll(); // Só agenda a próxima APÓS terminar
    }, POLL_INTERVAL_MS);
}

// Ao voltar a ficar visível, atualiza na hora em vez de esperar o próximo ciclo
document.addEventListener('visibilitychange', () => {
    if (shouldPoll()) pollServersOnce();
});

window.selectAllByStatus = (id, isChecked) => {
    const isRun = id === 'chkFilterRun';
    document.querySelectorAll('.server-item').forEach(item => {
        const stat = item.dataset.status || 'not_found';
        const chk = item.querySelector('.chk-batch-server');
        if (isRun && stat === 'running') chk.checked = isChecked;
        if (!isRun && stat !== 'running') chk.checked = isChecked;
    });
};

window.batchServerAction = async (action, blockBtn) => {
    const chks = document.querySelectorAll('.chk-batch-server:checked');
    if(chks.length === 0) return showCustomModal("Erro", "Selecione algum servidor na lista.", "error");

    // O botão clicado chega como argumento (onclick="batchServerAction('stop', this)"): fica desabilitado
    // enquanto a operação roda, sem depender de window.event.
    if (blockBtn) blockBtn.disabled = true;

    // Em paralelo — cada servidor/serviço é independente dos demais, então não há motivo
    // pra esperar um terminar antes de começar o próximo (o que antes multiplicava o tempo
    // total pelo número de itens selecionados).
    await Promise.all(Array.from(chks).map(async (c) => {
        const srv = JSON.parse(c.value);
        if (action === 'restart') {
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
    }));
    if (blockBtn) blockBtn.disabled = false;
};

// ==== Perfil (lote 733 / 734) ====
const DESCRICAO_PERFIL = { '733': 'Lote 733 · versão 4.0.x', '734': 'Lote 734 · versão 5.0.x' };

function atualizarSeletorPerfil() {
    document.querySelectorAll('#perfilSwitch button').forEach(b => b.classList.toggle('active', b.dataset.perfil === perfilAtivo));
    const desc = document.getElementById('perfilDescricao');
    if (desc) desc.textContent = DESCRICAO_PERFIL[perfilAtivo] || '';
}

function trocarPerfil(novo, { persistir = true, silencioso = false } = {}) {
    if (novo !== '733' && novo !== '734') return;
    if (novo === perfilAtivo) { atualizarSeletorPerfil(); return; }
    perfilAtivo = novo;
    atualizarSeletorPerfil();
    if (persistir) {
        if (!fullConfig.GERAL) fullConfig.GERAL = {};
        fullConfig.GERAL.PERFIL_ATIVO = novo;
        window.api.saveConfigSection('GERAL', fullConfig.GERAL).catch(() => {});
    }
    renderLists(); // mostra só os itens do novo perfil (e os "Ambos")
    if (!silencioso) appendLog(`Perfil ${novo} selecionado.`, LOG_COLORS.info, 'copiar');
    checkBranchExeAge();
    mostrarAvisoPerfil();
}

document.querySelectorAll('#perfilSwitch button').forEach(b => b.addEventListener('click', () => trocarPerfil(b.dataset.perfil)));

// ==== Helper: Memória da Última Cópia ====
function applySavedSelection(ultimaCopia, { trocarPerfilSalvo = false } = {}) {
    if (!ultimaCopia) return;

    // "Repetir última cópia" volta também ao perfil daquela cópia; na abertura do app vale o perfil em uso
    if (trocarPerfilSalvo && (ultimaCopia.perfil === '733' || ultimaCopia.perfil === '734')) {
        trocarPerfil(ultimaCopia.perfil, { silencioso: true });
    }

    if (Array.isArray(ultimaCopia.clients)) {
        document.querySelectorAll('.chk-client').forEach(cb => {
            try {
                const data = JSON.parse(cb.value);
                cb.checked = ultimaCopia.clients.includes(data.Nome);
            } catch (e) { }
        });
    }

    if (Array.isArray(ultimaCopia.servers)) {
        document.querySelectorAll('.chk-server').forEach(cb => {
            try {
                const data = JSON.parse(cb.value);
                cb.checked = ultimaCopia.servers.includes(data.Nome);
            } catch (e) { }
        });
    }

    if (Array.isArray(ultimaCopia.bds)) {
        document.querySelectorAll('.chk-bd').forEach(cb => {
            cb.checked = ultimaCopia.bds.includes(cb.value);
        });
    }

    const btnRepeat = document.getElementById('btnRepeatLastCopy');
    if (btnRepeat) btnRepeat.style.display = 'flex';
}

document.getElementById('btnRepeatLastCopy')?.addEventListener('click', () => {
    if (fullConfig.ULTIMA_COPIA) {
        applySavedSelection(fullConfig.ULTIMA_COPIA, { trocarPerfilSalvo: true });
        appendLog('Seleção da última cópia reaplicada aos checkboxes.', LOG_COLORS.success, 'copiar');
    }
});

// Listener de Progresso da Cópia em Tempo Real
if (window.api && window.api.onCopyProgress) {
    window.api.onCopyProgress(({ current, total, percent, fileName }) => {
        const pContainer = document.getElementById('copyProgressContainer');
        const pBar = document.getElementById('copyProgressBar');
        const pCount = document.getElementById('copyProgressCount');
        const pLabel = document.getElementById('copyProgressLabel');

        if (pContainer) pContainer.style.display = 'block';
        if (pBar) pBar.style.width = `${percent}%`;
        if (pCount) pCount.textContent = `${current} / ${total}`;
        if (pLabel && fileName) pLabel.textContent = `Copiando: ${fileName}`;
    });
}

// ==== Start Copy ====
document.getElementById('btnCopiarDados').addEventListener('click', async () => {
    // No último passo do tutorial o botão fica em destaque: clicar nele só encerra o tutorial,
    // sem iniciar uma cópia de verdade (a primeira cópia de quem acabou de instalar deve ser intencional)
    if (tutorialStep === 10) { updateTutorial(0); return; }
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
        showCustomModal("Caminhos Obrigatórios", "Por favor, informe os caminhos de destino (Clientes, Servidores e a raiz dos Dados) nas ⚙️ Configurações antes de iniciar a cópia.", "info");
        return;
    }

    const baseBranch = document.getElementById('edtCaminhoBranch').value.trim();
    if (!baseBranch) {
        showCustomModal("Caminho Obrigatório", "Por favor, informe o caminho da Branch de Origem.", "info");
        return;
    }

    let reqs = [];
    document.querySelectorAll('.chk-client:checked').forEach(c => reqs.push({destDir: document.getElementById('txtDestinoClientes').value, type:'client', itemData: JSON.parse(c.value)}));
    document.querySelectorAll('.chk-server:checked').forEach(c => reqs.push({destDir: document.getElementById('txtDestinoServidores').value, type:'server', itemData: JSON.parse(c.value)}));
    document.querySelectorAll('.chk-bd:checked').forEach(c => reqs.push({destDir: document.getElementById('txtDestinoAtualizadores').value, type:'bd', itemData: { Nome: c.value }}));

    if (reqs.length === 0) {
        showCustomModal("Seleção Vazia", "Selecione ao menos um executável ou pasta dos .cds para copiar.", "info");
        return;
    }

    // Perfil x versão dos exes da pasta: se não combinarem, confirma antes de copiar
    btn.disabled = true;
    appendLog('Conferindo a versão dos executáveis da pasta...', LOG_COLORS.info, 'copiar');
    let versaoPasta = null;
    try {
        versaoPasta = await window.api.getBranchVersion({ branchPath: baseBranch, fileNames: [...clientList, ...serverList].map(i => i.Nome) });
    } catch (e) { /* sem a leitura de versão, segue o fluxo normal */ }
    btn.disabled = false;
    if (versaoPasta && versaoPasta.perfil && versaoPasta.perfil !== perfilAtivo) {
        const seguir = await confirmarAsync(
            'Perfil diferente da versão dos executáveis',
            `Os executáveis desta pasta são da versão ${versaoPasta.version} (perfil ${versaoPasta.perfil}), mas o perfil selecionado é ${perfilAtivo}. Deseja copiar mesmo assim?`
        );
        if (!seguir) return;
    }

    isCopying = true;
    toggleUILock(true);
    btn.textContent = "Cancelar Cópia";
    btn.classList.add('is-copying');
    
    await window.saveConfig();

    // Salva a seleção atual na memória persistente
    const currentSelection = {
        clients: Array.from(document.querySelectorAll('.chk-client:checked')).map(c => JSON.parse(c.value).Nome),
        servers: Array.from(document.querySelectorAll('.chk-server:checked')).map(c => JSON.parse(c.value).Nome),
        bds: Array.from(document.querySelectorAll('.chk-bd:checked')).map(c => c.value),
        perfil: perfilAtivo,
        timestamp: new Date().toISOString()
    };
    fullConfig.ULTIMA_COPIA = currentSelection;
    await window.api.saveConfigSection('ULTIMA_COPIA', currentSelection).catch(() => {});
    const btnRepeat = document.getElementById('btnRepeatLastCopy');
    if (btnRepeat) btnRepeat.style.display = 'flex';

    // Inicializa a barra de progresso visual
    const pContainer = document.getElementById('copyProgressContainer');
    const pBar = document.getElementById('copyProgressBar');
    const pCount = document.getElementById('copyProgressCount');
    const pLabel = document.getElementById('copyProgressLabel');

    if (pContainer) pContainer.style.display = 'block';
    if (pBar) pBar.style.width = '0%';
    if (pCount) pCount.textContent = `0 / ${reqs.length}`;
    if (pLabel) pLabel.textContent = 'Validando branch...';

    // === ITEM 3: Validação Inteligente da Branch ===
    const fileNamesToCheck = [];
    reqs.forEach(r => {
        if (r.type === 'client' || r.type === 'server') {
            fileNamesToCheck.push(ensureExeSuffix(r.itemData.Nome));
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
        } else if (validation.scenario === 'root_branches') {
            showCustomModal(
                "Escolha a branch da tarefa",
                "O caminho informado é a pasta que contém TODAS as branches (ex.: a ERP). Complete com a pasta da branch da sua tarefa (ex.: ...\\ERP\\AG-12345-main): digite o começo do nome depois do caminho para ver as sugestões, ou use o botão Procurar.",
                "info"
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
        btn.classList.remove('is-copying');
        if (pContainer) pContainer.style.display = 'none';
        return;
    }
    appendLog('Branch validada com sucesso.', LOG_COLORS.success, 'copiar');

    // === ITEM 2: Fechar Clientes antes da cópia (em paralelo — processos independentes) ===
    const checkedClients = Array.from(document.querySelectorAll('.chk-client:checked')).map(c => JSON.parse(c.value));
    if (checkedClients.length > 0) {
        appendLog('Encerrando aplicativos clientes selecionados...', LOG_COLORS.info, 'copiar');
        await Promise.all(checkedClients.map(async (cli) => {
            const procName = ensureExeSuffix(cli.Nome);
            const result = await window.api.killProcess(procName);
            if (result.killed) {
                appendLog(`Processo ${procName} encerrado.`, LOG_COLORS.success, 'copiar');
            }
        }));
    }

    const checkedServers = Array.from(document.querySelectorAll('.chk-server:checked')).map(c=>JSON.parse(c.value));

    appendLog('Parando serviços/apps selecionados...', LOG_COLORS.info, 'copiar');
    const paradas = await Promise.all(checkedServers.map(async (srv) => ({ srv, ok: await window.api.manageServer({ srv, action: 'stop' }) })));

    // O que foi parado aqui PRECISA voltar, seja qual for o desfecho (concluída, cancelada, erro ou aborto).
    // Só os serviços do Windows sobem de novo; aplicações (.exe) são encerradas e ficam por conta de quem testa.
    const religar = async (aviso) => {
        const servicos = paradas.filter(p => p.ok && p.srv.Tipo === 'Servico').map(p => p.srv);
        if (servicos.length === 0) return;
        if (aviso) appendLog(aviso, LOG_COLORS.retry, 'copiar');
        await Promise.all(servicos.map(srv => window.api.manageServer({ srv, action: 'start' })));
    };

    // Parada que falhou (normalmente "acesso negado" por falta de Administrador): copiar assim só geraria
    // erro em cada arquivo preso, então aborta antes de mexer em qualquer arquivo.
    const falhasNaParada = paradas.filter(p => !p.ok).map(p => p.srv.Nome);
    if (falhasNaParada.length > 0) {
        appendLog(`Cópia abortada: não foi possível parar ${falhasNaParada.join(', ')}. Nenhum arquivo foi copiado.`, LOG_COLORS.error, 'copiar');
        showCustomModal(
            'Não foi possível parar os serviços',
            `Não foi possível parar: ${falhasNaParada.join(', ')}. Nenhum arquivo foi copiado. Na maioria das vezes é falta de privilégio: feche o ExeBoard e abra-o novamente como Administrador (clique com o botão direito > Executar como administrador).`,
            'error'
        );
        try { await religar('Religando os serviços que já tinham sido parados...'); } catch (e) { /* já logado por manage-server */ }
        isCopying = false;
        toggleUILock(false);
        btn.textContent = "Copiar Dados";
        btn.classList.remove('is-copying');
        if (pContainer) pContainer.style.display = 'none';
        return;
    }

    let avisoReligar = null; // texto mostrado antes de religar quando a cópia não terminou normalmente
    try {
        if (pLabel) pLabel.textContent = 'Mapeando arquivos na Branch...';
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
            await window.saveConfig(); // Persiste o aprendizado
            appendLog(`[MEMÓRIA] ${learnedPaths.length} caminhos foram aprendidos e salvos.`, LOG_COLORS.automation, 'copiar');
            renderLists();
        }

        if (pLabel) pLabel.textContent = 'Copiando arquivos...';
        const block = await window.api.executarCopia(queue);

        if (block.status === 'completed') {
            const skippedMsg = block.skipped ? ` (${block.skipped} ignorado(s))` : '';
            const hasErrors = block.errors > 0;
            const errorsMsg = hasErrors ? ` (${block.errors} com erro — veja o log acima)` : '';
            appendLog(`Cópia finalizada. ${block.news} arquivos processados${skippedMsg}${errorsMsg}.`, hasErrors ? LOG_COLORS.retry : LOG_COLORS.success, 'copiar');
            if (pBar) pBar.style.width = '100%';
            if (pLabel) pLabel.textContent = hasErrors ? 'Concluído com erros' : 'Concluído com sucesso!';
        } else {
            appendLog(`Operação cancelada ou interrompida. Erros: ${block.errors}`, LOG_COLORS.error, 'copiar');
            if (pLabel) pLabel.textContent = 'Cópia cancelada ou interrompida';
            avisoReligar = 'Cópia interrompida: religando os serviços que foram parados...';
        }
    } catch (err) {
        appendLog(`ERRO CRÍTICO na comunicação: ${err.message}`, LOG_COLORS.error, 'copiar');
        if (pLabel) pLabel.textContent = 'Erro durante a cópia';
        avisoReligar = 'Erro durante a cópia: religando os serviços que foram parados...';
    } finally {
        // Sobe de volta os serviços parados — também quando cancelou ou deu erro (antes ficavam parados)
        try { await religar(avisoReligar); } catch (e) { appendLog(`Erro ao religar serviços: ${e.message}`, LOG_COLORS.error, 'copiar'); }
        setTimeout(() => {
            if (!isCopying && pContainer) pContainer.style.display = 'none';
        }, 3000);
    }

    isCopying = false;
    toggleUILock(false);
    btn.textContent = "Copiar Dados";
    btn.classList.remove('is-copying');
});

// Helper: Trava de Interface
function toggleUILock(lock) {
    // Inputs de Caminhos
    document.getElementById('edtCaminhoBranch').disabled = lock;
    document.getElementById('txtDestinoClientes').disabled = lock;
    document.getElementById('txtDestinoServidores').disabled = lock;
    document.getElementById('txtDestinoAtualizadores').disabled = lock;

    // Checkboxes das Listas
    document.querySelectorAll('.chk-client, .chk-server, .chk-bd').forEach(cb => cb.disabled = lock);

    // Botões de Ação na Aba Principal
    document.getElementById('btnBuscarPath').disabled = lock;
    document.querySelectorAll('#perfilSwitch button').forEach(b => b.disabled = lock);
    const btnRepeat = document.getElementById('btnRepeatLastCopy');
    if (btnRepeat) btnRepeat.disabled = lock;
    document.querySelectorAll('.btn-icon').forEach(b => b.disabled = lock);

    // Botões da Aba Configurações (Prevenção extra)
    const configBtns = ["btnRemoveSelected", "btnCancelChanges", "btnSaveConfig"];
    configBtns.forEach(id => {
        const el = document.getElementById(id);
        if(el) el.disabled = lock;
    });
}

// Mocking actions
// Pasta ERP padrão (config-padrao.json): onde ficam as pastas de cada branch no Google Drive.
// É o ponto de partida do Procurar quando o campo da Branch ainda está vazio.
let raizBranchesCache;
async function getRaizBranches() {
    if (raizBranchesCache === undefined) {
        try {
            const r = await window.api.getDefaultConfig();
            raizBranchesCache = (r && r.data && r.data.CAMINHOS && r.data.CAMINHOS.RAIZ_BRANCHES) || '';
        } catch (e) { raizBranchesCache = ''; }
    }
    return raizBranchesCache;
}

// Passo 9 do tutorial: deixa o campo da Branch pronto — com a pasta ERP completa, editável e com o
// cursor no fim — e abre as sugestões, pra pessoa digitar o começo da branch da tarefa.
async function prepararPassoBranch() {
    const input = document.getElementById('edtCaminhoBranch');
    if (!input) return;
    input.readOnly = false; // o tutorial trava os campos no passo 2; aqui o campo precisa aceitar digitação
    if (!input.value.trim()) {
        const raiz = await getRaizBranches();
        if (raiz && tutorialStep === 9) {
            const caminho = raiz.endsWith('\\') ? raiz : raiz + '\\';
            // só preenche se a pasta existir nesta máquina (as sugestões vêm vazias se não existir)
            if ((await window.api.getPathSuggestions(caminho)).length > 0) {
                input.value = caminho;
                markUnsaved();
            }
        }
    }
    if (tutorialStep !== 9) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input')); // mostra as sugestões da pasta
}

document.getElementById('btnBuscarPath').addEventListener('click', async () => {
    let current = document.getElementById('edtCaminhoBranch').value;
    if (!current.trim()) current = await getRaizBranches(); // campo vazio: já abre na pasta ERP (se existir na máquina)
    const p = await window.api.openFileGetFolder(current);
    if(p) {
        document.getElementById('edtCaminhoBranch').value = p;
        markUnsaved();
        verificarBranch();
        // Escolheu a pasta no passo 9 do tutorial -> passo final
        if (typeof tutorialStep !== 'undefined' && tutorialStep === 9) updateTutorial(10);
    }
});




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

// Listeners para edição manual dos diretórios
['txtDestinoAtualizadores', 'txtDestinoClientes', 'txtDestinoServidores'].forEach(inputId => {
    const el = document.getElementById(inputId);
    if (el) {
        el.addEventListener('input', () => {
            markUnsaved();
            // Progressão do Tutorial
            if (typeof tutorialStep !== 'undefined') {
                if (tutorialStep === 2 && inputId === 'txtDestinoAtualizadores' && el.value.trim().length > 3) updateTutorial(3);
                else if (tutorialStep === 3 && inputId === 'txtDestinoClientes' && el.value.trim().length > 3) updateTutorial(4);
                else if (tutorialStep === 4 && inputId === 'txtDestinoServidores' && el.value.trim().length > 3) updateTutorial(5);
            }
        });
    }
});

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
        SubDiretorios: '', // Serviços Windows não possuem subpasta de destino no ExeBoard
        Perfil: '*' // serviço nativo (ex.: Firebird) costuma servir aos dois lotes — e não tem lápis para ajustar depois
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
                    AppServidora: true, SubDiretorios: subToUse, Perfil: perfilAtivo
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
                        IsPureService: false, AppServidora: true, SubDiretorios: subFinal, Perfil: perfilAtivo
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

        clientList.push({Nome: exe, SubDiretorios: subToUse, Perfil: perfilAtivo}); // entra no lote que está em uso
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
            showCustomModal("Aviso", `A pasta dos .cds ${name} já está na lista.`, "info");
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

    fullConfig.APLICACOES_CLIENTE = montarSecaoClientes();
    fullConfig.APLICACOES_SERVIDORAS = montarSecaoServidores();

    fullConfig.BANCO_DE_DADOS = { Count: bdList.length };
    bdList.forEach((b, i) => { fullConfig.BANCO_DE_DADOS[`BancoDados${i}`] = b; });
    
    // Geral
    if(!fullConfig.GERAL) fullConfig.GERAL = {};
    fullConfig.GERAL.HABILITAR_TRAY = document.getElementById('chkHabilitarTray').checked ? '1' : '0';
    fullConfig.GERAL.TEMA = document.body.classList.contains('light-theme') ? 'light' : 'dark';
    fullConfig.GERAL.PERFIL_ATIVO = perfilAtivo;

    await window.api.saveConfig(fullConfig);
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

// Versão com Promise do showConfirmModal: resolve true (Confirmar) ou false (Cancelar)
window.confirmarAsync = (titulo, texto) => new Promise((resolve) => {
    showConfirmModal(titulo, texto, () => resolve(true));
    document.getElementById('modalBtnCancel').onclick = () => {
        document.getElementById('customModal').style.display = 'none';
        resolve(false);
    };
});

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
            verificarBranch();
            // Escolheu uma sugestão no passo 9 do tutorial -> passo final
            if (tutorialStep === 9) updateTutorial(10);
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

// ==== Aviso de executáveis antigos na pasta da Branch ====
// Roda quando a pasta é informada (ao sair do campo/Enter, ao escolher uma sugestão ou pelo
// botão Procurar) e ao abrir o app. Aviso na tela, sem bloquear a cópia.
let branchAgeCheckToken = 0;

function hideBranchAgeWarning() {
    const box = document.getElementById('branchAgeWarning');
    if (box) { box.style.display = 'none'; box.textContent = ''; }
}

async function checkBranchExeAge() {
    const box = document.getElementById('branchAgeWarning');
    if (!box || !window.api.checkExeAge) return;

    const token = ++branchAgeCheckToken;
    const branchPath = inputBranch.value.trim();
    const names = [...clientList, ...serverList].filter(perfilVisivel).map(i => i.Nome); // só o perfil ativo
    if (!branchPath || names.length === 0) { hideBranchAgeWarning(); return; }

    const res = await window.api.checkExeAge({ branchPath, fileNames: names });
    if (token !== branchAgeCheckToken) return; // a pasta mudou enquanto verificava
    if (!res || !res.old || res.old.length === 0) { hideBranchAgeWarning(); return; }

    // textContent em tudo: os nomes vêm da configuração, nada de HTML montado à mão
    box.textContent = '';
    const maisAntigo = res.old[0].ageDays;

    const title = document.createElement('div');
    title.className = 'age-warning-title';
    title.textContent = res.old.length === 1
        ? `⚠️ ${res.old[0].name} foi gerado há ${maisAntigo} dias (limite: ${res.warnDays}).`
        : `⚠️ ${res.old.length} de ${res.checked} executáveis foram gerados há mais de ${res.warnDays} dias (o mais antigo: ${maisAntigo} dias).`;
    box.appendChild(title);

    if (res.old.length > 1) {
        const list = document.createElement('div');
        list.className = 'age-warning-list';
        res.old.slice(0, 6).forEach(o => {
            const row = document.createElement('div');
            row.textContent = `${o.name} — ${o.ageDays} dias`;
            list.appendChild(row);
        });
        if (res.old.length > 6) {
            const more = document.createElement('div');
            more.textContent = `e mais ${res.old.length - 6}...`;
            list.appendChild(more);
        }
        box.appendChild(list);
    }

    const hint = document.createElement('div');
    hint.className = 'age-warning-hint';
    hint.textContent = 'Confirme se esta é a pasta/build correto antes de copiar.';
    box.appendChild(hint);

    const close = document.createElement('button');
    close.className = 'age-warning-close';
    close.title = 'Dispensar aviso';
    close.textContent = '✕';
    close.onclick = hideBranchAgeWarning;
    box.appendChild(close);

    box.style.display = 'block';
    appendLog(`Aviso: executáveis com mais de ${res.warnDays} dias na pasta da Branch (o mais antigo tem ${maisAntigo} dias).`, LOG_COLORS.retry, 'copiar');
}

// ==== Perfil x versão dos executáveis da pasta ====
// Os exes do lote 733 são versão 4.x e os do 734 são 5.x. Lê a versão de um exe da pasta, sugere o
// perfil certo e avisa quando o perfil selecionado não combina (com botão pra trocar com um clique).
let branchVersionToken = 0;
let ultimaVersao = null; // resposta de get-branch-version para a pasta atual

function mostrarAvisoPerfil() {
    const box = document.getElementById('branchProfileWarning');
    if (!box) return;
    const res = ultimaVersao;
    box.textContent = '';
    if (!res || !res.perfil || res.perfil === perfilAtivo) { box.style.display = 'none'; return; }

    const title = document.createElement('div');
    title.className = 'age-warning-title';
    title.textContent = `⚠️ Os executáveis desta pasta são da versão ${res.version} (perfil ${res.perfil}), mas o perfil selecionado é ${perfilAtivo}.`;
    box.appendChild(title);

    const acao = document.createElement('button');
    acao.className = 'btn-secondary age-warning-action';
    acao.textContent = `Trocar para ${res.perfil}`;
    acao.onclick = () => trocarPerfil(res.perfil);
    box.appendChild(acao);

    box.style.display = 'block';
}

async function checkBranchVersion() {
    if (!window.api.getBranchVersion) return;
    const token = ++branchVersionToken;
    const branchPath = inputBranch.value.trim();
    const names = [...clientList, ...serverList].map(i => i.Nome); // todos os perfis: o exe achado define o perfil
    ultimaVersao = null;
    if (!branchPath || names.length === 0) { mostrarAvisoPerfil(); return; }

    const res = await window.api.getBranchVersion({ branchPath, fileNames: names });
    if (token !== branchVersionToken) return; // a pasta mudou enquanto lia a versão
    ultimaVersao = res;
    mostrarAvisoPerfil();
    if (res && res.perfil && res.perfil !== perfilAtivo) {
        appendLog(`Aviso: os executáveis da pasta são da versão ${res.version} (perfil ${res.perfil}) e o perfil selecionado é ${perfilAtivo}.`, LOG_COLORS.retry, 'copiar');
    }
}

// Conferências que rodam quando a pasta da Branch é informada
function verificarBranch() {
    checkBranchExeAge();
    checkBranchVersion();
}

inputBranch.addEventListener('change', verificarBranch);

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
        window.api.saveConfig(fullConfig);
    });

});

// ==== Interactive Tutorial (Onboarding) ====
let tutorialStep = 0;

// Um passo está "cumprido" quando o que ele pede já existe (útil ao rever o tutorial já configurado)
function tutorialStepDone(step) {
    const preenchido = (id) => ((document.getElementById(id) || {}).value || '').trim().length > 3;
    switch (step) {
        case 2: return preenchido('txtDestinoAtualizadores');
        case 3: return preenchido('txtDestinoClientes');
        case 4: return preenchido('txtDestinoServidores');
        case 5: return bdList.length >= 1;
        case 6: return clientList.length >= 1;
        case 7: return serverList.length >= 1;
        default: return false;
    }
}

// Grava que o tutorial já foi concluído/pulado, pra não reaparecer a cada abertura com as listas vazias
async function markTutorialDone() {
    try {
        if (!fullConfig.GERAL) fullConfig.GERAL = {};
        if (fullConfig.GERAL.TUTORIAL_CONCLUIDO === '1') return;
        fullConfig.GERAL.TUTORIAL_CONCLUIDO = '1';
        await window.api.saveConfigSection('GERAL', fullConfig.GERAL);
    } catch (e) { /* não impede o uso do app */ }
}

// Botões do card: "Usar configuração padrão" (passo 1), "Pular tutorial" (qualquer passo), "Entendi" (último)
function renderTutorialActions(step) {
    const box = document.getElementById('onboardingActions');
    if (!box) return;
    box.textContent = '';
    if (step === 0) return;
    const add = (label, cls, handler) => {
        const b = document.createElement('button');
        b.className = cls;
        b.textContent = label;
        b.onclick = handler;
        box.appendChild(b);
    };
    if (step === 1) add('Usar configuração padrão', 'btn-primary', () => applyDefaultConfig({ fromTutorial: true }));
    if (step === 9) add('Continuar', 'btn-primary', () => updateTutorial(10));
    if (step === 10) add('Entendi', 'btn-primary', () => updateTutorial(0));
    else add('Pular tutorial', 'btn-secondary', () => updateTutorial(0));
}

window.replayTutorial = () => {
    const abaCopiar = document.querySelector('.nav-links li[data-tab="copiar"]');
    if (abaCopiar) abaCopiar.click();
    updateTutorial(1);
};

// Aplica o config-padrao.json SEM apagar nada: só preenche pastas vazias e acrescenta o que falta nas listas
window.applyDefaultConfig = async (opts = {}) => {
    const aplicar = async () => {
        const res = await window.api.getDefaultConfig();
        if (!res || res.error || !res.data) {
            showCustomModal('Configuração padrão', `Não foi possível carregar a configuração padrão: ${(res && res.error) || 'arquivo não encontrado'}.`, 'error');
            return false;
        }
        const d = res.data;
        let added = 0;
        let classificados = 0;

        const setIfEmpty = (id, value) => {
            const el = document.getElementById(id);
            if (el && value && !el.value.trim()) { el.value = value; added++; }
        };
        setIfEmpty('txtDestinoClientes', d.CAMINHOS && d.CAMINHOS.PASTA_CLIENT);
        setIfEmpty('txtDestinoServidores', d.CAMINHOS && d.CAMINHOS.PASTA_SERVER);
        setIfEmpty('txtDestinoAtualizadores', d.CAMINHOS && d.CAMINHOS.PASTA_DADOS);

        // Itens que já existem mas ainda não têm perfil (listas antigas) recebem o perfil do padrão
        const classificar = (existente, padrao) => {
            if (!existente.Perfil && padrao.Perfil) { existente.Perfil = padrao.Perfil; classificados++; }
        };

        (d.CLIENTES || []).forEach(c => {
            const existente = clientList.find(x => x.Nome.toLowerCase() === c.Nome.toLowerCase());
            if (existente) { classificar(existente, c); return; }
            clientList.push({ Nome: c.Nome, SubDiretorios: c.SubDiretorios || '', Perfil: c.Perfil || '' });
            added++;
        });
        (d.SERVIDORES || []).forEach(s => {
            const existente = serverList.find(x => x.Nome.toLowerCase() === s.Nome.toLowerCase());
            if (existente) { classificar(existente, s); return; }
            serverList.push({
                Nome: s.Nome,
                Tipo: s.Tipo || 'Servico',
                IsPureService: !!s.IsPureService,
                AppServidora: s.AppServidora !== false,
                SubDiretorios: s.SubDiretorios || '',
                Perfil: s.Perfil || ''
            });
            added++;
        });
        (d.PASTAS_CDS || []).forEach(n => {
            if (!bdList.some(x => x.toLowerCase() === n.toLowerCase())) { bdList.push(n); added++; }
        });

        renderLists();
        await window.saveConfig();
        return { added, classificados };
    };

    const resumo = (r) => {
        const partes = [];
        if (r.added > 0) partes.push(`${r.added} item(ns) adicionado(s)`);
        if (r.classificados > 0) partes.push(`${r.classificados} item(ns) classificado(s) por perfil (733/734)`);
        return partes.join(' e ');
    };

    if (opts.fromTutorial) {
        const r = await aplicar();
        if (r !== false) {
            appendLog(`Configuração padrão aplicada (${resumo(r) || 'nada a alterar'}).`, LOG_COLORS.success, 'copiar');
            updateTutorial(9); // pastas e listas prontas: falta só apontar a pasta da Branch
        }
        return;
    }

    showConfirmModal(
        'Usar configuração padrão',
        'Isto adiciona as pastas e os executáveis padrão que ainda não estão na sua lista e define o perfil (733/734) dos itens que ainda não têm um. Nada do que você já configurou é removido, e perfis que você já escolheu não mudam. Deseja continuar?',
        async () => {
            const r = await aplicar();
            if (r === false) return;
            showCustomModal('Configuração padrão',
                resumo(r) ? `${resumo(r)}. Configuração salva.` : 'Sua configuração já tinha tudo o que existe no padrão. Nada foi alterado.',
                'info');
        }
    );
};

function updateTutorial(step) {
    // Pula passos que já estão cumpridos (ex.: ao rever o tutorial com tudo configurado)
    while (step >= 2 && step <= 7 && tutorialStepDone(step)) step++;
    tutorialStep = step;
    const title = document.getElementById('onboardingTitle');
    const text = document.getElementById('onboardingText');
    const spotlight = document.getElementById('onboardingSpotlight');
    const arrow = document.getElementById('onboardingArrow');

    // Remove previous highlights
    document.querySelectorAll('.spotlight-highlight').forEach(el => el.classList.remove('spotlight-highlight'));
    document.querySelectorAll('.spotlight-lift').forEach(el => el.classList.remove('spotlight-lift'));
    
    if (step === 0) {
        document.body.classList.remove('onboarding-active');
        markTutorialDone();
        renderTutorialActions(0);
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
            title.innerText = 'Passo 1/6: Pasta raiz dos Dados';
            text.innerHTML = 'Selecione a pasta <b>raiz dos dados</b>, que contém as pastas dos bancos com os arquivos <b>.cds</b> (Ex: <b>C:\\Viasoft\\Dados</b>). Clique na lupa e escolha essa pasta.<br>A pasta de cada banco (ex: <b>Firebird</b>), que fica dentro dela, você adiciona depois no botão <b>Adicionar Pasta dos .cds</b>.';
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
            text.innerHTML = 'Agora selecione a pasta onde ficam os <b>executáveis</b> dos clientes (como <b>AgroX</b> e <b>Agro3C</b>). Normalmente é <b>C:\\Viasoft\\Client</b>.';
            arrowChar = '↑';
            position = 'bottom-center';
            break;
        case 4:
            targetId = 'btnLupaOnboarding3';
            title.innerText = 'Passo 3/6: Quase lá...';
            text.innerHTML = 'Por fim, selecione a pasta onde ficam os <b>executáveis</b> dos servidores (como <b>ViasoftServerAgro</b>). Normalmente é <b>C:\\Viasoft\\Server</b>.';
            arrowChar = '↑';
            position = 'bottom-right';
            break;
        case 5:
            targetId = 'btnAddAtualizador';
            title.innerText = 'Passo 4/6: Pastas dos .cds';
            text.innerHTML = 'Muito bem. Agora adicione pelo menos uma <b>Pasta dos .cds</b> na sua lista: é a pasta de cada banco, dentro da raiz de Dados (ex: <b>Firebird</b>).';
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
            title.innerText = 'Quase lá! 💡';
            text.innerHTML = 'A branch da sua tarefa fica dentro da pasta <b>ERP</b> do Google Drive (ex: <b>G:\\Drives compartilhados\\Viasoft Sistemas\\Agro\\Versoes\\ERP</b>), uma pasta por branch. O campo já vem com esse caminho: <b>digite o começo do nome da branch</b> (ex: <b>AG-34060</b>) e escolha nas <b>sugestões</b>, ou use o <b>Procurar</b>. Confirme também que o Google Drive está instalado e sincronizado. Experimente e clique em <b>Continuar</b>.';
            arrowChar = '↑';
            position = 'bottom-right';
            break;
        case 10:
            targetId = 'btnCopiarDados';
            title.innerText = 'Agora é só copiar! 🚀';
            text.innerHTML = 'Para copiar: escolha o <b>perfil</b> do lote (<b>733</b> ou <b>734</b>) acima do botão, a pasta da branch da sua tarefa em <b>Procurar</b>, marque nas listas o que quer atualizar e clique em <b>Copiar Dados</b>. O progresso aparece na barra e o <b>Log de Atividades</b> mostra cada arquivo. Se os executáveis forem antigos (mais de 10 dias) ou de outro lote, o ExeBoard avisa logo abaixo do campo da Branch.';
            arrowChar = '↓';
            position = 'top-right';
            break;
    }

    renderTutorialActions(step);

    if (step === 9) {
        // Eleva o campo da Branch (e a lista de sugestões dentro dele) acima do escurecimento do tutorial
        const caixa = document.querySelector('.path-input-container');
        if (caixa) caixa.classList.add('spotlight-lift');
        const campo = document.getElementById('edtCaminhoBranch');
        if (campo) campo.classList.add('spotlight-highlight');
        prepararPassoBranch();
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

// ==== BITBUCKET EXTRACTION ====

// Auto-save de credenciais no blur (evento correto para "perder foco")
['bbWorkspace', 'bbRepo', 'bbUser', 'bbPassword'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('blur', async () => {
            const data = {
                WORKSPACE: document.getElementById('bbWorkspace').value.trim(),
                REPO: document.getElementById('bbRepo').value.trim(),
                USER: document.getElementById('bbUser').value.trim(),
                PASSWORD: document.getElementById('bbPassword').value.trim(),
                TARGET_DIR: document.getElementById('bbTargetDir').value.trim()
            };
            await window.api.saveConfigSection('BITBUCKET', data);
        });
    }
});

// Auto-save do campo de destino no blur também
document.getElementById('bbTargetDir')?.addEventListener('blur', async () => {
    const data = {
        WORKSPACE: document.getElementById('bbWorkspace').value.trim(),
        REPO: document.getElementById('bbRepo').value.trim(),
        USER: document.getElementById('bbUser').value.trim(),
        PASSWORD: document.getElementById('bbPassword').value.trim(),
        TARGET_DIR: document.getElementById('bbTargetDir').value.trim()
    };
    await window.api.saveConfigSection('BITBUCKET', data);
});

// Selecionar pasta via diálogo do sistema (fix: openFolder retorna string, não array)
async function selecionarDestinoBitbucket() {
    const defaultPath = document.getElementById('bbTargetDir').value;
    const selectedPath = await window.api.openFolder(defaultPath);
    if (selectedPath) {
        document.getElementById('bbTargetDir').value = selectedPath;
        document.getElementById('bbTargetDir').dispatchEvent(new Event('blur'));
    }
}

// Busca dinâmica de branches para autocomplete
async function fetchBitbucketBranchesDynamic(searchTerm) {
    const workspace = document.getElementById('bbWorkspace').value.trim();
    const repo = document.getElementById('bbRepo').value.trim();
    const user = document.getElementById('bbUser').value.trim();
    const appPassword = document.getElementById('bbPassword').value.trim();
    
    if (!workspace || !repo || !user || !appPassword) {
        return { branches: [], error: 'Preencha Workspace, Repositório, Usuário e API Token acima para listar as branches.' };
    }

    // devolve { branches, error }: o erro real da API (ex.: 403 por falta de 2FA) em vez de "lista vazia"
    return await window.api.listBranches({ workspace, repo, user, appPassword, searchTerm });
}

// Lógica Customizada de Autocomplete para Branches com Debounce (Live Search)
function renderBbSuggestions(inputId, suggestId) {
    const input = document.getElementById(inputId);
    const suggestBox = document.getElementById(suggestId);
    let debounceTimer;
    
    const handler = async () => {
        clearTimeout(debounceTimer);
        const val = input.value.trim();
        
        // UX Extra: Feedback visual
        suggestBox.innerHTML = '<div class="suggestion-item" style="color: var(--warning); opacity: 0.8; cursor: default;">⏳ Carregando...</div>';
        suggestBox.style.display = 'block';
        
        debounceTimer = setTimeout(async () => {
            const { branches, error } = await fetchBitbucketBranchesDynamic(val);

            suggestBox.innerHTML = '';
            if (error) {
                const aviso = document.createElement('div');
                aviso.className = 'suggestion-item';
                aviso.style.cssText = 'color: var(--danger); cursor: default; white-space: normal;';
                aviso.textContent = error; // textContent: o texto vem da API, nunca como HTML
                suggestBox.appendChild(aviso);
            } else if (branches.length > 0) {
                branches.forEach(s => {
                    const item = document.createElement('div');
                    item.className = 'suggestion-item';
                    item.textContent = s;
                    item.onclick = () => {
                        input.value = s;
                        suggestBox.style.display = 'none';
                    };
                    suggestBox.appendChild(item);
                });
            } else {
                suggestBox.innerHTML = '<div class="suggestion-item" style="color: var(--danger); cursor: default;">Nenhuma branch encontrada</div>';
            }
        }, 400); // Debounce de 400ms
    };

    // Apenas evento de input para não engatilhar sem necessidade e proteger a API
    input?.addEventListener('input', handler);
}

renderBbSuggestions('bbBase', 'suggest-bbBase');
renderBbSuggestions('bbBranch', 'suggest-bbBranch');

// Oculta ao clicar fora
document.addEventListener('click', (e) => {
    if (e.target !== document.getElementById('bbBase')) document.getElementById('suggest-bbBase').style.display = 'none';
    if (e.target !== document.getElementById('bbBranch')) document.getElementById('suggest-bbBranch').style.display = 'none';
});

// Helper para coletar config do modal
function getBbConfig() {
    return {
        workspace: document.getElementById('bbWorkspace').value.trim(),
        repo: document.getElementById('bbRepo').value.trim(),
        user: document.getElementById('bbUser').value.trim(),
        appPassword: document.getElementById('bbPassword').value.trim(),
        base: document.getElementById('bbBase').value.trim() || 'main',
        branch: document.getElementById('bbBranch').value.trim(),
        targetDir: document.getElementById('bbTargetDir').value.trim()
    };
}

// Botão "Verificar Arquivos" — Preview antes de baixar
document.getElementById('btnVerifyBitbucket')?.addEventListener('click', async () => {
    const cfg = getBbConfig();
    
    if (!cfg.workspace || !cfg.repo || !cfg.user || !cfg.appPassword || !cfg.branch) {
        appendLog('Preencha Credenciais e Branch da Tarefa para verificar.', '#f38ba8', 'copiar');
        return;
    }
    
    const btn = document.getElementById('btnVerifyBitbucket');
    btn.disabled = true;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg> Verificando...';
    
    const preview = document.getElementById('bbPreviewContainer');
    preview.style.display = 'none';
    preview.innerHTML = '';
    
    try {
        // A consulta à API roda no backend (sem depender de CORS/CSP da tela) e devolve o erro real
        const r = await window.api.verifyBitbucket({ workspace: cfg.workspace, repo: cfg.repo, user: cfg.user, appPassword: cfg.appPassword, base: cfg.base, branch: cfg.branch });
        if (!r.success) {
            const erro = document.createElement('span');
            erro.style.color = '#f38ba8';
            erro.textContent = 'Erro: ' + r.msg; // textContent: texto vindo da API
            preview.appendChild(erro);
            preview.style.display = 'block';
            return;
        }
        const files = r.files;
        
        if (files.length === 0) {
            preview.innerHTML = '<span style="color: #fbbf24;">Nenhum arquivo modificado encontrado entre as branches.</span>';
        } else {
            // Extrai apenas o basename de cada arquivo e renderiza como lista organizada
            const fileNames = files.map(f => f.split('/').pop());
            const headerHtml = `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid rgba(255,255,255,0.08);">
                <strong style="color: var(--text-primary); font-size: 0.82rem;">${files.length} arquivo(s) encontrado(s)</strong>
                <span style="font-size:0.72rem; opacity:0.5;">Preview</span>
            </div>`;
            const listHtml = fileNames.map((name, i) => `<div style="display:flex; align-items:center; gap:8px; padding:4px 8px; border-radius:4px; background:${i % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'transparent'};">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${String(name).replace(/[&<>"']/g, ch => '&#' + ch.charCodeAt(0) + ';')}</span>
            </div>`).join('');
            preview.innerHTML = headerHtml + `<div style="display:flex; flex-direction:column; gap:2px;">${listHtml}</div>`;
        }
        preview.style.display = 'block';
    } catch (err) {
        preview.innerHTML = `<span style="color: #f38ba8;">Erro de conexão: ${err.message}</span>`;
        preview.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg> Verificar Arquivos';
    }
});

// Botão "Iniciar Extração"
document.getElementById('btnExtractBitbucket')?.addEventListener('click', async () => {
    const cfg = getBbConfig();
    
    if (!cfg.workspace || !cfg.repo || !cfg.user || !cfg.appPassword || !cfg.branch || !cfg.targetDir) {
        appendLog('Por favor, preencha todos os campos obrigatórios da extração.', '#f38ba8', 'copiar');
        return;
    }
    
    document.getElementById('modalBitbucket').style.display = 'none';
    appendLog(`[Extrator Cloud] Iniciando download da branch: ${cfg.branch}`, '#cba6f7', 'copiar');
    
    const btn = document.getElementById('btnExtractBitbucket');
    btn.disabled = true;
    btn.textContent = '⏳ Extraindo...';
    
    const config = { workspace: cfg.workspace, repo: cfg.repo, user: cfg.user, appPassword: cfg.appPassword, base: cfg.base, branch: cfg.branch, targetDir: cfg.targetDir };
    const res = await window.api.extractBitbucket(config);
    
    if (res.success && res.root) {
        window.api.executeExternal(res.root); 
    }
    
    btn.disabled = false;
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Iniciar Extração';
});

// Botão para abrir o Modal do Bitbucket
document.getElementById('btnOpenBitbucket')?.addEventListener('click', () => {
    document.getElementById('modalBitbucket').style.display = 'flex';
});

