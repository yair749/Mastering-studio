<#
  One-time setup of the export queue on the export PC. Run through "Install.cmd".

  - Installs Node.js (22.13 or newer) with winget if it's missing
  - Installs the one dependency (Express) with npm
  - Creates config.json by itself: finds this PC's network drives, allows them, and maps the
    names Macs use for them (/Volumes/<share>); asks for the drive only if none is found
  - Starts the queue at every login of this Windows user (Startup folder), because InDesign
    needs the user's desktop session: it can't run as a background Windows service
  - Opens the port in Windows Firewall for the private (office) network, if run as administrator
  - Starts the queue now

  -Uninstall removes the auto-start and the firewall rule (jobs and settings are kept).
#>
param(
    [switch]$Uninstall,
    [switch]$NoStart,
    [object[]]$TestDrives               # for testing the settings step: @{ Letter = "P:"; Unc = "\\NAS\Projects" }
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

# Node.js: install it if missing (winget is built into Windows 10/11)
function Get-NodeVersion {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { return $null }
    return [version](& node.exe --version).TrimStart("v")
}
$version = Get-NodeVersion
if (-not $version -or $version -lt [version]"22.13.0") {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw "Node.js 22 or newer is needed. Install the LTS version from https://nodejs.org, then run Install.cmd again."
    }
    Write-Host "Installing Node.js (free, from the official OpenJS Foundation package)..." -ForegroundColor Cyan
    & winget.exe install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    $version = Get-NodeVersion
    if (-not $version -or $version -lt [version]"22.13.0") {
        throw "Node.js could not be installed automatically. Install the LTS version from https://nodejs.org, then run Install.cmd again."
    }
}
Write-Host "Node.js $version ready." -ForegroundColor Green

# Dependencies (exact versions from package-lock.json when present)
Push-Location $AppDir
try {
    if (Test-Path (Join-Path $AppDir "package-lock.json")) { & npm.cmd ci --omit=dev --no-audit --no-fund } else { & npm.cmd install --omit=dev --no-audit --no-fund }
    if ($LASTEXITCODE -ne 0) { throw "npm could not install the dependencies (see the messages above)." }
} finally { Pop-Location }
Write-Host "Dependencies installed." -ForegroundColor Green

# Config: written automatically from this PC's network drives.
function Get-NetworkDrives {
    if ($TestDrives) { return $TestDrives }
    @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType = 4" -ErrorAction SilentlyContinue |
        Where-Object { $_.ProviderName } |
        ForEach-Object { [pscustomobject]@{ Letter = $_.DeviceID; Unc = $_.ProviderName.TrimEnd("\") } })
}

function New-QueueConfig($drives) {
    $roots = New-Object System.Collections.Generic.List[string]
    $maps = New-Object System.Collections.Generic.List[object]
    foreach ($d in $drives) {
        if ($d.Unc) {
            $unc = $d.Unc.TrimEnd("\")
            if (-not $roots.Contains($unc)) {
                $roots.Add($unc)
                # A Mac shows \\SERVER\Share as /Volumes/Share (smb://server/Share when typed).
                $share = ($unc -split "\\")[-1]
                $server = ($unc -split "\\" | Where-Object { $_ })[0]
                $maps.Add([ordered]@{ from = "/Volumes/$share"; to = $unc })
                $maps.Add([ordered]@{ from = "smb://$server/$share"; to = $unc })
            }
        }
        if ($d.Letter) {
            $letter = $d.Letter.TrimEnd("\") + "\"
            if (-not $roots.Contains($letter)) { $roots.Add($letter) }
        }
    }
    # Start from the example's defaults, replacing only the drive settings.
    $example = Get-Content (Join-Path $AppDir "config.example.json") -Raw | ConvertFrom-Json
    $out = [ordered]@{}
    foreach ($prop in $example.PSObject.Properties) { $out[$prop.Name] = $prop.Value }
    $out["allowedRoots"] = [object[]]$roots.ToArray()
    $out["pathMappings"] = [object[]]$maps.ToArray()
    return [pscustomobject]$out
}

$config = Join-Path $AppDir "config.json"
if (-not (Test-Path $config)) {
    $drives = @(Get-NetworkDrives)
    if ($drives.Count -eq 0) {
        Write-Host ""
        Write-Host "No mapped network drive was found on this PC." -ForegroundColor Yellow
        Write-Host "In File Explorer, open the shared projects drive, click the address bar and copy it (e.g. \\NAS\Projects)."
        while ($true) {
            $answer = (Read-Host "Paste the projects drive address here").Trim().Trim('"').TrimEnd("\")
            if ($answer -match '^\\\\[^\\]+\\[^\\]+' -and (Test-Path $answer)) { $drives = @([pscustomobject]@{ Letter = $null; Unc = $answer }); break }
            if ($answer -match '^[A-Za-z]:$' -and (Test-Path "$answer\")) { $drives = @([pscustomobject]@{ Letter = $answer; Unc = $null }); break }
            Write-Host "That address can't be opened from this PC. Check it in File Explorer and try again." -ForegroundColor Yellow
        }
    }
    $settings = New-QueueConfig $drives
    [IO.File]::WriteAllText($config, ($settings | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Settings written. Jobs may use these drives:" -ForegroundColor Green
    foreach ($r in $settings.allowedRoots) { Write-Host "   $r" }
    Write-Host "Mac paths understood automatically:" -ForegroundColor Green
    foreach ($m in $settings.pathMappings | Where-Object { $_.from -like "/Volumes/*" }) { Write-Host "   $($m.from)  ->  $($m.to)" }
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

if (-not $NoStart) {
    Start-Process $StartCmd -WorkingDirectory $AppDir -WindowStyle Minimized
    Write-Host "Started. Designers open: http://$($env:COMPUTERNAME):$port/" -ForegroundColor Cyan
}
