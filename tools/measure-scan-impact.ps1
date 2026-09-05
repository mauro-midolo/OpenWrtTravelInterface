<#
.SYNOPSIS
    Esegue la misura dell'impatto della scansione WiFi sul router.

.DESCRIPTION
    Copia measure-scan-impact.sh sul router e lo lancia. Non modifica niente:
    lo script fa solo ping e scansioni.

    Prima di lanciarlo, collega il telefono al WiFi del router e lascialo li':
    e' il bersaglio della misura.

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

Write-Host "==> invio la misura a $remote" -ForegroundColor Cyan
Write-Host "    Il telefono deve essere collegato al WiFi del router." -ForegroundColor DarkGray

# -Encoding UTF8 non e' opzionale: senza, PowerShell 5.1 legge il file con la
# codepage ANSI e i caratteri non-ASCII si trasformano in virgolette dritte,
# che sballano il quoting dello script una volta arrivato sul router.
# CRLF -> LF perche' la shell del router non digerisce i ritorni a capo Windows.
$body = (Get-Content $script -Raw -Encoding UTF8) -replace "`r`n", "`n"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName              = 'ssh'
$psi.Arguments             = "-o StrictHostKeyChecking=accept-new $remote ""cat > /tmp/measure-scan-impact.sh && sh /tmp/measure-scan-impact.sh"""
$psi.RedirectStandardInput = $true
$psi.UseShellExecute       = $false

$proc = [System.Diagnostics.Process]::Start($psi)
try {
    # StreamWriter esplicito in UTF-8 senza BOM: lo stdin di default userebbe la
    # codepage della console, che rimappa i caratteri fuori tabella.
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
    Write-Host "La misura non e' andata a buon fine (ssh ha restituito $($proc.ExitCode))." -ForegroundColor Yellow
}
