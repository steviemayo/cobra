# Helpers that keep the gateway's secrets away from other people who use the same machine. Loaded
# (dot-sourced) by configure.ps1 and update.ps1; not run on its own.
#
# What is in the data folder: the gateway's credential, the logins for the room's devices, the
# phone-control secrets, the admin code and the staged update. Anyone who can read those can act as
# the gateway, so only the system, administrators and the account the gateway runs as may.

$script:AdministratorsSid = '*S-1-5-32-544'

function Invoke-Icacls {
  param([Parameter(Mandatory)][string[]] $Arguments)
  $out = & icacls.exe @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "icacls $($Arguments -join ' ') failed: $out" }
}

<#
  Limits a folder to SYSTEM, Administrators (full control) and the listed accounts (modify), with
  nothing inherited from the folder above. Files made inside it later inherit the same rules.
#>
function Protect-KestrelFolder {
  param(
    [Parameter(Mandatory)][string] $Path,
    [string[]] $Modify = @()
  )
  $grants = @("SYSTEM:(OI)(CI)F", "$($script:AdministratorsSid):(OI)(CI)F")
  foreach ($who in ($Modify | Where-Object { $_ } | Select-Object -Unique)) { $grants += "${who}:(OI)(CI)M" }
  $arguments = @($Path, '/inheritance:r', '/grant:r') + $grants
  Invoke-Icacls -Arguments $arguments
}

<#
  Limits one file to SYSTEM and Administrators (full control) and the listed accounts (read).
#>
function Protect-KestrelFile {
  param(
    [Parameter(Mandatory)][string] $Path,
    [string[]] $Read = @()
  )
  if (-not (Test-Path $Path)) { return }
  $grants = @("SYSTEM:F", "$($script:AdministratorsSid):F")
  foreach ($who in ($Read | Where-Object { $_ } | Select-Object -Unique)) { $grants += "${who}:R" }
  $arguments = @($Path, '/inheritance:r', '/grant:r') + $grants
  Invoke-Icacls -Arguments $arguments
}

<# The account the installed service runs as, or $null when it runs as the system (or is not installed). #>
function Get-KestrelServiceAccount {
  $svc = Get-CimInstance Win32_Service -Filter "Name='KestrelGateway'" -ErrorAction SilentlyContinue
  if (-not $svc -or -not $svc.StartName) { return $null }
  if ($svc.StartName -in 'LocalSystem', 'NT AUTHORITY\SYSTEM') { return $null }
  return $svc.StartName
}

<#
  Lets the given account start the update task (which runs as SYSTEM, outside the gateway, because
  it has to stop and replace the gateway). A plain service account cannot run it otherwise.
#>
function Grant-KestrelTaskRun {
  param([Parameter(Mandatory)][string] $TaskName, [Parameter(Mandatory)][string] $Account)
  $sid = (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
  $scheduler = New-Object -ComObject 'Schedule.Service'
  $scheduler.Connect()
  $task = $scheduler.GetFolder('\').GetTask($TaskName)
  $sddl = $task.GetSecurityDescriptor(4)   # the access list only
  # SDDL writes well-known accounts as short aliases, so look at the parsed list, not the text.
  $descriptor = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
  $already = @($descriptor.DiscretionaryAcl | Where-Object { $_.SecurityIdentifier.Value -eq $sid -and $_.AceType -eq 'AccessAllowed' })
  if ($already.Count -eq 0) { $task.SetSecurityDescriptor($sddl + "(A;;GRGX;;;$sid)", 0) }
}
