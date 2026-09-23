<#
  Installs the InDesign export notifier on this PC. Run it through Install.cmd (double-click).

  - Picks a private, random notification channel (or reuses the one from a previous install)
  - Copies export-notify.jsx into the "startup scripts" folder of every InDesign version on this PC
  - Sends a test notification
  - Puts a "Export notifications" link on the desktop to share with staff

  Works with Windows PowerShell 5.1 (built into Windows 10/11) and PowerShell 7.
#>
param(
    [string]$Topic,                        # reuse a specific channel name
    [string]$Server = "https://ntfy.sh",   # or your own ntfy server
    [string]$Token = "",                   # access token, only for a private server
    [switch]$HideFileNames,                # notifications say "2 files" instead of listing names
    [switch]$Uninstall,
    [switch]$NoTest,
    [string]$AppData = $env:APPDATA,       # overridable for testing
    [string]$Desktop = [Environment]::GetFolderPath("Desktop")
)

$ErrorActionPreference = "Stop"
$ScriptName = "export-notify.jsx"
$SettingsDir = Join-Path $AppData "InDesignExportNotify"
$TopicFile = Join-Path $SettingsDir "channel.txt"
$Source = Join-Path $PSScriptRoot $ScriptName
$Server = $Server.TrimEnd("/")

function Say($text, $color = "Gray") { Write-Host $text -ForegroundColor $color }

function Find-StartupFolders {
    # %APPDATA%\Adobe\InDesign\Version 20.0\en_US\Scripts\startup scripts
    $root = Join-Path $AppData "Adobe\InDesign"
    if (-not (Test-Path $root)) { return @() }
    $folders = @()
    foreach ($version in Get-ChildItem $root -Directory -Filter "Version *") {
        foreach ($locale in Get-ChildItem $version.FullName -Directory) {
            if (Test-Path (Join-Path $locale.FullName "Scripts")) {
                $folders += Join-Path $locale.FullName "Scripts\startup scripts"
            }
        }
    }
    return $folders
}

function New-Topic {
    $chars = "abcdefghijkmnpqrstuvwxyz23456789".ToCharArray()
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $suffix = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
    return "indesign-exports-$suffix"
}

$folders = @(Find-StartupFolders)

if ($Uninstall) {
    foreach ($f in $folders) {
        $target = Join-Path $f $ScriptName
        if (Test-Path $target) { Remove-Item $target; Say "Removed $target" }
    }
    Say "Uninstalled. Restart InDesign to finish." Green
    return
}

if (-not (Test-Path $Source)) { throw "Can't find $ScriptName next to this installer. Keep the files together in one folder." }
if ($folders.Count -eq 0) {
    Say "InDesign's settings folder wasn't found for this Windows user." Yellow
    Say "Open InDesign once (as this user), close it, then run Install.cmd again." Yellow
    exit 1
}

# Channel: explicit > previous install > new random one.
if (-not $Topic -and (Test-Path $TopicFile)) { $Topic = (Get-Content $TopicFile -Raw).Trim() }
if (-not $Topic) { $Topic = New-Topic }
if ($Topic -notmatch '^[A-Za-z0-9_-]{16,64}$') { throw "Channel name must be 16-64 letters, digits, - or _." }
New-Item -ItemType Directory -Force $SettingsDir | Out-Null
[IO.File]::WriteAllText($TopicFile, $Topic)

# Fill in the settings and install into every InDesign version found.
$jsx = [IO.File]::ReadAllText($Source)
$jsx = $jsx -replace 'server: "[^"]*"', ('server: "' + $Server + '"')
$jsx = $jsx -replace 'topic: "[^"]*"', ('topic: "' + $Topic + '"')
$jsx = $jsx -replace 'token: "[^"]*"', ('token: "' + $Token + '"')
if ($HideFileNames) { $jsx = $jsx -replace 'showFileNames: true', 'showFileNames: false' }
$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($f in $folders) {
    New-Item -ItemType Directory -Force $f | Out-Null
    [IO.File]::WriteAllText((Join-Path $f $ScriptName), $jsx, $utf8)
    Say "Installed into $f"
}

# Staff link, as a desktop shortcut and on the clipboard.
$link = "$Server/$Topic"
$shortcut = Join-Path $Desktop "Export notifications.url"
[IO.File]::WriteAllText($shortcut, "[InternetShortcut]`r`nURL=$link`r`n")
try { Set-Clipboard -Value $link } catch {}

if (-not $NoTest) {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $body = [Text.Encoding]::UTF8.GetBytes("The export notifier is installed on $([Environment]::MachineName).")
        $headers = @{ Title = "Test: export notifications are working"; Tags = "tada" }
        if ($Token) { $headers.Authorization = "Bearer $Token" }
        Invoke-RestMethod -Method Post -Uri "$Server/$Topic" -Body $body -TimeoutSec 20 -Headers $headers | Out-Null
        Say "Test notification sent." Green
    } catch {
        Say "Couldn't reach $Server ($($_.Exception.Message)). Check this PC's internet access." Yellow
    }
}

if (Get-Process -Name "InDesign" -ErrorAction SilentlyContinue) {
    Say "InDesign is open: restart it to start the notifier." Yellow
}

Say ""
Say "Done. Share this link with staff (it's on your clipboard and on the desktop):" Green
Say "  $link" Cyan
Say "Staff open it in Chrome or Edge, click Allow, then Install. See STAFF.md."
