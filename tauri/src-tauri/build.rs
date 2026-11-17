// Em release o app exige Administrador (sc stop / taskkill precisam). Em debug NÃO exige, para poder ser
// aberto e testado sem UAC (igual ao `electron .` do desenvolvimento).
fn main() {
    let mut windows = tauri_build::WindowsAttributes::new();
    if std::env::var("PROFILE").map(|p| p == "release").unwrap_or(false) {
        windows = windows.app_manifest(include_str!("manifest.xml"));
    }
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("falha ao executar o tauri-build");
}
