# Shows a tray icon and keeps the gateway running for as long as this user is logged in. Started at
# login by the "Kestrel Gateway Tray" entry in HKLM's Run key, written by configure.ps1. Restarts the
# gateway on its own if it crashes; stays stopped only after "Stop gateway" from the tray menu.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $root 'app'

$envVars = @{}
foreach ($line in Get-Content (Join-Path $root 'gateway.env')) {
  if ($line -match '^\s*([A-Z0-9_]+)=(.*)$') { $envVars[$Matches[1]] = $Matches[2] }
}
$dataDir = $envVars['KESTREL_DATA_DIR']
$port = $envVars['KESTREL_PANEL_PORT']
$logDir = Join-Path $dataDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'gateway.log'
# update.ps1 creates this while it swaps the app folder, so the watchdog below does not race it.
$updateLock = Join-Path $dataDir 'update.lock'

$script:proc = $null
$script:stopped = $false

function Write-Log([string] $line) {
  Add-Content -Path $log -Value "$(Get-Date -Format s) $line"
}

function Start-Gateway {
  if ((Test-Path $updateLock) -or $script:stopped) { return }
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) { Move-Item -Force $log "$log.old" }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $app 'runtime\node.exe'
  $psi.Arguments = '--disable-warning=ExperimentalWarning --import tsx src/main.ts'
  $psi.WorkingDirectory = $app
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  foreach ($key in $envVars.Keys) { $psi.EnvironmentVariables[$key] = $envVars[$key] }

  $script:proc = New-Object System.Diagnostics.Process
  $script:proc.StartInfo = $psi
  # The gateway writes its own gateway.log directly now, so these just drain the redirected
  # streams (still required so the OS pipe never fills and blocks the child) without duplicating it.
  $script:proc.add_OutputDataReceived({})
  $script:proc.add_ErrorDataReceived({})
  [void]$script:proc.Start()
  $script:proc.BeginOutputReadLine()
  $script:proc.BeginErrorReadLine()
  Write-Log 'Gateway starting'
}

function Stop-Gateway {
  if ($script:proc -and -not $script:proc.HasExited) {
    try { $script:proc.Kill() } catch {}
  }
  $script:proc = $null
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Visible = $true
$notify.Text = 'Kestrel Gateway'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('Open panel')
$logsItem = $menu.Items.Add('Open logs folder')
$reconfigureItem = $menu.Items.Add('Change cloud URL...')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$toggleItem = $menu.Items.Add('Stop gateway')
$restartItem = $menu.Items.Add('Restart gateway')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exitItem = $menu.Items.Add('Exit')
$notify.ContextMenuStrip = $menu

$openItem.add_Click({ Start-Process "http://127.0.0.1:$port/" }.GetNewClosure())
$logsItem.add_Click({ Start-Process $logDir }.GetNewClosure())
# reconfigure.ps1 self-elevates (UAC) and restarts the gateway itself once applied.
$reconfigureItem.add_Click({ Start-Process powershell.exe -ArgumentList `
  "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $root 'reconfigure.ps1')`" -InstallDir `"$root`""
}.GetNewClosure())
$notify.add_DoubleClick({ Start-Process "http://127.0.0.1:$port/" }.GetNewClosure())

$toggleItem.add_Click({
  if ($script:stopped) {
    $script:stopped = $false
    Start-Gateway
  } else {
    $script:stopped = $true
    Stop-Gateway
    Write-Log 'Gateway stopped from the tray menu'
  }
})
$restartItem.add_Click({
  $script:stopped = $false
  Stop-Gateway
  Start-Sleep -Milliseconds 500
  Start-Gateway
})
$exitItem.add_Click({
  $script:stopped = $true
  Stop-Gateway
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
}.GetNewClosure())
$menu.add_Opening({
  $toggleItem.Text = if ($script:stopped) { 'Start gateway' } else { 'Stop gateway' }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  if ($script:stopped) {
    $notify.Text = 'Kestrel Gateway - stopped'
  } elseif (Test-Path $updateLock) {
    $notify.Text = 'Kestrel Gateway - updating'
  } elseif (-not $script:proc -or $script:proc.HasExited) {
    Write-Log 'Gateway not running, restarting'
    Start-Gateway
    $notify.Text = 'Kestrel Gateway - running'
  } else {
    $notify.Text = 'Kestrel Gateway - running'
  }
}.GetNewClosure())
$timer.Start()

Start-Gateway
[System.Windows.Forms.Application]::Run()
