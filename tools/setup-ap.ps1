<#
.SYNOPSIS
    Creates the access point on the router, on both radios.

.DESCRIPTION
    Needed before measuring the impact of scanning: with nothing turned on
    there is nothing to measure. On vanilla OpenWrt the radios start disabled.

    Warning: this script CHANGES the router's wireless configuration. It turns
    off the default wifi-ifaces (otherwise an open "OpenWrt" network would come
    up) and creates its own on each radio.

    The password travels over ssh's stdin, not on the command line: it ends up
    neither in the shell history nor in the router's process list.

.EXAMPLE
    .\tools\setup-ap.ps1 -Ssid "Beryl" -Password "alongpassword" -Country IT
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Ssid,
    [Parameter(Mandatory = $true)] [string] $Password,
    # The country you are PHYSICALLY in: it determines the allowed channels and power.
    [string] $Country = 'IT',
    [string] $Router = '192.168.10.1',
    [string] $User = 'root'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Password.Length -lt 8) { throw 'The password must be at least 8 characters long.' }

$script = Join-Path $PSScriptRoot 'setup-ap.sh'
$remote = "$User@$Router"

function Sh([string] $value) { "'" + ($value -replace "'", "'\''") + "'" }

# The parameters are prepended as assignments inside the script itself, so
# they do not go through ssh's command line.
$body = @(
    "AP_SSID=$(Sh $Ssid)",
    "AP_PASS=$(Sh $Password)",
    "AP_COUNTRY=$(Sh $Country)",
    # -Encoding UTF8 is not optional: without it, PowerShell 5.1 reads with the
    # ANSI code page and non-ASCII characters turn into straight quotes, which
    # break the script's quoting once it reaches the router.
    ((Get-Content $script -Raw -Encoding UTF8) -replace "`r`n", "`n")
) -join "`n"

Write-Host "==> configuring the access point on $remote" -ForegroundColor Cyan
Write-Host "    SSID: $Ssid   Country: $Country" -ForegroundColor DarkGray
Write-Host "    If you are connected to the router over WiFi you may lose the" -ForegroundColor DarkGray
Write-Host "    connection: better to do it over a cable." -ForegroundColor DarkGray

# The script contains the password in clear text: it is deleted from the
# router right after running, whatever the outcome.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName              = 'ssh'
$psi.Arguments             = "-o StrictHostKeyChecking=accept-new $remote ""cat > /tmp/setup-ap.sh; sh /tmp/setup-ap.sh; rc=`$?; rm -f /tmp/setup-ap.sh; exit `$rc"""
$psi.RedirectStandardInput = $true
$psi.UseShellExecute       = $false

$proc = [System.Diagnostics.Process]::Start($psi)
try {
    # Explicit UTF-8 StreamWriter without BOM: the default stdin would use the
    # console code page, which remaps characters outside its table. This matters
    # twice here, where the password goes through too.
    $writer = New-Object System.IO.StreamWriter($proc.StandardInput.BaseStream, (New-Object System.Text.UTF8Encoding($false)))
    $writer.NewLine = "`n"
    $writer.Write($body)
    $writer.Flush()
    $writer.Close()
    $proc.WaitForExit()
} finally {
    if (-not $proc.HasExited) { $proc.Kill() }
}

if ($proc.ExitCode -ne 0) {
    Write-Host ''
    Write-Host "Configuration failed (ssh returned $($proc.ExitCode))." -ForegroundColor Yellow
}
