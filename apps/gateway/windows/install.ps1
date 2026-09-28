<#
.SYNOPSIS
  Downloads and installs the Kestrel gateway on Windows, and keeps it updated from its release channel.

.DESCRIPTION
  Most people should use the KestrelGatewaySetup.exe installer linked from the Gateways page instead —
  this script is the scriptable path (mass deployment, automation) that does the same thing from an
  elevated PowerShell:
    .\install.ps1 -CloudUrl https://<your kestrel app> -EnrollToken <token from the portal>

  What it sets up (all removable with uninstall.ps1):
    - the gateway, with its own copy of Node, under C:\Program Files\Kestrel Gateway
    - either a Windows service (starts at boot, before anyone logs in) or a system tray app that
      starts at login (-Mode Tray) — either way, it restarts on its own and runs until stopped
    - a scheduled task that updates the gateway, run by the gateway when the portal orders it
    - a firewall rule so touch panels on the LAN can reach the panel port

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
  [switch] $NoFirewall,
  [ValidateSet('Service', 'Tray')] [string] $Mode = 'Service'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated PowerShell (Run as administrator).'
}
if ($CloudUrl -notmatch '^https?://') { throw 'CloudUrl must start with http:// or https://' }

New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir, (Join-Path $DataDir 'logs') | Out-Null

# Stop a previous install before replacing its files: if it's still running, the app folder's files
# (especially runtime\node.exe) are locked.
$envFile = Join-Path $InstallDir 'gateway.env'
if (Test-Path $envFile) {
  $prevMode = 'Service'
  foreach ($line in Get-Content $envFile) { if ($line -match '^KESTREL_RUN_MODE=(.+)$') { $prevMode = $Matches[1] } }
  if ($prevMode -eq 'Tray') {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like "*$([regex]::Escape((Join-Path $InstallDir 'tray.ps1')))*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } else {
    & (Join-Path $InstallDir 'KestrelGatewayService.exe') stop 2>$null
  }
  Get-Process -Name node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like (Join-Path $InstallDir '*') } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

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

$app = Join-Path $InstallDir 'app'
if (Test-Path $app) { Remove-Item -Recurse -Force $app }
Move-Item -Path $stage -Destination $app

& (Join-Path $app 'windows\configure.ps1') `
  -CloudUrl $CloudUrl -EnrollToken $EnrollToken -Channel $Channel -Repo $Repo `
  -InstallDir $InstallDir -DataDir $DataDir -PanelPort $PanelPort -Mode $Mode -NoFirewall:$NoFirewall
