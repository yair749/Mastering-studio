<#
  One-time setup of the export queue on the export PC. Run through "Install.cmd".

  - Checks Node.js (22.13 or newer) is installed
  - Installs the one dependency (Express) with npm
  - Creates config.json from the example if there isn't one
  - Starts the queue at every login of this Windows user (Startup folder), because InDesign
    needs the user's desktop session: it can't run as a background Windows service
  - Opens the port in Windows Firewall for the private (office) network, if run as administrator
  - Starts the queue now

  -Uninstall removes the auto-start and the firewall rule (jobs and settings are kept).
#>
param(
    [switch]$Uninstall,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$AppDir = Split-Path -Parent $PSScriptRoot
$Startup = [Environment]::GetFolderPath("Startup")
$Shortcut = Join-Path $Startup "InDesign Export Queue.lnk"
$StartCmd = Join-Path $PSScriptRoot "start.cmd"
$RuleName = "InDesign Export Queue"
trap { Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Uninstall) {
    if (Test-Path $Shortcut) { Remove-Item $Shortcut; Write-Host "Removed the auto-start." -ForegroundColor Green }
    if (Test-Admin) {
        Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        Write-Host "Removed the firewall rule." -ForegroundColor Green
    } else {
        Write-Host "Run as administrator to also remove the firewall rule '$RuleName'." -ForegroundColor Yellow
    }
    Write-Host "The queue's jobs and settings in $AppDir are kept. Close its window to stop it now."
    return
}

# Node.js
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js is not installed. Install the LTS version from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), then run Install.cmd again." }
$version = (& node.exe --version).TrimStart("v")
if ([version]$version -lt [version]"22.13.0") { throw "Node.js $version is too old; version 22.13 or newer is needed (it has the built-in database). Install the current LTS from https://nodejs.org." }
Write-Host "Node.js $version found." -ForegroundColor Green

# Dependencies (exact versions from package-lock.json when present)
Push-Location $AppDir
try {
    if (Test-Path (Join-Path $AppDir "package-lock.json")) { & npm.cmd ci --omit=dev --no-audit --no-fund } else { & npm.cmd install --omit=dev --no-audit --no-fund }
    if ($LASTEXITCODE -ne 0) { throw "npm could not install the dependencies (see the messages above)." }
} finally { Pop-Location }
Write-Host "Dependencies installed." -ForegroundColor Green

# Config
$config = Join-Path $AppDir "config.json"
$needsEditing = $false
if (-not (Test-Path $config)) {
    Copy-Item (Join-Path $AppDir "config.example.json") $config
    $needsEditing = $true
}
$port = (Get-Content $config -Raw | ConvertFrom-Json).port
if (-not $port) { $port = 8080 }

# Auto-start at login
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($Shortcut)
$lnk.TargetPath = $StartCmd
$lnk.WorkingDirectory = $AppDir
$lnk.WindowStyle = 7          # minimized
$lnk.Description = "InDesign export queue server"
$lnk.Save()
Write-Host "The queue will start automatically when this Windows user logs in." -ForegroundColor Green

# Firewall (private network only)
if (Test-Admin) {
    Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Private, Domain | Out-Null
    Write-Host "Firewall opened for port $port on the office network." -ForegroundColor Green
} else {
    Write-Host "Not running as administrator, so the firewall was not changed. If designers can't open the page," -ForegroundColor Yellow
    Write-Host "right-click Install.cmd > Run as administrator once, or allow port $port for Node.js when Windows asks." -ForegroundColor Yellow
}

if ($needsEditing) {
    Write-Host ""
    Write-Host "IMPORTANT: edit config.json first (allowedRoots and pathMappings = your network drives)." -ForegroundColor Yellow
    Start-Process notepad.exe $config
    Write-Host "Save it, then double-click windows\start.cmd (or log out and in)."
    return
}

if (-not $NoStart) {
    Start-Process $StartCmd -WorkingDirectory $AppDir -WindowStyle Minimized
    Write-Host "Started. Designers open: http://$($env:COMPUTERNAME):$port/" -ForegroundColor Cyan
}
