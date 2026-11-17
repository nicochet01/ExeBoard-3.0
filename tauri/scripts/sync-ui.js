// Monta tauri/ui/ (a interface do app Tauri) a partir dos arquivos da raiz do repositório:
//   index.html, renderer.js, style.css  -> copiados como estão (a interface é UMA só, compartilhada com o Electron)
//   shim/tauri-api.js                   -> ponte window.api -> comandos Rust
// O index.html recebe a tag do shim logo antes do renderer.js. Nada em tauri/ui/ é editado à mão.
const fs = require('fs');
const path = require('path');

const raiz = path.resolve(__dirname, '..', '..');
const tauri = path.resolve(__dirname, '..');
const ui = path.join(tauri, 'ui');

fs.rmSync(ui, { recursive: true, force: true });
fs.mkdirSync(ui, { recursive: true });

const marca = '<script src="renderer.js"></script>';
let html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
if (!html.includes(marca)) throw new Error('index.html: não achei ' + marca);
html = html.replace(marca, '<script src="tauri-api.js"></script>\r\n    ' + marca);
fs.writeFileSync(path.join(ui, 'index.html'), html);

for (const f of ['renderer.js', 'style.css']) fs.copyFileSync(path.join(raiz, f), path.join(ui, f));
fs.copyFileSync(path.join(tauri, 'shim', 'tauri-api.js'), path.join(ui, 'tauri-api.js'));

console.log('ui/ pronta:', fs.readdirSync(ui).join(', '));

// O gancho do instalador (migração a partir do Electron) também é gerado antes de qualquer build
require('./gerar-hook.js');
