//! Proteção do token do Bitbucket com a DPAPI do Windows (escopo do usuário atual, sem entropia extra).
//! É o MESMO formato que o app Electron gravava via PowerShell (`ProtectedData.Protect(..., 'CurrentUser')`),
//! então o arquivo `configuracoes.json` continua legível depois da migração.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

fn blob_para_vec(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
    unsafe {
        if blob.pbData.is_null() || blob.cbData == 0 {
            return Vec::new();
        }
        let v = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(blob.pbData as *mut _)));
        v
    }
}

pub fn proteger(dados: &[u8]) -> Option<Vec<u8>> {
    unsafe {
        let entrada = CRYPT_INTEGER_BLOB { cbData: dados.len() as u32, pbData: dados.as_ptr() as *mut u8 };
        let mut saida = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(&entrada, PCWSTR::null(), None, None, None, 0, &mut saida).ok()?;
        Some(blob_para_vec(&saida))
    }
}

pub fn abrir(dados: &[u8]) -> Option<Vec<u8>> {
    unsafe {
        let entrada = CRYPT_INTEGER_BLOB { cbData: dados.len() as u32, pbData: dados.as_ptr() as *mut u8 };
        let mut saida = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(&entrada, None, None, None, None, 0, &mut saida).ok()?;
        Some(blob_para_vec(&saida))
    }
}
