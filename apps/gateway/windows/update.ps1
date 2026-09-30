# Updates the gateway. Run as the system by the "Kestrel Gateway Update" scheduled task (registered
# for both Service and Tray installs by configure.ps1), which the gateway starts when the portal
# orders an update. The gateway has already downloaded the bundle and staged it in <data>\update
# with its signature. Before anything is swapped this checks that signature again, using the
# installed gateway's own node and release key (windows\verify-bundle.ts), so a bundle that Kestrel
# did not sign for this exact file and version, or one that is not newer, is never installed, and
# neither the portal nor anyone who can write to the staging folder can change that. The path of the
# zip is fixed here, not read from request.json.
# Keeps the previous version and puts it back if the new one does not come up healthy, leaving
# <data>\update\result.json so the gateway can tell the portal what happened.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$settings = @{}
foreach ($line in Get-Content (Join-Path $root 'gateway.env')) {
  if ($line -match '^\s*([A-Z0-9_]+)=(.*)$') { $settings[$Matches[1]] = $Matches[2] }
}
$channel = $settings['KESTREL_CHANNEL']; if (-not $channel) { $channel = 'stable' }
$port = $settings['KESTREL_PANEL_PORT']; if (-not $port) { $port = '8080' }
$mode = $settings['KESTREL_RUN_MODE']; if (-not $mode) { $mode = 'Service' }
$dataDir = $settings['KESTREL_DATA_DIR']
$log = Join-Path $dataDir 'logs\update.log'
$updateLock = Join-Path $dataDir 'update.lock'
function Note($m) { Add-Content -Path $log -Value "$(Get-Date -Format s) $m" }

$app = Join-Path $root 'app'
$current = (Get-Content (Join-Path $app 'VERSION') -ErrorAction SilentlyContinue | Select-Object -First 1)

$updateDir = Join-Path $dataDir 'update'
$request = Join-Path $updateDir 'request.json'
$resultFile = Join-Path $updateDir 'result.json'
# Where the gateway stages the bundle and its signature: fixed, whatever request.json says.
$zip = Join-Path $updateDir 'bundle.zip'
$zipSignature = "$zip.sig"
function Report($ok, $version, $message) {
  New-Item -ItemType Directory -Force -Path $updateDir | Out-Null
  @{ ok = $ok; version = "$version"; error = "$message" } | ConvertTo-Json | Set-Content -Path $resultFile -Encoding ASCII
}
function Forget-Request {
  Remove-Item -Force $request, $zip, $zipSignature -ErrorAction SilentlyContinue
}

$staged = $null
if (Test-Path $request) {
  try { $staged = Get-Content $request -Raw | ConvertFrom-Json } catch { Remove-Item -Force $request -ErrorAction SilentlyContinue }
}

# Updates are ordered from the portal and staged by the gateway. There is no other way in: a bundle
# fetched here on its own would have nothing to check it against.
if (-not $staged) {
  Note 'Nothing was staged, so there is nothing to update. Updates are ordered from the portal.'
  exit 0
}
$latest = "$($staged.version)".Trim()
if (-not $latest -or $latest -eq $current) { Forget-Request; exit 0 }

Note "Updating $current -> $latest ($channel, $mode mode)"
Remove-Item -Force $resultFile -ErrorAction SilentlyContinue
$stage = Join-Path $root 'app.new'
try {
  if (-not (Test-Path $zip)) { throw 'The staged bundle is missing' }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
  if ($actual -ne "$($staged.sha256)".ToLower()) { throw 'The staged bundle does not match its digest' }

  # The check that matters, made by code that is already installed (in a folder only administrators
  # can change), against the release key that shipped with it. A staged file and a staged digest
  # prove nothing on their own: anyone who could write one could write the other.
  $verifier = Join-Path $app 'windows\verify-bundle.ts'
  $nodeExe = Join-Path $app 'runtime\node.exe'
  if (Test-Path $verifier) {
    if (-not (Test-Path $zipSignature)) { throw 'The staged bundle has no signature' }
    Push-Location $app
    # Windows PowerShell 5.1 turns a native program's stderr into an error under 'Stop'; only its exit code counts here.
    $before = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $verdict = & $nodeExe --disable-warning=ExperimentalWarning --import tsx $verifier $zip $zipSignature $latest $current 2>&1
      $verified = ($LASTEXITCODE -eq 0)
    } finally {
      $ErrorActionPreference = $before
      Pop-Location
    }
    if (-not $verified) { throw "The staged bundle was refused: $($verdict | Out-String)".Trim() }
    Note "The bundle is signed by Kestrel for $latest"
  } else {
    # This install is older than signed updates, so it has nothing to check with. Only the first
    # signed release is installed this way; from then on every update is checked.
    Note 'This install predates signed updates: installing without a signature check (one time only)'
  }
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  if (-not (Test-Path (Join-Path $stage 'runtime\node.exe'))) { throw 'The download is not a gateway bundle' }
} catch {
  Note "Could not prepare $latest, keeping $current : $($_.Exception.Message)"
  Report $false $latest "Could not prepare the update: $($_.Exception.Message)"
  Forget-Request
  exit 1
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
# An install made before the compiled gateway existed starts the TypeScript source, which takes many
# seconds to start. Point it at the compiled one now that the new bundle has it.
$xmlPath = Join-Path $root 'KestrelGatewayService.xml'
if (($mode -eq 'Service') -and (Test-Path (Join-Path $app 'dist\main.mjs')) -and (Test-Path $xmlPath)) {
  $xml = Get-Content $xmlPath -Raw
  if ($xml -match '--import tsx src/main\.ts') {
    Set-Content -Path $xmlPath -Value ($xml -replace '--import tsx src/main\.ts', 'dist\main.mjs') -Encoding UTF8
    Note 'Switched the service to the compiled gateway'
  }
}
Start-Gateway

# Healthy means the panel server answers within a minute.
$healthy = $false
for ($i = 0; $i -lt 30 -and -not $healthy; $i++) {
  Start-Sleep -Seconds 2
  foreach ($p in ([int]$port)..([int]$port + 9)) {
    try { if ((Invoke-WebRequest -Uri "http://127.0.0.1:$p/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $healthy = $true; break } } catch { }
  }
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
# The version put back may not have the compiled gateway the settings were just pointed at.
if ((Test-Path $xmlPath) -and -not (Test-Path (Join-Path $app 'dist\main.mjs'))) {
  Set-Content -Path $xmlPath -Value ((Get-Content $xmlPath -Raw) -replace 'dist\\main\.mjs', '--import tsx src/main.ts') -Encoding UTF8
}
Start-Gateway
exit 1
