# Updates the gateway. Run by the "Kestrel Gateway Update" scheduled task (registered for both
# Service and Tray installs by configure.ps1), which the gateway starts when the portal orders an
# update; or by hand. The gateway has already downloaded the bundle and checked it against the
# portal's digest (<data>\update\request.json names it), so this uses it as it is. With no such
# request it looks at the release channel directly, which only works while that is reachable.
# Keeps the previous version and puts it back if the new one does not come up healthy, leaving
# <data>\update\result.json so the gateway can tell the portal what happened.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$settings = @{}
foreach ($line in Get-Content (Join-Path $root 'gateway.env')) {
  if ($line -match '^\s*([A-Z0-9_]+)=(.*)$') { $settings[$Matches[1]] = $Matches[2] }
}
$channel = $settings['KESTREL_CHANNEL']; if (-not $channel) { $channel = 'stable' }
$repo = $settings['KESTREL_REPO']; if (-not $repo) { $repo = 'steviemayo/cobra' }
$port = $settings['KESTREL_PANEL_PORT']; if (-not $port) { $port = '8080' }
$mode = $settings['KESTREL_RUN_MODE']; if (-not $mode) { $mode = 'Service' }
$dataDir = $settings['KESTREL_DATA_DIR']
$base = "https://github.com/$repo/releases/download/gateway-$channel"
$log = Join-Path $dataDir 'logs\update.log'
$updateLock = Join-Path $dataDir 'update.lock'
function Note($m) { Add-Content -Path $log -Value "$(Get-Date -Format s) $m" }

$app = Join-Path $root 'app'
$current = (Get-Content (Join-Path $app 'VERSION') -ErrorAction SilentlyContinue | Select-Object -First 1)

$updateDir = Join-Path $dataDir 'update'
$request = Join-Path $updateDir 'request.json'
$resultFile = Join-Path $updateDir 'result.json'
function Report($ok, $version, $message) {
  New-Item -ItemType Directory -Force -Path $updateDir | Out-Null
  @{ ok = $ok; version = "$version"; error = "$message" } | ConvertTo-Json | Set-Content -Path $resultFile -Encoding ASCII
}
function Forget-Request {
  Remove-Item -Force $request -ErrorAction SilentlyContinue
  if ($staged -and $staged.zip) { Remove-Item -Force $staged.zip -ErrorAction SilentlyContinue }
}

$staged = $null
if (Test-Path $request) {
  try { $staged = Get-Content $request -Raw | ConvertFrom-Json } catch { Remove-Item -Force $request -ErrorAction SilentlyContinue }
}

if ($staged) {
  $latest = "$($staged.version)".Trim()
} else {
  try {
    $latest = ((Invoke-WebRequest -Uri "$base/VERSION" -UseBasicParsing).Content).Trim()
  } catch {
    Note "Could not check for updates: $($_.Exception.Message)"
    exit 0
  }
}
if (-not $latest -or $latest -eq $current) { Forget-Request; exit 0 }

Note "Updating $current -> $latest ($channel, $mode mode)"
Remove-Item -Force $resultFile -ErrorAction SilentlyContinue
$stage = Join-Path $root 'app.new'
$ownsZip = $false
$zip = $null
try {
  if ($staged) {
    $zip = "$($staged.zip)"
    if (-not (Test-Path $zip)) { throw 'The staged bundle is missing' }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
    if ($actual -ne "$($staged.sha256)".ToLower()) { throw 'The staged bundle does not match its digest' }
  } else {
    $zip = Join-Path ([IO.Path]::GetTempPath()) "kestrel-gateway-$([Guid]::NewGuid().ToString('N')).zip"
    $ownsZip = $true
    Invoke-WebRequest -Uri "$base/kestrel-gateway-win-x64.zip" -OutFile $zip -UseBasicParsing
  }
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  if (-not (Test-Path (Join-Path $stage 'runtime\node.exe'))) { throw 'The download is not a gateway bundle' }
} catch {
  Note "Could not prepare $latest, keeping $current : $($_.Exception.Message)"
  if ($staged) { Report $false $latest "Could not prepare the update: $($_.Exception.Message)"; Forget-Request; exit 1 }
  exit 0
} finally {
  if ($ownsZip -and $zip) { Remove-Item -Force $zip -ErrorAction SilentlyContinue }
}

function Stop-Gateway {
  if ($mode -eq 'Tray') {
    # Tells the tray's watchdog to hold off restarting the process while the app folder is swapped.
    New-Item -ItemType File -Force -Path $updateLock | Out-Null
    Get-Process -Name node -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -like (Join-Path $root '*') } | Stop-Process -Force
  } else {
    & (Join-Path $root 'KestrelGatewayService.exe') stop
  }
  Start-Sleep -Seconds 2
}
function Start-Gateway {
  if ($mode -eq 'Tray') {
    Remove-Item -Force $updateLock -ErrorAction SilentlyContinue
    # the tray's own watchdog relaunches node within a few seconds of the lock going away
  } else {
    & (Join-Path $root 'KestrelGatewayService.exe') start
  }
}

Stop-Gateway
$old = Join-Path $root 'app.old'
if (Test-Path $old) { Remove-Item -Recurse -Force $old }
Move-Item -Path $app -Destination $old
Move-Item -Path $stage -Destination $app
if (($mode -eq 'Service') -and (Test-Path (Join-Path $app 'windows\KestrelGatewayService.exe'))) {
  Copy-Item -Force (Join-Path $app 'windows\KestrelGatewayService.exe') (Join-Path $root 'KestrelGatewayService.exe')
}
Start-Gateway

# Healthy means the panel server answers within a minute.
$healthy = $false
for ($i = 0; $i -lt 30 -and -not $healthy; $i++) {
  Start-Sleep -Seconds 2
  try { $healthy = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { }
}
if ($healthy) {
  # Pick up changes to the helper scripts. This script is running, so it is left for the installer.
  foreach ($name in 'configure.ps1', 'tray.ps1', 'uninstall.ps1') {
    $fresh = Join-Path $app "windows\$name"
    if (Test-Path $fresh) { Copy-Item -Force $fresh (Join-Path $root $name) }
  }
  # Installs made before the data folder was locked down get that now. Service installs only: the
  # account a tray install runs as is not known here.
  try {
    $protect = Join-Path $app 'windows\protect-data.ps1'
    if (($mode -eq 'Service') -and (Test-Path $protect)) {
      . $protect
      $runAs = Get-KestrelServiceAccount
      Protect-KestrelFolder -Path $dataDir -Modify @($runAs)
      Protect-KestrelFile -Path (Join-Path $root 'KestrelGatewayService.xml') -Read @($runAs)
      Protect-KestrelFile -Path (Join-Path $root 'gateway.env')
    }
  } catch {
    Note "Could not tighten the permissions on the data folder: $($_.Exception.Message)"
  }
  Note "Updated to $latest"
  Forget-Request
  exit 0
}

Note "$latest did not start; putting $current back"
Report $false $latest "$latest did not start, so $current was put back."
Forget-Request
Stop-Gateway
Remove-Item -Recurse -Force $app
Move-Item -Path $old -Destination $app
Start-Gateway
exit 1
