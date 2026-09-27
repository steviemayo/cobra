<#
.SYNOPSIS
  Removes the Kestrel gateway from this machine — the Windows service or the tray/login autostart,
  whichever is set up. Its data (identity, cached releases) is kept unless -RemoveData is given.
#>
[CmdletBinding()]
param(
  [switch] $RemoveData,
  # Used when the KestrelGatewaySetup.exe uninstaller runs this: it removes {app} itself right
  # after, so this script does not also race it with the deferred self-delete below.
  [switch] $NoSelfDelete
)
$ErrorActionPreference = 'Stop'

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated PowerShell (Run as administrator).'
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = $null
$envFile = Join-Path $root 'gateway.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) { if ($line -match '^KESTREL_DATA_DIR=(.+)$') { $dataDir = $Matches[1] } }
}

$serviceExe = Join-Path $root 'KestrelGatewayService.exe'
if (Test-Path $serviceExe) {
  & $serviceExe stop 2>$null
  & $serviceExe uninstall 2>$null
}
Remove-ItemProperty -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Kestrel Gateway Tray' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$([regex]::Escape((Join-Path $root 'tray.ps1')))*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process -Name node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like (Join-Path $root '*') } | Stop-Process -Force -ErrorAction SilentlyContinue

foreach ($name in 'Kestrel Gateway Update', 'Kestrel Gateway') {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}
Get-NetFirewallRule -DisplayName 'Kestrel Gateway panel' -ErrorAction SilentlyContinue | Remove-NetFirewallRule

if ($RemoveData -and $dataDir -and (Test-Path $dataDir)) { Remove-Item -Recurse -Force $dataDir }

if (-not $NoSelfDelete) {
  # This script lives in the folder it is removing, so hand the last step to a separate process.
  Start-Process -WindowStyle Hidden -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') `
    -ArgumentList "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q `"$root`""
}
Write-Host 'Kestrel gateway removed.'
if ($dataDir -and -not $RemoveData) { Write-Host "Its data was kept in $dataDir." }
