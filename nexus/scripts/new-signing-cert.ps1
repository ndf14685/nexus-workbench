# Copyright 2026, Nexus Workbench
# SPDX-License-Identifier: Apache-2.0
#
# Genera un certificado de code signing AUTOFIRMADO para Nexus Workbench, lo
# confía en esta máquina y deja el .pfx listo para cargarlo como secret de CI.
#
# Autofirmado quiere decir que nadie validó la identidad: es una afirmación
# tuya sobre vos mismo. Sirve porque sos el único que instala esta app. Lo que
# te da:
#   - se va el "editor desconocido" en las máquinas donde confiaste la raíz
#   - el auto-update puede verificar que la actualización la firmaste vos
# Lo que no te da: confianza en cualquier otra máquina.
#
# Uso (PowerShell COMO ADMINISTRADOR, para poder escribir en LocalMachine\Root):
#   .\nexus\scripts\new-signing-cert.ps1 -Subject "Nestor Fleitas"
#
# Si el gh CLI está autenticado, carga solo los secrets en el repo y el próximo
# tag sale firmado. Con -SkipGitHub sólo imprime los valores para cargarlos a
# mano. Guardá el .pfx y su contraseña: sin ellos no podés volver a firmar
# actualizaciones que las instalaciones existentes acepten.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Subject,

    [string]$OutDir = "$PSScriptRoot\..\..\.signing",

    [int]$Years = 10,

    # Sin -TrustLocally el certificado se genera pero no se confía: útil para
    # producirlo en una máquina que no es la que va a instalar la app.
    [switch]$SkipTrust,

    [string]$Repo = "ndf14685/nexus-workbench",

    # Con -SkipGitHub sólo imprime los valores en vez de cargarlos con gh.
    [switch]$SkipGitHub
)

$ErrorActionPreference = "Stop"

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not $SkipTrust -and -not (Test-Admin)) {
    throw "Ejecutá esta consola como Administrador, o pasá -SkipTrust para sólo generar el .pfx."
}

$cn = "CN=$Subject"
Write-Host "Generando certificado de code signing para $cn ..." -ForegroundColor Cyan

$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $cn `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyUsage DigitalSignature `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears($Years) `
    -CertStoreLocation "Cert:\CurrentUser\My"

Write-Host "  thumbprint: $($cert.Thumbprint)"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$pfxPath = Join-Path $OutDir "nexus-codesign.pfx"
$cerPath = Join-Path $OutDir "nexus-codesign.cer"

# La contraseña protege la clave privada dentro del .pfx. Se genera acá para
# que no termine siendo algo adivinable escrito a mano.
$bytes = [byte[]]::new(24)
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$plainPassword = [Convert]::ToBase64String($bytes)
$password = ConvertTo-SecureString -String $plainPassword -Force -AsPlainText

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $password | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

if (-not $SkipTrust) {
    # Root: hace que Windows confíe en la cadena, que es lo que
    # Get-AuthenticodeSignature necesita para devolver Valid y lo que mira el
    # auto-updater. TrustedPublisher: evita el prompt al ejecutar el instalador.
    Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\LocalMachine\Root" | Out-Null
    Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\LocalMachine\TrustedPublisher" | Out-Null
    Write-Host "Certificado confiado en esta máquina (Root + TrustedPublisher)." -ForegroundColor Green
}

$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxPath))

# Se cargan con gh en vez de imprimirlos: el base64 de una clave privada no
# tiene por qué quedar en el scrollback de la consola, y copiarlo a mano es
# largo y propenso a error.
$uploaded = $false
if (-not $SkipGitHub) {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $gh) {
        Write-Warning "gh CLI no encontrado; los valores se imprimen abajo para cargarlos a mano."
    }
    else {
        try {
            $b64 | gh secret set WIN_CSC_LINK --repo $Repo
            $plainPassword | gh secret set WIN_CSC_KEY_PASSWORD --repo $Repo
            gh variable set NEXUS_PUBLISHER_NAME --repo $Repo --body $Subject
            if ($LASTEXITCODE -ne 0) { throw "gh devolvio $LASTEXITCODE" }
            $uploaded = $true
            Write-Host ""
            Write-Host "Secrets y variable cargados en $Repo." -ForegroundColor Green
            Write-Host "El proximo tag va a salir firmado." -ForegroundColor Green
        }
        catch {
            Write-Warning "No se pudieron cargar con gh ($_). Cargalos a mano con los valores de abajo."
        }
    }
}

if (-not $uploaded) {
    Write-Host ""
    Write-Host "=== Cargá esto en GitHub (Settings > Secrets and variables > Actions) ===" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "secret   WIN_CSC_KEY_PASSWORD:" -ForegroundColor Yellow
    Write-Host $plainPassword
    Write-Host ""
    Write-Host "variable NEXUS_PUBLISHER_NAME:" -ForegroundColor Yellow
    Write-Host $Subject
    Write-Host ""
    Write-Host "secret   WIN_CSC_LINK (base64 del .pfx, tambien en $pfxPath):" -ForegroundColor Yellow
    Write-Host $b64
}

Write-Host ""
Write-Host "Contraseña del .pfx (guardala en tu gestor de contraseñas):" -ForegroundColor Yellow
Write-Host $plainPassword
Write-Host ""
Write-Host "El .pfx en $pfxPath contiene tu clave privada." -ForegroundColor Red
Write-Host "Sin el, perdes la posibilidad de firmar actualizaciones que las instalaciones" -ForegroundColor Red
Write-Host "existentes acepten: respaldalo. Esta gitignoreado, NO lo commitees." -ForegroundColor Red
