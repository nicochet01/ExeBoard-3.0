#!/usr/bin/env node
// Script de release do ExeBoard (Tauri). Monta TUDO que uma release precisa e confere antes de publicar.
//
//   node scripts/release.js                    só monta e confere (usa o build já existente). NÃO publica.
//   node scripts/release.js --build            compila (release) + assina + monta + confere. NÃO publica.
//   node scripts/release.js --publish --prerelease                 publica como PRÉ-LANÇAMENTO (para testar)
//   node scripts/release.js --publish --confirmo-atualizar-todos   publica como release normal: todo mundo que já
//                                                                  tem o ExeBoard (Electron ou Tauri) será atualizado
//
// Opções: --repo dono/repo  --notes "texto"  --key caminho\da\chave.key  --out pasta
//
// O que sai em release-out/v<versão>/ (e vai para a release do GitHub):
//   ExeBoard_<v>_x64-setup.exe      instalador NSIS (por máquina)
//   ExeBoard_<v>_x64-setup.exe.sig  assinatura do atualizador do Tauri (minisign)
//   latest.json                     lido pelo atualizador do TAURI (quem já tem o Tauri)
//   latest.yml                      lido pelo atualizador do ELECTRON (a release "ponte": quem ainda tem o Electron
//                                   baixa este mesmo instalador, e ele remove a instalação antiga — windows\hooks.nsh)
//
// Documentação: docs/REGRAS-DE-NEGOCIO.md, seções 14 e 16.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const raiz = path.resolve(__dirname, '..');
const srcTauri = path.join(raiz, 'src-tauri');
const args = process.argv.slice(2);
const tem = (n) => args.includes(n);
const valor = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const REPO = valor('--repo') || 'nicochet01/ExeBoard-3.0';
const ULTIMA_VERSAO_ELECTRON = '3.0.11'; // a release ponte precisa ser MAIOR que esta, senão o Electron ignora
const CHAVE = valor('--key') || path.join(process.env.USERPROFILE || '', '.tauri', 'exeboard.key');

const ok = (m) => console.log('  [ok] ' + m);
const info = (m) => console.log('       ' + m);
const falha = (m) => { console.error('\n  [ERRO] ' + m + '\n'); process.exit(1); };

function semver(v) { return v.split('.').map((x) => parseInt(x, 10)); }
function maior(a, b) { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; }
function sha512b64(arq) { return crypto.createHash('sha512').update(fs.readFileSync(arq)).digest('base64'); }

console.log('\n=== Release do ExeBoard (Tauri) ===');

// ---------- 1) versão: tem que ser a mesma nos três lugares ----------
const conf = JSON.parse(fs.readFileSync(path.join(srcTauri, 'tauri.conf.json'), 'utf8'));
const versao = conf.version;
const cargo = (fs.readFileSync(path.join(srcTauri, 'Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m) || [])[1];
const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8')).version;
if (versao !== cargo || versao !== pkg) falha(`versões diferentes: tauri.conf.json=${versao}, Cargo.toml=${cargo}, package.json=${pkg}. Corrija antes.`);
if (!/^\d+\.\d+\.\d+$/.test(versao)) falha(`versão "${versao}" fora do formato X.Y.Z`);
if (!maior(versao, ULTIMA_VERSAO_ELECTRON)) falha(`a versão ${versao} não é maior que a do último Electron (${ULTIMA_VERSAO_ELECTRON}): o atualizador do Electron não ofereceria esta release.`);
ok(`versão ${versao} (igual nos 3 arquivos e maior que o Electron ${ULTIMA_VERSAO_ELECTRON})`);
const tag = 'v' + versao;

// ---------- 2) build (opcional) ----------
const nomeInstalador = `ExeBoard_${versao}_x64-setup.exe`;
const dirBundle = path.join(srcTauri, 'target', 'release', 'bundle', 'nsis');
if (tem('--build')) {
  if (!fs.existsSync(CHAVE)) falha(`chave de assinatura não encontrada: ${CHAVE}`);
  info('compilando (pode levar vários minutos)...');
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: CHAVE, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '' };
  let r = spawnSync('node', [path.join(__dirname, 'sync-ui.js')], { cwd: raiz, stdio: 'inherit', env });
  if (r.status !== 0) falha('sync-ui falhou');
  r = spawnSync('npx.cmd', ['tauri', 'build'], { cwd: raiz, stdio: 'inherit', env, shell: true });
  if (r.status !== 0) falha('tauri build falhou');
  ok('build concluído');
}

// ---------- 3) artefatos ----------
const instalador = path.join(dirBundle, nomeInstalador);
const arqSig = instalador + '.sig';
if (!fs.existsSync(instalador)) falha(`instalador não encontrado: ${instalador}\nRode com --build.`);
if (!fs.existsSync(arqSig)) falha(`assinatura não encontrada: ${arqSig}\n(O build precisa da chave: TAURI_SIGNING_PRIVATE_KEY.)`);
const tamanho = fs.statSync(instalador).size;
const sha512 = sha512b64(instalador);
const assinatura = fs.readFileSync(arqSig, 'utf8').trim();
ok(`instalador ${nomeInstalador} (${(tamanho / 1048576).toFixed(2)} MiB)`);

// ---------- 4) arquivos da release ----------
const saida = path.resolve(valor('--out') || path.join(raiz, 'release-out'), tag);
fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(saida, { recursive: true });
fs.copyFileSync(instalador, path.join(saida, nomeInstalador));
fs.copyFileSync(arqSig, path.join(saida, nomeInstalador + '.sig'));

const agora = new Date().toISOString();
const notas = valor('--notes') ||
  `ExeBoard ${versao}: nova versão em Tauri (instalador ~${(tamanho / 1048576).toFixed(0)} MB em vez de ~80 MB). ` +
  `Instalar remove a versão anterior automaticamente e mantém suas configurações.`;
const urlInstalador = `https://github.com/${REPO}/releases/download/${tag}/${nomeInstalador}`;

// latest.json — formato do atualizador do Tauri v2 (JSON estático)
const latestJson = {
  version: versao,
  notes: notas,
  pub_date: agora,
  platforms: { 'windows-x86_64': { signature: assinatura, url: urlInstalador } },
};
fs.writeFileSync(path.join(saida, 'latest.json'), JSON.stringify(latestJson, null, 2) + '\n');

// latest.yml — formato do electron-updater (a release "ponte"). Mesmo formato do que a release 3.0.11 publicou.
const latestYml =
  `version: ${versao}\n` +
  `files:\n` +
  `  - url: ${nomeInstalador}\n` +
  `    sha512: ${sha512}\n` +
  `    size: ${tamanho}\n` +
  `path: ${nomeInstalador}\n` +
  `sha512: ${sha512}\n` +
  `releaseDate: '${agora}'\n`;
fs.writeFileSync(path.join(saida, 'latest.yml'), latestYml);
fs.writeFileSync(path.join(saida, 'NOTAS.md'), notas + '\n');
ok(`arquivos gerados em ${saida}`);

// ---------- 5) auto-conferência: relê o que gravou e confere ----------
const lj = JSON.parse(fs.readFileSync(path.join(saida, 'latest.json'), 'utf8'));
if (lj.version !== versao) falha('latest.json: versão divergente');
const plat = lj.platforms['windows-x86_64'];
if (!plat || !plat.signature || !plat.url.endsWith(nomeInstalador)) falha('latest.json: plataforma/assinatura/url inválidas');
if (plat.signature !== assinatura) falha('latest.json: assinatura diferente do .sig');
if (!/^untrusted comment:/m.test(Buffer.from(plat.signature, 'base64').toString('utf8'))) falha('assinatura não parece uma assinatura minisign válida');
ok('latest.json consistente (versão, URL e assinatura minisign)');

const yml = fs.readFileSync(path.join(saida, 'latest.yml'), 'utf8');
const get = (k) => (yml.match(new RegExp('^' + k + ': (.+)$', 'm')) || [])[1];
if (get('version') !== versao) falha('latest.yml: versão divergente');
if (get('path') !== nomeInstalador || get('sha512') !== sha512b64(path.join(saida, nomeInstalador))) falha('latest.yml: path/sha512 não batem com o instalador copiado');
if (!yml.includes(`url: ${nomeInstalador}`) || !yml.includes(`size: ${tamanho}`)) falha('latest.yml: files[] inconsistente');
ok('latest.yml consistente (o hash sha512 confere com o instalador que será publicado)');

const ativos = [nomeInstalador, nomeInstalador + '.sig', 'latest.json', 'latest.yml'];
console.log('\n  Arquivos da release ' + tag + ':');
ativos.forEach((a) => info(a.padEnd(42) + (fs.statSync(path.join(saida, a)).size + ' bytes')));

// ---------- 6) publicar (só com flag explícita) ----------
if (!tem('--publish')) {
  console.log('\n  Nada foi publicado (simulação). Para publicar use --publish (veja o topo deste arquivo).\n');
  process.exit(0);
}
const pre = tem('--prerelease');
if (!pre && !tem('--confirmo-atualizar-todos')) {
  falha('Publicar como release NORMAL atualiza TODOS os ExeBoard instalados (Electron e Tauri).\n' +
        '        Use --prerelease para testar, ou acrescente --confirmo-atualizar-todos se é isso mesmo que você quer.');
}
const gh = process.env.GH || (fs.existsSync('C:\\Program Files\\GitHub CLI\\gh.exe') ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh');
const existe = spawnSync(gh, ['release', 'view', tag, '--repo', REPO], { encoding: 'utf8' });
if (existe.status === 0) falha(`a release ${tag} já existe em ${REPO}. Apague-a ou aumente a versão.`);
const cmd = ['release', 'create', tag, ...ativos.map((a) => path.join(saida, a)), '--repo', REPO,
  '--title', `ExeBoard ${versao}${pre ? ' (pré-lançamento)' : ''}`, '--notes-file', path.join(saida, 'NOTAS.md')];
if (pre) cmd.push('--prerelease'); else cmd.push('--latest');
info(`publicando ${tag} em ${REPO}${pre ? ' como PRÉ-LANÇAMENTO' : ' como release NORMAL'}...`);
const p = spawnSync(gh, cmd, { stdio: 'inherit' });
if (p.status !== 0) falha('gh release create falhou');
ok(`release ${tag} publicada: https://github.com/${REPO}/releases/tag/${tag}`);
