<#
.SYNOPSIS
  Lets you change this gateway's cloud URL and/or enrolment token without uninstalling and
  reinstalling. Self-elevates (UAC prompt) since it rewrites the same protected settings the
  installer does, then reruns configure.ps1 with the current settings plus whatever you changed -
  safe to run more than once (a repair, re-provisioning, moving to a different org).

.DESCRIPTION
  Shipped alongside configure.ps1 in the install directory, and launched from the Start Menu
  shortcut ("Kestrel Gateway > Change cloud URL") or the tray icon's "Change cloud URL..." menu
  item. Not normally run with -InstallDir by hand; the shortcuts already pass it.
#>
[CmdletBinding()]
param([string] $InstallDir = $PSScriptRoot)
$ErrorActionPreference = 'Stop'

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Start-Process -FilePath $ps -Verb RunAs -ArgumentList `
    "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -InstallDir `"$InstallDir`""
  exit
}

$envFile = Join-Path $InstallDir 'gateway.env'
if (-not (Test-Path $envFile)) { throw "No gateway.env found at $envFile - is this a Kestrel Gateway install directory?" }
$current = @{}
foreach ($line in Get-Content $envFile) { if ($line -match '^([A-Z0-9_]+)=(.*)$') { $current[$Matches[1]] = $Matches[2] } }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Kestrel Gateway'
$form.Width = 480; $form.Height = 240; $form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false; $form.MinimizeBox = $false

$lbl1 = New-Object System.Windows.Forms.Label
$lbl1.Text = 'Cloud URL:'
$lbl1.Location = New-Object System.Drawing.Point(12, 20)
$lbl1.AutoSize = $true
$txtUrl = New-Object System.Windows.Forms.TextBox
$txtUrl.Location = New-Object System.Drawing.Point(12, 40)
$txtUrl.Width = 440
$txtUrl.Text = $current['KESTREL_CLOUD_URL']

$lbl2 = New-Object System.Windows.Forms.Label
$lbl2.Text = "New enrolment token (only if re-provisioning; leave blank to keep this gateway's identity):"
$lbl2.Location = New-Object System.Drawing.Point(12, 75)
$lbl2.AutoSize = $true
$txtToken = New-Object System.Windows.Forms.TextBox
$txtToken.Location = New-Object System.Drawing.Point(12, 95)
$txtToken.Width = 440

$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Apply'
$ok.Location = New-Object System.Drawing.Point(296, 150)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Location = New-Object System.Drawing.Point(377, 150)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

$form.Controls.AddRange(@($lbl1, $txtUrl, $lbl2, $txtToken, $ok, $cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit }

$cloudUrl = $txtUrl.Text.Trim()
if ($cloudUrl -notmatch '^https?://') {
  [System.Windows.Forms.MessageBox]::Show('The cloud URL must start with http:// or https://', 'Kestrel Gateway', 'OK', 'Error') | Out-Null
  exit 1
}

& (Join-Path $InstallDir 'configure.ps1') `
  -CloudUrl $cloudUrl -EnrollToken $txtToken.Text.Trim() `
  -Channel $current['KESTREL_CHANNEL'] -Repo $current['KESTREL_REPO'] `
  -InstallDir $InstallDir -DataDir $current['KESTREL_DATA_DIR'] `
  -PanelPort ([int]$current['KESTREL_PANEL_PORT']) -Mode $current['KESTREL_RUN_MODE']

[System.Windows.Forms.MessageBox]::Show(
  'Applied. The gateway restarted with the new settings.', 'Kestrel Gateway', 'OK', 'Information') | Out-Null
