#Requires -Version 5.1
<#
.SYNOPSIS
  Bootstrap d'installation en une commande pour Windows, via :
    irm https://maj.aymericmillot.com/iutlab/web-install.ps1 | iex

.DESCRIPTION
  Ce script est destine a etre heberge separement du depot (ex: maj.aymericmillot.com) et
  invoque via `irm ... | iex`. Comme il s'execute par evaluation de chaine (Invoke-Expression)
  et non comme fichier .ps1, il n'est jamais bloque par la politique d'execution de scripts de
  Windows (Restricted par defaut) - pas besoin de -ExecutionPolicy Bypass pour cette premiere
  etape.

  Il telecharge l'archive du projet, l'extrait dans le dossier utilisateur, puis lance
  install.ps1 en passant explicitement -ExecutionPolicy Bypass (ce script imbrique, lui, est
  un vrai fichier et serait sinon bloque par la meme politique).

  Ne remplace pas les prerequis d'install.ps1 : Docker Desktop necessite toujours la
  virtualisation materielle activee dans le BIOS/UEFI (Intel VT-x ou AMD-V), avec ou sans
  WSL2. Si `wsl --install` echoue en demandant d'activer la virtualisation, c'est un reglage
  BIOS a faire une seule fois, ce script ne peut pas le faire a votre place.
#>

param(
  [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

$archiveUrl = "https://maj.aymericmillot.com/iutlab/assistant-ia.zip"
$destinationRoot = Join-Path $HOME "assistant-ia"
$zipPath = Join-Path $env:TEMP "assistant-ia-$([guid]::NewGuid().ToString('N')).zip"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

Write-Step "Telechargement de Assistant IA..."
Invoke-WebRequest -Uri $archiveUrl -OutFile $zipPath

if (Test-Path $destinationRoot) {
  Write-Host "Un dossier assistant-ia existe deja dans $HOME : les fichiers seront mis a jour sur place (vos donnees dans backend/data et backend/uploads sont preservees, elles ne font pas partie de l'archive)." -ForegroundColor Yellow
} else {
  New-Item -ItemType Directory -Path $destinationRoot | Out-Null
}

Write-Step "Extraction de l'archive..."
Expand-Archive -Path $zipPath -DestinationPath $destinationRoot -Force
Remove-Item $zipPath -Force

# L'archive peut contenir un sous-dossier racine (ex: assistant-ia-main) : on retrouve
# install.ps1 quel que soit le niveau d'imbrication plutot que de supposer sa position exacte.
$installScript = Get-ChildItem -Path $destinationRoot -Filter "install.ps1" -Recurse -File |
  Select-Object -First 1

if (-not $installScript) {
  throw "install.ps1 introuvable dans l'archive telechargee depuis $archiveUrl."
}

Write-Step "Lancement de l'installation depuis $($installScript.Directory)..."
Set-Location $installScript.Directory.FullName

$installArgs = @("-ExecutionPolicy", "Bypass", "-File", $installScript.FullName)
if ($NonInteractive) {
  $installArgs += "-NonInteractive"
}

& powershell @installArgs
exit $LASTEXITCODE
