# Starts the gateway with the settings in gateway.env. Run by the "Kestrel Gateway" scheduled task.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

foreach ($line in Get-Content (Join-Path $root 'gateway.env')) {
  if ($line -match '^\s*([A-Z0-9_]+)=(.*)$') {
    if ($Matches[2] -ne '') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
  }
}
$dataDir = [Environment]::GetEnvironmentVariable('KESTREL_DATA_DIR', 'Process')
$logs = Join-Path $dataDir 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$log = Join-Path $logs 'gateway.log'
# Keep one previous log so the disk never fills.
if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) { Move-Item -Force $log "$log.old" }

$app = Join-Path $root 'app'
Set-Location $app
& (Join-Path $app 'runtime\node.exe') --disable-warning=ExperimentalWarning --import tsx src/main.ts *>> $log
# Exiting non-zero lets the task's restart policy bring the gateway back.
exit 1
