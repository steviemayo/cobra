# Opens the Kestrel gateway's own page in the default browser. This is what the Start menu and desktop
# shortcuts run. The port is read from viewer.json (written by configure.ps1; not a secret), so it
# works for any signed-in person, and follows the gateway if it was set up on a different port.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8080
$viewerFile = Join-Path $root 'viewer.json'
if (Test-Path $viewerFile) {
  try { $v = Get-Content $viewerFile -Raw | ConvertFrom-Json; if ($v.port) { $port = [int]$v.port } } catch { }
}
Start-Process "http://127.0.0.1:$port/"
