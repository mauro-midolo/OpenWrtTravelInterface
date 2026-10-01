<#
.SYNOPSIS
    Measures the impact of WiFi scanning on the router.

.DESCRIPTION
    Copies measure-scan-impact.sh to the router and runs it. It changes
    nothing: the script only pings and scans.

    Before running it, connect the phone to the router's WiFi and leave it
    there: it is the target of the measurement.

.EXAMPLE
    .\tools\measure-scan-impact.ps1
#>
[CmdletBinding()]
param(
    [string] $Router = '192.168.10.1',
    [string] $User = 'root'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script = Join-Path $PSScriptRoot 'measure-scan-impact.sh'
$remote = "$User@$Router"

Write-Host "==> sending the measurement to $remote" -ForegroundColor Cyan
Write-Host "    The phone must be connected to the router's WiFi." -ForegroundColor DarkGray

# -Encoding UTF8 is not optional: without it, PowerShell 5.1 reads the file with
# the ANSI code page and non-ASCII characters turn into straight quotes, which
# break the script's quoting once it reaches the router.
# CRLF -> LF because the router's shell cannot digest Windows line endings.
$body = (Get-Content $script -Raw -Encoding UTF8) -replace "`r`n", "`n"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName              = 'ssh'
$psi.Arguments             = "-o StrictHostKeyChecking=accept-new $remote ""cat > /tmp/measure-scan-impact.sh && sh /tmp/measure-scan-impact.sh"""
$psi.RedirectStandardInput = $true
$psi.UseShellExecute       = $false

$proc = [System.Diagnostics.Process]::Start($psi)
try {
    # Explicit UTF-8 StreamWriter without BOM: the default stdin would use the
    # console code page, which remaps characters outside its table.
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
    Write-Host "The measurement did not succeed (ssh returned $($proc.ExitCode))." -ForegroundColor Yellow
}
