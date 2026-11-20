; OCC - NSIS Installer Hooks
; 安装时注册 Windows 资源管理器右键菜单,卸载时清理

!macro NSIS_HOOK_POSTINSTALL
  ; 右键文件夹 → "Open with OCC"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OCC" "" "Open with OCC"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OCC" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OCC\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'

  ; 右键文件夹空白处 → "Open with OCC"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OCC" "" "Open with OCC"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OCC" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OCC\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OCC"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OCC"
  ; 清理旧版本注册的 OpenCodeUI 键
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenCodeUI"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenCodeUI"
!macroend