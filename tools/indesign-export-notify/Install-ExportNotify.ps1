<#
  Installs the InDesign export notifier for this Windows user. Run it through Install.cmd (double-click).

  - Picks a private, random notification channel (or keeps the one from a previous install)
  - Copies the notifier into %APPDATA%\InDesignExportNotify\app and into the "startup scripts"
    folder of every InDesign version on this PC
  - Sends a test notification through the real sender
  - Puts the staff link (and your status link) on the desktop
  - Adds a daily self-check (Windows Task Scheduler) that re-installs into new InDesign
    versions after upgrades and posts "Daily check OK" to the status channel

  Works with Windows PowerShell 5.1 (built into Windows 10/11) and PowerShell 7.
#>
param(
    [string]$Topic,                        # use a specific channel name
    [string]$Server,                       # default https://ntfy.sh, or your own ntfy server
    [string]$Token,                        # access token, only for a private server
    [switch]$HideFileNames,                # notifications say "Done (2)" instead of listing names
    [switch]$ShowFileNames,                # undo -HideFileNames
    [switch]$Repair,                       # quiet mode used by the daily self-check
    [switch]$Uninstall,
    [switch]$NoTest,
    [switch]$NoScheduledTask,
    [string]$AppData = $env:APPDATA,       # overridable for testing
    [string]$Desktop = [Environment]::GetFolderPath("Desktop")
)

$ErrorActionPreference = "Stop"
$ScriptName = "export-notify.jsx"
$TaskName = "InDesign Export Notifier daily check"
$Dir = Join-Path $AppData "InDesignExportNotify"
$AppDir = Join-Path $Dir "app"
$Outbox = Join-Path $Dir "outbox"
$SettingsFile = Join-Path $Dir "settings.txt"
$LegacyTopicFile = Join-Path $Dir "channel.txt"
$Log = Join-Path $Dir "notifier.log"
$AppFiles = @("export-notify.jsx", "send-notification.ps1", "Install-ExportNotify.ps1")

function Say($text, $color = "Gray") {
    if ($Repair) { Write-Log $text } else { Write-Host $text -ForegroundColor $color }
}

function Write-Log($text) {
    try {
        New-Item -ItemType Directory -Force $Dir | Out-Null
        Add-Content $Log ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $text) -Encoding UTF8
    } catch {}
}

# Any unexpected error: log it (the daily check has no window) and show it when run by hand.
trap {
    Write-Log "Installer error: $($_.Exception.Message)"
    if (-not $Repair) { Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red }
    if ($Repair -and $statusTopic) {
        Send-Notification $statusTopic "Daily check failed" "warning" "high" `
            "The notifier's daily check stopped with an error: $($_.Exception.Message). Run Install.cmd on the export PC." 3 | Out-Null
    }
    exit 1
}

function Find-StartupFolders {
    # %APPDATA%\Adobe\InDesign\Version 21.0\en_US\Scripts\startup scripts
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
    return "indesign-exports-" + (-join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] }))
}

function Read-Settings {
    $s = @{}
    if (Test-Path $SettingsFile) {
        foreach ($line in Get-Content $SettingsFile) {
            $eq = $line.IndexOf("=")
            if ($eq -gt 0) { $s[$line.Substring(0, $eq)] = $line.Substring($eq + 1) }
        }
    } elseif (Test-Path $LegacyTopicFile) {
        $s.topic = (Get-Content $LegacyTopicFile -Raw).Trim()   # installs from before settings.txt
    }
    return $s
}

function Send-Notification($topic, $title, $tags, $priority, $body, $attempts) {
    New-Item -ItemType Directory -Force $Outbox | Out-Null
    $file = Join-Path $Outbox ("{0}-install.msg" -f [DateTime]::Now.Ticks)
    $text = "server=$($settings.server)`ntopic=$topic`ntoken=$($settings.token)`ntitle=$title`ntags=$tags`npriority=$priority`n---`n$body"
    [IO.File]::WriteAllText($file, $text, (New-Object System.Text.UTF8Encoding($false)))
    try {
        & (Join-Path $AppDir "send-notification.ps1") -MessageFile $file -Attempts $attempts
        return $LASTEXITCODE -eq 0
    } catch {
        Write-Log "Sender error: $($_.Exception.Message)"
        return $false
    }
}

$folders = @(Find-StartupFolders)

if ($Uninstall) {
    foreach ($f in $folders) {
        $target = Join-Path $f $ScriptName
        if (Test-Path $target) { Remove-Item $target; Say "Removed $target" }
    }
    try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop; Say "Removed the daily check." } catch {}
    if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
    Say "Uninstalled. Your channel is kept in $SettingsFile, so reinstalling keeps the same link." Green
    Say "Restart InDesign to finish." Green
    return
}

# Settings: command line > previous install > defaults.
$settings = Read-Settings
if ($Topic) { $settings.topic = $Topic }
if ($Server) { $settings.server = $Server }
if ($PSBoundParameters.ContainsKey("Token")) { $settings.token = $Token }
if ($HideFileNames) { $settings.showFileNames = "false" }
if ($ShowFileNames) { $settings.showFileNames = "true" }
if (-not $settings.topic) { $settings.topic = New-Topic }
if (-not $settings.server) { $settings.server = "https://ntfy.sh" }
if (-not $settings.token) { $settings.token = "" }
if (-not $settings.showFileNames) { $settings.showFileNames = "true" }
$settings.server = $settings.server.TrimEnd("/")
if ($settings.topic -notmatch '^[A-Za-z0-9_-]{16,57}$') { throw "Channel name must be 16-57 letters, digits, - or _." }
$statusTopic = $settings.topic + "-status"

# Keep a copy of the notifier in %APPDATA% so the daily check can re-install it after upgrades.
New-Item -ItemType Directory -Force $AppDir | Out-Null
if ((Resolve-Path $PSScriptRoot).Path -ne (Resolve-Path $AppDir).Path) {
    foreach ($name in $AppFiles) {
        $src = Join-Path $PSScriptRoot $name
        if (-not (Test-Path $src)) { throw "Can't find $name next to this installer. Keep the files together in one folder." }
        Copy-Item $src (Join-Path $AppDir $name) -Force
    }
}
[IO.File]::WriteAllText($SettingsFile, (($settings.Keys | Sort-Object | ForEach-Object { "$_=$($settings[$_])" }) -join "`r`n"))

if ($folders.Count -eq 0) {
    Say "InDesign's settings folder wasn't found for this Windows user." Yellow
    Say "Open InDesign once (as this user), close it, then run Install.cmd again." Yellow
    if ($Repair) { exit 0 } else { exit 1 }
}

# Fill in the settings and install into every InDesign version found (only rewrite changed files).
$jsx = [IO.File]::ReadAllText((Join-Path $AppDir $ScriptName))
$jsx = $jsx -replace 'server: "[^"]*"', ('server: "' + $settings.server + '"')
$jsx = $jsx -replace 'topic: "[^"]*"', ('topic: "' + $settings.topic + '"')
$jsx = $jsx -replace 'token: "[^"]*"', ('token: "' + $settings.token + '"')
$jsx = $jsx -replace 'showFileNames: (true|false)', ('showFileNames: ' + $settings.showFileNames)
$utf8 = New-Object System.Text.UTF8Encoding($false)
$changed = @()
$failed = @()
foreach ($f in $folders) {
    # One broken folder must not stop the other InDesign versions from being installed.
    try {
        $target = Join-Path $f $ScriptName
        if ((Test-Path $target) -and ([IO.File]::ReadAllText($target) -eq $jsx)) { continue }
        New-Item -ItemType Directory -Force $f | Out-Null
        [IO.File]::WriteAllText($target, $jsx, $utf8)
        $changed += $f
        Say "Installed into $f"
    } catch {
        $failed += "$f ($($_.Exception.Message))"
        Write-Log "Could not install into $f - $($_.Exception.Message)"
        Say "Could not install into $f - $($_.Exception.Message)" Yellow
    }
}

$versions = ($folders | ForEach-Object { ($_ -split '[\\/]') | Where-Object { $_ -like "Version *" } } | Sort-Object -Unique) -join ", "

if ($Repair) {
    if ($failed.Count) {
        Send-Notification $statusTopic "Daily check found a problem" "warning" "high" `
            "Could not install the notifier into: $($failed -join '; '). Run Install.cmd on the export PC." 7 | Out-Null
    } elseif ($changed.Count) {
        Send-Notification $statusTopic "Notifier installed into a new InDesign version" "wrench" "default" `
            "Installed into: $($changed -join '; '). Restart InDesign if it is open." 7 | Out-Null
    } else {
        Send-Notification $statusTopic "Daily check OK" "green_circle" "min" `
            "Notifier is installed in InDesign $versions on $([Environment]::MachineName)." 7 | Out-Null
    }
    exit 0
}

# Links: staff channel (share this) and status channel (just for you).
$link = "$($settings.server)/$($settings.topic)"
$statusLink = "$($settings.server)/$statusTopic"
[IO.File]::WriteAllText((Join-Path $Desktop "Export notifications.url"), "[InternetShortcut]`r`nURL=$link`r`n")
[IO.File]::WriteAllText((Join-Path $Desktop "Export notifier status (admin).url"), "[InternetShortcut]`r`nURL=$statusLink`r`n")
try { Set-Clipboard -Value $link } catch {}

if (-not $NoScheduledTask) {
    try {
        $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument `
            ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $AppDir "Install-ExportNotify.ps1") + '" -Repair')
        $trigger = New-ScheduledTaskTrigger -Daily -At "09:00"
        $taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $taskSettings -Force | Out-Null
        Say "Daily self-check scheduled (09:00, or at next start-up if the PC was off)."
    } catch {
        Say "Couldn't schedule the daily self-check ($($_.Exception.Message))." Yellow
        Say "Everything else works; re-run Install.cmd after InDesign upgrades." Yellow
    }
}

if (-not $NoTest) {
    if (Send-Notification $settings.topic "Test: export notifications are working" "tada" "default" `
            "The export notifier is installed on $([Environment]::MachineName) (InDesign $versions)." 1) {
        Say "Test notification sent." Green
        Send-Notification $statusTopic "Notifier installed" "green_circle" "min" `
            "Installed in InDesign $versions on $([Environment]::MachineName)." 1 | Out-Null
    } else {
        Say "Couldn't reach $($settings.server). Check this PC's internet access; details in $Log" Yellow
    }
}

if (Get-Process | Where-Object { $_.ProcessName -like "*InDesign*" }) {
    Say "InDesign is open: close and reopen it to start the notifier." Yellow
}

Say ""
Say "Done. Share this link with staff (it's on your clipboard and on the desktop):" Green
Say "  $link" Cyan
Say "Your status link (only for you, shows 'Notifier running' / 'Daily check OK'):" Green
Say "  $statusLink" Cyan
