//! Motor de cópia — seção 7 de docs/REGRAS-DE-NEGOCIO.md.
//! Montagem da fila, cópia segura (`.tmp` + troca atômica, 5 tentativas, cancelável), 4 trabalhadores simultâneos,
//! cópia nativa do Windows (CopyFileExW) e pulo dos arquivos que já estão iguais no destino.

use crate::index::{cached_index, index_dir, Index};
use crate::state::AppState;
use crate::util::*;
use futures::StreamExt;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use core::ffi::c_void;
use std::sync::atomic::AtomicBool;
use windows::core::PCWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{
    CopyFileExW, COPYFILE_FLAGS, COPYPROGRESSROUTINE_PROGRESS, LPPROGRESS_ROUTINE_CALLBACK_REASON, PROGRESS_CANCEL, PROGRESS_CONTINUE,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const VERMELHO: &str = "#f38ba8";
const VERDE: &str = "#40a02b";
const AZUL: &str = "#89b4fa";
const CINZA_CLARO: &str = "#bac2de";
const ROXO: &str = "#cba6f7";
const LARANJA: &str = "#fab387";

const MAX_RETRIES: u32 = 5;
const RETRY_DELAY: Duration = Duration::from_secs(2);
const CONCURRENCY: usize = 4;
/// Arquivos copiados ao mesmo tempo dentro de uma pasta dos .cds (que costuma ter centenas de arquivos)
const CONCURRENCY_PASTA: usize = 6;
/// Diferença de data tolerada para considerar o destino igual à origem (sistemas de arquivos arredondam a data)
const TOLERANCIA_DATA: Duration = Duration::from_secs(2);

fn cancelado(app: &AppHandle) -> bool {
    app.state::<AppState>().copy_cancel.load(Ordering::SeqCst)
}

// =====================================================================
// Montagem da fila
// =====================================================================

fn tira_prefixo_bd(nome: &str) -> &str {
    for p in ["bd\\", "bd/", "dados\\", "dados/"] {
        if let Some(resto) = nome.strip_prefix(p) {
            return resto;
        }
    }
    nome
}

fn basename(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Resolve a subpasta real de um exe que já existe no destino (modo detetive), mantendo a caixa do disco.
fn subpasta_real(dest_dir: &str, achado: &Path) -> String {
    let raiz_norm = norm_path(dest_dir);
    let pasta = achado.parent().map(|p| p.to_string_lossy().replace('/', "\\")).unwrap_or_default();
    let pasta = pasta.trim_end_matches('\\').to_string();
    if !pasta.to_lowercase().starts_with(&raiz_norm) {
        return String::new();
    }
    let mut real: String = pasta.chars().skip(raiz_norm.chars().count()).collect();
    if !real.is_empty() && !real.starts_with('\\') {
        real.insert(0, '\\');
    }
    real
}

/// Mapeia a branch e resolve o destino final de cada item marcado.
/// Devolve `{queue:[{origem,destino,type}], learnedPaths:[{type,name,subFolder}]}`.
#[tauri::command]
pub async fn build_queue(app: AppHandle, reqs: Option<Vec<Value>>, branch_root: String) -> Result<Value, String> {
    let mut queue: Vec<Value> = Vec::new();
    let mut learned: Vec<Value> = Vec::new();
    let reqs = reqs.unwrap_or_default();
    if reqs.is_empty() {
        return Ok(json!({ "queue": queue, "learnedPaths": learned }));
    }

    send_log(&app, &format!("Mapeando Branch: {branch_root}"), AZUL, "copiar");
    let idx: Arc<Index> = cached_index(&app, &branch_root).await;
    if idx.file_map.is_empty() && idx.dir_map.is_empty() {
        send_log(&app, "AVISO: Nenhum arquivo ou pasta encontrado na Branch.", VERMELHO, "copiar");
        return Ok(json!({ "queue": queue, "learnedPaths": learned }));
    }

    // Busca híbrida: só varre o DESTINO para itens sem subpasta definida
    let sem_subpasta = |r: &Value| -> bool {
        let tipo = str_of(r, "type");
        let sub = r.get("itemData").map(|i| str_of(i, "SubDiretorios")).unwrap_or_default();
        tipo != "bd" && (sub.is_empty() || sub == "\\")
    };
    let mut raizes: Vec<String> = Vec::new();
    for r in reqs.iter().filter(|r| sem_subpasta(r)) {
        let d = str_of(r, "destDir");
        if !raizes.contains(&d) {
            raizes.push(d);
        }
    }
    let mut mapas_destino: HashMap<String, Index> = HashMap::new();
    for raiz in raizes {
        send_log(
            &app,
            &format!("MODO DETETIVE: Localizando subpastas em {}...", basename(Path::new(&raiz))),
            ROXO,
            "copiar",
        );
        let m = index_dir(&app, Path::new(&raiz)).await;
        mapas_destino.insert(raiz, m);
    }

    send_log(&app, "Cruzando dados e resolvendo caminhos finais...", AZUL, "copiar");
    let mut reivindicados: HashSet<String> = HashSet::new(); // dois itens não podem apontar para o mesmo destino
    let raiz_branch_norm = norm_path(&branch_root);

    for req in &reqs {
        let tipo = str_of(req, "type");
        let dest_dir = str_of(req, "destDir");
        let item = req.get("itemData").cloned().unwrap_or(Value::Null);
        let nome_cadastrado = match &item {
            Value::String(s) => s.clone(),
            v => str_of(v, "Nome"),
        };
        let mut nome_puro = nome_cadastrado.to_lowercase();

        if tipo == "bd" {
            // ---- Pastas dos .cds ----
            let limpo = tira_prefixo_bd(&nome_puro).trim().to_string();
            let puro_norm = nome_puro.replace('/', "\\");
            // 1) caminhos inequívocos: cadastrado com caminho (bd\x, a\b), bd\<nome>, dados\<nome>
            let mut origem: Option<PathBuf> = if puro_norm.contains('\\') { idx.dir_map.get(&puro_norm).cloned() } else { None };
            if origem.is_none() {
                origem = idx
                    .dir_map
                    .get(&format!("bd\\{limpo}"))
                    .or_else(|| idx.dir_map.get(&format!("dados\\{limpo}")))
                    .cloned();
            }
            // 2) pelo nome puro: só é seguro no primeiro nível da branch ou quando existe UMA única pasta com o nome
            if origem.is_none() {
                if let Some(p) = idx.dir_map.get(&limpo) {
                    let no_primeiro_nivel = p.parent().map(|pai| norm_path(&pai.to_string_lossy()) == raiz_branch_norm).unwrap_or(false);
                    if idx.ambiguous.contains(&limpo) && !no_primeiro_nivel {
                        send_log(
                            &app,
                            &format!("X Ambíguo: existem várias pastas chamadas \"{limpo}\" na Branch. Organize-a em bd\\{limpo} ou dados\\{limpo} para evitar copiar a pasta errada."),
                            VERMELHO,
                            "copiar",
                        );
                        continue;
                    }
                    origem = Some(p.clone());
                }
            }
            let Some(origem) = origem else {
                send_log(&app, &format!("X Pasta dos .cds não encontrada na Branch: {nome_puro}"), CINZA_CLARO, "copiar");
                continue;
            };
            let destino = Path::new(&dest_dir).join(basename(&origem));
            let chave = norm_path(&destino.to_string_lossy());
            if !reivindicados.insert(chave) {
                send_log(
                    &app,
                    &format!("X Destino duplicado ignorado (já reivindicado por outro item selecionado): {}", destino.display()),
                    VERMELHO,
                    "copiar",
                );
                continue;
            }
            queue.push(json!({ "origem": path_str(&origem), "destino": path_str(&destino), "type": "bd" }));
        } else {
            // ---- Clientes e servidores (arquivos) ----
            if nome_puro.ends_with(".exe") {
                nome_puro.truncate(nome_puro.len() - 4);
            }
            let exe_nome = format!("{nome_puro}.exe");
            let Some(origem) = idx.file_map.get(&exe_nome).or_else(|| idx.file_map.get(&nome_puro)) else {
                send_log(&app, &format!("X Não encontrado na Branch: {nome_puro}"), CINZA_CLARO, "copiar");
                continue;
            };

            // FIDELIDADE DE NOME: o destino usa o nome EXATO cadastrado
            let arquivo_final = ensure_exe_suffix(&nome_cadastrado);
            let mut sub = str_of(&item, "SubDiretorios").trim_end_matches('\\').to_string();

            // Sem subpasta cadastrada: tenta descobrir onde o exe já está no destino
            if sub.is_empty() || sub == "\\" {
                if let Some(achado) = mapas_destino.get(&dest_dir).and_then(|m| m.file_map.get(&exe_nome)) {
                    sub = subpasta_real(&dest_dir, &achado.full_path);
                    send_log(
                        &app,
                        &format!("-> DESCOBERTO: {arquivo_final} está em {}", if sub.is_empty() { "Raiz" } else { &sub }),
                        ROXO,
                        "copiar",
                    );
                    learned.push(json!({ "type": tipo, "name": nome_cadastrado, "subFolder": sub }));
                }
            }

            let destino = join_sub(&dest_dir, &sub, &arquivo_final);
            let chave = norm_path(&destino.to_string_lossy());
            if !reivindicados.insert(chave) {
                send_log(
                    &app,
                    &format!("X Destino duplicado ignorado (já reivindicado por outro item selecionado): {}", destino.display()),
                    VERMELHO,
                    "copiar",
                );
                continue;
            }
            queue.push(json!({ "origem": path_str(&origem.full_path), "destino": path_str(&destino), "type": tipo }));
        }
    }
    Ok(json!({ "queue": queue, "learnedPaths": learned }))
}

// =====================================================================
// Cópia segura de arquivo
// =====================================================================

#[derive(PartialEq, Clone, Copy)]
enum Resultado {
    Ok,
    Cancelado,
    /// O destino já era igual à origem (mesmo tamanho e mesma data): nada a copiar
    Igual,
}

/// O destino já tem o mesmo arquivo da origem? Mesmo tamanho e mesma data de modificação (a cópia nativa do Windows
/// preserva a data, então um arquivo copiado antes pelo ExeBoard bate exatamente). Se o arquivo de destino foi
/// alterado (ex.: a base .cds usada nos testes), a data muda e ele é copiado de novo.
async fn sem_alteracao(origem: &Path, destino: &Path) -> bool {
    let (Ok(o), Ok(d)) = (tokio::fs::metadata(origem).await, tokio::fs::metadata(destino).await) else { return false };
    if !d.is_file() || o.len() != d.len() {
        return false;
    }
    let (Ok(mo), Ok(md)) = (o.modified(), d.modified()) else { return false };
    let dif = mo.duration_since(md).or_else(|_| md.duration_since(mo)).unwrap_or(Duration::MAX);
    dif <= TOLERANCIA_DATA
}

/// Erro de trava/permissão (EPERM/EBUSY do Electron): acesso negado (5), violação de compartilhamento (32) ou de trava (33).
fn erro_de_trava(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33)) || e.kind() == std::io::ErrorKind::PermissionDenied
}

/// Chamada pelo Windows durante a cópia: interrompe assim que o usuário cancela.
unsafe extern "system" fn progresso_copia(
    _total: i64,
    _copiado: i64,
    _stream: i64,
    _stream_copiado: i64,
    _n: u32,
    _motivo: LPPROGRESS_ROUTINE_CALLBACK_REASON,
    _origem: HANDLE,
    _destino: HANDLE,
    dados: *const c_void,
) -> COPYPROGRESSROUTINE_PROGRESS {
    // `dados` aponta para o AtomicBool de cancelamento do AppState, que vive enquanto o app estiver aberto
    let cancelar = unsafe { &*(dados as *const AtomicBool) };
    if cancelar.load(Ordering::SeqCst) { PROGRESS_CANCEL } else { PROGRESS_CONTINUE }
}

fn largo(p: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// Cópia nativa do Windows (CopyFileExW) para qualquer tamanho: E/S otimizada pelo sistema, preserva a data de
/// modificação (usada para pular arquivos iguais) e é cancelável no meio. Devolve `true` se foi cancelada.
fn copia_nativa(app: &AppHandle, origem: &Path, tmp: &Path) -> std::io::Result<bool> {
    let (o, t) = (largo(origem), largo(tmp));
    let estado = app.state::<AppState>();
    let dados = &estado.copy_cancel as *const AtomicBool as *const c_void;
    let r = unsafe { CopyFileExW(PCWSTR(o.as_ptr()), PCWSTR(t.as_ptr()), Some(progresso_copia), Some(dados), None, COPYFILE_FLAGS(0)) };
    match r {
        Ok(()) => Ok(false),
        Err(_) if cancelado(app) => {
            let _ = std::fs::remove_file(tmp);
            Ok(true)
        }
        Err(e) => {
            // HRESULT 0x8007xxxx = erro Win32 xxxx (mantém 5/32/33 para a detecção de arquivo preso)
            let hr = e.code().0 as u32;
            if hr >> 16 == 0x8007 {
                Err(std::io::Error::from_raw_os_error((hr & 0xFFFF) as i32))
            } else {
                Err(std::io::Error::new(std::io::ErrorKind::Other, e.message()))
            }
        }
    }
}

async fn tentar_copiar(app: &AppHandle, origem: &Path, destino: &Path, tmp: &Path) -> std::io::Result<Resultado> {
    // remove somente-leitura do destino, se houver
    if let Ok(meta) = tokio::fs::metadata(destino).await {
        let mut perm = meta.permissions();
        if perm.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perm.set_readonly(false);
            let _ = tokio::fs::set_permissions(destino, perm).await;
        }
    }
    let (a, o, t) = (app.clone(), origem.to_path_buf(), tmp.to_path_buf());
    let cancelou = tauri::async_runtime::spawn_blocking(move || copia_nativa(&a, &o, &t))
        .await
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))??;
    if cancelou {
        return Ok(Resultado::Cancelado);
    }
    if cancelado(app) {
        let _ = tokio::fs::remove_file(tmp).await;
        return Ok(Resultado::Cancelado);
    }
    // Troca atômica: do temporário para o destino final (substitui o existente)
    tokio::fs::rename(tmp, destino).await?;
    Ok(Resultado::Ok)
}

/// Copia gravando em `destino.tmp` e trocando no fim. Até 5 tentativas; em erro de trava mata o processo do exe
/// de destino antes de tentar de novo. Esgotadas, explica a provável falta de Administrador.
async fn secure_copy_file(app: &AppHandle, origem: &Path, destino: &Path) -> Result<Resultado, String> {
    if sem_alteracao(origem, destino).await {
        return Ok(Resultado::Igual);
    }
    let mut tentativas = 0u32;
    loop {
        if cancelado(app) {
            return Ok(Resultado::Cancelado);
        }
        let mut tmp_os = destino.as_os_str().to_owned();
        tmp_os.push(".tmp");
        let tmp = PathBuf::from(tmp_os);

        match tentar_copiar(app, origem, destino, &tmp).await {
            Ok(r) => return Ok(r),
            Err(err) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                if cancelado(app) {
                    return Ok(Resultado::Cancelado);
                }
                tentativas += 1;
                let trava = erro_de_trava(&err);
                let nome_dest = basename(destino);
                if tentativas < MAX_RETRIES {
                    send_log(
                        app,
                        &format!("Tentativa {tentativas} falhou p/ {nome_dest}. Falha física ou arquivo preso. Retentando..."),
                        LARANJA,
                        "copiar",
                    );
                    // O destino costuma estar preso por um processo ainda de pé (não parou a tempo ou é religado
                    // por um watchdog): força o encerramento pelo nome do executável antes de tentar de novo.
                    if trava && nome_dest.to_lowercase().ends_with(".exe") && nome_seguro(&nome_dest) {
                        let _ = run_cmd("taskkill", &["/F", "/IM", &nome_dest]).await;
                    }
                    tokio::time::sleep(RETRY_DELAY).await;
                } else {
                    if trava && !is_process_running(&nome_dest).await {
                        send_log(
                            app,
                            &format!("ERRO: Falha persistente ao gravar em \"{}\" mesmo sem nenhum processo travando o arquivo pelo nome. Se o problema persistir, feche o ExeBoard e abra-o novamente como Administrador.", destino.display()),
                            VERMELHO,
                            "copiar",
                        );
                    }
                    return Err(err.to_string());
                }
            }
        }
    }
}

/// Resultado da cópia de uma pasta: quantos arquivos foram copiados e quantos já estavam iguais.
struct ResumoPasta {
    cancelado: bool,
    copiados: usize,
    iguais: usize,
}

/// Copia uma pasta inteira (mescla e sobrescreve; não apaga o que só existe no destino).
/// Primeiro cria as pastas e lista os arquivos; depois copia vários arquivos ao mesmo tempo, pulando os que já estão
/// iguais no destino. Se algum arquivo falhar de vez (após as 5 tentativas), a pasta inteira conta como erro.
async fn copy_folder_recursive(app: &AppHandle, origem: &Path, destino: &Path) -> Result<ResumoPasta, String> {
    let cancelou = ResumoPasta { cancelado: true, copiados: 0, iguais: 0 };
    if cancelado(app) {
        return Ok(cancelou);
    }
    let meta = tokio::fs::metadata(origem).await.map_err(|e| e.to_string())?;
    if !meta.is_dir() {
        return Err(format!("{} não é uma pasta", origem.display()));
    }
    let mut arquivos: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut pilha: Vec<(PathBuf, PathBuf)> = vec![(origem.to_path_buf(), destino.to_path_buf())];
    while let Some((src, dst)) = pilha.pop() {
        if cancelado(app) {
            return Ok(cancelou);
        }
        if !dst.exists() {
            tokio::fs::create_dir_all(&dst).await.map_err(|e| e.to_string())?;
            send_log(app, &format!("Criado diretório: {}", basename(&dst)), CINZA_CLARO, "copiar");
        }
        let mut rd = tokio::fs::read_dir(&src).await.map_err(|e| e.to_string())?;
        while let Some(e) = rd.next_entry().await.map_err(|e| e.to_string())? {
            let s = src.join(e.file_name());
            let d = dst.join(e.file_name());
            if e.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
                pilha.push((s, d));
            } else {
                arquivos.push((s, d));
            }
        }
    }

    let copiados = AtomicUsize::new(0);
    let iguais = AtomicUsize::new(0);
    let resultados: Vec<Result<Resultado, String>> = futures::stream::iter(arquivos)
        .map(|(s, d)| {
            let (copiados, iguais) = (&copiados, &iguais);
            async move {
                if cancelado(app) {
                    return Ok(Resultado::Cancelado);
                }
                let r = secure_copy_file(app, &s, &d).await?;
                match r {
                    Resultado::Ok => copiados.fetch_add(1, Ordering::SeqCst),
                    Resultado::Igual => iguais.fetch_add(1, Ordering::SeqCst),
                    Resultado::Cancelado => 0,
                };
                Ok(r)
            }
        })
        .buffer_unordered(CONCURRENCY_PASTA)
        .collect()
        .await;
    if let Some(Err(e)) = resultados.iter().find(|r| r.is_err()) {
        return Err(e.clone());
    }
    let foi_cancelado = cancelado(app) || resultados.iter().any(|r| matches!(r, Ok(Resultado::Cancelado)));
    Ok(ResumoPasta {
        cancelado: foi_cancelado,
        copiados: copiados.load(Ordering::SeqCst),
        iguais: iguais.load(Ordering::SeqCst),
    })
}

// =====================================================================
// Execução
// =====================================================================

#[tauri::command]
pub fn cancel_copy(app: AppHandle, state: State<'_, AppState>) {
    state.copy_cancel.store(true, Ordering::SeqCst);
    send_log(&app, "Solicitação de cancelamento recebida pelo Motor.", VERMELHO, "copiar");
}

/// Copia a fila com 4 trabalhadores simultâneos e emite `copy-progress`.
/// Devolve `{status: completed|cancelled, errors, news, skipped}`.
#[tauri::command]
pub async fn execute_copy_files(app: AppHandle, state: State<'_, AppState>, fila: Option<Vec<Value>>) -> Result<Value, String> {
    let fila = fila.unwrap_or_default();
    state.copy_cancel.store(false, Ordering::SeqCst);
    let total = fila.len();
    let erros = Arc::new(AtomicUsize::new(0));
    let novos = Arc::new(AtomicUsize::new(0));
    let ignorados = Arc::new(AtomicUsize::new(0));
    let iguais = Arc::new(AtomicUsize::new(0));
    let concluidos = Arc::new(AtomicUsize::new(0));

    let emitir = {
        let app = app.clone();
        let concluidos = concluidos.clone();
        move |arquivo: &str| {
            let atual = concluidos.load(Ordering::SeqCst);
            let pct = if total > 0 { ((atual as f64 / total as f64) * 100.0).round() as i64 } else { 0 };
            let _ = app.emit("copy-progress", json!({ "current": atual, "total": total, "percent": pct, "fileName": arquivo }));
        }
    };
    emitir("");

    state.copy_in_progress.store(true, Ordering::SeqCst); // antes de iniciar: os trabalhadores começam a copiar na hora

    futures::stream::iter(fila)
        .for_each_concurrent(CONCURRENCY, |tarefa| {
            let app = app.clone();
            let (erros, novos, ignorados, iguais, concluidos) =
                (erros.clone(), novos.clone(), ignorados.clone(), iguais.clone(), concluidos.clone());
            let emitir = &emitir;
            async move {
                if cancelado(&app) {
                    return;
                }
                let origem = PathBuf::from(str_of(&tarefa, "origem"));
                let destino = PathBuf::from(str_of(&tarefa, "destino"));
                let tipo = str_of(&tarefa, "type");

                let r: Result<(), String> = async {
                    if !origem.exists() {
                        send_log(&app, &format!("PULANDO: Origem não encontrada [{}]", origem.display()), CINZA_CLARO, "copiar");
                        ignorados.fetch_add(1, Ordering::SeqCst);
                        return Ok(());
                    }
                    let eh_novo = !destino.exists();
                    if tipo == "bd" {
                        let resumo = copy_folder_recursive(&app, &origem, &destino).await?;
                        if resumo.cancelado {
                            ignorados.fetch_add(1, Ordering::SeqCst);
                            return Ok(());
                        }
                        if resumo.copiados == 0 && resumo.iguais > 0 {
                            iguais.fetch_add(1, Ordering::SeqCst);
                            send_log(&app, &format!("SEM ALTERAÇÃO: pasta {} já estava igual à da branch ({} arquivo(s)).", basename(&destino), resumo.iguais), CINZA_CLARO, "copiar");
                            return Ok(());
                        }
                        novos.fetch_add(1, Ordering::SeqCst);
                        let extra = if resumo.iguais > 0 { format!(" ({} copiado(s), {} já igual(is))", resumo.copiados, resumo.iguais) } else { String::new() };
                        send_log(&app, &format!("PASTA ATUALIZADA: {}{extra}", basename(&destino)), VERDE, "copiar");
                    } else {
                        if let Some(pai) = destino.parent() {
                            tokio::fs::create_dir_all(pai).await.map_err(|e| e.to_string())?;
                        }
                        match secure_copy_file(&app, &origem, &destino).await? {
                            Resultado::Cancelado => {
                                ignorados.fetch_add(1, Ordering::SeqCst);
                                return Ok(());
                            }
                            Resultado::Igual => {
                                iguais.fetch_add(1, Ordering::SeqCst);
                                send_log(&app, &format!("SEM ALTERAÇÃO: {} já estava igual ao da branch.", basename(&destino)), CINZA_CLARO, "copiar");
                                return Ok(());
                            }
                            Resultado::Ok => {}
                        }
                        novos.fetch_add(1, Ordering::SeqCst);
                        if eh_novo {
                            send_log(&app, &format!("NOVO ARQUIVO (Instalação Limpa): {}", basename(&destino)), "#d65d0e", "copiar");
                        } else {
                            send_log(&app, &format!("ATUALIZADO: {}", destino.display()), VERDE, "copiar");
                        }
                    }
                    Ok(())
                }
                .await;

                if let Err(e) = r {
                    erros.fetch_add(1, Ordering::SeqCst);
                    send_log(&app, &format!("ERRO FATAL em {}: {e}", origem.display()), VERMELHO, "copiar");
                }
                concluidos.fetch_add(1, Ordering::SeqCst);
                emitir(&basename(&destino));
            }
        })
        .await;

    state.copy_in_progress.store(false, Ordering::SeqCst);
    let status = if state.copy_cancel.load(Ordering::SeqCst) { "cancelled" } else { "completed" };
    Ok(json!({
        "status": status,
        "errors": erros.load(Ordering::SeqCst),
        "news": novos.load(Ordering::SeqCst),
        "skipped": ignorados.load(Ordering::SeqCst),
        "unchanged": iguais.load(Ordering::SeqCst)
    }))
}

// =====================================================================
// Limpeza de temporários órfãos (seção 2.7)
// =====================================================================

const TMP_ORFAO_IDADE: Duration = Duration::from_secs(3600);
const TMP_LIMITE_ENTRADAS: usize = 50_000;

/// `nome.ext.tmp` — o que a cópia segura grava. Um `.tmp` de outro programa não tem a extensão original.
fn eh_tmp_do_exeboard(nome: &str) -> bool {
    let n = nome.to_lowercase();
    let Some(sem_tmp) = n.strip_suffix(".tmp") else { return false };
    let Some(i) = sem_tmp.rfind('.') else { return false };
    let ext = &sem_tmp[i + 1..];
    (1..=8).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Apaga os `.tmp` órfãos (parados há mais de 1 hora) das três pastas de destino configuradas.
pub fn limpar_temporarios(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = app.state::<AppState>().config.snapshot();
        let c = cfg.get("CAMINHOS").cloned().unwrap_or(Value::Null);
        let mut raizes: Vec<String> = Vec::new();
        for k in ["PASTA_CLIENT", "PASTA_SERVER", "PASTA_DADOS"] {
            let p = str_of(&c, k);
            if !p.is_empty() && !p.contains("Informe") && !raizes.iter().any(|r| norm_path(r) == norm_path(&p)) {
                raizes.push(p);
            }
        }
        let mut visitadas = 0usize;
        let mut removidos = 0usize;
        for raiz in raizes {
            let mut pilha = vec![PathBuf::from(&raiz)];
            while let Some(dir) = pilha.pop() {
                if visitadas >= TMP_LIMITE_ENTRADAS {
                    break;
                }
                let Ok(rd) = std::fs::read_dir(&dir) else { continue };
                for e in rd.flatten() {
                    visitadas += 1;
                    let Ok(t) = e.file_type() else { continue };
                    let caminho = e.path();
                    if t.is_dir() {
                        pilha.push(caminho);
                        continue;
                    }
                    if !t.is_file() || !eh_tmp_do_exeboard(&e.file_name().to_string_lossy()) {
                        continue;
                    }
                    let velho = e
                        .metadata()
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|m| m.elapsed().ok())
                        .map(|d| d >= TMP_ORFAO_IDADE)
                        .unwrap_or(false);
                    if velho && std::fs::remove_file(&caminho).is_ok() {
                        removidos += 1;
                        log_info(&format!("Arquivo temporário órfão removido: {}", caminho.display()));
                    }
                }
            }
        }
        if removidos > 0 {
            send_log(
                &app,
                &format!("Limpeza: {removidos} arquivo(s) temporário(s) órfão(s) de cópias interrompidas removido(s)."),
                ROXO,
                "copiar",
            );
        }
    });
}
