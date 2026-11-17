//! Extrator Cloud (Bitbucket) — seção 12 de docs/REGRAS-DE-NEGOCIO.md.
//! Toda a comunicação com a API fica aqui no backend (a tela só chama os comandos).

use crate::util::*;
use reqwest::{Client, StatusCode, Url};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

const VERMELHO: &str = "#f38ba8";

fn cliente() -> Client {
    Client::builder()
        .user_agent("ExeBoard")
        .timeout(Duration::from_secs(120))
        .build()
        .expect("cliente HTTP")
}

/// Valor entre aspas numa consulta BbQL (`name = "..."`)
fn bbq(valor: &str) -> String {
    valor.replace('\\', "\\\\").replace('"', "\\\"")
}

fn erro_rede(e: &reqwest::Error) -> String {
    format!("Sem conexão com o Bitbucket ({e}). Verifique a internet/VPN.")
}

/// URL `https://api.bitbucket.org/2.0/repositories/{ws}/{repo}/...` com cada trecho codificado corretamente.
fn url_repo(workspace: &str, repo: &str, resto: &[&str]) -> Result<Url, String> {
    let mut u = Url::parse("https://api.bitbucket.org/2.0/repositories/").map_err(|e| e.to_string())?;
    {
        let mut seg = u.path_segments_mut().map_err(|_| "URL inválida".to_string())?;
        seg.pop_if_empty().push(workspace).push(repo);
        for r in resto {
            seg.push(r);
        }
    }
    Ok(u)
}

/// Mensagem amigável para uma resposta de erro da API (ex.: 403 por falta de 2FA não pode virar "nenhuma branch").
async fn mensagem_erro(res: reqwest::Response, contexto: &str) -> String {
    let status = res.status();
    let corpo = res.text().await.unwrap_or_default();
    let detalhe = match serde_json::from_str::<Value>(&corpo) {
        Ok(j) => j
            .pointer("/error/message")
            .or_else(|| j.pointer("/error/detail"))
            .or_else(|| j.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        Err(_) => corpo.chars().take(200).collect(),
    };
    let motivo = match status {
        StatusCode::UNAUTHORIZED => "usuário ou API Token inválido (401). Confira o e-mail e o token.".to_string(),
        StatusCode::FORBIDDEN => format!(
            "acesso negado (403){}. Confira se a conta tem a verificação em duas etapas ativa e se o token tem permissão de leitura do repositório.",
            if detalhe.is_empty() { String::new() } else { format!(": {detalhe}") }
        ),
        StatusCode::NOT_FOUND => "workspace ou repositório não encontrado (404). Confira os nomes.".to_string(),
        StatusCode::TOO_MANY_REQUESTS => "muitas requisições ao Bitbucket (429). Aguarde um instante e tente de novo.".to_string(),
        s => format!("erro {}{}", s.as_u16(), if detalhe.is_empty() { String::new() } else { format!(": {detalhe}") }),
    };
    if contexto.is_empty() {
        motivo
    } else {
        format!("{contexto}: {motivo}")
    }
}

fn campo(c: &Value, k: &str) -> String {
    str_of(c, k)
}

/// Lista branches para o autocomplete → `{branches, error}` (o erro real, em vez de lista vazia).
#[tauri::command]
pub async fn list_branches(config: Value) -> Result<Value, String> {
    let (ws, repo, user, token, termo) = (
        campo(&config, "workspace"),
        campo(&config, "repo"),
        campo(&config, "user"),
        campo(&config, "appPassword"),
        campo(&config, "searchTerm"),
    );
    if ws.is_empty() || repo.is_empty() || user.is_empty() || token.is_empty() {
        return Ok(json!({ "branches": [], "error": "Preencha Workspace, Repositório, Usuário e API Token acima para listar as branches." }));
    }
    let mut url = url_repo(&ws, &repo, &["refs", "branches"])?;
    url.query_pairs_mut().append_pair("sort", "-target.date").append_pair("pagelen", "20");
    if !termo.is_empty() {
        url.query_pairs_mut().append_pair("q", &format!("name ~ \"{}\"", bbq(&termo)));
    }
    match cliente().get(url).basic_auth(&user, Some(&token)).send().await {
        Err(e) => Ok(json!({ "branches": [], "error": erro_rede(&e) })),
        Ok(res) if !res.status().is_success() => {
            Ok(json!({ "branches": [], "error": mensagem_erro(res, "Não foi possível listar as branches").await }))
        }
        Ok(res) => {
            let data: Value = res.json().await.unwrap_or(Value::Null);
            let nomes: Vec<Value> = data
                .get("values")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|b| b.get("name").cloned()).collect())
                .unwrap_or_default();
            Ok(json!({ "branches": nomes, "error": null }))
        }
    }
}

struct Tarefa {
    path: String,
    branch_url: Option<String>,
    base_url: Option<String>,
}

enum Listagem {
    Ok { tarefas: Vec<Tarefa>, branch_hash: String, base_hash: String },
    /// branch não encontrada: (mensagem curta, detalhe para o log)
    Nada { msg: String, detalhe: String },
}

/// Hash da ponta de uma branch (`None` se não existir).
async fn hash_da_branch(c: &Client, ws: &str, repo: &str, user: &str, token: &str, nome: &str) -> Result<Option<String>, String> {
    let mut url = url_repo(ws, repo, &["refs", "branches"])?;
    url.query_pairs_mut().append_pair("q", &format!("name = \"{}\"", bbq(nome)));
    let res = c.get(url).basic_auth(user, Some(token)).send().await.map_err(|e| erro_rede(&e))?;
    if !res.status().is_success() {
        return Err(mensagem_erro(res, &format!("Erro na API ao buscar a branch \"{nome}\"")).await);
    }
    let d: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(d.pointer("/values/0/target/hash").and_then(|v| v.as_str()).map(String::from))
}

/// Arquivos alterados entre a branch da tarefa e a base (diffstat), seguindo TODAS as páginas da API.
async fn listar_alterados(config: &Value) -> Result<Listagem, String> {
    let (ws, repo, user, token) = (campo(config, "workspace"), campo(config, "repo"), campo(config, "user"), campo(config, "appPassword"));
    let (base, branch) = (campo(config, "base"), campo(config, "branch"));
    let c = cliente();

    let Some(base_hash) = hash_da_branch(&c, &ws, &repo, &user, &token, &base).await? else {
        return Ok(Listagem::Nada {
            msg: format!("Branch base '{base}' não encontrada."),
            detalhe: format!("A branch base '{base}' não foi encontrada no repositório."),
        });
    };
    let Some(branch_hash) = hash_da_branch(&c, &ws, &repo, &user, &token, &branch).await? else {
        return Ok(Listagem::Nada {
            msg: format!("Branch da tarefa '{branch}' não encontrada."),
            detalhe: format!("A branch da tarefa '{branch}' não foi encontrada no repositório."),
        });
    };

    let mut tarefas: Vec<Tarefa> = Vec::new();
    let mut vistos: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut url: Option<Url> = Some(url_repo(&ws, &repo, &["diffstat", &format!("{branch_hash}..{base_hash}")])?);
    let mut pagina = 0;
    while let Some(u) = url.take() {
        pagina += 1;
        if pagina > 100 {
            break; // teto de 100 páginas: nunca entra em laço infinito
        }
        let res = c.get(u).basic_auth(&user, Some(&token)).send().await.map_err(|e| erro_rede(&e))?;
        if !res.status().is_success() {
            return Err(mensagem_erro(res, "Falha no DiffStat").await);
        }
        let data: Value = res.json().await.map_err(|e| e.to_string())?;
        for item in data.get("values").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
            if item.get("status").and_then(|s| s.as_str()) == Some("removed") {
                continue;
            }
            let caminho = item
                .pointer("/new/path")
                .or_else(|| item.pointer("/old/path"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if caminho.is_empty() || !vistos.insert(caminho.clone()) {
                continue;
            }
            tarefas.push(Tarefa {
                path: caminho,
                branch_url: item.pointer("/new/links/self/href").and_then(|v| v.as_str()).map(String::from),
                base_url: item.pointer("/old/links/self/href").and_then(|v| v.as_str()).map(String::from),
            });
        }
        url = data.get("next").and_then(|v| v.as_str()).and_then(|s| Url::parse(s).ok());
    }
    Ok(Listagem::Ok { tarefas, branch_hash, base_hash })
}

fn nome_do_arquivo(caminho: &str) -> String {
    caminho.rsplit(['/', '\\']).next().unwrap_or(caminho).to_string()
}

/// "Verificar Arquivos": só lista o que seria baixado.
#[tauri::command]
pub async fn verify_bitbucket(config: Value) -> Result<Value, String> {
    Ok(match listar_alterados(&config).await {
        Ok(Listagem::Ok { tarefas, .. }) => {
            json!({ "success": true, "files": tarefas.iter().map(|t| nome_do_arquivo(&t.path)).collect::<Vec<_>>() })
        }
        Ok(Listagem::Nada { detalhe, .. }) => json!({ "success": false, "msg": detalhe }),
        Err(e) => json!({ "success": false, "msg": e }),
    })
}

/// Nome da base higienizado para virar nome de pasta: barras viram hífen; `<>:"\|?*` viram `_`.
fn base_segura(base: &str) -> String {
    base.replace('/', "-")
        .chars()
        .map(|c| if "<>:\"\\|?*".contains(c) { '_' } else { c })
        .collect()
}

/// Um nome que vira pasta não pode ser vazio nem escapar da pasta de destino (`..`).
fn nome_de_pasta_ok(n: &str) -> bool {
    !n.trim_matches('.').trim().is_empty() && !n.contains("..")
}

fn renomear_para_base(nome: &str, base: &str) -> String {
    match nome.rfind('.') {
        Some(i) if i > 0 => format!("{}({}){}", &nome[..i], base, &nome[i..]),
        _ => format!("{nome}({base})"),
    }
}

async fn esvaziar_pasta(p: &Path) -> std::io::Result<()> {
    match tokio::fs::remove_dir_all(p).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    tokio::fs::create_dir_all(p).await
}

async fn baixar(c: &Client, url: &str, user: &str, token: &str, destino: &Path) -> Result<(), String> {
    let res = c.get(url).basic_auth(user, Some(token)).send().await.map_err(|e| erro_rede(&e))?;
    if !res.status().is_success() {
        return Err(mensagem_erro(res, "").await);
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    tokio::fs::write(destino, &bytes).await.map_err(|e| e.to_string())
}

/// Extração: baixa os arquivos alterados da branch da tarefa (nome original) e da base (nome com sufixo).
#[tauri::command]
pub async fn extract_bitbucket(app: AppHandle, config: Value) -> Result<Value, String> {
    let (user, token, repo) = (campo(&config, "user"), campo(&config, "appPassword"), campo(&config, "repo"));
    let (base, target_dir) = (campo(&config, "base"), campo(&config, "targetDir"));
    let log = |m: &str, cor: &str| send_log(&app, m, cor, "copiar");

    log("Iniciando comunicação com Bitbucket API...", "#89b4fa");

    let falha = |msg: String| -> Result<Value, String> {
        let msg = if msg.is_empty() { "erro desconhecido".to_string() } else { msg };
        log(&format!("Erro Crítico na Extração: {msg}"), VERMELHO);
        Ok(json!({ "success": false, "msg": msg }))
    };

    let (tarefas, branch_hash, base_hash) = match listar_alterados(&config).await {
        Ok(Listagem::Ok { tarefas, branch_hash, base_hash }) => (tarefas, branch_hash, base_hash),
        Ok(Listagem::Nada { msg, detalhe }) => {
            log(&format!("ERRO: {detalhe}"), VERMELHO);
            return Ok(json!({ "success": false, "msg": msg }));
        }
        Err(e) => return falha(e),
    };
    log(&format!("Branches localizadas. Hashes: {}..{}", &branch_hash[..7.min(branch_hash.len())], &base_hash[..7.min(base_hash.len())]), "#a6adc8");

    if tarefas.is_empty() {
        log("Nenhum arquivo modificado encontrado entre as branches.", VERMELHO);
        return Ok(json!({ "success": false, "msg": "Sem alterações" }));
    }
    log(&format!("DiffStat concluído: {} arquivo(s) modificado(s).", tarefas.len()), "#a6adc8");

    // Estrutura achatada: {destino}\{repo}\branch  e  {destino}\{repo}\{base}
    let base_safe = base_segura(&base);
    if !nome_de_pasta_ok(&repo) || !nome_de_pasta_ok(&base_safe) || repo.contains(['/', '\\']) {
        return falha("Nome de repositório ou de branch base inválido para virar pasta.".into());
    }
    let raiz_extracao: PathBuf = Path::new(&target_dir).join(&repo);
    let dir_branch = raiz_extracao.join("branch");
    let dir_base = raiz_extracao.join(&base_safe);
    // Garante as pastas VAZIAS para não misturar arquivos de extrações antigas
    if let Err(e) = esvaziar_pasta(&dir_branch).await {
        return falha(e.to_string());
    }
    if let Err(e) = esvaziar_pasta(&dir_base).await {
        return falha(e.to_string());
    }
    log(&format!("Estrutura limpa/criada em: {}", raiz_extracao.display()), "#a6adc8");

    // Download concorrente em lotes de 5
    let c = cliente();
    let mut ausentes: Vec<String> = Vec::new();
    let total = tarefas.len();
    let mut concluido = 0usize;
    for lote in tarefas.chunks(5) {
        let resultados = futures::future::join_all(lote.iter().map(|t| {
            let (c, user, token) = (c.clone(), user.clone(), token.clone());
            let (dir_branch, dir_base, base_safe) = (dir_branch.clone(), dir_base.clone(), base_safe.clone());
            let nome = nome_do_arquivo(&t.path);
            let (burl, purl, caminho) = (t.branch_url.clone(), t.base_url.clone(), t.path.clone());
            async move {
                let mut avisos: Vec<(String, String)> = Vec::new();
                let mut ausente: Option<String> = None;
                if let Some(u) = burl {
                    if let Err(e) = baixar(&c, &u, &user, &token, &dir_branch.join(&nome)).await {
                        avisos.push((format!("[ERRO] Falha ao baixar {nome} (Tarefa): {e}"), "#f87171".into()));
                    }
                }
                match purl {
                    Some(u) => {
                        let destino = dir_base.join(renomear_para_base(&nome, &base_safe));
                        if let Err(e) = baixar(&c, &u, &user, &token, &destino).await {
                            avisos.push((format!("[ERRO] Falha ao baixar {nome} (Base): {e}"), "#f87171".into()));
                            ausente = Some(caminho);
                        }
                    }
                    None => ausente = Some(caminho),
                }
                (nome, avisos, ausente)
            }
        }))
        .await;
        for (nome, avisos, ausente) in resultados {
            for (m, cor) in avisos {
                log(&m, &cor);
            }
            if let Some(a) = ausente {
                ausentes.push(a);
            }
            concluido += 1;
            log(&format!("Progresso: [{concluido}/{total}] {nome}"), "#a6adc8");
        }
    }

    if !ausentes.is_empty() {
        let _ = tokio::fs::write(dir_base.join("arquivos_ausentes.txt"), ausentes.join("\n")).await;
        log(&format!("Aviso: {} arquivo(s) novo(s) ignorado(s) na pasta {base_safe} (registrados em txt).", ausentes.len()), "#fbbf24");
    }
    log("🎉 Extração Concluída com Sucesso!", "#4ade80");
    Ok(json!({ "success": true, "root": path_str(&raiz_extracao) }))
}
