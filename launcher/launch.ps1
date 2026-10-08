# Thrust / Zarch launcher (the desktop shortcut runs this through launch.vbs, so no console window shows).
# Every launch runs the latest working tree: the old server is replaced, the no-cache server serves game/ straight from
# the repo, and the icon is re-rendered from the game whenever the commit has changed since it was last built.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$port = 8765
$log = Join-Path $PSScriptRoot 'launcher.log'
"$(Get-Date -Format s) launch" | Out-File $log

$node = (Get-Command node).Source
if (-not $node) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show('Node.js is required to run Thrust / Zarch (https://nodejs.org).', 'Thrust / Zarch') | Out-Null
  exit 1
}

# stop whatever is serving on the port (an older build of this server, or the old python one from start.bat)
Get-NetTCPConnection -LocalPort $port -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

Start-Process -FilePath $node -ArgumentList "`"$root\tools\serve.mjs`" --port $port" -WindowStyle Hidden
for ($i = 0; $i -lt 50; $i++) {
  try { Invoke-WebRequest "http://127.0.0.1:$port/version.json" -UseBasicParsing -TimeoutSec 1 | Out-Null; break } catch { Start-Sleep -Milliseconds 100 }
}
$commit = (git -C $root rev-parse --short HEAD) 2>$null
Start-Process "http://127.0.0.1:$port/?v=$commit-$([DateTimeOffset]::Now.ToUnixTimeSeconds())"
"$(Get-Date -Format s) opened build $commit" | Out-File $log -Append

# refresh the icon from the game when the build changed (background; needs tools/node_modules)
$stamp = Join-Path $PSScriptRoot '.icon-commit'
if ($commit -and (Test-Path "$root\tools\node_modules\puppeteer-core") -and ((Get-Content $stamp) -ne $commit)) {
  & $node "$root\tools\make-icon.mjs" *>> $log
  if ($LASTEXITCODE -eq 0) { $commit | Out-File $stamp -NoNewline; ie4uinit.exe -show }
}
