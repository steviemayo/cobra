# The Kestrel gateway's tray icon. The gateway itself runs as a Windows service (started at boot by
# configure.ps1); this icon is only a way to see and reach it: its colour shows whether the gateway is
# running, double-click or "Open gateway page" opens its page, and the menu starts, stops or restarts
# the service (Windows asks for permission, as for any service). Closing the icon never stops the gateway.
# Started at login by the "Kestrel Gateway Tray" entry in HKLM's Run key.
#
# Older installs that were set up in "Tray" mode (KESTREL_RUN_MODE=Tray) have no service: this script
# still starts and watches the gateway for them, exactly as it used to, until they are converted
# ("Change cloud URL..." re-applies the settings as a service, or reinstall).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:app = Join-Path $script:root 'app'

# The port is not a secret, so it is kept where any signed-in person can read it (gateway.env holds
# the enrolment token and is for administrators only). Legacy tray installs read gateway.env as before.
$viewer = $null
$viewerFile = Join-Path $script:root 'viewer.json'
if (Test-Path $viewerFile) { try { $viewer = Get-Content $viewerFile -Raw | ConvertFrom-Json } catch { } }
$envVars = @{}
$envFile = Join-Path $script:root 'gateway.env'
try {
  foreach ($line in Get-Content $envFile -ErrorAction Stop) {
    if ($line -match '^\s*([A-Z0-9_]+)=(.*)$') { $envVars[$Matches[1]] = $Matches[2] }
  }
} catch { }
$script:legacy = ($envVars['KESTREL_RUN_MODE'] -eq 'Tray')
$script:port = if ($viewer -and $viewer.port) { [int]$viewer.port } elseif ($envVars['KESTREL_PANEL_PORT']) { [int]$envVars['KESTREL_PANEL_PORT'] } else { 8080 }
$script:dataDir = if ($viewer -and $viewer.dataDir) { $viewer.dataDir } elseif ($envVars['KESTREL_DATA_DIR']) { $envVars['KESTREL_DATA_DIR'] } else { Join-Path $env:ProgramData 'Kestrel Gateway' }
$script:logFile = Join-Path (Join-Path $script:dataDir 'logs') 'gateway.log'
$script:codeFile = Join-Path $script:dataDir 'admin-code.txt'
$script:ServiceName = 'KestrelGateway'
$script:base = "http://127.0.0.1:$port"

# ---- legacy tray mode: this script runs the gateway ------------------------------------------------
$script:proc = $null
$script:stopped = $false
$script:updateLock = Join-Path $script:dataDir 'update.lock'

function Write-Log([string] $line) {
  try { Add-Content -Path $script:logFile -Value "$(Get-Date -Format s) $line" } catch { }
}

function Start-LegacyGateway {
  # An update that died would leave its lock behind and keep the gateway off for ever; ignore one that is old.
  if ((Test-Path $script:updateLock) -and ((Get-Date) - (Get-Item $script:updateLock).LastWriteTime).TotalMinutes -gt 20) {
    Remove-Item -Force $script:updateLock -ErrorAction SilentlyContinue
  }
  if ((Test-Path $script:updateLock) -or $script:stopped) { return }
  if ((Test-Path $script:logFile) -and (Get-Item $script:logFile).Length -gt 10MB) { Move-Item -Force $script:logFile "$script:logFile.old" }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $script:app 'runtime\node.exe'
  $entry = if (Test-Path (Join-Path $script:app 'dist\main.mjs')) { 'dist\main.mjs' } else { '--import tsx src/main.ts' }
  $psi.Arguments = "--disable-warning=ExperimentalWarning $entry"
  $psi.WorkingDirectory = $script:app
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  foreach ($key in $envVars.Keys) { $psi.EnvironmentVariables[$key] = $envVars[$key] }

  $script:proc = New-Object System.Diagnostics.Process
  $script:proc.StartInfo = $psi
  # The gateway writes its own gateway.log directly, so these just drain the redirected streams (the
  # OS pipe must never fill and block the child) without duplicating it.
  $script:proc.add_OutputDataReceived({})
  $script:proc.add_ErrorDataReceived({})
  [void]$script:proc.Start()
  $script:proc.BeginOutputReadLine()
  $script:proc.BeginErrorReadLine()
  Write-Log 'Gateway starting'
}

function Stop-LegacyGateway {
  if ($script:proc -and -not $script:proc.HasExited) { try { $script:proc.Kill() } catch { } }
  $script:proc = $null
}

# ---- what the icon shows ---------------------------------------------------------------------------

function New-StatusIcon([System.Drawing.Color] $colour) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $colour), 1, 1, 13, 13)
  $g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90, 0, 0, 0))), 1, 1, 13, 13)
  $g.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  return $icon
}
$script:iconOk = New-StatusIcon ([System.Drawing.Color]::FromArgb(22, 163, 74))
$script:iconWarn = New-StatusIcon ([System.Drawing.Color]::FromArgb(217, 119, 6))
$script:iconBad = New-StatusIcon ([System.Drawing.Color]::FromArgb(220, 38, 38))

function Get-GatewayState {
  # running: the service is up and its page answers. starting: up but not answering yet.
  # stopped: the service is stopped (or, legacy, deliberately stopped from this menu).
  if ($script:legacy) {
    if ($script:stopped) { return 'stopped' }
    if (Test-Path $script:updateLock) { return 'updating' }
    if (-not $script:proc -or $script:proc.HasExited) { return 'starting' }
  } else {
    $svc = Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) { return 'missing' }
    if ($svc.Status -ne 'Running') { return 'stopped' }
  }
  try {
    $r = Invoke-WebRequest -Uri "$script:base/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { return 'running' }
  } catch { }
  return 'starting'
}

$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Icon = $script:iconWarn
$script:notify.Visible = $true
$script:notify.Text = 'Kestrel Gateway'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:statusItem = $menu.Items.Add('Kestrel Gateway')
$script:statusItem.Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$openItem = $menu.Items.Add('Open gateway page')
$adminItem = $menu.Items.Add('Open admin page')
$codeItem = $menu.Items.Add('Show admin code...')
$logsItem = $menu.Items.Add('Open log')
$reconfigureItem = $menu.Items.Add('Change cloud URL...')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$script:toggleItem = $menu.Items.Add('Stop gateway')
$restartItem = $menu.Items.Add('Restart gateway')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exitItem = $menu.Items.Add('Close this icon')
$script:notify.ContextMenuStrip = $menu

$openItem.add_Click({ Start-Process "$script:base/" })
$adminItem.add_Click({ Start-Process "$script:base/admin" })
$script:notify.add_DoubleClick({ Start-Process "$script:base/" })

# The data folder is private to administrators, so a person who is not one asks Windows for permission.
$codeItem.add_Click({
  $text = $null
  try { $text = (Get-Content $script:codeFile -Raw -ErrorAction Stop).Trim() } catch { }
  if ($text) {
    [void][System.Windows.Forms.MessageBox]::Show("Admin code: $text`n`nEnter it on the gateway's admin page. Signing in with your Kestrel account is the usual way in.", 'Kestrel Gateway')
  } else {
    $cmd = "`$t = (Get-Content -LiteralPath '$script:codeFile' -Raw -ErrorAction SilentlyContinue); Add-Type -AssemblyName System.Windows.Forms; if (`$t) { [void][System.Windows.Forms.MessageBox]::Show('Admin code: ' + `$t.Trim(), 'Kestrel Gateway') } else { [void][System.Windows.Forms.MessageBox]::Show('The gateway has not made its admin code yet. Wait a few seconds after it starts and try again.', 'Kestrel Gateway') }"
    try { Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', $cmd } catch { }
  }
})

$logsItem.add_Click({
  try { Get-Content $script:logFile -TotalCount 1 -ErrorAction Stop | Out-Null; Start-Process notepad.exe $script:logFile }
  catch { try { Start-Process notepad.exe -Verb RunAs -ArgumentList "`"$script:logFile`"" } catch { } }
})

# reconfigure.ps1 asks Windows for permission itself and restarts the gateway once applied.
$reconfigureItem.add_Click({ Start-Process powershell.exe -ArgumentList `
  "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $script:root 'reconfigure.ps1')`" -InstallDir `"$script:root`""
})

function Invoke-ServiceAction([string] $verb) {
  # Starting and stopping a service needs permission; Windows asks for it.
  try { Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', "$verb-Service -Name $script:ServiceName -Force -ErrorAction SilentlyContinue" } catch { }
}

$script:toggleItem.add_Click({
  if ($script:legacy) {
    if ($script:stopped) { $script:stopped = $false; Start-LegacyGateway }
    else { $script:stopped = $true; Stop-LegacyGateway; Write-Log 'Gateway stopped from the tray menu' }
    return
  }
  $svc = Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq 'Running') { Invoke-ServiceAction 'Stop' } else { Invoke-ServiceAction 'Start' }
})
$restartItem.add_Click({
  if ($script:legacy) { $script:stopped = $false; Stop-LegacyGateway; Start-Sleep -Milliseconds 500; Start-LegacyGateway }
  else { Invoke-ServiceAction 'Restart' }
})
$exitItem.add_Click({
  # Closing the icon leaves a service running. A legacy install runs the gateway from here, so it stops with the icon.
  if ($script:legacy) { $script:stopped = $true; Stop-LegacyGateway }
  $script:notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$menu.add_Opening({
  $state = Get-GatewayState
  $script:toggleItem.Text = if ($state -eq 'stopped') { 'Start gateway' } else { 'Stop gateway' }
})

$script:lastState = ''
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  if ($script:legacy -and -not $script:stopped -and -not (Test-Path $script:updateLock) -and (-not $script:proc -or $script:proc.HasExited)) {
    Write-Log 'Gateway not running, restarting'
    Start-LegacyGateway
  }
  $state = Get-GatewayState
  $labels = @{ running = 'running'; starting = 'starting'; stopped = 'stopped'; updating = 'updating'; missing = 'not installed as a service' }
  $text = "Kestrel Gateway - $($labels[$state])"
  $script:notify.Text = $text
  $script:statusItem.Text = $text
  $script:notify.Icon = switch ($state) { 'running' { $script:iconOk } 'stopped' { $script:iconBad } 'missing' { $script:iconBad } default { $script:iconWarn } }
  # Say so once if it stops, so a stopped gateway is not found out about by accident.
  if ($state -eq 'stopped' -and $script:lastState -eq 'running') {
    $script:notify.ShowBalloonTip(5000, 'Kestrel Gateway', 'The gateway has stopped. It restarts by itself if it crashed; use the icon menu to start it.', 'Warning')
  }
  $script:lastState = $state
})
$timer.Start()

if ($script:legacy) { Start-LegacyGateway }
[System.Windows.Forms.Application]::Run()
