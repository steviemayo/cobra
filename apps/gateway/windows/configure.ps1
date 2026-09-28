<#
.SYNOPSIS
  Configures an already-staged Kestrel gateway: writes its settings and sets it up to run either as
  a Windows service (starts at boot, before anyone logs in) or from the system tray (starts at login).

.DESCRIPTION
  Called by KestrelGatewaySetup.exe right after it lays down the files, and by install.ps1 after it
  downloads and stages them. Not normally run by hand.

  Re-running it (a repair, or switching Mode) tears down whichever of the two run modes is currently
  set up before reconfiguring, so it is safe to call again.
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
  [ValidateSet('Service', 'Tray')] [string] $Mode = 'Service',
  # Tray mode only: the account that will run the tray (and so the gateway). Default: whoever runs this.
  [string] $TrayUser = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($CloudUrl -notmatch '^https?://') { throw 'CloudUrl must start with http:// or https://' }

$app = Join-Path $InstallDir 'app'
if (-not (Test-Path (Join-Path $app 'runtime\node.exe'))) { throw "No gateway app found at $app" }
. (Join-Path $app 'windows\protect-data.ps1')

New-Item -ItemType Directory -Force -Path $DataDir, (Join-Path $DataDir 'logs') | Out-Null
# Only the system, administrators and the account that runs the gateway may read what is in here
# (its credential, the room's device logins, its admin code, staged updates).
if (-not $TrayUser) { $TrayUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name }
$trayAccounts = if ($Mode -eq 'Tray') { @($TrayUser) } else { @() }
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
  "KESTREL_RUN_MODE=$Mode"
)
$configPath = Join-Path $InstallDir 'gateway.env'
Set-Content -Path $configPath -Value $config -Encoding ASCII
# Only administrators and the system (and, in tray mode, the tray's account) may read the enrolment token.
Protect-KestrelFile -Path $configPath -Read $trayAccounts

function XmlEscape([string] $s) {
  $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}

# Both modes update the same way: a SYSTEM task swaps the app folder. It has no schedule of its own:
# the gateway starts it when the portal orders an update (see docs/decisions.md, Step S). Made
# before the gateway starts, so a service account can be allowed to run it.
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$upd = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'update.ps1')`""
$updSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'Kestrel Gateway Update' -Force -Principal $system -Settings $updSettings `
  -Action $upd -Description "Updates the Kestrel gateway when the portal orders it (the $Channel channel)." | Out-Null

if ($Mode -eq 'Service') {
  if (-not (Test-Path $ServiceExe)) { throw "Missing $ServiceExe (the bundle is missing its service wrapper)" }
  $envXml = ($config | ForEach-Object {
    $parts = $_.Split('=', 2)
    "    <env name=`"$($parts[0])`" value=`"$(XmlEscape $parts[1])`"/>"
  }) -join "`n"
  $template = Get-Content (Join-Path $app 'windows\service.xml.template') -Raw
  $xml = $template.Replace('__ENV__', $envXml).Replace('__LOGPATH__', (XmlEscape (Join-Path $DataDir 'logs')))
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
    for ($i = 0; $i -lt 22 -and -not $up; $i++) {
      Start-Sleep -Seconds 2
      try { $up = (Invoke-WebRequest -Uri "http://127.0.0.1:$PanelPort/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { }
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
} else {
  Copy-Item -Force (Join-Path $app 'windows\tray.ps1') $TrayScript
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $trayArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$TrayScript`""
  # HKLM (not HKCU) so it starts for whichever account logs into this machine, admin or not.
  Set-ItemProperty -Path $RunKeyPath -Name $RunValueName -Value "`"$ps`" $trayArgs"
  Start-Process -FilePath $ps -ArgumentList $trayArgs -WindowStyle Hidden
}

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
Write-Host "Kestrel gateway $version installed (channel: $Channel, mode: $Mode)."
if ($Mode -eq 'Service') {
  Write-Host "It runs as a Windows service (as $runAs) and starts at boot, before anyone logs in."
  Write-Host 'Its data folder can be read only by administrators, the system and that account.'
} else {
  Write-Host "It runs from the system tray and starts when someone logs in. Its data folder can be read only by administrators, the system and $TrayUser."
}
Write-Host "It restarts on its own if it crashes, and keeps running until stopped from the service/tray."
Write-Host "Panels open http://<this machine>:$PanelPort/room/<room id>."
Write-Host "Logs: $(Join-Path $DataDir 'logs\gateway.log')"
