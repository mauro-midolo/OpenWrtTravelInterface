<#
.SYNOPSIS
    Builds the interface and installs it on the router.

.DESCRIPTION
    Deployment by direct copy: no OpenWrt SDK, no package to build. Only `ssh`
    is needed, which Windows 11 already ships.

    The transfer goes through a tar sent over ssh's stdin because OpenWrt does
    not install `scp` or the SFTP server by default: it is the only method that
    works on a freshly flashed device.

.EXAMPLE
    .\tools\deploy.ps1
    .\tools\deploy.ps1 -Router 192.168.10.1 -WithTtyd
    .\tools\deploy.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
    [string] $Router = '192.168.10.1',
    [string] $User = 'root',
    # Skips the frontend build: useful when iterating on the backend only.
    [switch] $SkipBuild,
    # Also installs the web terminal, the safety net for when you are on the
    # road without SSH. Requires the router to have Internet access.
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

# --- 1. Frontend build ------------------------------------------------------

if (-not $SkipBuild) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm not found. Install Node.js, or use -SkipBuild."
    }

    if (-not (Test-Path (Join-Path $frontend 'node_modules'))) {
        Step 'installing frontend dependencies (first time only)'
        Push-Location $frontend
        try { npm install } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    }

    Step 'building the frontend'
    Push-Location $frontend
    try { npm run build } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
}

$dist = Join-Path $frontend 'dist'
if (-not (Test-Path $dist)) {
    throw "$dist is missing. Run again without -SkipBuild."
}

# --- 2. Staging: a tree that mirrors the router's filesystem ---------------

Step 'preparing the files to send'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
$wwwTarget = Join-Path $stage 'www\travel'
New-Item -ItemType Directory -Path $wwwTarget -Force | Out-Null
Copy-Item (Join-Path $dist '*') $wwwTarget -Recurse -Force

# Everything under package\travel\files mirrors the router's filesystem: all
# branches are copied, not just usr, otherwise a new file in etc\ would never
# reach its destination.
foreach ($branch in Get-ChildItem $files -Directory) {
    Copy-Item $branch.FullName $stage -Recurse -Force
}

$payloadKb = [math]::Round(((Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum / 1KB))
Note "$payloadKb KB to transfer"

# ustar: busybox tar on the router does not reliably read the pax format
# that bsdtar would produce by default.
if (Test-Path $tarball) { Remove-Item $tarball -Force }
tar --format=ustar -czf $tarball -C $stage .
if ($LASTEXITCODE -ne 0) { throw 'tar creation failed' }

# --- 3. Transfer -----------------------------------------------------------

Step "sending to $remote"
Note 'If typing the password gets tiresome, set up a key: see the README.'

# `cat >` and not `dd`: busybox's dd does not know status=none and replies by
# printing its help. The redirection is interpreted by the router's shell, not cmd.
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
if ($proc.ExitCode -ne 0) { throw "transfer failed (ssh returned $($proc.ExitCode))" }

# --- 4. Installation on the router -----------------------------------------

Step 'installing on the router'

if ($WithTtyd) { $ttyd = '1' } else { $ttyd = '0' }

# /www/travel is emptied: Vite puts a hash in file names, and without cleanup
# old bundles would stay there taking up flash forever.
$install = @"
set -e
rm -rf /www/travel
tar xzf /tmp/travel-deploy.tar.gz -C /
rm -f /tmp/travel-deploy.tar.gz
TRAVEL_INSTALL_TTYD=$ttyd sh /usr/share/travel/setup.sh
"@

ssh -o StrictHostKeyChecking=accept-new $remote $install
if ($LASTEXITCODE -ne 0) { throw 'installation failed on the router' }

Write-Host ''
Write-Host "Done. Open  https://$Router/travel/" -ForegroundColor Green
Note "LuCI stays where it is: https://$Router/cgi-bin/luci"
if ($WithTtyd) { Note "Web terminal: https://$Router/cgi-bin/luci/admin/services/ttyd" }
