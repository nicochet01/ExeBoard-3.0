//! Validações da pasta da branch e sugestões de caminho — seções 5.2 e 9 de docs/REGRAS-DE-NEGOCIO.md.

use crate::index::{cached_index, eh_raiz_de_branches};
use crate::state::AppState;
use crate::util::*;
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, State};
use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO};

/// Executáveis da branch mais velhos que isso geram aviso na tela.
const EXE_AGE_WARN_DAYS: i64 = 10;

fn nomes(file_names: &Option<Vec<String>>) -> Vec<String> {
    file_names.clone().unwrap_or_default()
}

/// A pasta existe, não é a raiz com todas as branches e tem os exes pedidos? (`validate-branch`)
#[tauri::command]
pub async fn validate_branch(app: AppHandle, branch_path: String, file_names: Option<Vec<String>>) -> Result<Value, String> {
    if !Path::new(&branch_path).exists() {
        return Ok(json!({ "valid": false, "scenario": "not_found" }));
    }
    if eh_raiz_de_branches(&branch_path).await {
        return Ok(json!({ "valid": false, "scenario": "root_branches" }));
    }
    let lista = nomes(&file_names);
    if lista.is_empty() {
        return Ok(json!({ "valid": true }));
    }
    let idx = cached_index(&app, &branch_path).await;
    let ausentes: Vec<String> = lista
        .iter()
        .filter(|n| !idx.file_map.contains_key(&ensure_exe_suffix(&n.to_lowercase())))
        .cloned()
        .collect();
    if !ausentes.is_empty() {
        return Ok(json!({ "valid": false, "scenario": "missing_files", "missing": ausentes }));
    }
    Ok(json!({ "valid": true }))
}

/// Aviso de executáveis antigos: usa a data de MODIFICAÇÃO (a de criação no Drive é a do sincronismo, não a do build).
#[tauri::command]
pub async fn check_exe_age(app: AppHandle, branch_path: Option<String>, file_names: Option<Vec<String>>) -> Result<Value, String> {
    let vazio = json!({ "checked": 0, "old": [], "warnDays": EXE_AGE_WARN_DAYS });
    let branch = branch_path.unwrap_or_default();
    let lista = nomes(&file_names);
    if branch.is_empty() || lista.is_empty() || !Path::new(&branch).exists() || eh_raiz_de_branches(&branch).await {
        return Ok(vazio);
    }
    let idx = cached_index(&app, &branch).await;
    let agora_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    let mut achados: Vec<(String, i64)> = Vec::new();
    for nome in &lista {
        let exe = ensure_exe_suffix(nome);
        if let Some(e) = idx.file_map.get(&exe.to_lowercase()) {
            achados.push((exe, ((agora_ms - e.mtime_ms) / 86_400_000.0).floor() as i64));
        }
    }
    let total = achados.len();
    let mut velhos: Vec<(String, i64)> = achados.into_iter().filter(|(_, d)| *d > EXE_AGE_WARN_DAYS).collect();
    velhos.sort_by(|a, b| b.1.cmp(&a.1));
    let old: Vec<Value> = velhos.iter().map(|(n, d)| json!({ "name": n, "ageDays": d })).collect();
    Ok(json!({ "checked": total, "old": old, "warnDays": EXE_AGE_WARN_DAYS }))
}

/// Lê a versão do arquivo (FileVersion) pela API do Windows: "major.minor.build.revisão".
fn ler_versao_exe(caminho: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    let largo: Vec<u16> = caminho.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let tamanho = GetFileVersionInfoSizeW(PCWSTR(largo.as_ptr()), None);
        if tamanho == 0 {
            return None;
        }
        let mut buf = vec![0u8; tamanho as usize];
        GetFileVersionInfoW(PCWSTR(largo.as_ptr()), None, tamanho, buf.as_mut_ptr() as *mut _).ok()?;
        let raiz: Vec<u16> = "\\".encode_utf16().chain(std::iter::once(0)).collect();
        let mut ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut len: u32 = 0;
        if !VerQueryValueW(buf.as_ptr() as *const _, PCWSTR(raiz.as_ptr()), &mut ptr, &mut len).as_bool() || ptr.is_null() {
            return None;
        }
        let info = &*(ptr as *const VS_FIXEDFILEINFO);
        Some(format!(
            "{}.{}.{}.{}",
            info.dwFileVersionMS >> 16,
            info.dwFileVersionMS & 0xFFFF,
            info.dwFileVersionLS >> 16,
            info.dwFileVersionLS & 0xFFFF
        ))
    }
}

/// versão 4.x -> lote 733; 5.x -> lote 734; outra -> sem perfil.
fn perfil_da_versao(versao: &str) -> Option<&'static str> {
    match versao.split('.').next()? {
        "4" => Some("733"),
        "5" => Some("734"),
        _ => None,
    }
}

/// Versão dos executáveis da pasta -> perfil sugerido. Examina no máximo 4 exes e ignora versões que não indicam
/// um lote (ex.: stub 1.0.0.0). Cache por arquivo+data+tamanho.
#[tauri::command]
pub async fn get_branch_version(
    app: AppHandle,
    state: State<'_, AppState>,
    branch_path: Option<String>,
    file_names: Option<Vec<String>>,
) -> Result<Value, String> {
    let vazio = json!({ "version": null, "file": null, "perfil": null });
    let branch = branch_path.unwrap_or_default();
    let lista = nomes(&file_names);
    if branch.is_empty() || lista.is_empty() || !Path::new(&branch).exists() || eh_raiz_de_branches(&branch).await {
        return Ok(vazio);
    }
    let idx = cached_index(&app, &branch).await;
    let mut primeiro: Option<Value> = None;
    let mut examinados = 0;
    for nome in &lista {
        if examinados >= 4 {
            break;
        }
        let exe = ensure_exe_suffix(nome);
        let Some(entry) = idx.file_map.get(&exe.to_lowercase()) else { continue };
        examinados += 1;
        let chave = format!("{}|{}|{}", entry.full_path.display(), entry.mtime_ms, entry.size);
        let cached = state.version_cache.lock().unwrap().get(&chave).cloned();
        let versao = match cached {
            Some(v) => v,
            None => {
                let caminho = entry.full_path.clone();
                let v = tauri::async_runtime::spawn_blocking(move || ler_versao_exe(&caminho))
                    .await
                    .map_err(|e| e.to_string())?;
                state.version_cache.lock().unwrap().insert(chave, v.clone());
                v
            }
        };
        let Some(versao) = versao else { continue };
        match perfil_da_versao(&versao) {
            Some(p) => return Ok(json!({ "version": versao, "file": exe, "perfil": p })),
            None => {
                if primeiro.is_none() {
                    primeiro = Some(json!({ "version": versao, "file": exe, "perfil": null }));
                }
            }
        }
    }
    Ok(primeiro.unwrap_or(vazio))
}

/// Sugestões de pasta para o campo da Branch: subpastas do que foi digitado (se já é uma pasta) ou pastas irmãs que
/// começam com o texto final. Só diretórios, até ~16 itens.
#[tauri::command]
pub async fn get_path_suggestions(partial: Option<String>) -> Result<Vec<String>, String> {
    let parcial = partial.unwrap_or_default();
    if parcial.chars().count() < 2 {
        return Ok(vec![]);
    }
    let p = Path::new(&parcial);
    let (pasta, filtro) = if p.is_dir() {
        (p.to_path_buf(), String::new())
    } else {
        let pai = p.parent().map(|x| x.to_path_buf()).unwrap_or_default();
        let base = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        (pai, base)
    };
    if !pasta.is_dir() {
        return Ok(vec![]);
    }
    let mut achadas: Vec<String> = Vec::new();
    let Ok(mut rd) = tokio::fs::read_dir(&pasta).await else { return Ok(vec![]) };
    while let Ok(Some(e)) = rd.next_entry().await {
        let nome = e.file_name().to_string_lossy().into_owned();
        if nome.to_lowercase().starts_with(&filtro) {
            if let Ok(t) = e.file_type().await {
                if t.is_dir() {
                    achadas.push(path_str(&pasta.join(&nome)));
                }
            }
        }
        if achadas.len() > 15 {
            break;
        }
    }
    Ok(achadas)
}
