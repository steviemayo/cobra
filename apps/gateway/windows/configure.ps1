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
  [ValidateSet('Service', 'Tray')] [string] $Mode = 'Service'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($CloudUrl -notmatch '^https?://') { throw 'CloudUrl must start with http:// or https://' }

$app = Join-Path $InstallDir 'app'
if (-not (Test-Path (Join-Path $app 'runtime\node.exe'))) { throw "No gateway app found at $app" }

New-Item -ItemType Directory -Force -Path $DataDir, (Join-Path $DataDir 'logs') | Out-Null

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
# Only administrators and the system may read the enrolment token.
icacls $configPath /inheritance:r /grant:r 'SYSTEM:(R)' 'Administrators:(F)' | Out-Null

function XmlEscape([string] $s) {
  $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}

if ($Mode -eq 'Service') {
  if (-not (Test-Path $ServiceExe)) { throw "Missing $ServiceExe (the bundle is missing its service wrapper)" }
  $envXml = ($config | ForEach-Object {
    $parts = $_.Split('=', 2)
    "    <env name=`"$($parts[0])`" value=`"$(XmlEscape $parts[1])`"/>"
  }) -join "`n"
  $template = Get-Content (Join-Path $app 'windows\service.xml.template') -Raw
  $xml = $template.Replace('__ENV__', $envXml).Replace('__LOGPATH__', (XmlEscape (Join-Path $DataDir 'logs')))
  Set-Content -Path $ServiceXml -Value $xml -Encoding UTF8
  & $ServiceExe install
  & $ServiceExe start
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

# Both modes update the same way: a daily SYSTEM task checks the channel and swaps the app folder.
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$upd = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'update.ps1')`""
$updTrigger = New-ScheduledTaskTrigger -Daily -At '03:30' -RandomDelay (New-TimeSpan -Minutes 30)
$updSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'Kestrel Gateway Update' -Force -Principal $system -Settings $updSettings `
  -Action $upd -Trigger $updTrigger -Description "Updates the Kestrel gateway from the $Channel channel." | Out-Null

$version = (Get-Content (Join-Path $app 'VERSION') -ErrorAction SilentlyContinue | Select-Object -First 1)
Write-Host ''
Write-Host "Kestrel gateway $version installed (channel: $Channel, mode: $Mode)."
if ($Mode -eq 'Service') {
  Write-Host 'It runs as a Windows service and starts at boot, before anyone logs in.'
} else {
  Write-Host 'It runs from the system tray and starts when someone logs in.'
}
Write-Host "It restarts on its own if it crashes, and keeps running until stopped from the service/tray."
Write-Host "Panels open http://<this machine>:$PanelPort/room/<room id>."
Write-Host "Logs: $(Join-Path $DataDir 'logs\gateway.log')"
