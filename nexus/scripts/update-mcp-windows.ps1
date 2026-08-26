<#
.SYNOPSIS
    Actualiza el servidor MCP del Workbench desde un release publicado.

.DESCRIPTION
    El instalador de la app no toca D:\Mcp, asi que el MCP se venia
    reemplazando a mano — y una maquina parchada a mano no la reproduce ningun
    release. Este script hace lo mismo pero desde el artefacto publicado y con
    el hash verificado, que es la diferencia entre actualizar y improvisar.

        release publicado -> descarga -> SHA256 contra SHA256SUMS.txt
                          -> backup -> reemplazo -> tarea reiniciada

    Sin -Tag toma el release mas nuevo (incluidas las betas).

.EXAMPLE
    pwsh nexus/scripts/update-mcp-windows.ps1
    pwsh nexus/scripts/update-mcp-windows.ps1 -Tag v0.17.0-beta.3
#>
[CmdletBinding()]
param(
    [string]$Tag = "",
    [string]$Dest = "D:\Mcp",
    [string]$TaskName = "JarvisAgent",
    [string]$Repo = "ndf14685/nexus-workbench",
    [switch]$SkipTask
)

$ErrorActionPreference = "Stop"
$exeName = "nexus-workbench-mcp.exe"
$target = Join-Path $Dest $exeName

function Get-ReleaseJson {
    $headers = @{ "User-Agent" = "nexus-update-mcp" }
    if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $env:GITHUB_TOKEN" }
    if ($Tag) {
        return Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag"
    }
    $all = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repo/releases?per_page=10"
    $newest = $all | Where-Object { -not $_.draft } | Select-Object -First 1
    if (-not $newest) { throw "no hay releases publicados en $Repo" }
    return $newest
}

function Get-Asset($release, [string]$name) {
    $asset = $release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if (-not $asset) { throw "el release $($release.tag_name) no trae $name" }
    return $asset
}

Write-Host "== buscando release" -ForegroundColor Cyan
$release = Get-ReleaseJson
Write-Host "   $($release.tag_name)  ($($release.published_at))"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("nexus-mcp-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $exeAsset = Get-Asset $release $exeName
    $downloaded = Join-Path $tmp $exeName
    Write-Host "== descargando $($exeAsset.size) bytes" -ForegroundColor Cyan
    Invoke-WebRequest -Uri $exeAsset.browser_download_url -OutFile $downloaded

    # El hash no es ceremonia: es lo unico que distingue este binario de
    # cualquier otro que haya pasado por el medio.
    $sumsAsset = Get-Asset $release "SHA256SUMS.txt"
    $sumsFile = Join-Path $tmp "SHA256SUMS.txt"
    Invoke-WebRequest -Uri $sumsAsset.browser_download_url -OutFile $sumsFile
    $expected = (Select-String -Path $sumsFile -Pattern ([regex]::Escape($exeName)) |
        Select-Object -First 1).Line -split "\s+" | Select-Object -First 1
    if (-not $expected) { throw "SHA256SUMS.txt no menciona $exeName" }
    $actual = (Get-FileHash $downloaded -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) {
        throw "hash distinto: esperaba $expected y bajo $actual"
    }
    Write-Host "== hash verificado" -ForegroundColor Green

    if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest | Out-Null }
    if (Test-Path $target) {
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $backup = Join-Path $Dest ("nexus-workbench-mcp.$stamp.bak.exe")
        Copy-Item $target $backup -Force
        Write-Host "== backup en $backup"
    }

    if (-not $SkipTask) {
        Write-Host "== parando la tarea $TaskName"
        schtasks /End /TN $TaskName 2>$null | Out-Null
        Start-Sleep -Seconds 2
        # El .exe queda tomado unos instantes despues de matar el proceso.
        Get-Process -Name "nexus-workbench-mcp" -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }

    Copy-Item $downloaded $target -Force
    Write-Host "== instalado en $target" -ForegroundColor Green

    if (-not $SkipTask) {
        Write-Host "== arrancando la tarea $TaskName"
        schtasks /Run /TN $TaskName | Out-Null
        Start-Sleep -Seconds 5
        $running = Get-Process -Name "nexus-workbench-mcp" -ErrorAction SilentlyContinue
        if (-not $running) {
            Write-Warning "la tarea no dejo el proceso corriendo; revisa el log del agente"
        } else {
            Write-Host "== corriendo (pid $($running.Id))" -ForegroundColor Green
        }
    }
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
