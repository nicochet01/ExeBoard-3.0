//! Indexação da pasta da branch (e das pastas de destino) — seção 7.1 de docs/REGRAS-DE-NEGOCIO.md.

use crate::state::AppState;
use crate::util::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub struct FileEntry {
    pub full_path: PathBuf,
    pub mtime_ms: f64,
    pub size: u64,
}

pub struct Index {
    /// nome-em-minúsculas -> arquivo. Nome repetido em várias pastas: vence o de maior data de modificação.
    pub file_map: HashMap<String, FileEntry>,
    /// nome da pasta E caminho relativo (`bd\firebird`), tudo em minúsculas -> caminho completo
    pub dir_map: HashMap<String, PathBuf>,
    /// nomes de pasta que existem em mais de um lugar da árvore
    pub ambiguous: HashSet<String>,
}

/// Pastas de controle de versão/metadados que nunca entram na varredura.
const IGNORADAS: [&str; 7] = [".git", ".svn", ".vs", ".idea", ".vscode", "node_modules", "__pycache__"];

/// Varredura em pilha (sem recursão). Pastas ilegíveis viram um aviso no log e são puladas; os `stat` dos
/// arquivos rodam em lotes paralelos de 25 (a pasta do Google Drive é lenta, o paralelismo compensa).
pub async fn index_dir(app: &AppHandle, start: &Path) -> Index {
    let mut file_map: HashMap<String, FileEntry> = HashMap::new();
    let mut dir_map: HashMap<String, PathBuf> = HashMap::new();
    let mut ambiguous: HashSet<String> = HashSet::new();
    let mut pilha: Vec<PathBuf> = vec![start.to_path_buf()];

    while let Some(atual) = pilha.pop() {
        let mut rd = match tokio::fs::read_dir(&atual).await {
            Ok(r) => r,
            Err(_) => {
                send_log(
                    app,
                    &format!("Aviso: Pasta ignorada (Acesso Negado): {}", atual.display()),
                    "#fe640b",
                    "copiar",
                );
                continue;
            }
        };
        let mut arquivos: Vec<(String, PathBuf)> = Vec::new();

        loop {
            let entrada = match rd.next_entry().await {
                Ok(Some(e)) => e,
                _ => break,
            };
            let nome = entrada.file_name().to_string_lossy().to_lowercase();
            let completo = atual.join(entrada.file_name());
            let tipo = match entrada.file_type().await {
                Ok(t) => t,
                Err(_) => {
                    send_log(
                        app,
                        &format!("Aviso: Item ignorado dentro de {}: {}", atual.display(), entrada.file_name().to_string_lossy()),
                        "#fe640b",
                        "copiar",
                    );
                    continue;
                }
            };
            if tipo.is_dir() {
                if IGNORADAS.contains(&nome.as_str()) {
                    continue;
                }
                pilha.push(completo.clone());
                let rel = completo
                    .strip_prefix(start)
                    .map(|p| p.to_string_lossy().replace('/', "\\").to_lowercase())
                    .unwrap_or_default();
                match dir_map.get(&nome) {
                    None => {
                        dir_map.insert(nome.clone(), completo.clone());
                    }
                    Some(existente) if *existente != completo => {
                        ambiguous.insert(nome.clone());
                    }
                    _ => {}
                }
                dir_map.entry(rel).or_insert(completo);
            } else {
                arquivos.push((nome, completo));
            }
        }

        for lote in arquivos.chunks(25) {
            let metas = futures::future::join_all(lote.iter().map(|(_, p)| tokio::fs::metadata(p))).await;
            for ((nome, completo), meta) in lote.iter().zip(metas) {
                let Ok(m) = meta else { continue };
                let mtime = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs_f64() * 1000.0)
                    .unwrap_or(0.0);
                let trocar = match file_map.get(nome) {
                    None => true,
                    Some(e) => mtime > e.mtime_ms,
                };
                if trocar {
                    file_map.insert(nome.clone(), FileEntry { full_path: completo.clone(), mtime_ms: mtime, size: m.len() });
                }
            }
        }
    }
    Index { file_map, dir_map, ambiguous }
}

const TTL_CACHE: Duration = Duration::from_secs(8);

/// Índice da branch com cache curto (8 s). O lock fica preso durante a varredura: quem pedir a mesma pasta ao
/// mesmo tempo (validar + montar fila, idade + versão) espera e reaproveita o resultado — uma leitura só do Drive.
pub async fn cached_index(app: &AppHandle, dir: &str) -> Arc<Index> {
    let state = app.state::<AppState>();
    let chave = norm_path(dir);
    let mut g = state.index_cache.lock().await;
    if let Some((p, t, d)) = g.as_ref() {
        if *p == chave && t.elapsed() < TTL_CACHE {
            return d.clone();
        }
    }
    let novo = Arc::new(index_dir(app, Path::new(dir)).await);
    *g = Some((chave, Instant::now(), novo.clone()));
    novo
}

/// Uma pasta com MUITAS subpastas no primeiro nível (a ERP, ~1000 branches) não é uma branch: varrê-la leria todas
/// as branches e o "exe mais novo" de cada nome viria de uma branch qualquer.
const MAX_SUBPASTAS_BRANCH: usize = 100;

pub async fn eh_raiz_de_branches(dir: &str) -> bool {
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else { return false };
    let mut n = 0usize;
    while let Ok(Some(e)) = rd.next_entry().await {
        if let Ok(t) = e.file_type().await {
            if t.is_dir() {
                n += 1;
                if n > MAX_SUBPASTAS_BRANCH {
                    return true;
                }
            }
        }
    }
    false
}
