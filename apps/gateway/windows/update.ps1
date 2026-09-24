# Updates the gateway from its release channel. Run daily by the "Kestrel Gateway Update" task,
# or by hand. Keeps the previous version and puts it back if the new one does not come up healthy.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$settings = @{}
foreach ($line in Get-Content (Join-Path $root 'gateway.env')) {
  if ($line -match '^\s*([A-Z0-9_]+)=(.*)$') { $settings[$Matches[1]] = $Matches[2] }
}
$channel = $settings['KESTREL_CHANNEL']; if (-not $channel) { $channel = 'stable' }
$repo = $settings['KESTREL_REPO']; if (-not $repo) { $repo = 'steviemayo/cobra' }
$port = $settings['KESTREL_PANEL_PORT']; if (-not $port) { $port = '8080' }
$base = "https://github.com/$repo/releases/download/gateway-$channel"
$log = Join-Path $settings['KESTREL_DATA_DIR'] 'logs\update.log'
function Note($m) { Add-Content -Path $log -Value "$(Get-Date -Format s) $m" }

$app = Join-Path $root 'app'
$current = (Get-Content (Join-Path $app 'VERSION') -ErrorAction SilentlyContinue | Select-Object -First 1)
try {
  $latest = ((Invoke-WebRequest -Uri "$base/VERSION" -UseBasicParsing).Content).Trim()
} catch {
  Note "Could not check for updates: $($_.Exception.Message)"
  exit 0
}
if (-not $latest -or $latest -eq $current) { exit 0 }

Note "Updating $current -> $latest ($channel)"
$zip = Join-Path ([IO.Path]::GetTempPath()) "kestrel-gateway-$([Guid]::NewGuid().ToString('N')).zip"
$stage = Join-Path $root 'app.new'
try {
  Invoke-WebRequest -Uri "$base/kestrel-gateway-win-x64.zip" -OutFile $zip -UseBasicParsing
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  if (-not (Test-Path (Join-Path $stage 'runtime\node.exe'))) { throw 'The download is not a gateway bundle' }
} catch {
  Note "Download failed, keeping $current : $($_.Exception.Message)"
  exit 0
} finally {
  Remove-Item -Force $zip -ErrorAction SilentlyContinue
}

function Stop-Gateway {
  Stop-ScheduledTask -TaskName 'Kestrel Gateway' -ErrorAction SilentlyContinue
  Get-Process -Name node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like (Join-Path $root '*') } | Stop-Process -Force
  Start-Sleep -Seconds 2
}

Stop-Gateway
$old = Join-Path $root 'app.old'
if (Test-Path $old) { Remove-Item -Recurse -Force $old }
Move-Item -Path $app -Destination $old
Move-Item -Path $stage -Destination $app
Start-ScheduledTask -TaskName 'Kestrel Gateway'

# Healthy means the panel server answers within a minute.
$healthy = $false
for ($i = 0; $i -lt 30 -and -not $healthy; $i++) {
  Start-Sleep -Seconds 2
  try { $healthy = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { }
}
if ($healthy) {
  # Pick up changes to the runner and uninstaller. This script is running, so it is left for the installer.
  foreach ($name in 'run.ps1', 'uninstall.ps1') {
    $fresh = Join-Path $app "windows\$name"
    if (Test-Path $fresh) { Copy-Item -Force $fresh (Join-Path $root $name) }
  }
  Note "Updated to $latest"
  exit 0
}

Note "$latest did not start; putting $current back"
Stop-Gateway
Remove-Item -Recurse -Force $app
Move-Item -Path $old -Destination $app
Start-ScheduledTask -TaskName 'Kestrel Gateway'
exit 1
