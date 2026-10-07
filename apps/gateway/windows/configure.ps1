<#
.SYNOPSIS
  Configures an already-staged Kestrel gateway: writes its settings, sets it up to run as a Windows
  service (starts at boot, before anyone logs in), and adds a tray icon at login for seeing and reaching it.

.DESCRIPTION
  Called by KestrelGatewaySetup.exe right after it lays down the files, and by install.ps1 after it
  downloads and stages them. Not normally run by hand.

  Re-running it (a repair, or an install that used to run from the tray) tears down what is currently
  set up before reconfiguring, so it is safe to call again.

  The gateway always runs as a service now. -Mode Tray is still accepted so older scripts keep working,
  and sets up the service as well; the tray icon is a viewer that never runs the gateway itself.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $CloudUrl,
  [string] $EnrollToken = '',
  [ValidateSet('stable', 'beta')] [string] $Channel = 'stable',
  [string] $Repo = 'steviemayo/cobra',
  [Parameter(Mandatory)] [string] $InstallDir,
  [string] $DataDir = (Join-Path $env:ProgramData 'Kestrel Gateway'),
  [int] $PanelPort = 8080,
  [switch] $NoFirewall,
  # Kept so scripted installs that pass it still work: the gateway always runs as a service.
  [ValidateSet('Service', 'Tray')] [string] $Mode = 'Service',
  # No longer used (the tray no longer runs the gateway); kept for older scripts.
  [string] $TrayUser = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($CloudUrl -notmatch '^https?://') { throw 'CloudUrl must start with http:// or https://' }
if ($Mode -eq 'Tray') {
  Write-Warning 'Tray mode has been retired: the gateway now always runs as a Windows service, with a tray icon to reach it.'
  $Mode = 'Service'
}

$app = Join-Path $InstallDir 'app'
if (-not (Test-Path (Join-Path $app 'runtime\node.exe'))) { throw "No gateway app found at $app" }
. (Join-Path $app 'windows\protect-data.ps1')

New-Item -ItemType Directory -Force -Path $DataDir, (Join-Path $DataDir 'logs') | Out-Null
# Only the system, administrators and the account that runs the gateway may read what is in here
# (its credential, the room's device logins, its admin code, staged updates).
$trayAccounts = @()
Protect-KestrelFolder -Path $DataDir -Modify $trayAccounts

$FirewallRule = 'Kestrel Gateway panel'
$ServiceExe = Join-Path $InstallDir 'KestrelGatewayService.exe'
$ServiceXml = Join-Path $InstallDir 'KestrelGatewayService.xml'
$RunKeyPath = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunValueName = 'Kestrel Gateway Tray'
$TrayScript = Join-Path $InstallDir 'tray.ps1'

# Tear down whichever run mode is currently set up (fresh install, repair, or a Service<->Tray switch)
# before reconfiguring. Also cleans up the old scheduled-task-only installs from before this rework.
function Stop-Everything {
  if (Test-Path $ServiceExe) {
    & $ServiceExe stop 2>$null
    & $ServiceExe uninstall 2>$null
  }
  # A service left behind by an install that is gone, or one the wrapper could not remove, would block
  # the new one from being made. Ask Windows directly, and wait for it to let go.
  if (Get-Service -Name KestrelGateway -ErrorAction SilentlyContinue) {
    Stop-Service -Name KestrelGateway -Force -ErrorAction SilentlyContinue
    & sc.exe delete KestrelGateway 2>$null | Out-Null
    for ($i = 0; $i -lt 30 -and (Get-Service -Name KestrelGateway -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
  }
  Remove-ItemProperty -Path $RunKeyPath -Name $RunValueName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$([regex]::Escape($TrayScript))*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-Process -Name node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like (Join-Path $InstallDir '*') } | Stop-Process -Force -ErrorAction SilentlyContinue
  foreach ($name in 'Kestrel Gateway Update', 'Kestrel Gateway') {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  }
}
Stop-Everything
# The gateway's process can outlive its service for a moment; wait for it, or its files stay locked.
for ($i = 0; $i -lt 20; $i++) {
  $left = @(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like (Join-Path $InstallDir '*') })
  if ($left.Count -eq 0) { break }
  $left | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

# Leftovers of an earlier run that would confuse this one: an update that was half done, an update lock
# that holds the tray's watchdog off for ever, and a staged update nobody finished.
foreach ($stale in (Join-Path $InstallDir 'app.new'), (Join-Path $InstallDir 'app.old')) {
  if (Test-Path $stale) { Remove-Item -Recurse -Force $stale -ErrorAction SilentlyContinue }
}
Remove-Item -Force (Join-Path $DataDir 'update.lock') -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $DataDir 'update') -ErrorAction SilentlyContinue

# Settings the running gateway, and the service/tray that starts it, read. The token is only needed
# for the first start.
$config = @(
  "KESTREL_CLOUD_URL=$CloudUrl",
  "KESTREL_ENROLL_TOKEN=$EnrollToken",
  "KESTREL_DATA_DIR=$DataDir",
  "KESTREL_PANEL_PORT=$PanelPort",
  "KESTREL_PANEL_DIR=$(Join-Path $app 'panel')",
  "KESTREL_CHANNEL=$Channel",
  "KESTREL_REPO=$Repo",
  "KESTREL_RUN_MODE=Service"
)
$configPath = Join-Path $InstallDir 'gateway.env'
Set-Content -Path $configPath -Value $config -Encoding ASCII
# Only administrators and the system (and the gateway's own account, below) may read the enrolment token.
Protect-KestrelFile -Path $configPath -Read $trayAccounts

function XmlEscape([string] $s) {
  $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}

# Updates: a SYSTEM task swaps the app folder. It has no schedule of its own:
# the gateway starts it when the portal orders an update (see docs/decisions.md, Step S). Made
# before the gateway starts, so a service account can be allowed to run it.
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$upd = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'update.ps1')`""
$updSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'Kestrel Gateway Update' -Force -Principal $system -Settings $updSettings `
  -Action $upd -Description "Updates the Kestrel gateway when the portal orders it (the $Channel channel)." | Out-Null

if (-not (Test-Path $ServiceExe)) { throw "Missing $ServiceExe (the bundle is missing its service wrapper)" }
$envXml = ($config | ForEach-Object {
  $parts = $_.Split('=', 2)
  "    <env name=`"$($parts[0])`" value=`"$(XmlEscape $parts[1])`"/>"
}) -join "`n"
$template = Get-Content (Join-Path $app 'windows\service.xml.template') -Raw
# The compiled gateway starts in about a second; the TypeScript source (older bundles) takes far longer.
$entry = if (Test-Path (Join-Path $app 'dist\main.mjs')) { 'dist\main.mjs' } else { '--import tsx src/main.ts' }
$xml = $template.Replace('__ARGS__', "--disable-warning=ExperimentalWarning $entry").Replace('__ENV__', $envXml).Replace('__LOGPATH__', (XmlEscape (Join-Path $DataDir 'logs')))
Set-Content -Path $ServiceXml -Value $xml -Encoding UTF8
# The service's settings hold the enrolment token, so they are as private as gateway.env.
Protect-KestrelFile -Path $ServiceXml
& $ServiceExe install

# Run as a service account of its own, not as the system: the gateway talks to the network and
# to the room's devices, so it should be able to touch only its own folder. If that does not
# work on this machine it goes back to running as the system rather than not running.
$account = 'NT SERVICE\KestrelGateway'
$leastPrivilege = $false
& sc.exe config KestrelGateway obj= $account | Out-Null
if ($LASTEXITCODE -eq 0) {
  try {
    Protect-KestrelFolder -Path $DataDir -Modify @($account)
    Protect-KestrelFile -Path $ServiceXml -Read @($account)
    Grant-KestrelTaskRun -TaskName 'Kestrel Gateway Update' -Account $account
    $leastPrivilege = $true
  } catch {
    Write-Warning "Could not set up the gateway's own account: $($_.Exception.Message)"
  }
} else {
  Write-Warning 'Could not switch the service to its own account.'
}
& $ServiceExe start
if ($leastPrivilege) {
  $up = $false
  # A first start can be slow on a busy machine (and much slower for an older, uncompiled bundle).
  for ($i = 0; $i -lt 60 -and -not $up; $i++) {
    Start-Sleep -Seconds 2
    # The gateway moves to the next port if its usual one is taken, so look at a few.
    foreach ($p in $PanelPort..($PanelPort + 9)) {
      try { if ((Invoke-WebRequest -Uri "http://127.0.0.1:$p/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $up = $true; break } } catch { }
    }
    if ((Get-Service -Name KestrelGateway).Status -eq 'Stopped') { break }  # it has already given up; no point waiting
  }
  if (-not $up) {
    Write-Warning 'The gateway did not start under its own account, so it is being set to run as the system instead.'
    & $ServiceExe stop 2>$null
    & sc.exe config KestrelGateway obj= LocalSystem | Out-Null
    & $ServiceExe start
    $leastPrivilege = $false
  }
}
$runAs = if ($leastPrivilege) { $account } else { 'the system (LocalSystem)' }

# The tray icon: a viewer that starts at login for whoever signs in. It never runs the gateway.
# Its port and data folder go in a file anyone may read (gateway.env holds the enrolment token).
Set-Content -Path (Join-Path $InstallDir 'viewer.json') -Value (@{ port = $PanelPort; dataDir = $DataDir } | ConvertTo-Json) -Encoding ASCII
Copy-Item -Force (Join-Path $app 'windows\tray.ps1') $TrayScript
Copy-Item -Force (Join-Path $app 'windows\open-gateway.ps1') (Join-Path $InstallDir 'open-gateway.ps1')
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$trayArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$TrayScript`""
# HKLM (not HKCU) so it starts for whichever account logs into this machine, admin or not.
Set-ItemProperty -Path $RunKeyPath -Name $RunValueName -Value "`"$ps`" $trayArgs"
Start-Process -FilePath $ps -ArgumentList $trayArgs -WindowStyle Hidden

Copy-Item -Force (Join-Path $app 'windows\update.ps1') (Join-Path $InstallDir 'update.ps1')
Copy-Item -Force (Join-Path $app 'windows\uninstall.ps1') (Join-Path $InstallDir 'uninstall.ps1')
Copy-Item -Force (Join-Path $app 'windows\configure.ps1') (Join-Path $InstallDir 'configure.ps1')
Copy-Item -Force (Join-Path $app 'windows\reconfigure.ps1') (Join-Path $InstallDir 'reconfigure.ps1')

if (-not $NoFirewall) {
  Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound -Protocol TCP -LocalPort $PanelPort `
    -Action Allow -Profile Domain, Private | Out-Null
}

$version = (Get-Content (Join-Path $app 'VERSION') -ErrorAction SilentlyContinue | Select-Object -First 1)
Write-Host ''
Write-Host "Kestrel gateway $version installed (channel: $Channel)."
Write-Host "It runs as a Windows service (as $runAs) and starts at boot, before anyone logs in."
Write-Host 'Its data folder can be read only by administrators, the system and that account.'
Write-Host 'A tray icon at login shows whether it is running and opens its page (also in the Start menu: Kestrel Gateway).'
Write-Host 'It restarts on its own if it crashes, and keeps running until stopped from the service.'
Write-Host "Its page: http://<this machine>:$PanelPort/ (sign in with your Kestrel account)."
Write-Host "Logs: $(Join-Path $DataDir 'logs\gateway.log')"
