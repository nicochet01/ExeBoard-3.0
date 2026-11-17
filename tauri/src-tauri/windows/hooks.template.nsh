; Ganchos do instalador NSIS do Tauri (docs/REGRAS-DE-NEGOCIO.md, seções 14 e 16).
; ESTE É O MODELO. O arquivo hooks.nsh é GERADO por scripts/gerar-hook.js (roda dentro de scripts/sync-ui.js),
; que embute aqui o conteúdo de remover-electron.ps1. Não edite o hooks.nsh à mão.
;
; PREINSTALL: remove as instalações antigas do app Electron (por máquina e por usuário) antes de copiar os
;   arquivos novos — senão ficariam dois programas, atalhos duplicados e ~300 MB de arquivos velhos. A
;   configuração dos testadores (%APPDATA%\ExeBoard) é preservada.
; POSTINSTALL: quando o instalador foi chamado pelo atualizador do Electron (que passa --updated), abre o app novo
;   no fim, como o Electron fazia depois de uma atualização.

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  FileOpen $R7 "$PLUGINSDIR\remover-electron.ps1" w
;;REMOVER_ELECTRON_PS1;;
  FileClose $R7
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\remover-electron.ps1"'
  Pop $R8
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ClearErrors
  ${GetOptions} $CMDLINE "--updated" $R9
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
  ${EndIf}
  ClearErrors
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
