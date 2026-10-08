# Creates (or refreshes) the "Thrust Zarch" desktop shortcut pointing at launch.vbs with the game-rendered icon.
$here = $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'Thrust Zarch.lnk'))
$lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
$lnk.Arguments = "`"$here\launch.vbs`""
$lnk.WorkingDirectory = Split-Path -Parent $here
$lnk.IconLocation = "$here\thrust-zarch.ico,0"
$lnk.Description = 'Thrust / Zarch - runs the latest build from the repo'
$lnk.Save()
Write-Output "Shortcut: $(Join-Path $desktop 'Thrust Zarch.lnk')"
