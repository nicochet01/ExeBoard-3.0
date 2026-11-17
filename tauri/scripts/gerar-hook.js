// Gera src-tauri/windows/hooks.nsh a partir de hooks.template.nsh, embutindo remover-electron.ps1 como linhas
// FileWrite do NSIS (o instalador recria o .ps1 em tempo de instalação; o NSIS não acha arquivos soltos ao lado
// do .nsh porque o Tauri copia o .nsh para outra pasta ao empacotar).
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '..', 'src-tauri', 'windows');
const modelo = fs.readFileSync(path.join(dir, 'hooks.template.nsh'), 'utf8');
const ps1 = fs.readFileSync(path.join(dir, 'remover-electron.ps1'), 'utf8').replace(/^﻿/, '');

if (/[^\x09\x0A\x0D\x20-\x7E]/.test(ps1)) throw new Error('remover-electron.ps1 deve ter só caracteres ASCII');

// Escapes do NSIS dentro de string entre aspas: $ -> $$   " -> $\"   tab -> $\t
// (numa função de replace o retorno é LITERAL: '$$' aqui significa dois cifrões mesmo)
const esc = (s) => s.replace(/\$/g, () => '$$').replace(/"/g, () => '$\\"').replace(/\t/g, () => '$\\t');
// Inverso do escape (como o NSIS interpreta a string): usado para provar que o .ps1 recriado fica idêntico
const unesc = (s) => s.replace(/\$(\$|\\"|\\t|\\r|\\n)/g, (m, c) => ({ '$': '$', '\\"': '"', '\\t': '\t', '\\r': '\r', '\\n': '\n' }[c]));
const linhas = ps1.split(/\r?\n/);
if (linhas.length && linhas[linhas.length - 1] === '') linhas.pop();
for (const l of linhas) if (l.length > 900) throw new Error('linha longa demais para o NSIS (limite 1024): ' + l.slice(0, 60));

const embutido = linhas.map((l) => `  FileWrite $R7 "${esc(l)}$\\r$\\n"`).join('\r\n');
if (!modelo.includes(';;REMOVER_ELECTRON_PS1;;')) throw new Error('marcador não encontrado no modelo');
const saida = modelo.replace(';;REMOVER_ELECTRON_PS1;;', () => embutido);
fs.writeFileSync(path.join(dir, 'hooks.nsh'), saida.replace(/\r?\n/g, '\r\n'));

// Verificação de ida e volta: lê de volta as linhas FileWrite, desfaz o escape e compara com o .ps1 original.
const lidas = saida.split(/\r?\n/)
  .map((l) => l.match(/^  FileWrite \$R7 "(.*)"$/))
  .filter(Boolean)
  .map((m) => unesc(m[1]))
  .join('');
const esperado = linhas.map((l) => l + '\r\n').join('');
if (lidas !== esperado) throw new Error('verificação de ida e volta FALHOU: o .ps1 recriado pelo instalador seria diferente do original');
console.log(`hooks.nsh gerado (${linhas.length} linhas do PowerShell embutidas; ida e volta idêntica ao original)`);
