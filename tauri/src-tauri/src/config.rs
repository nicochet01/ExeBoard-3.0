//! Configuração (`%APPDATA%\ExeBoard\configuracoes.json`) — seção 3 de docs/REGRAS-DE-NEGOCIO.md.
//! Mesmo arquivo e mesmo formato do app Electron.

use crate::dpapi;
use crate::state::AppState;
use crate::util::*;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

const PREFIXO_DPAPI: &str = "dpapi:";

pub fn config_path() -> PathBuf {
    user_data_dir().join("configuracoes.json")
}

fn config_inicial() -> Value {
    json!({ "GERAL": { "HABILITAR_TRAY": "0" } })
}

pub struct ConfigState {
    /// Config em memória (o token fica legível AQUI; em disco vai cifrado)
    pub cache: Mutex<Value>,
    /// Gravações em fila: duas gravações quase simultâneas nunca se cruzam
    write_gate: tokio::sync::Mutex<()>,
    cifrado: Mutex<HashMap<String, String>>,
    aberto: Mutex<HashMap<String, String>>,
}

impl ConfigState {
    pub fn new() -> Self {
        ConfigState {
            cache: Mutex::new(config_inicial()),
            write_gate: tokio::sync::Mutex::new(()),
            cifrado: Mutex::new(HashMap::new()),
            aberto: Mutex::new(HashMap::new()),
        }
    }

    pub fn snapshot(&self) -> Value {
        self.cache.lock().unwrap().clone()
    }

    pub fn tray_habilitado(&self) -> bool {
        self.cache
            .lock()
            .unwrap()
            .get("GERAL")
            .and_then(|g| g.get("HABILITAR_TRAY"))
            .and_then(|v| v.as_str())
            == Some("1")
    }

    /// Cópia da config pronta para o disco: token cifrado em `BITBUCKET.PASSWORD_ENC` ("dpapi:" + base64).
    /// Se não conseguir cifrar, mantém o token legível em vez de perdê-lo — e avisa no log.
    fn token_para_disco(&self, cfg: &Value) -> Value {
        let mut copia = cfg.clone();
        let Some(bb) = copia.get_mut("BITBUCKET").and_then(|v| v.as_object_mut()) else {
            return copia;
        };
        bb.remove("PASSWORD_ENC");
        let senha = bb.get("PASSWORD").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if senha.is_empty() {
            bb.remove("PASSWORD");
            return copia;
        }
        let cached = self.cifrado.lock().unwrap().get(&senha).cloned();
        let cifrado = cached.or_else(|| dpapi::proteger(senha.as_bytes()).map(|b| B64.encode(b)));
        match cifrado {
            Some(c) => {
                self.cifrado.lock().unwrap().insert(senha.clone(), c.clone());
                self.aberto.lock().unwrap().insert(c.clone(), senha);
                bb.remove("PASSWORD");
                bb.insert("PASSWORD_ENC".into(), Value::String(format!("{PREFIXO_DPAPI}{c}")));
            }
            None => log_warn("Não foi possível proteger o token do Bitbucket com o Windows; mantido sem cifra neste salvamento."),
        }
        copia
    }

    /// Decifra em memória (cfg é alterado). Retorna true se o arquivo tinha o token legível (formato antigo)
    /// e precisa ser regravado cifrado.
    fn token_do_disco(&self, cfg: &mut Value) -> bool {
        let Some(bb) = cfg.get_mut("BITBUCKET").and_then(|v| v.as_object_mut()) else {
            return false;
        };
        let enc = bb.get("PASSWORD_ENC").and_then(|v| v.as_str()).map(String::from);
        if let Some(enc) = enc {
            if let Some(c) = enc.strip_prefix(PREFIXO_DPAPI) {
                let cached = self.aberto.lock().unwrap().get(c).cloned();
                let aberto = cached.or_else(|| {
                    B64.decode(c)
                        .ok()
                        .and_then(|b| dpapi::abrir(&b))
                        .and_then(|v| String::from_utf8(v).ok())
                });
                bb.remove("PASSWORD_ENC");
                match aberto {
                    Some(a) => {
                        self.aberto.lock().unwrap().insert(c.to_string(), a.clone());
                        self.cifrado.lock().unwrap().insert(a.clone(), c.to_string());
                        bb.insert("PASSWORD".into(), Value::String(a));
                    }
                    None => {
                        bb.insert("PASSWORD".into(), Value::String(String::new()));
                        log_warn("Token do Bitbucket não pôde ser aberto (salvo por outro usuário do Windows?). Informe-o novamente.");
                    }
                }
                return false;
            }
        }
        bb.get("PASSWORD").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
    }
}

/// Parser mínimo do `Inicializar.ini` legado: `[SECAO]`, `chave=valor`, comentários com `;` ou `#`.
fn parse_ini(texto: &str) -> Value {
    let mut raiz = Map::new();
    let mut secao: Option<String> = None;
    for linha in texto.lines() {
        let l = linha.trim().trim_start_matches('\u{feff}');
        if l.is_empty() || l.starts_with(';') || l.starts_with('#') {
            continue;
        }
        if l.starts_with('[') && l.ends_with(']') {
            let nome = l[1..l.len() - 1].trim().to_string();
            raiz.entry(nome.clone()).or_insert_with(|| Value::Object(Map::new()));
            secao = Some(nome);
            continue;
        }
        if let Some((k, v)) = l.split_once('=') {
            let v = v.trim().trim_matches('"').to_string();
            let k = k.trim().to_string();
            match &secao {
                Some(s) => {
                    if let Some(Value::Object(m)) = raiz.get_mut(s) {
                        m.insert(k, Value::String(v));
                    }
                }
                None => {
                    raiz.insert(k, Value::String(v));
                }
            }
        }
    }
    Value::Object(raiz)
}

/// Grava a config atual em disco (fila: a última gravação sempre leva o estado mais recente).
pub async fn write_config(st: &ConfigState) -> Result<(), String> {
    let _g = st.write_gate.lock().await;
    let snapshot = st.snapshot();
    let disco = st.token_para_disco(&snapshot);
    tokio::fs::create_dir_all(user_data_dir()).await.map_err(|e| e.to_string())?;
    let texto = serde_json::to_string_pretty(&disco).map_err(|e| e.to_string())?;
    tokio::fs::write(config_path(), texto).await.map_err(|e| e.to_string())
}

/// Regras de carga (REGRAS 3.1): 1) JSON existente; 2) migra o INI legado; 3) cria o padrão.
pub async fn load_config(st: &ConfigState) {
    let r: Result<(), String> = async {
        tokio::fs::create_dir_all(user_data_dir()).await.map_err(|e| e.to_string())?;
        let path = config_path();

        if path.exists() {
            let conteudo = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
            let mut v: Value =
                serde_json::from_str(conteudo.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
            let token_legivel = st.token_do_disco(&mut v);
            *st.cache.lock().unwrap() = v;
            if token_legivel {
                // arquivo antigo com o token em texto puro: regrava já cifrado
                match write_config(st).await {
                    Ok(_) => log_info("Token do Bitbucket migrado para armazenamento protegido."),
                    Err(e) => log_warn(&format!("Não foi possível cifrar o token existente: {e}")),
                }
            }
            log_info("Config carregada do configuracoes.json.");
            return Ok(());
        }

        // INI legado (no AppData ou ao lado do executável)
        let ini_appdata = user_data_dir().join("Inicializar.ini");
        let ini_ao_lado = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|p| p.join("Inicializar.ini")));
        let ini = if ini_appdata.exists() {
            Some(ini_appdata.clone())
        } else {
            ini_ao_lado.filter(|p| p.exists())
        };
        if let Some(ini) = ini {
            log_info(&format!("Migrando INI legado para JSON: {}", ini.display()));
            let texto = tokio::fs::read_to_string(&ini).await.map_err(|e| e.to_string())?;
            *st.cache.lock().unwrap() = parse_ini(&texto);
            write_config(st).await?;
            log_info("Migração concluída: configuracoes.json criado com sucesso.");
            if ini_appdata.exists() {
                let _ = tokio::fs::remove_file(&ini_appdata).await;
                log_info("INI legado removido do AppData após migração.");
            }
            return Ok(());
        }

        log_warn("Nenhuma configuração encontrada. Criando configuracoes.json padrão.");
        *st.cache.lock().unwrap() = config_inicial();
        write_config(st).await
    }
    .await;

    if let Err(e) = r {
        log_error(&format!("Erro ao carregar configurações: {e}"));
        // arquivo ilegível: usa o padrão em memória, SEM sobrescrever o arquivo
        *st.cache.lock().unwrap() = config_inicial();
    }
}

// ---------- comandos ----------

/// `read-config`: sempre relê do disco.
#[tauri::command]
pub async fn read_config(state: State<'_, AppState>) -> Result<Value, String> {
    load_config(&state.config).await;
    Ok(json!({ "success": true, "data": state.config.snapshot() }))
}

/// `save-config`: substitui a config inteira.
#[tauri::command]
pub async fn save_config(state: State<'_, AppState>, data: Value) -> Result<Value, String> {
    *state.config.cache.lock().unwrap() = data;
    Ok(match write_config(&state.config).await {
        Ok(_) => json!({ "success": true }),
        Err(e) => json!({ "error": e }),
    })
}

/// `save-config-section`: altera só uma seção e regrava (não sobrescreve o resto).
#[tauri::command]
pub async fn save_config_section(state: State<'_, AppState>, section: String, data: Value) -> Result<Value, String> {
    {
        let mut c = state.config.cache.lock().unwrap();
        if !c.is_object() {
            *c = config_inicial();
        }
        c.as_object_mut().unwrap().insert(section, data);
    }
    Ok(match write_config(&state.config).await {
        Ok(_) => json!({ "success": true }),
        Err(e) => json!({ "error": e }),
    })
}
