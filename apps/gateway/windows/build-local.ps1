<#
.SYNOPSIS
  Builds the Windows gateway bundle and installer on this machine, the way CI does, so an install can be
  tried without pushing anything. The bundle is NOT signed: it is for testing here, never for release.

.DESCRIPTION
  Needs pnpm (via corepack) and Inno Setup 6 (winget install JRSoftware.InnoSetup). Writes
  <OutDir>\bundle\app, <OutDir>\kestrel-gateway-win-x64.zip and <OutDir>\KestrelGatewaySetup.exe.
    .\build-local.ps1 -OutDir C:\temp\kestrel-build
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $OutDir,
  [string] $CloudUrlDefault = ''
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$bundle = Join-Path $OutDir 'bundle\app'
if (Test-Path (Join-Path $OutDir 'bundle')) { Remove-Item -Recurse -Force (Join-Path $OutDir 'bundle') }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Windows PowerShell 5.1 turns a native program's stderr into an error under 'Stop'; only the exit code counts.
function Run([scriptblock] $cmd) {
  $before = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $cmd 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $before }
  if ($LASTEXITCODE -ne 0) { throw "Failed: $cmd" }
}

Push-Location $repo
try {
  Run { corepack pnpm --filter '@kestrel/panel-app' build }
  Run { corepack pnpm --filter '@kestrel/gateway' build }
  Run { corepack pnpm --config.node-linker=hoisted --filter '@kestrel/gateway' deploy --prod $bundle }
} finally { Pop-Location }

Copy-Item -Recurse (Join-Path $repo 'apps\panel\dist') (Join-Path $bundle 'panel')
Copy-Item -Recurse (Join-Path $repo 'apps\gateway\dist') (Join-Path $bundle 'dist')
Copy-Item -Recurse (Join-Path $repo 'apps\gateway\windows') (Join-Path $bundle 'windows')
$version = (Select-String -Path (Join-Path $repo 'apps\gateway\src\config.ts') -Pattern "GATEWAY_VERSION = '([^']+)'").Matches[0].Groups[1].Value
Set-Content -Path (Join-Path $bundle 'VERSION') -Value $version -NoNewline

# The same Node the tests run on, and the same pinned service wrapper CI uses.
$node = (Get-Command node).Source
New-Item -ItemType Directory -Force -Path (Join-Path $bundle 'runtime') | Out-Null
Copy-Item $node (Join-Path $bundle 'runtime\node.exe')
$wrapper = Join-Path $bundle 'windows\KestrelGatewayService.exe'
Invoke-WebRequest 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET4.exe' -OutFile $wrapper -UseBasicParsing
$actual = (Get-FileHash -Algorithm SHA256 -Path $wrapper).Hash.ToLower()
if ($actual -ne '923111c7142b3dc783a3c722b19b8a21bcb78222d7a136ac33f0ca8a29f4cb66') { throw "WinSW does not match the expected digest (got $actual)" }

$zip = Join-Path $OutDir 'kestrel-gateway-win-x64.zip'
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $bundle '*') -DestinationPath $zip

$iscc = @('C:\Program Files (x86)\Inno Setup 6\ISCC.exe', (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 is not installed (winget install JRSoftware.InnoSetup).' }
Run { & $iscc "/DAppVersion=$version" "/DCloudUrlDefault=$CloudUrlDefault" "/DSourceDir=$bundle" "/DOutputDir=$OutDir" (Join-Path $PSScriptRoot 'setup.iss') }
Write-Host "Built ${version}: $(Join-Path $OutDir 'KestrelGatewaySetup.exe')"


