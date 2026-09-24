<#
.SYNOPSIS
  Removes the Kestrel gateway from this machine. Its data (identity, cached releases) is kept
  unless -RemoveData is given.
#>
[CmdletBinding()]
param(
  [switch] $RemoveData
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

foreach ($name in 'Kestrel Gateway Update', 'Kestrel Gateway') {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}
Get-Process -Name node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like (Join-Path $root '*') } | Stop-Process -Force
Get-NetFirewallRule -DisplayName 'Kestrel Gateway panel' -ErrorAction SilentlyContinue | Remove-NetFirewallRule

if ($RemoveData -and $dataDir -and (Test-Path $dataDir)) { Remove-Item -Recurse -Force $dataDir }

# This script lives in the folder it is removing, so hand the last step to a separate process.
Start-Process -WindowStyle Hidden -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') `
  -ArgumentList "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q `"$root`""
Write-Host 'Kestrel gateway removed.'
if ($dataDir -and -not $RemoveData) { Write-Host "Its data was kept in $dataDir." }
