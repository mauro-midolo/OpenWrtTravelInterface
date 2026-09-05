<#
.SYNOPSIS
    Crea l'access point sul router, su entrambe le radio.

.DESCRIPTION
    Serve prima della misura sull'impatto della scansione: senza niente acceso
    non c'e' niente da misurare. Su OpenWrt vanilla le radio nascono disabilitate.

    Attenzione: questo script MODIFICA la configurazione wireless del router.
    Spegne le wifi-iface di default (altrimenti si accenderebbe una rete
    "OpenWrt" aperta) e crea la propria su ogni radio.

    La password viaggia sullo stdin di ssh, non sulla riga di comando: non
    finisce nella cronologia della shell ne' nella lista dei processi del router.

.EXAMPLE
    .\tools\setup-ap.ps1 -Ssid "Beryl" -Password "unapasswordlunga" -Country IT
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Ssid,
    [Parameter(Mandatory = $true)] [string] $Password,
    # Il paese in cui ti trovi FISICAMENTE: determina canali e potenze ammessi.
    [string] $Country = 'IT',
    [string] $Router = '192.168.10.1',
    [string] $User = 'root'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Password.Length -lt 8) { throw 'La password deve essere di almeno 8 caratteri.' }

$script = Join-Path $PSScriptRoot 'setup-ap.sh'
$remote = "$User@$Router"

function Sh([string] $value) { "'" + ($value -replace "'", "'\''") + "'" }

# I parametri vengono anteposti come assegnazioni dentro lo script stesso, cosi'
# non passano dalla riga di comando di ssh.
$body = @(
    "AP_SSID=$(Sh $Ssid)",
    "AP_PASS=$(Sh $Password)",
    "AP_COUNTRY=$(Sh $Country)",
    # -Encoding UTF8 non e' opzionale: senza, PowerShell 5.1 legge con la
    # codepage ANSI e i caratteri non-ASCII diventano virgolette dritte, che
    # sballano il quoting dello script una volta arrivato sul router.
    ((Get-Content $script -Raw -Encoding UTF8) -replace "`r`n", "`n")
) -join "`n"

Write-Host "==> configuro l'access point su $remote" -ForegroundColor Cyan
Write-Host "    SSID: $Ssid   Country: $Country" -ForegroundColor DarkGray
Write-Host "    Se sei collegato al router via WiFi potresti perdere la" -ForegroundColor DarkGray
Write-Host "    connessione: meglio farlo via cavo." -ForegroundColor DarkGray

# Lo script contiene la password in chiaro: viene cancellato dal router subito
# dopo l'esecuzione, comunque vada.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName              = 'ssh'
$psi.Arguments             = "-o StrictHostKeyChecking=accept-new $remote ""cat > /tmp/setup-ap.sh; sh /tmp/setup-ap.sh; rc=`$?; rm -f /tmp/setup-ap.sh; exit `$rc"""
$psi.RedirectStandardInput = $true
$psi.UseShellExecute       = $false

$proc = [System.Diagnostics.Process]::Start($psi)
try {
    # StreamWriter esplicito in UTF-8 senza BOM: lo stdin di default userebbe la
    # codepage della console, che rimappa i caratteri fuori tabella. Vale doppio
    # qui, dove passa anche la password.
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
    Write-Host "Configurazione fallita (ssh ha restituito $($proc.ExitCode))." -ForegroundColor Yellow
}
