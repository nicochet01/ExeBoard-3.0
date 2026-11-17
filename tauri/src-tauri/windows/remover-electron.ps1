# Remove as instalacoes ANTIGAS do ExeBoard feitas pelo app Electron (instalador NSIS do electron-builder).
# Chamado pelo instalador do Tauri (windows\hooks.nsh) antes de instalar a versao nova.
#
# Seguranca:
#  - So considera chaves de desinstalacao cujo DisplayName comeca com "ExeBoard" E cujo desinstalador se chama
#    exatamente "Uninstall ExeBoard.exe" (o do Electron). O desinstalador do Tauri ("uninstall.exe") nunca casa.
#  - So apaga a pasta da instalacao se ela se chamar "ExeBoard" (sem diferenciar maiusculas).
#  - NUNCA toca em %APPDATA%\ExeBoard (configuracoes.json e logs dos testadores ficam preservados).
#  - Qualquer falha e registrada e ignorada: a instalacao nova segue mesmo assim.
# Arquivo so com caracteres ASCII de proposito (o PowerShell 5.1 le arquivo sem BOM como ANSI).
#
# Parametros de TESTE:  -DryRun  (so mostra o que faria)   -SomenteChave <nome da chave>  (ignora as demais)
param(
    [switch]$DryRun,
    [string]$SomenteChave = ''
)
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'exeboard-migracao.log'
function Log($m) {
    $l = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Write-Output $l
    try { Add-Content -Path $log -Value $l } catch { }
}

# Vistas explicitas do registro: funciona igual com PowerShell de 32 ou 64 bits
$bases = @(
    @{ Hive = 'LocalMachine'; View = 'Registry64' },
    @{ Hive = 'LocalMachine'; View = 'Registry32' },
    @{ Hive = 'CurrentUser';  View = 'Registry64' }
)
$sub = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
$candidatos = @()
foreach ($b in $bases) {
    try {
        $raiz = [Microsoft.Win32.RegistryKey]::OpenBaseKey($b.Hive, $b.View)
        $un = $raiz.OpenSubKey($sub)
        if (-not $un) { continue }
        foreach ($nome in $un.GetSubKeyNames()) {
            if ($SomenteChave -and $nome -ne $SomenteChave) { continue }
            $k = $un.OpenSubKey($nome)
            if (-not $k) { continue }
            $dn = [string]$k.GetValue('DisplayName')
            if (-not $dn -or -not $dn.StartsWith('ExeBoard')) { continue }
            $qs = [string]$k.GetValue('QuietUninstallString')
            $us = [string]$k.GetValue('UninstallString')
            $cmd = if ($qs) { $qs } else { $us }
            if ($cmd -notmatch '^"([^"]*\\Uninstall ExeBoard\.exe)"\s*(.*)$') { continue }
            # guarda os grupos ANTES de qualquer outro -match (cada -match sobrescreve $Matches)
            $exeDesinstalador = $Matches[1]
            $args1 = $Matches[2]
            if ($args1 -notmatch '(^|\s)/S(\s|$)') { $args1 = ($args1 + ' /S').Trim() } # sempre silencioso
            $candidatos += [pscustomobject]@{
                Hive = $b.Hive; View = $b.View; Chave = $nome; Nome = $dn; Exe = $exeDesinstalador; Args = $args1
            }
        }
    } catch {
        Log ('erro lendo o registro ({0}/{1}): {2}' -f $b.Hive, $b.View, $_.Exception.Message)
    }
}

if ($candidatos.Count -eq 0) { Log 'Nenhuma instalacao antiga do Electron encontrada.'; exit 0 }

foreach ($c in $candidatos) {
    $dir = Split-Path -Parent $c.Exe
    Log ('Instalacao antiga do Electron: "{0}" [{1}/{2}\{3}] em {4}' -f $c.Nome, $c.Hive, $c.View, $c.Chave, $dir)

    if ($DryRun) {
        Log ('  [simulacao] encerraria processos em {0}; executaria: "{1}" {2} _?={3}; e apagaria a pasta e a chave' -f $dir, $c.Exe, $c.Args, $dir)
        continue
    }

    try {
        # 1) fecha o app antigo, se estiver aberto (senao os arquivos ficam presos)
        Get-Process -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and $_.Path.StartsWith($dir + '\', [System.StringComparison]::OrdinalIgnoreCase) } |
            ForEach-Object { try { $_.Kill(); Log ('  encerrado: ' + $_.Path) } catch { } }

        # 2) desinstalador silencioso e SINCRONO. "_?=<pasta>" faz o NSIS rodar no lugar (sem se copiar para o TEMP e
        #    retornar antes de terminar); por isso ele nao se apaga sozinho, o que fazemos no passo 3.
        if (Test-Path -LiteralPath $c.Exe) {
            $p = Start-Process -FilePath $c.Exe -ArgumentList ($c.Args + ' _?=' + $dir) -PassThru -WindowStyle Hidden
            if ($p.WaitForExit(180000)) { Log ('  desinstalador terminou (codigo {0})' -f $p.ExitCode) }
            else { try { $p.Kill() } catch { }; Log '  desinstalador demorou demais; encerrado' }
        } else {
            Log '  desinstalador nao existe mais; so a limpeza sera feita'
        }

        # 3) sobras: o proprio desinstalador e a pasta (somente se ela se chamar ExeBoard)
        if ((Split-Path -Leaf $dir) -ieq 'ExeBoard' -and (Test-Path -LiteralPath $dir)) {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
            Log ('  pasta removida: ' + $dir)
        }

        # 4) a chave do registro, se o desinstalador deixou
        $raiz = [Microsoft.Win32.RegistryKey]::OpenBaseKey($c.Hive, $c.View)
        $un = $raiz.OpenSubKey($sub, $true)
        if ($un -and ($un.GetSubKeyNames() -contains $c.Chave)) {
            $un.DeleteSubKeyTree($c.Chave, $false)
            Log ('  chave do registro removida: ' + $c.Chave)
        }
    } catch {
        Log ('  falha (ignorada): ' + $_.Exception.Message)
    }
}
exit 0
