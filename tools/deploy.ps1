<#
.SYNOPSIS
    Compila l'interfaccia e la installa sul router.

.DESCRIPTION
    Deploy per copia diretta: niente SDK OpenWrt, niente pacchetto da costruire.
    Serve solo `ssh`, che Windows 11 ha gia' integrato.

    Il trasferimento passa da un tar inviato sullo stdin di ssh perche' OpenWrt
    non installa `scp` ne' il server SFTP di default: e' l'unico metodo che
    funziona su un dispositivo appena flashato.

.EXAMPLE
    .\tools\deploy.ps1
    .\tools\deploy.ps1 -Router 192.168.10.1 -WithTtyd
    .\tools\deploy.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
    [string] $Router = '192.168.10.1',
    [string] $User = 'root',
    # Salta la compilazione del frontend: utile per iterare solo sul backend.
    [switch] $SkipBuild,
    # Installa anche il terminale web, la rete di sicurezza per quando sei in
    # viaggio senza SSH. Richiede che il router abbia Internet.
    [switch] $WithTtyd
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo     = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path $repo 'frontend'
$files    = Join-Path $repo 'package\travel\files'
$stage    = Join-Path $env:TEMP 'travel-stage'
$tarball  = Join-Path $env:TEMP 'travel-deploy.tar.gz'
$remote   = "$User@$Router"

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Note($text) { Write-Host "    $text" -ForegroundColor DarkGray }

# --- 1. Compilazione del frontend -------------------------------------------

if (-not $SkipBuild) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm non trovato. Installa Node.js, oppure usa -SkipBuild."
    }

    if (-not (Test-Path (Join-Path $frontend 'node_modules'))) {
        Step 'installo le dipendenze del frontend (solo la prima volta)'
        Push-Location $frontend
        try { npm install } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw 'npm install fallito' }
    }

    Step 'compilo il frontend'
    Push-Location $frontend
    try { npm run build } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'npm run build fallito' }
}

$dist = Join-Path $frontend 'dist'
if (-not (Test-Path $dist)) {
    throw "Manca $dist. Rilancia senza -SkipBuild."
}

# --- 2. Staging: un albero che rispecchia il filesystem del router ----------

Step 'preparo i file da inviare'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
$wwwTarget = Join-Path $stage 'www\travel'
New-Item -ItemType Directory -Path $wwwTarget -Force | Out-Null
Copy-Item (Join-Path $dist '*') $wwwTarget -Recurse -Force

# Tutto quello che sta sotto package\travel\files rispecchia il filesystem del
# router: si copiano tutti i rami, non solo usr, altrimenti un file nuovo in
# etc\ non arriverebbe mai a destinazione.
foreach ($branch in Get-ChildItem $files -Directory) {
    Copy-Item $branch.FullName $stage -Recurse -Force
}

$payloadKb = [math]::Round(((Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum / 1KB))
Note "$payloadKb KB da trasferire"

# ustar: busybox tar sul router non legge in modo affidabile il formato pax
# che bsdtar produrrebbe di default.
if (Test-Path $tarball) { Remove-Item $tarball -Force }
tar --format=ustar -czf $tarball -C $stage .
if ($LASTEXITCODE -ne 0) { throw 'creazione del tar fallita' }

# --- 3. Trasferimento -------------------------------------------------------

Step "invio a $remote"
Note 'Se chiede la password e ti stanca, configura una chiave: vedi README.'

# `cat >` e non `dd`: il dd di busybox non conosce status=none e risponde
# stampando l'help. La redirezione la interpreta la shell del router, non cmd.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = 'ssh'
$psi.Arguments              = "-o StrictHostKeyChecking=accept-new $remote ""cat > /tmp/travel-deploy.tar.gz"""
$psi.RedirectStandardInput  = $true
$psi.UseShellExecute        = $false

$proc = [System.Diagnostics.Process]::Start($psi)
try {
    $stream = [System.IO.File]::OpenRead($tarball)
    try { $stream.CopyTo($proc.StandardInput.BaseStream) } finally { $stream.Dispose() }
    $proc.StandardInput.Close()
    $proc.WaitForExit()
} finally {
    if (-not $proc.HasExited) { $proc.Kill() }
}
if ($proc.ExitCode -ne 0) { throw "trasferimento fallito (ssh ha restituito $($proc.ExitCode))" }

# --- 4. Installazione sul router -------------------------------------------

Step 'installo sul router'

if ($WithTtyd) { $ttyd = '1' } else { $ttyd = '0' }

# /www/travel viene svuotata: Vite mette un hash nel nome dei file, senza
# pulizia i vecchi bundle resterebbero li' a occupare flash per sempre.
$install = @"
set -e
rm -rf /www/travel
tar xzf /tmp/travel-deploy.tar.gz -C /
rm -f /tmp/travel-deploy.tar.gz
TRAVEL_INSTALL_TTYD=$ttyd sh /usr/share/travel/setup.sh
"@

ssh -o StrictHostKeyChecking=accept-new $remote $install
if ($LASTEXITCODE -ne 0) { throw 'installazione fallita sul router' }

Write-Host ''
Write-Host "Fatto. Apri  https://$Router/travel/" -ForegroundColor Green
Note "LuCI resta dov'e': https://$Router/cgi-bin/luci"
if ($WithTtyd) { Note "Terminale web: https://$Router/cgi-bin/luci/admin/services/ttyd" }
