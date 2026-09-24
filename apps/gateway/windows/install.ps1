<#
.SYNOPSIS
  Installs the Kestrel gateway on Windows and keeps it updated from its release channel.

.DESCRIPTION
  Run in an elevated PowerShell:
    .\install.ps1 -CloudUrl https://<your kestrel app> -EnrollToken <token from the portal>

  What it sets up (all removable with uninstall.ps1):
    - the gateway, with its own copy of Node, under C:\Program Files\Kestrel Gateway
    - a scheduled task that starts the gateway at boot and restarts it if it stops
    - a daily scheduled task that updates the gateway from the stable or beta channel
    - a firewall rule so touch panels on the LAN can reach port 8080

  Nothing else on the machine is changed. Data (the gateway's identity, cached room releases and
  buffered telemetry) lives in C:\ProgramData\Kestrel Gateway and survives updates.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $CloudUrl,
  [string] $EnrollToken = '',
  [ValidateSet('stable', 'beta')] [string] $Channel = 'stable',
  [string] $Repo = 'steviemayo/cobra',
  [string] $InstallDir = (Join-Path $env:ProgramFiles 'Kestrel Gateway'),
  [string] $DataDir = (Join-Path $env:ProgramData 'Kestrel Gateway'),
  [int] $PanelPort = 8080,
  [switch] $NoFirewall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated PowerShell (Run as administrator).'
}
if ($CloudUrl -notmatch '^https?://') { throw 'CloudUrl must start with http:// or https://' }

$ServiceTask = 'Kestrel Gateway'
$UpdateTask = 'Kestrel Gateway Update'
$FirewallRule = 'Kestrel Gateway panel'

New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir, (Join-Path $DataDir 'logs') | Out-Null

# The bundle for this channel: everything needed to run, including Node.
$tag = "gateway-$Channel"
$url = "https://github.com/$Repo/releases/download/$tag/kestrel-gateway-win-x64.zip"
$zip = Join-Path ([IO.Path]::GetTempPath()) "kestrel-gateway-$([Guid]::NewGuid().ToString('N')).zip"
Write-Host "Downloading the $Channel gateway..."
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

$stage = Join-Path $InstallDir 'app.new'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
Expand-Archive -Path $zip -DestinationPath $stage -Force
Remove-Item -Force $zip
if (-not (Test-Path (Join-Path $stage 'runtime\node.exe'))) { throw 'The download does not look like a Kestrel gateway bundle.' }

# Stop an existing install before replacing its files.
$existing = Get-ScheduledTask -TaskName $ServiceTask -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $ServiceTask -ErrorAction SilentlyContinue
  Get-Process -Name node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like (Join-Path $InstallDir '*') } | Stop-Process -Force
}
$app = Join-Path $InstallDir 'app'
if (Test-Path $app) { Remove-Item -Recurse -Force $app }
Move-Item -Path $stage -Destination $app

# Settings the runner script reads. The enrolment token is only needed for the first start.
$config = @(
  "KESTREL_CLOUD_URL=$CloudUrl",
  "KESTREL_ENROLL_TOKEN=$EnrollToken",
  "KESTREL_DATA_DIR=$DataDir",
  "KESTREL_PANEL_PORT=$PanelPort",
  "KESTREL_PANEL_DIR=$(Join-Path $app 'panel')",
  "KESTREL_CHANNEL=$Channel",
  "KESTREL_REPO=$Repo"
)
$configPath = Join-Path $InstallDir 'gateway.env'
Set-Content -Path $configPath -Value $config -Encoding ASCII
# Only administrators and the system may read the enrolment token.
icacls $configPath /inheritance:r /grant:r 'SYSTEM:(R)' 'Administrators:(F)' | Out-Null

Copy-Item -Force (Join-Path $app 'windows\run.ps1') (Join-Path $InstallDir 'run.ps1')
Copy-Item -Force (Join-Path $app 'windows\update.ps1') (Join-Path $InstallDir 'update.ps1')
Copy-Item -Force (Join-Path $app 'windows\uninstall.ps1') (Join-Path $InstallDir 'uninstall.ps1')

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$run = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'run.ps1')`""
$runSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $ServiceTask -Force -Principal $system -Settings $runSettings `
  -Action $run -Trigger (New-ScheduledTaskTrigger -AtStartup) `
  -Description 'Runs the Kestrel gateway.' | Out-Null

$upd = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'update.ps1')`""
$updTrigger = New-ScheduledTaskTrigger -Daily -At '03:30' -RandomDelay (New-TimeSpan -Minutes 30)
$updSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName $UpdateTask -Force -Principal $system -Settings $updSettings `
  -Action $upd -Trigger $updTrigger -Description "Updates the Kestrel gateway from the $Channel channel." | Out-Null

if (-not $NoFirewall) {
  Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound -Protocol TCP -LocalPort $PanelPort `
    -Action Allow -Profile Domain, Private | Out-Null
}

Start-ScheduledTask -TaskName $ServiceTask
$version = (Get-Content (Join-Path $app 'VERSION') -ErrorAction SilentlyContinue | Select-Object -First 1)
Write-Host ''
Write-Host "Kestrel gateway $version installed (channel: $Channel)."
Write-Host "It is starting now. Panels open http://<this machine>:$PanelPort/room/<room id>."
Write-Host "Logs: $(Join-Path $DataDir 'logs\gateway.log')"
