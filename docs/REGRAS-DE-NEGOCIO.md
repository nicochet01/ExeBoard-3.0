# ExeBoard — Regras de negócio e comportamento (v3.0.11 + alterações não commitadas)

Documento de referência para a migração Electron → Tauri. **Fonte da verdade durante a migração:** se faltar
algum comportamento, volte aqui; se este documento não cobrir, volte ao código (`main.js`, `renderer.js`,
`index.html`) e **acrescente aqui**.

Levantado a partir da leitura integral de `main.js`, `renderer.js`, `preload.js`, `index.html`, `package.json`
e `config-padrao.json` (estado do disco em 2026-11-16, com tudo que está sem commit desde `6e0a00d`).

**App Tauri (2026-11-17):** o backend foi reescrito em Rust em `tauri/` (interface reaproveitada). Estrutura, build, release e a migração dos usuários do Electron: **seção 19**.

**Atualização 2026-11-17:** as falhas conhecidas (seção 17) foram **corrigidas no app Electron atual**. As seções abaixo já
descrevem o comportamento **corrigido**; a seção 17 traz o que mudou, como foi testado e o que ficou pendente.

Legenda usada nas regras:
- **[FRONT]** vive no `renderer.js`/`index.html`/`style.css`. Na migração a interface é reaproveitada, então
  estas regras **permanecem sozinhas**. Só muda a ponte com o backend (`window.api.*`).
- **[BACK]** vive no `main.js` (Node/Electron). **Precisa ser reescrita** no backend do Tauri.
- **[AMBOS]** tem parte em cada lado.

---

## 1. O que é e para quem

- App Windows para **testadores da Viasoft (Agro)**. Copia executáveis (clientes e servidores) e pastas de banco
  (`.cds`) de uma **pasta de branch** (normalmente no Google Drive compartilhado) para as pastas de ambiente local
  (`C:\Viasoft\Client`, `\Server`, `\Dados`), parando serviços/apps antes e subindo os serviços depois.
- Convive com **dois lotes ("perfis")**: **733** (executáveis versão 4.x, linha DataSnap) e **734** (versão 5.x, linha TMS).
- Equipe (aba Sobre): Fernando — Arquiteto de Software; Giancarlo e Nicolas — Analistas de Teste. Repositório:
  `https://github.com/nicochet01/ExeBoard-3.0`.
- Idioma da interface: **português (pt-BR)**. Todas as mensagens abaixo são em português e devem ser mantidas.

---

## 2. Ambiente, execução e ciclo de vida

### 2.1 Administrador [BACK]
- O instalador/exe é gerado com `requestedExecutionLevel: requireAdministrator` → UAC a cada abertura.
- `check-admin` roda `fltmc`; se não der erro, é admin. Resultado vai para o renderer.
- [FRONT] Na abertura, se **não** for admin: log de aviso (aba Copiar) "O ExeBoard não está como Administrador. Algumas funções de
  servidores podem falhar." e, na aba Servidores, "Para corrigir, clique com o botão direito no programa e
  selecione 'Executar como Administrador'." Se for admin: "Privilégios de Administrador confirmados."
- Sem admin, `sc stop`/`taskkill` dão "acesso negado" (ver 8.3). Isso já causou bug real em campo (EPERM ao
  sobrescrever `.exe` de serviço) — a causa era falta de privilégio.

### 2.2 Instância única [BACK + FRONT]
- Só uma instância. Segunda tentativa de abrir: fecha a nova, e na existente faz `restore` (se minimizada), `show`,
  `focus` e envia o evento `show-instance-warning`.
- [FRONT] Mostra modal "🚀 Aviso do Sistema": "**O ExeBoard já está aberto!** O aplicativo já está em execução no seu computador.
  Esta janela foi trazida para a frente." (só botão Entendido).

### 2.3 Janela [BACK]
- 1100×800, mínimo 1000×700, inicia **oculta** e ao ficar pronta: `center`, `show`, **`maximize`**, `focus`.
- Menu oculto (`autoHideMenuBar`), ícone `assets/LOGO_EXEBOARD.ico`, **sem corretor ortográfico**.
- Isolamento: sem Node na página; só a API exposta pelo preload.
- Logs de crash do renderer (`render-process-gone`) e de janela sem resposta (`unresponsive`).

### 2.4 Fechar (X) e minimizar [BACK]
- **X sempre encerra o app** (não vai para bandeja).
- Se houver **cópia em andamento**, o X é interceptado e abre diálogo: título "Cópia em andamento",
  mensagem "Há uma cópia de arquivos em andamento.", detalhe "Se sair agora, a cópia será interrompida e os arquivos
  que estavam sendo copiados podem ficar incompletos.", botões **"Continuar copiando"** (padrão/cancel) e
  **"Sair mesmo assim"** (cancela a cópia via token e fecha). Só um diálogo por vez.
- **Minimizar**: se `GERAL.HABILITAR_TRAY = '1'`, a janela é **escondida** (vai para a bandeja); senão minimiza normal.
- Ao encerrar de verdade: destrói o ícone da bandeja. `window-all-closed`: encerra se bandeja desabilitada **ou** fechamento real.

### 2.5 Bandeja do sistema [BACK]
- O ícone da bandeja é **criado sempre** na abertura (independe da opção). A opção `HABILITAR_TRAY` só controla o
  comportamento do **minimizar**.
- Tooltip "ExeBoard - Gerenciador". Menu: **Abrir Painel** (mostra, traz ao topo e foca), separador, **Sair ExeBoard**.
- Duplo clique: mostra + traz ao topo + foca. Clique simples: mostra.

### 2.6 Pastas e logs [BACK]
- `userData` = `%APPDATA%\ExeBoard`. Config: `configuracoes.json`. Log de arquivo: `userData\logs\main.log` (nível info).
- Em **desenvolvimento** (app não empacotado) usa `%APPDATA%\ExeBoard-Dev` e, se não existir config lá, **copia a de produção** para ele.
- Handlers globais para `uncaughtException`/`unhandledRejection`: só registram em log (e mandam "Erro Crítico:
  Verifique os logs em AppData." ao log da tela); **não derrubam o app**.
- ⚠️ **Migração:** o Tauri, por padrão, usa outra pasta de dados (baseada no identificador do app). Para não perder
  a configuração dos testadores, **o novo app precisa ler/migrar de `%APPDATA%\ExeBoard\configuracoes.json`** (ver seção 16).

### 2.7 Limpeza de temporários órfãos [BACK]
- Na abertura (sem atrasar a janela), varre as três pastas de destino configuradas (PASTA_CLIENT, PASTA_SERVER, PASTA_DADOS; ignora vazias/com "Informe") e apaga **só** os
  `nome.ext.tmp` (o que a cópia segura grava) **parados há mais de 1 hora** — resto de cópia interrompida por queda de energia/processo morto. Um `.tmp` de outro programa
  (sem a extensão original no nome) ou recente **não é tocado**. Teto de 50 mil entradas visitadas. Loga "Limpeza: N arquivo(s) temporário(s) órfão(s)…" quando remove algo.
---

## 3. Configuração (arquivo único)

### 3.1 Local e carga [BACK]
Regras de `loadConfig` (chamada na abertura e **a cada `read-config`**, ou seja, sempre relê do disco):
1. Se `configuracoes.json` existe → usa (fonte da verdade).
2. Senão, se existe `Inicializar.ini` (no `userData` ou o embutido no app) → **migra** para JSON, grava e **apaga o INI do AppData**.
3. Senão → cria `{ "GERAL": { "HABILITAR_TRAY": "0" } }` e grava.
4. Erro de leitura/parse → usa o padrão em memória (`HABILITAR_TRAY: '0'`) e registra no log (**não** sobrescreve o arquivo).

### 3.2 Gravação [BACK]
- `save-config`: **substitui o arquivo inteiro** pelo objeto enviado (JSON com indentação de 2) e atualiza o cache.
- `save-config-section(nome, dados)`: altera **só aquela seção** no cache e regrava o arquivo (não sobrescreve o resto).
- **Gravações em fila**: duas gravações quase simultâneas nunca se cruzam; a última sempre grava o estado mais recente do cache.
  Antes de gravar, o token do Bitbucket é cifrado (ver 3.3); `read-config` devolve a config já com o token decifrado.
- Quem usa o quê (importante, já causou bug de tema): na abertura e no perfil usa-se **seção**; `saveConfig` completo
  só nas ações explícitas do usuário (Salvar, Copiar, trocar tema).

### 3.3 Esquema (seções e chaves) — formato INI-no-JSON, **valores sempre texto** [FRONT lê/escreve]
```
GERAL:
  HABILITAR_TRAY   "0" | "1"
  TEMA             "dark" | "light"            (padrão dark)
  TUTORIAL_CONCLUIDO "1"                        (ausente = tutorial ainda não concluído)
  PERFIL_ATIVO     "733" | "734"                (inválido/ausente → 734)
CAMINHOS:
  DE               pasta da branch (última usada)
  PASTA_CLIENT     destino dos executáveis clientes
  PASTA_SERVER     destino dos executáveis servidores
  PASTA_DADOS      raiz dos .cds
APLICACOES_CLIENTE:
  Count, Cliente{i}, SubDiretorios{i} (opcional), Perfil{i} (opcional)
APLICACOES_SERVIDORAS:
  Count, Servidor{i}, Tipo{i} ("Servico"|"Aplicacao"), Replicar{i} (sempre "Sim", não lido),
  IsPureService{i} ("Sim"/"Não"), AppServidora{i} ("Sim"/"Não"; ausente na leitura = Sim),
  SubDiretorios{i} (opcional), Perfil{i} (opcional)
BANCO_DE_DADOS:
  Count, BancoDados{i}   (na leitura aceita também Banco{i})
ULTIMA_COPIA:
  clients[], servers[], bds[], perfil, timestamp (ISO)
BITBUCKET:
  WORKSPACE, REPO, USER, TARGET_DIR
  PASSWORD_ENC   token cifrado em disco: "dpapi:" + base64 (DPAPI do Windows, escopo do usuário atual, sem entropia extra)
                 (em memória e na tela o token continua em PASSWORD; arquivo antigo com PASSWORD em texto é migrado
                 sozinho na primeira leitura. Só o MESMO usuário do Windows decifra; outro usuário/máquina → pede o token de novo.
                 No Tauri/Rust: CryptUnprotectData lê esse formato.)
```
- `SubDiretorios`: sempre começa com `\` ou é vazio (vazio = raiz). Normalização ao confirmar na edição: se não vazio e
  não começar com `\`, acrescenta; se for só `\`, vira vazio.
- Listas são **ordenadas alfabeticamente** (`localeCompare`) na leitura e a cada renderização.
- Placeholder legado: qualquer caminho que contenha a palavra **"Informe"** é tratado como "não configurado"
  (validação do Copiar, diálogos de pasta, limpeza de .tmp).

### 3.4 Configuração padrão [AMBOS] — `config-padrao.json` (arquivo ao lado do app)
Conteúdo atual:
- `CAMINHOS`: `PASTA_CLIENT=C:\Viasoft\Client`, `PASTA_SERVER=C:\Viasoft\Server`, `PASTA_DADOS=C:\Viasoft\Dados`,
  `RAIZ_BRANCHES=G:\Drives compartilhados\Viasoft Sistemas\Agro\Versoes\ERP`.
- `CLIENTES` (todos subpasta `\Agro`): 733 → `Agro3C.exe`, `Exped.exe`, `ExpImpAgro3C.exe`, `FinAgro3C.exe`;
  734 → `AgroX.exe`, `ExpedX.exe`, `ExpImpAgroX.exe`, `FinAgroX.exe`.
- `SERVIDORES`: `FirebirdServerDefaultInstance` (Serviço, **serviço puro**, perfil `*`);
  `ViasoftServerAgro` (Aplicação, `\Agro`, 733); `ViasoftServerAgroApi` e `ViasoftServerAgroJobs` (Serviço, `\Agro`, `*`);
  `ViasoftServerAgroX` (Serviço, `\Agro`, 734); `ViasoftServerDFE` (Aplicação, `\DFe`, 733); `ViasoftServerDfeX` (Serviço, `\DFe`, 734).
- `PASTAS_CDS`: `Firebird`, `Oracle`.
- `LINKS.SUGESTOES`: endereço (https) do formulário de **Sugestões e ajustes** (Google Forms). Vazio = o botão avisa que o formulário ainda não foi configurado.
- O backend só **lê** o arquivo (`get-default-config` → `{data}` ou `{error}`).
- **Aplicar padrão** (sempre **não destrutivo**): preenche só caminhos **vazios**; acrescenta itens que faltam (comparação por nome,
  case-insensitive); itens já existentes **sem perfil** recebem o perfil do padrão; **nunca** apaga nem muda perfil já escolhido.
  Depois salva a configuração inteira.
- **Classificação automática na abertura**: itens de listas antigas sem `Perfil` que o padrão conhece recebem o perfil;
  **clientes** que o padrão não conhece recebem o lote **pelo nome do executável** (seção 4); só grava se classificou algo (e grava **apenas** as duas seções de listas);
  loga "N item(ns) classificado(s) por perfil (733/734) com base no padrão e no nome do executável."

---

## 4. Perfis (lotes 733 / 734) [FRONT, exceto detecção de versão]

- Cada item de cliente/servidor tem `Perfil`: `'733'`, `'734'`, `'*'` (Ambos) ou vazio (**legado = Ambos**).
- **Visível** no perfil ativo quando: sem perfil, ou `'*'`, ou igual ao perfil ativo.
- O perfil ativo filtra: lista Clientes, lista Servidores da aba Copiar, contagens e a checagem de idade.
  **Não filtra** a lista de Pastas dos .cds **nem a aba Servidores** (que mostra os serviços dos dois lotes, para iniciar/parar qualquer um).
- **Lote pelo nome do executável CLIENTE**: termina em **"X"** → **734** (AgroX, FinAgroX, ExpedX); termina em **"3C"** ou é só o nome → **733** (Agro3C, FinAgro3C, Exped).
  Vale para clientes **novos** (Adicionar Exes) e para os que ainda não têm lote; quem já tem lote não muda.
- **Lote automático pela branch**: ao informar a pasta da branch (sair do campo, escolher sugestão ou Procurar), a versão dos executáveis define o lote
  (4.x → 733, 5.x → 734) e o seletor **troca sozinho**, com o aviso informativo "Lote N selecionado automaticamente: os executáveis desta pasta são da versão X." e o botão
  **"Voltar para M"** (volta ao lote anterior; aí aparece o aviso normal de lote diferente). Não troca durante uma cópia nem na abertura do app.
- Descrições: 733 = "Lote 733 · versão 4.0.x"; 734 = "Lote 734 · versão 5.0.x". Resumo: "N cliente(s) · N servidor(es) neste perfil".
- Seletor segmentado 733/734 no painel "Copiar". Trocar de perfil: salva `GERAL.PERFIL_ATIVO` (seção), re-renderiza listas,
  loga "Perfil NNN selecionado.", reconfere idade e aviso de versão.
- **Marcações são preservadas** ao redesenhar as listas (trocar de perfil, adicionar/remover/editar item, "aprender" subpasta): o estado de cada item é guardado
  (`marcacoes`, chave `cli:`/`srv:`/`bd:` + nome) e restaurado; item nunca visto vem **marcado**. Itens de outro perfil mantêm a marcação para quando voltarem.
- **Repetir última cópia**: reaplica as marcações de `ULTIMA_COPIA` e **volta também ao perfil** daquela cópia. Na abertura do app
  as marcações da última cópia são restauradas **sem** trocar o perfil (vale o perfil em uso). O botão só aparece depois que
  existe uma última cópia.
- Etiqueta de perfil nas listas de configuração: chips `733` (âmbar), `734` (verde), `Ambos` (cinza). Serviços puros mostram "Serviço Nativo" (sem chip de perfil e sem lápis).
- **Detecção de versão (backend)** — `get-branch-version`: lê o **FileVersion** de até **4** exes da pasta (os cadastrados,
  em qualquer perfil), pulando os cuja versão não indica lote (ex.: stub `1.0.0.0`); `major 4 → 733`, `major 5 → 734`,
  outro → sem perfil. Resultado `{version, file, perfil}`; cache por `caminho|mtime|tamanho`. Hoje é feita via PowerShell
  (`FileVersionInfo`) — no Tauri dá para ler direto da API do Windows.

---

## 5. Tela principal ("Copiar dados") [FRONT]

**Menu lateral** (desde a interface nova): **Copiar dados | Servidores** (Operação), **Extrator Cloud** (Ferramentas) e, embaixo, **Configurações**, **Sobre e ajuda** e o botão de **tema** (escuro/claro). O item **Sugestões e ajustes** abre o formulário de `LINKS.SUGESTOES` (seção 3.4). Na base do menu fica o indicador de **Administrador** (verde: "Pode parar e iniciar serviços"; amarelo: "Sem administrador — serviços podem falhar"). A versão do app aparece sob o nome. **Configurações** e **Extrator Cloud** abrem como telas sobre a área principal (o menu continua visível; clicar em outro item do menu fecha a tela aberta).

0. **Lote 733 | 734** — seletor no topo da tela (troca o perfil; ver seção 4).
1. **Branch** — campo de texto com **sugestões** (ver 5.2) + botão **Procurar**; no canto do cartão, o resumo "N cliente(s) · M servidor(es) neste perfil". Abaixo, dois avisos opcionais:
   idade dos executáveis (9.3) e perfil × versão (9.4).
2. **Três listas** lado a lado: **Pastas dos .cds**, **Clientes**, **Servidores**, cada uma com contagem no título e ícone de ajuda.
   Itens com caixa de seleção, **todos marcados por padrão**. Cada lista tem os links **Todos / Nenhum** no título; clique direito no título/lista → **Marcar Todos / Desmarcar Todos**.
   Item desmarcado aparece em cinza. A lista de servidores traz o aviso "Serviços marcados são parados antes da cópia e religados ao final.".
3. **Barra de ação fixa** (sempre visível, embaixo): resumo do que está marcado ("3 clientes, 1 servidor e 2 bases selecionados") com as **pastas de destino**, botão **Repetir última cópia** e o botão grande **Copiar Dados**. Durante a cópia, o **progresso** (nome do arquivo, "n / total" e barra) ocupa o lugar do resumo e o botão vira **Cancelar Cópia**.
4. **Log de atividades recolhido**: uma barra fina mostra só a **última linha** (com a cor da mensagem); clicar (ou Enter/espaço) abre a **gaveta do log** (filtro Todos/Sucesso/Erros + lixeira "Limpar log"), que empurra o conteúdo para cima sem cobrir a barra de ação. Cada aba (Copiar e Servidores) tem seu próprio log.
- Aba **Servidores** (8.4) e tela **Sobre e ajuda** (versão do app, tabela da equipe, link do repositório, seção Ajuda com **Rever tutorial**).

### 5.1 Quais itens aparecem
- **Clientes**: todos os do perfil ativo.
- **Servidores (aba Copiar)**: só os que **não são serviço puro** *ou* têm `AppServidora` (serviços puros, como o Firebird, ficam só na aba Servidores).
- **Servidores (aba Servidores)**: todos os `Tipo = Servico` (inclui serviços puros), do perfil ativo, com indicador de status.
- Listas vazias mostram **dicas** de orientação (ex.: "Nenhum cliente cadastrado. Abra **Configurações** e use **Adicionar Exes** ou **Usar configuração padrão**."),
  e as de serviços orientam a usar **Adicionar Serviço**.

### 5.2 Sugestões de caminho (campo da Branch) [AMBOS]
- Disparam ao digitar com **≥ 2 caracteres**. Backend `get-path-suggestions(parcial)`: se o texto é uma **pasta existente**, lista as
  subpastas dela; senão usa a pasta pai e filtra por **prefixo do nome (sem diferenciar maiúsculas)**. Só **diretórios**, até ~16 itens.
- Teclado: ↑/↓ navegam, **Enter** escolhe o selecionado, **Esc** fecha; clicar fora fecha. Escolher uma sugestão preenche o campo,
  marca "alterações não salvas" e dispara as conferências (9.3 e 9.4).
- Conferências também disparam: ao **sair do campo/Enter** (`change`), ao **Procurar**, ao trocar de perfil e **ao abrir o app** (idade).

### 5.3 Botão Procurar (Branch)
- Abre **diálogo de ARQUIVO** (não de pasta) e usa **a pasta do arquivo escolhido** (para o usuário "ver" os exes dentro da branch).
- Ponto de partida: o valor atual do campo (se existir e sem "Informe…"); se o campo estiver vazio, a pasta **ERP** (`RAIZ_BRANCHES`).

---

## 6. Fluxo "Copiar Dados" — ordem exata dos passos [AMBOS]

Clique no botão **Copiar Dados** (que durante a cópia vira **Cancelar Cópia**):
0. Se o tutorial está no passo 10: só encerra o tutorial, **não copia**.
1. Se já copiando: envia cancelamento; botão mostra "Cancelamento Enviado...". Fim.
2. **Validação de destinos**: os 3 caminhos (Clientes, Servidores, Dados) não podem estar vazios nem conter "Informe" → modal
   "Caminhos Obrigatórios" ("...informe os caminhos de destino (Clientes, Servidores e a raiz dos Dados) nas ⚙️ Configurações antes de iniciar a cópia.").
3. Caminho da branch não vazio → senão modal "Caminho Obrigatório".
4. Monta `reqs` com o que está **marcado** (clientes → destino Clientes; servidores → destino Servidores; pastas .cds → destino Dados). Se vazio → modal "Seleção Vazia".
5. **Versão × perfil**: lê a versão dos exes da pasta (com o botão bloqueado). Se indicar perfil **diferente** do ativo → confirmação
   "Perfil diferente da versão dos executáveis": "Os executáveis desta pasta são da versão X (perfil Y), mas o perfil selecionado é Z. Deseja copiar mesmo assim?". Cancelar aborta.
6. Trava a interface (`toggleUILock`), botão vira "Cancelar Cópia" (visual de cancelamento).
7. **Salva a configuração inteira** (`saveConfig`) — ou seja, clicar em Copiar também persiste caminhos/listas editados e não salvos — e grava `ULTIMA_COPIA`
   (nomes marcados, perfil, timestamp); mostra o botão "Repetir última cópia".
8. Barra de progresso 0 / N com "Validando branch...".
9. **Validar branch** (backend `validate-branch`, ver 9.1) com a lista de exes (clientes e servidores marcados, com `.exe`). Se inválida: modal conforme o cenário,
   destrava a interface e **encerra sem mexer em nada** (nenhum processo é parado). Cenários: `not_found` ("Pasta não encontrada…"), `root_branches`
   ("Escolha a branch da tarefa…"), `missing_files` (lista os arquivos ausentes), `error`.
10. **Encerrar clientes** marcados (`taskkill /F /IM nome.exe`) em **paralelo**; loga "Processo X encerrado." só para os que existiam.
11. **Parar servidores** marcados (serviços **e** aplicações) em **paralelo**, guardando o resultado de cada um. Se **algum falhar** (normalmente "acesso negado" por falta de Administrador):
    **aborta antes de copiar** — log "Cópia abortada: não foi possível parar X. Nenhum arquivo foi copiado.", modal "Não foi possível parar os serviços" (explica que é preciso abrir como Administrador),
    **religa os que já tinham sido parados**, destrava a interface e encerra.
12. `build-queue` (seção 7): mapeia a branch, resolve destinos, devolve a **fila** e os **caminhos aprendidos**.
13. **Auto-aprendizado**: para cada caminho aprendido atualiza `SubDiretorios` do item, salva a configuração inteira, loga "[MEMÓRIA] N caminhos foram aprendidos e salvos." e re-renderiza.
14. `execute-copy-files` (seção 7) com a fila.
15. Fim **concluído**: "Cópia finalizada. N arquivos processados (X ignorado(s)) (E com erro — veja o log acima)." — verde se sem erro, laranja se houve erro;
    barra 100% ("Concluído com sucesso!" ou "Concluído com erros").
16. Fim **cancelado/interrompido**: "Operação cancelada ou interrompida. Erros: N". Qualquer exceção: "ERRO CRÍTICO na comunicação: …".
17. **Em todo desfecho** (concluído, cancelado, erro): **sobe de volta os serviços (`Tipo = Servico`) que foram parados**, em paralelo. Quando não foi um fim normal, avisa antes no log
    ("Cópia interrompida: religando os serviços que foram parados..." / "Erro durante a cópia: religando…"). Aplicações (`Tipo = Aplicacao`) **não** são reiniciadas (só foram encerradas).
    Por fim: destrava interface, botão volta para "Copiar Dados", e a barra some após 3 s.
    ⚠️ Único caso ainda **não** coberto: o usuário escolher "Sair mesmo assim" (fechar o app durante a cópia) — os serviços ficam parados.

- **Trava de interface** durante a cópia desabilita: os 4 campos de caminho, todas as caixas de seleção das listas, Procurar, seletor de perfil, Repetir última cópia,
  botões de ícone e os botões de Remover/Cancelar/Salvar das configurações.
- A barra mostra "Copiando: arquivo.exe" e "atual / total" (**por tarefa**, não por byte).

---

## 7. Motor de cópia [BACK]

### 7.1 Indexação da branch (`indexarDiretorio`)
- Varredura em pilha (sem recursão), ignorando as pastas `.git .svn .vs .idea .vscode node_modules __pycache__` (comparação em minúsculas).
- Pasta ilegível: loga "Aviso: Pasta ignorada (Acesso Negado): …" e segue.
- **Arquivos**: mapa `nome-em-minúsculas → {caminho, mtime, tamanho}`. Se o **mesmo nome aparece em várias pastas**, **vence o de maior data de modificação (mtime)**.
  Stats em lotes paralelos de **25**.
- **Pastas**: mapa por *nome* (primeira encontrada) e por *caminho relativo* à raiz (`bd\firebird`), tudo em minúsculas; nomes repetidos em caminhos
  diferentes entram num conjunto de **ambíguos**.
- **Cache**: o índice da branch fica em cache por **8 s** (mesma pasta) e varreduras simultâneas da mesma pasta são **unificadas** (uma só leitura do Drive).
  O objetivo é só evitar varrer duas vezes no mesmo clique (validar + montar fila) e conferir idade+versão ao mesmo tempo.

### 7.2 Montagem da fila (`build-queue`)
Entrada: `reqs[{destDir, type: client|server|bd, itemData}]` e `branchRoot`. Saída: `{queue[{origem,destino,type}], learnedPaths[{type,name,subFolder}]}`.
- Sem `reqs` → fila vazia. Branch sem nenhum arquivo/pasta → "AVISO: Nenhum arquivo ou pasta encontrado na Branch." e fila vazia.
- **Auto-descoberta ("MODO DETETIVE")**: para itens (não-BD) **sem subpasta definida** varre **a pasta de destino** daquele tipo (uma vez por raiz), loga
  "MODO DETETIVE: Localizando subpastas em X…". Se o exe **já existe no destino**, a subpasta real é calculada e usada
  ("-> DESCOBERTO: X está em …") e devolvida em `learnedPaths` (o front grava). Se não existe no destino → fica na raiz.
- **Arquivos (cliente/servidor)**: remove `.exe` do nome, procura `nome.exe` (ou `nome`) no índice da branch. Não achou → "X Não encontrado na Branch: nome" e segue.
  **Fidelidade de nome**: o arquivo de destino usa **o nome exato cadastrado** (com `.exe`), não o nome achado na branch.
  Destino = `destDir + subpasta + nome`.
- **Pastas dos .cds (`bd`)**: o nome é limpo de prefixo `bd\` ou `dados\`. Busca, nesta ordem:
  1. caminho cadastrado com barra (ex.: `bd\Firebird`, `a\b`) → caminho exato; 2. `bd\nome`; 3. `dados\nome`;
  4. pelo **nome puro**: se a pasta está no **primeiro nível** da branch, é usada; se existem **duas ou mais pastas com esse nome em lugares diferentes** e nenhuma no primeiro nível,
     **avisa e pula** ("X Ambíguo: existem várias pastas chamadas "nome" na Branch. Organize-a em bd\nome ou dados\nome…"); se só existe uma, é usada.
  Não achou → "X Pasta dos .cds não encontrada na Branch: nome". Destino = `destDir + nome da pasta como está na branch`.
  (Antes, o aviso de ambiguidade nunca era alcançado para nomes simples e a primeira pasta encontrada era copiada em silêncio.)
- **Sem destinos duplicados**: dois itens que apontam para o mesmo destino → o segundo é ignorado com "X Destino duplicado ignorado (já reivindicado por outro item selecionado): …".
- Erro geral: "ERRO CRÍTICO no Mapeamento: …".

### 7.3 Execução (`execute-copy-files`)
- Zera o token de cancelamento. **4 trabalhadores simultâneos** consomem a fila. Marca "cópia em andamento" **antes** de iniciar os workers.
- Por tarefa: origem inexistente → "PULANDO: Origem não encontrada […]" (conta como ignorada).
  - **Arquivo**: cria a pasta destino, copia com `secureCopyFile`. Log: **"NOVO ARQUIVO (Instalação Limpa): nome"** (laranja) se o destino não existia, senão **"ATUALIZADO: caminho"** (verde).
  - **Pasta (.cds)**: cópia **recursiva**: cria primeiro os diretórios que faltam ("Criado diretório: X"), depois copia **6 arquivos ao mesmo tempo**; **sobrescreve/mescla**, **não apaga** o que só existe no destino.
    Log "PASTA ATUALIZADA: nome (N copiado(s), M já igual(is))", ou "SEM ALTERAÇÃO: pasta X já estava igual à da branch (N arquivo(s))." quando nada mudou. Se um arquivo falhar de vez, a pasta conta como erro.
  - **Arquivo igual** (mesmo tamanho e mesma data de modificação, tolerância de 2 s) **não é copiado de novo**: log "SEM ALTERAÇÃO: nome já estava igual ao da branch.".
    Como a cópia preserva a data da origem, repetir a cópia da mesma build só copia o que mudou. Arquivo do destino alterado (ex.: base usada nos testes) tem outra data e é copiado de novo.
  - Erro numa tarefa: "ERRO FATAL em origem: mensagem", contador de erros++, **as demais continuam**.
- Resultado: `{status: 'completed'|'cancelled', errors, news, skipped, unchanged}`. `news` conta o que foi copiado (arquivos e pastas); `unchanged` o que já estava igual
  (a mensagem final acrescenta "(N já estava(m) igual(is) à branch e não precisou(aram) ser copiado(s))").
- **Progresso** (evento `copy-progress`): `{current, total, percent, fileName}` a cada tarefa concluída (e um evento inicial com 0).
- **Cancelar** (`cancel-copy`): liga o token; log "Solicitação de cancelamento recebida pelo Motor."; tarefas em andamento param, as pendentes não iniciam.

### 7.4 Cópia segura de arquivo (`secureCopyFile`)
- Escreve em **`destino.tmp`** e só então **move (substitui) para o destino** — troca atômica. Se o destino existir, remove o atributo somente-leitura antes.
- Cópia **nativa do Windows** (`CopyFileExW`) para qualquer tamanho: E/S otimizada pelo sistema, **preserva a data de modificação** e é **cancelável no meio**
  (a rotina de progresso do Windows consulta o token de cancelamento a cada bloco).
- Em qualquer falha: apaga o `.tmp`. **Até 5 tentativas**, 2 s entre elas; cada falha (exceto a última) loga
  "Tentativa N falhou p/ nome. Falha física ou arquivo preso. Retentando...".
- Se o erro for de trava (`EPERM`/`EBUSY`) e o destino for `.exe`: **mata o processo pelo nome do exe** antes de tentar de novo (cobre serviço com recuperação automática/watchdog).
- Esgotadas as tentativas com erro de trava **e nenhum processo com aquele nome rodando**: loga a dica "Falha persistente ao gravar em "…" mesmo sem nenhum processo travando o arquivo pelo nome.
  Se o problema persistir, feche o ExeBoard e abra-o novamente como Administrador." e relança o erro.
- Cancelamento é checado antes, durante (callback do `CopyFileExW`) e depois da cópia (apaga o `.tmp` e devolve "cancelled").

---

## 8. Serviços e processos [BACK + FRONT]

### 8.1 Status (`check-status`) — usado no polling
- `Tipo = Servico`: consulta o serviço; `RUNNING → running`, `STOPPED → stopped`, `PENDING → transition`, qualquer outra coisa/erro → `not_found`.
- Outro (Aplicação): procura o processo `nome.exe` na lista de processos → `running` ou `stopped` (não detecta transição).
- Hoje usa `sc query`/`tasklist` com `execFile` (sem shell). **No Tauri use a API de serviços do Windows** em vez de interpretar texto.
- **Segurança dos comandos**: *nenhum* comando passa por shell (tudo `execFile` com argumentos separados). Nomes de serviço/processo são validados (`nomeSeguro`): 1–256 caracteres, sem `\ / " * ? < > |` nem
  caracteres de controle (barra o curinga do taskkill `/IM *` e `\\maquina-remota` do `sc`). Nome inválido → `not_found` / `false` / `{killed:false, msg:'Nome de processo inválido.'}`.
  `execute-external` abre http(s) no navegador e o resto com o shell do SO (`openPath`), sem montar `start "" "…"`; `open-external-url` só aceita http(s).

### 8.2 Tipo do item (`detectar-tipo`) e lista de serviços
- `detectar-tipo(nome)`: se o serviço existe → `Servico`, senão `Aplicacao`.
- `get-windows-services`: lista todos os serviços com `{Name, DisplayName, Status}`; o front considera **`Status === 4` = em execução**.

### 8.3 Controle (`manage-server`) — ações `start`, `stop`, `kill`
- **start** (serviço): inicia e espera `RUNNING` (até **20 s**, consulta a cada 400 ms). Logs: "Sucesso: X INICIADO." / "Aviso: X demorando para responder..." / "ERRO ao iniciar X: …".
  Aplicação: "Ação: X é Aplicação. Inicie manualmente pela pasta." (e devolve `false`).
- **stop/kill** (serviço):
  1. Pede a parada. Se **acesso negado** → mensagem "Acesso negado ao parar "X". Feche o ExeBoard e abra-o novamente como Administrador (clique com o botão direito > Executar como administrador) antes de copiar."
     nos **dois logs** (servidores e copiar) e devolve `false`. Erro que não seja "1062" (serviço já parado) vira aviso "Aviso STOP X: …".
  2. Espera `STOPPED` (até **10 s**).
  3. **Confirma pelo processo** (não pelo estado do serviço): até **8 rodadas**, se o `nome.exe` ainda existir, **mata** (`/F`) e espera 500 ms. Se der acesso negado → "Acesso negado ao encerrar "X.exe". Execute o ExeBoard como Administrador antes de copiar." e devolve `false`.
  4. `stop` loga "X parado."; `kill` não loga.
- **stop/kill** (aplicação): mata o processo; acesso negado → mesma mensagem; sucesso → "KILL enviado para X.exe".
- Motivo da checagem por processo: o gerenciador de serviços pode dizer "parado" antes de o arquivo ser liberado, e alguns serviços têm recuperação que os religa sozinhos.
- `kill-process(nome)` (clientes): `taskkill /F /IM nome.exe` → `{killed, msg}`.

### 8.4 Aba Servidores [FRONT]
- Lista os serviços (do perfil ativo) com **indicador de situação** em forma de etiqueta: `running` ("Em execução"), `stopped` ("Parado"), `transition` ("Em transição…"), `not_found` ("Não encontrado").
- Um contador mostra quantos estão **selecionados**. Cada linha tem botões **Iniciar / Parar / Reiniciar** só daquele serviço (mesma lógica dos botões em lote, e atualiza a situação logo em seguida).
- Caixas **"Selecionar em execução"** e **"Selecionar Parados"** (este marca tudo que **não** está `running`, inclusive `not_found`/`transition`).
- Botões **Iniciar / Parar / Reiniciar** sobre os selecionados (nenhum selecionado → modal de erro "Selecione algum servidor na lista.").
  Executa **em paralelo** entre os itens; **Reiniciar** = parar e depois iniciar, **em sequência por item** (marca o indicador como `transition` e loga "Reiniciando X...").
  Logs: "Iniciando X..." (azul) / "Parando X..." (vermelho). O botão clicado fica desabilitado durante a operação.
- **Polling**: a cada **3 s**, **somente** com a aba Servidores visível **e** a janela visível; verifica **em sequência** (nunca em avalanche) e só os itens que têm indicador.
  Ao abrir a aba e ao a janela voltar a ficar visível, atualiza **na hora**. Não agenda a próxima rodada até terminar a atual.
- Log próprio da aba (barra recolhida + gaveta, com filtro Todos / Sucesso / Erros e Limpar).

---

## 9. Validações da branch [BACK + FRONT]

### 9.1 `validate-branch` — pasta e arquivos
Em ordem: pasta não existe → `not_found`; pasta é uma **raiz de branches** → `root_branches`; sem lista de arquivos → válida; algum exe da lista **não está** na branch →
`missing_files` com a lista; erro → `error`. (Aceita nome com ou sem `.exe`, sem diferenciar maiúsculas.)
- [FRONT] **Ao informar a pasta** (antes da cópia), se ela não existe aparece a faixa "⚠️ Pasta não encontrada." com "Confira se o nome da branch está certo. Se estiver, a pasta com os
  executáveis desta branch ainda não foi criada: o build da tarefa pode não ter terminado ou o Google Drive ainda não sincronizou." (o mesmo texto do modal da cópia).
  Se for a pasta com todas as branches: "⚠️ Esta é a pasta com todas as branches." + orientação para completar. Nesses casos a idade e a versão não são conferidas.

### 9.2 Raiz de branches (guarda)
Uma pasta com **mais de 100 subpastas** no primeiro nível (ex.: a **ERP**, ~1000 branches) **não é uma branch**: não é varrida (varrer leria todas as branches e o "exe mais novo" viria de uma
branch qualquer). Esta guarda vale para validar, idade e versão.
Modal: "Escolha a branch da tarefa — O caminho informado é a pasta que contém TODAS as branches (ex.: a ERP). Complete com a pasta da branch da sua tarefa (ex.: ...\ERP\AG-12345-main): digite o começo do
nome depois do caminho para ver as sugestões, ou use o botão Procurar."

### 9.3 Aviso de executáveis antigos (`check-exe-age`)
- Limite: **10 dias** (`EXE_AGE_WARN_DAYS`). Usa a data de **modificação** (a de criação no Drive é a do sincronismo, não a do build).
- Considera só os itens **do perfil ativo** que existem na branch. Retorna `{checked, old[{name, ageDays}] (mais antigos primeiro), warnDays}`.
- [FRONT] Faixa amarela com "⚠️ X foi gerado há N dias (limite: 10)." ou "⚠️ N de M executáveis foram gerados há mais de 10 dias (o mais antigo: D dias)." + lista dos 6 primeiros ("e mais N...") +
  "Confirme se esta é a pasta/build correto antes de copiar." + botão ✕ para dispensar. Também grava um aviso no log. **Não bloqueia** a cópia.
  Descarta resposta antiga se a pasta mudou durante a verificação (token).

### 9.4 Aviso perfil × versão
- [FRONT] Ao informar a pasta, o lote **troca sozinho** para o da versão (seção 4). Se a pessoa voltar ao outro lote, aparece a faixa "⚠️ Os executáveis desta pasta são da versão X (perfil Y),
  mas o perfil selecionado é Z." com botão **"Trocar para Y"**. Some quando o perfil bate. Não bloqueia; no Copiar pede confirmação (passo 5 da seção 6).

---

## 10. Tela de Configurações [FRONT]

_Abre pelo item **Configurações** do menu lateral, ocupando a área ao lado do menu; a barra de ação fixa tem **Usar configuração padrão / Remover Selecionados / Cancelar Alterações / Salvar Alterações** e o aviso de alterações não salvas. Em cada coluna, os botões de adicionar ficam logo abaixo do campo de caminho (antes da lista)._

- **Preferências Gerais**: "Rodar em segundo plano (minimizar para bandeja)" → `GERAL.HABILITAR_TRAY`.
- Três colunas, cada uma com **campo de caminho + lupa** (diálogo de pasta) e lista com caixas de exclusão:
  - **Gerenciar Pastas dos .cds** (raiz `PASTA_DADOS`, placeholder "Ex: C:\Viasoft\Dados") — botão **Adicionar Pasta dos .cds**.
  - **Gerenciar Executáveis Clientes** (`PASTA_CLIENT`, "Ex: C:\Viasoft\Client") — botão **Adicionar Exes**.
  - **Gerenciar Aplicações/Serviços Servidores** (`PASTA_SERVER`, "Ex: C:\Viasoft\Server") — botões **Adicionar Serviço** e **Adicionar Exe**.
- Rodapé: **Usar configuração padrão**, **Remover Selecionados**, **Cancelar Alterações**, **Salvar Alterações** + rótulo de status ("(Existem alterações não salvas. Vá descendo e salve as configs!)").
- Editar qualquer campo/lista marca "não salvo". **Salvar** grava tudo (caminhos, listas, bancos, bandeja, tema, perfil ativo) e mostra "(Salvo com Sucesso!)" por 2 s.
  **Cancelar Alterações** recarrega do disco ("(Alterações Descartadas)").
- **Remover Selecionados**: confirmação "Temos a intenção de apagar permanentemente N registros de sua configuração atual. Deseja excluir?" (remove por índice, do maior para o menor).
- **Adicionar Pasta dos .cds**: diálogo de pasta a partir da raiz de dados; guarda só o **nome** da pasta; duplicado (exato) → "A pasta dos .cds X já está na lista."
- **Adicionar Serviço**: modal com lista de todos os serviços do Windows (nome e nome de exibição, com bolinha de status), **busca** por nome/exibição; exige seleção; duplicado → "O serviço X já existe na configuração.".
  Entra como `{Tipo: Servico, IsPureService: true, AppServidora: false, SubDiretorios: ''}` (**serviço nativo**, sem cópia de arquivos).
- **Adicionar Exes (clientes)** / **Adicionar Exe (servidores)**: a origem é perguntada — **"Extrair da Branch (Nova Versão)"** (exige caminho da branch preenchido e sem "Informe"; seletor de arquivos abre na branch)
  ou **"Já existe localmente (Destino)"** (abre na pasta de destino). Durante o tutorial a pergunta é pulada (sempre local). Seletor aceita só `.exe`, múltiplos.
  - Subpasta: origem **local** → caminho relativo ao destino configurado; origem **branch** → a subpasta **mais frequente** entre os itens já cadastrados (efeito manada); para clientes, se não houver,
    copia a do cliente com mesmo prefixo de 3 letras. Em origem branch, abre a **janela de edição de subpasta** para cada item novo, em fila.
  - Cliente duplicado (nome exato, diferencia maiúsculas) é ignorado em silêncio.
  - **Servidor**: compara o nome do exe com os serviços do Windows (nome **ou** nome de exibição, sem diferenciar maiúsculas); se achar → `Servico` com o **nome real do serviço**; os que não achar entram numa janela
    de confirmação "**Confirmar e Adicionar**" com a caixa marcada se `detectar-tipo` disser que é serviço (marcada = `Servico`, desmarcada = `Aplicacao`). Entram com `IsPureService: false`, `AppServidora: true`.
  - **Perfil dos itens novos**: exes (cliente e servidor) entram **no perfil ativo** no momento da adição (ajustável no lápis). **Serviço nativo** (Adicionar Serviço) entra como **Ambos (`*`)**: costuma servir aos dois lotes
    (ex.: Firebird) e não tem lápis para corrigir depois.
- **Lápis (editar)** em cliente/servidor (não existe para serviço nativo): janela "Subpasta Relativa" (campo + Procurar dentro da raiz; "A pasta selecionada deve estar dentro da pasta Raiz configurada." se for fora) e **seletor de perfil** (733 / 734 / Ambos; padrão Ambos).
- Todas as janelas de seleção de pasta abrem na pasta atual do campo (se existir).

---

## 11. Primeira instalação / Tutorial [FRONT]

- **Dispara** na abertura quando as **três listas estão vazias** e `GERAL.TUTORIAL_CONCLUIDO ≠ '1'`. Também pode ser reaberto em **Sobre → Ajuda → Rever tutorial** (volta à aba Copiar e inicia no passo 1).
- Visual: escurece a tela, destaca o elemento-alvo com cartão e seta ("spotlight"), **bloqueia a interface** (`onboarding-active`); os campos de caminho ficam **somente leitura** a partir do passo 2.
- Botões do cartão: passo 1 → **Usar configuração padrão** (aplica o padrão e **pula para o passo 9**); qualquer passo → **Pular tutorial**; passo 9 → **Continuar**; passo 10 → **Entendi**.
  Encerrar/pular grava `TUTORIAL_CONCLUIDO = '1'` (não reaparece).
- Passos (os textos exatos estão em `renderer.js`, função `updateTutorialLogic`, e **não mudam na migração**):
  1. Abrir Configurações. 2. Pasta raiz dos Dados (`.cds`). 3. Pasta dos executáveis clientes (ex.: `C:\Viasoft\Client`). 4. Pasta dos executáveis servidores (ex.: `C:\Viasoft\Server`).
  5. Adicionar ≥ 1 Pasta dos .cds. 6. Adicionar ≥ 1 executável cliente. 7. Adicionar ≥ 1 executável servidor. 8. **Salvar**.
  9. Pasta da branch (campo vem preenchido com a pasta ERP — se existir na máquina — editável, com foco, e já abre as sugestões; digitar o início do nome da branch ou usar Procurar). 10. Explica o botão Copiar Dados (clicar nele só encerra o tutorial).
- **Avanço automático** dos passos 2–4 ao escolher a pasta **ou** digitar > 3 caracteres; 5–7 quando a lista passa a ter ≥ 1 item. Passos já cumpridos são **pulados** (útil ao rever o tutorial).
- Ao **Salvar no passo 8**: modal "**Sincronização Necessária**" — "Você já possui o aplicativo do Google Drive instalado e sincronizado neste computador?" **Sim** → passo 9;
  **Não** → abre `https://www.google.com/drive/download/` e **encerra** o tutorial.
- Escolher uma sugestão ou pasta no passo 9 leva ao passo 10.

---

## 12. Extrator Cloud (Bitbucket) [AMBOS]

- Janela com **Workspace, Repositório, Usuário (e-mail), API Token** (campo senha; link "Como criar um Token?" → `https://nimitz.atlassian.net/wiki/x/GoAMPgE`), **Branch Base** (padrão `main`),
  **Branch da Tarefa**, **Pasta de Destino Local** (+ Procurar). Credenciais e destino são **salvos ao sair de cada campo** na seção `BITBUCKET`.
- Autenticação: HTTP **Basic** `usuario:token`. (O workspace exige 2FA; a conta/token é de usuário Atlassian com API token.)
- **Toda a comunicação com a API roda no backend** (a tela só chama `list-branches`, `verify-bitbucket`, `extract-bitbucket`) — sem depender de CORS/CSP do navegador embutido (importante para o WebView2 do Tauri).
- **Sugestões de branch** (base e tarefa): ao digitar, "⏳ Carregando..." e **debounce de 400 ms**, depois lista até **20** branches (`name ~ "termo"`, aspas/barra do termo escapadas, ordenadas pela data do último commit, mais recentes primeiro).
  `list-branches` devolve **`{branches, error}`**: se faltar credencial → "Preencha Workspace, Repositório, Usuário e API Token acima…"; erro da API → mensagem real em vermelho na caixa de sugestões
  (**401** "usuário ou API Token inválido", **403** "acesso negado… confira a verificação em duas etapas e a permissão do token" + o texto do Bitbucket, **404** "workspace ou repositório não encontrado",
  **429** "muitas requisições", sem rede "Sem conexão com o Bitbucket (…). Verifique a internet/VPN."); lista vazia sem erro → "Nenhuma branch encontrada" (só quando realmente não há).
- **Verificar Arquivos** (`verify-bitbucket`, backend): resolve o hash das duas branches, consulta o **diffstat** `hashTarefa..hashBase` **seguindo todas as páginas** (`next`, teto de 100) e lista os nomes dos arquivos (sem os removidos).
  Erros: "Erro: Branch base 'X' não encontrada." etc. (mensagem real da API como acima); "Nenhum arquivo modificado encontrado entre as branches.".
- **Branch base pelo pull request**: ao escolher/informar a **Branch da Tarefa**, o backend (`pr_base_branch`) consulta os pull requests do Bitbucket com essa branch de origem
  (o mesmo que o Jira mostra) e usa o **destino** do PR aberto mais recente (sem aberto, o mais recente mergeado/recusado). A base é preenchida sozinha com o texto
  "Preenchida pelo pull request #N (aberto): a tarefa vai para X."; se a pessoa já digitou outra base, ela não é trocada e aparece "O pull request #N vai para X. **Usar X**".
  Sem PR: "Nenhum pull request encontrado…". ⚠️ O **API Token precisa da permissão de leitura de Pull requests** (`read:pullrequest:bitbucket`); sem ela a tela explica isso.
- **Iniciar Extração** (backend): exige todos os campos; **a tela do Extrator continua aberta** (o progresso aparece no **log da extração**, dentro da própria tela, e o resultado
  numa faixa verde "Extração concluída. Arquivos em …" com **Abrir pasta**, ou vermelha com o motivo da falha). Passos: hashes das branches → diffstat → ignora `removed`, deduplica por caminho → prepara
  `{destino}\{repositório}\branch` (arquivos com nome original) e `{destino}\{repositório}\{base}` (arquivos renomeados `nome(base).ext`; barras da base viram `-` e `<>:"\|?*` viram `_`) →
  ⚠️ **esvazia as duas pastas antes** → baixa em **lotes de 5** os arquivos (achatados, sem recriar diretórios) → arquivos novos que não existem na base vão para `arquivos_ausentes.txt` (um por linha) com aviso →
  "🎉 Extração Concluída com Sucesso!" e **abre a pasta raiz** no Explorer — **a menos que** alguma janela do Explorador já esteja na pasta de destino ou dentro dela
  (`folder_open_in_explorer`, via `Shell.Application.Windows()`; funciona também com o app como Administrador); nesse caso loga que a pasta já está aberta. Cada falha é logada ("[ERRO] Falha ao baixar X (Tarefa/Base): …") sem derrubar o restante. Progresso "Progresso: [n/N] arquivo".
- O diffstat segue **todas as páginas** (antes só lia a primeira). A consulta de arquivos usa o mesmo código em "Verificar" e em "Iniciar Extração".

---

## 13. Tema, logs e utilidades [FRONT]

- **Tema** escuro/claro: botão 🌙/☀️; grava `GERAL.TEMA` **na hora** (config completa). Aplicado na abertura.
- **Log de Atividades**: horário `[hh:mm:ss]` (pt-BR) + mensagem colorida; **máx. 500 entradas** em memória e 500 linhas visíveis por caixa (descarta as mais antigas); rola para o fim.
  Dois alvos: `copiar` e `servidores` (mensagens do backend dizem o alvo).
  Filtro **Todos/Sucesso/Erros** é por **tipo derivado da cor** (`tipoDoLog`): sucesso = `#40a02b`, `#4ade80`, `var(--success)`; erro = `#f38ba8`, `#f87171`, `var(--danger)`; o resto é informativo
  (as cores do Extrator Cloud agora entram nos filtros). **"Limpar log" esvazia a tela e a memória** daquele log (reaplicar um filtro não traz as linhas de volta).
- Paleta de cores de log: info `#89b4fa`, automação `#cba6f7`, sucesso `#40a02b`, novo `#fe640b`, retentativa `#fab387`, erro `#f38ba8`.
- Mensagens de abertura no log: "Iniciando carregamento da interface...", versão, "Lendo configurações...", "Renderizando listas...", "Última seleção de executáveis restaurada.",
  verificação de admin, "ExeBoard pronto para uso." (testes automatizados dependem dessa frase).
- **Abrir externo** (`open-external-url`): abre URL no navegador padrão. **Executar externo** (`execute-external`): abre pasta/arquivo/URL pelo shell ("start").

---

## 14. Atualização automática e instalação [BACK + build]

- Ao ficar pronta a janela, verifica atualizações em silêncio no **GitHub Releases** (`nicochet01/ExeBoard-3.0`). Sem diff diferencial, sem downgrade, sem web installer.
- Ao baixar: evento `update-downloaded` → modal "**Nova Atualização Disponível!**" com "(de vA para vB)… Deseja reiniciar a aplicação agora para aplicar a atualização?" → **Mais Tarde** / **Reiniciar e Atualizar**.
- Reiniciar (`restart-app`): marca saída real, destrói a bandeja, fecha as janelas, espera 1 s (libera locks) e instala (**instalação não silenciosa, reabre o app depois**).
- Instalador: **NSIS**, instalação **por máquina** (todos os usuários), **não** "um clique", permite escolher a pasta, atalhos na área de trabalho e no menu iniciar, nome do artefato `ExeBoard.exe`, `appId com.viasoft.exeboard`.
- Compressão máxima; só idiomas pt-BR/en-US do Chromium. Tamanhos medidos: instalador ≈ 81,5 MB; instalado ≈ 301 MB.
- Sem internet a verificação de atualização só registra um aviso no log (a rejeição é tratada; antes virava "Unhandled Rejection").

---

## 15. Mapeamento: IPC atual → comandos/eventos do backend (para o Tauri)

| IPC (preload) | Tipo | O que faz | Seção |
|---|---|---|---|
| `read-config` / `save-config` / `save-config-section` | invoke | ler (sempre do disco) / gravar tudo / gravar uma seção | 3 |
| `get-app-version` | invoke | versão do app | 13 |
| `get-default-config` | invoke | lê `config-padrao.json` | 3.4 |
| `check-admin` | invoke | é administrador? | 2.1 |
| `check-status` | invoke | status de serviço/processo | 8.1 |
| `detectar-tipo` | invoke | serviço existe? | 8.2 |
| `get-windows-services` | invoke | lista serviços `{Name, DisplayName, Status}` | 8.2 |
| `manage-server` | invoke | start/stop/kill (+ logs) | 8.3 |
| `kill-process` | invoke | taskkill por nome | 8.3 |
| `validate-branch` / `check-exe-age` / `get-branch-version` | invoke | validações da pasta | 9 |
| `build-queue` / `execute-copy-files` | invoke | montar fila / copiar | 7 |
| `cancel-copy` | send | liga token de cancelamento | 7.3 |
| `open-folder-dialog` / `open-file-get-folder` / `open-multi-files` | invoke | diálogos | 5.3, 10 |
| `get-path-suggestions` | invoke | subpastas para sugestão | 5.2 |
| `execute-external` / `open-external-url` | invoke | abrir pasta/URL | 13 |
| `list-branches` / `extract-bitbucket` | invoke | Bitbucket | 12 |
| `restart-app` | invoke | instalar atualização | 14 |
| **eventos →front:** `log-message {msg,color,target}`, `copy-progress {current,total,percent,fileName}`, `show-instance-warning`, `update-downloaded {currentVersion,newVersion}` | | | |

---

## 16. Pontos CRÍTICOS da migração (não perder)

1. **Config dos usuários existentes**: ler `%APPDATA%\ExeBoard\configuracoes.json` (mesmo formato) ou migrá-lo na primeira execução do novo app, **sem apagar o original**.
2. **Administrador obrigatório** (manifest `requireAdministrator`) — sem isso `sc stop`/`taskkill` falham e a cópia de exes de serviço dá EPERM.
3. **Instância única** + modal de aviso.
4. **Ponte do front**: o `renderer.js` chama `window.api.*` — o mais barato é criar um *shim* `window.api` que traduz para `invoke`/`listen` do Tauri (mesmos nomes), sem tocar na tela.
5. **Eventos em tempo real** (`log-message`, `copy-progress`) com a mesma forma de dados.
6. **Trava de fechamento** durante cópia, minimizar → bandeja (só se a opção estiver ligada), bandeja sempre criada.
7. **Atualização dos usuários que já têm o Electron**: resolvida pela **release "ponte"** — um `latest.yml` (para o `electron-updater`) que aponta para o instalador do Tauri, que por sua vez remove a instalação antiga. Mecanismo, script de release e **o que ainda precisa ser testado numa máquina real**: seção 19.
8. **Cópia**: `.tmp` + troca atômica, 4 simultâneos, 5 tentativas, stream > 200 MB cancelável, kill por nome em EPERM/EBUSY, cancelamento em todos os pontos.
9. **Resolução de caminhos** (seção 7.2): exe mais novo por nome, fidelidade de nome, descoberta de subpasta no destino, duplicados, ignorados.
10. **Guarda de raiz de branches** (> 100 subpastas): sem ela o app varre o Drive inteiro.
11. **Leitura de versão do exe** (FileVersion) e mapeamento 4→733 / 5→734.
12. **Requisições de rede**: Bitbucket/GitHub no backend (não no front), por causa de CSP/CORS no WebView2 — **já é assim** no app atual (verificar/listar/extrair).
12b. **Token do Bitbucket**: formato `BITBUCKET.PASSWORD_ENC = "dpapi:" + base64(CryptProtectData, escopo usuário atual, sem entropia)`; o novo app deve ler esse campo (CryptUnprotectData) e migrar `PASSWORD` em texto.
    Atenção: quem voltar a uma versão antiga do ExeBoard depois da migração perde o token (a versão antiga não conhece `PASSWORD_ENC`) e terá de digitá-lo de novo.
13. **Cache do índice** (8 s) e unificação de varreduras.
14. **Tutorial e dicas de lista vazia** continuam no front (nenhuma mudança).

---

## 17. Falhas conhecidas — corrigidas em 2026-11-17 (app Electron atual)

Corrigidas no código atual (para o Tauri herdar o comportamento certo). "Testado" = teste ponta a ponta no Electron real
(34 verificações de falhas + 8 de regressão da cópia normal, todas passando); "só revisão" = não deu para exercitar de verdade.

| # | Falha | Correção | Verificação |
|---|---|---|---|
| 1 | Parada de serviço que falhava era ignorada e a cópia seguia | Aborta antes de copiar, avisa (log + modal) e religa o que já tinha sido parado | **Testado** (serviço real negado sem admin: nada copiado, interface destravada, serviço intacto) |
| 2 | Cópia cancelada/com erro não religava os serviços | `religar()` roda em **todo** desfecho (concluído, cancelado, erro) | **Só revisão** do ramo cancelado/erro (exige administrador para parar serviço de verdade); o ramo de aborto e o normal foram testados |
| 3 | Pasta de .cds ambígua (nomes simples) era copiada em silêncio | Ordem de busca nova (ver 7.2): caminho exato → `bd\`/`dados\` → nome puro só se 1º nível ou única | **Testado** (5 cenários) |
| 4 | Erro do Bitbucket aparecia como "Nenhuma branch encontrada" | `list-branches` devolve `{branches, error}` com a causa real (401/403/404/429/rede) | **Testado** (credencial inválida → "usuário ou API Token inválido (401)") |
| 5 | Token do Bitbucket em texto puro no arquivo | Cifrado com DPAPI do Windows (`PASSWORD_ENC`), migração automática do texto puro | **Testado** (migra, não aparece em texto, troca, salva config inteira, reabre e decifra) |
| 6 | Comandos montados com texto (`exec`, `start "" "…"`) | Tudo `execFile`/`shell.openPath`, nomes validados (`nomeSeguro`), `open-external-url` só http(s) | **Testado** (curinga `*`, `\\remoto`, aspas/`&` recusados) |
| 7 | Diffstat só lia a 1ª página | Segue `next` (teto 100 páginas); mesma função em Verificar e Extrair | **Só revisão** (não há repositório com mais de uma página para exercitar) |
| 8 | Redesenhar listas remarcava tudo | Memória das marcações (ver seção 4) | **Testado** |
| 9 | Itens novos entravam sem perfil | Exes entram no perfil ativo; serviço nativo entra como Ambos | **Só revisão** (exige o diálogo de arquivos) |
| 10 | "Limpar log" só limpava a tela | `limparLog(alvo)` limpa tela e memória | **Testado** |
| 11 | Filtro do log por cor exata | `tipoDoLog()` agrupa as cores de sucesso/erro (inclui as do Bitbucket) | **Testado** |
| 12 | Limpeza de `.tmp` nunca rodava (chaves inexistentes) | Usa `PASTA_CLIENT/SERVER/DADOS`; só apaga `nome.ext.tmp` **parado há > 1 h**, teto de 50 mil entradas, avisa no log | **Testado** (remove órfão antigo e em subpasta; preserva recente, `.tmp` comum e outros arquivos) |
| 13 | Atualização offline gerava "Unhandled Rejection" | `.catch` com aviso no log | **Só revisão** |
| 14 | `window.event` e variáveis globais implícitas | Botão passado como argumento (`this`); `selectedService` e `unsavedChanges` declarados | **Testado** indiretamente (tela carrega e opera) |

Extras feitos no caminho: o texto vindo da API/arquivos do repositório passa a ser inserido na tela como texto (não como HTML) no Extrator Cloud.

### Pendências e observações
1. **"Sair mesmo assim" durante a cópia** deixa os serviços parados (o app encerra). Corrigir exigiria o backend lembrar quais serviços parou e religá-los ao sair.
2. **Token no mesmo usuário**: o token cifrado só abre para o **mesmo usuário do Windows**. Quem executa o ExeBoard elevando com **outra conta** de administrador verá o campo do token vazio e terá de informá-lo de novo.
3. **Voltar a uma versão antiga** do ExeBoard depois da migração do token faz o token sumir (versão antiga não conhece `PASSWORD_ENC`).
4. Parar um serviço **inexistente** ainda espera até 10 s pelo estado "parado" antes de seguir (comportamento antigo, não alterado).
5. Texto do passo 9 do tutorial fala em "Procurar", mas o diálogo é de **arquivo** (escolhe um arquivo dentro da branch) — manter coerência na interface.

---

## 18. Checklist de aceitação (roteiro de testes da migração)

Já validado no app Electron por testes de ponta a ponta (CDP) e deve passar igual no Tauri:
- Abre, carrega config, lista itens do perfil 734; troca para 733 e a lista muda; contagens e descrição do perfil; "Repetir última cópia" volta ao perfil salvo.
- Config legada (sem `Perfil`) é classificada sozinha e gravada; tema claro **continua** claro após a classificação.
- Branch real do Drive: pasta com exes 4.x → sugere 733; 5.x → sugere 734; aviso e botão "Trocar para N"; stub `1.0.0.0` é ignorado.
- Pasta ERP (raiz com ~1000 subpastas) **não** é varrida: aviso "Escolha a branch da tarefa".
- Aviso de exe antigo (> 10 dias) aparece sem bloquear.
- Cópia de exe de **serviço** parado/religado com sucesso (como administrador); sem administrador → mensagem clara.
- Cancelar durante cópia grande; fechar a janela durante cópia pede confirmação.
- Tutorial completo (10 passos), "Usar configuração padrão", "Pular", "Rever tutorial"; primeiro uso com `--user-data-dir` vazio.
- Extrator Cloud: sugestões de branch, verificar arquivos, extrair (pastas `branch` e `{base}`, `arquivos_ausentes.txt`).
- Atualização automática e instalação sobre a versão anterior.
- Instância única; bandeja (minimizar com opção ligada); X encerra.
- Aba Servidores: polling só com a aba visível; iniciar/parar/reiniciar em paralelo.

*(Quando algo novo for lembrado: adicione na seção certa e, se for decisão de migração, na 16 ou 17.)*

---

## 19. App Tauri: estrutura, build e release (migração do Electron)

O app Tauri vive em `tauri/` e **convive** com o Electron da raiz (que continua gerando releases). A interface é **uma só**:
`index.html`, `renderer.js` e `style.css` da raiz são copiados para `tauri/ui/` por `scripts/sync-ui.js`, junto com `shim/tauri-api.js`
(a ponte que expõe o mesmo `window.api` do `preload.js` do Electron, chamando os comandos Rust). O backend em Rust está em `tauri/src-tauri/src/`
(`config`, `services`, `index`, `branch`, `copy`, `bitbucket`, `ui_cmds`, `app`, `dpapi`, `util`) e segue este documento seção por seção.

### 19.1 Pré-requisitos para compilar
Rust (toolchain MSVC), **Visual Studio com a carga "Desenvolvimento para desktop com C++" + Windows SDK** (sem o SDK o linker não funciona), Node, WebView2.

### 19.2 Comandos (dentro de `tauri/`)
| Comando | Para quê |
|---|---|
| `node scripts/sync-ui.js` | monta `ui/` e gera `src-tauri/windows/hooks.nsh` |
| `cargo build` (em `src-tauri/`) | build de desenvolvimento: **não** exige Administrador, usa `%APPDATA%\ExeBoard-Dev`, não verifica atualização |
| `node scripts/release.js` | monta e confere a release **sem publicar** (usa o build existente) |
| `node scripts/release.js --build` | compila o release, assina, monta e confere (sem publicar) |
| `node scripts/release.js --publish --prerelease` | publica como **pré-lançamento** (não atualiza ninguém) |
| `node scripts/release.js --publish --confirmo-atualizar-todos` | publica release **normal**: atualiza todos os ExeBoard instalados |

A versão tem de ser igual em `tauri.conf.json`, `Cargo.toml` e `package.json` (o script confere) e **maior que a do último Electron (3.0.11)**. A primeira versão Tauri é a **3.1.0**.
O release (`cargo build --release`) embute o manifest `requireAdministrator`; o build de desenvolvimento não.

### 19.3 O que uma release contém (`release-out/v<versão>/`)
`ExeBoard_<v>_x64-setup.exe` (instalador NSIS por máquina), `.sig` (assinatura minisign), **`latest.json`** (lido pelo atualizador do **Tauri**) e
**`latest.yml`** (lido pelo atualizador do **Electron** — é a release "ponte"). Os dois descrevem o **mesmo instalador**.

### 19.4 Como cada tipo de instalação se atualiza
- **Já tem o Tauri**: o app consulta `https://github.com/nicochet01/ExeBoard-3.0/releases/latest/download/latest.json`, baixa, **verifica a assinatura** (chave pública embutida no app) e mostra o modal
  "Reiniciar e Atualizar". O atualizador exige que a versão anunciada seja a mesma para a qual o instalador foi assinado.
- **Ainda tem o Electron** (`electron-updater`): lê o `latest.yml` da release mais recente, baixa o instalador do Tauri, confere o `sha512` e o executa (o app não valida assinatura de editor).
  O instalador então **remove a instalação antiga** e instala a nova; o atualizador do Electron o chama com `--updated`, e nesse caso o app novo é aberto ao final.
- **Remoção da instalação antiga** (`src-tauri/windows/remover-electron.ps1`, embutido no instalador por `scripts/gerar-hook.js` e executado no gancho `NSIS_HOOK_PREINSTALL`):
  procura no registro (HKLM 64/32 bits e HKCU) chaves de desinstalação com `DisplayName` iniciando em "ExeBoard" **e** desinstalador chamado exatamente `Uninstall ExeBoard.exe` (o do Electron);
  encerra processos daquela pasta, roda o desinstalador silencioso e síncrono (`/S _?=<pasta>`), apaga a pasta (só se ela se chamar `ExeBoard`) e a chave. **Nunca** toca em `%APPDATA%\ExeBoard`.
  Qualquer falha é registrada em `%TEMP%\exeboard-migracao.log` e ignorada. Testado com `-DryRun` nas instalações reais e com instalações **falsas** (ver 19.6).
  Achado na máquina de desenvolvimento: **duas** instalações do Electron coexistindo (3.0.11 por máquina e 3.0.0 por usuário) — o script trata as duas.

### 19.5 Chave de assinatura
Gerada em `%USERPROFILE%\.tauri\exeboard.key` (sem senha); a chave **pública** está em `tauri.conf.json`. **Faça backup da chave privada fora da máquina**: sem ela não dá para publicar atualizações que os apps instalados aceitem.
O build lê a chave pela variável `TAURI_SIGNING_PRIVATE_KEY` (o `release.js --build` já define).

### 19.6 O que foi verificado e o que NÃO foi
Verificado (app Tauri de desenvolvimento, ponta a ponta): cópia, correções, perfis, visual, tutorial/ERP, janela (instância única, bandeja, X, X durante a cópia), token compatível com o Electron nos dois sentidos,
**atualizador** contra servidor local (baixa e mostra o modal com assinatura válida; **recusa** instalador adulterado e assinatura inválida; "sem versão nova" não faz nada),
`remover-electron.ps1` (simulação nas instalações reais; execução em instalações falsas: remove pasta e chave, preserva "Tauri" falso, preserva pasta com outro nome),
geração e auto-conferência de `latest.json`/`latest.yml` (o `sha512` confere), instalador NSIS com o gancho compila.

**NÃO verificado — fazer em UMA máquina de teste antes de publicar para todos:**
1. **Execução real do instalador sobre uma instalação do Electron** (precisa de Administrador e desinstala de fato a versão antiga): confirmar que remove o Electron, instala o Tauri, mantém `%APPDATA%\ExeBoard` e abre o app.
2. **O `electron-updater` consumindo o `latest.yml`** (só o formato foi comparado com o `latest.yml` real da 3.0.11).
3. **A instalação da atualização pelo Tauri** (`Update.install`) e o reabrir depois — só o download/verificação foi testado.
4. **Abertura do `.exe` de release como Administrador** (o teste automatizado roda a versão de desenvolvimento, sem UAC).

### 19.7 Ordem segura de publicação
1. Publicar como **pré-lançamento** (`--prerelease`): o `/releases/latest` e o atualizador do Electron **ignoram** pré-lançamentos → ninguém é atualizado.
2. Baixar o instalador da pré-release numa máquina de teste e executar o roteiro 19.6 (itens 1, 3 e 4).
3. Só então publicar como release normal (`--confirmo-atualizar-todos`) — a partir daí **todos** os Electron instalados se atualizam na próxima abertura.
4. Reversão: apagar a release no GitHub impede novas migrações, mas quem já migrou fica com o Tauri (voltar ao Electron exige reinstalar o instalador antigo; a configuração em `%APPDATA%\ExeBoard` continua compatível).

