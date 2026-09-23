<#
  One-time setup of the export notification receiver on a staff PC (run through Install.cmd in this folder).

  - Copies the receiver to %APPDATA%\ExportReceiver
  - Starts it silently at every login (shortcut in this user's Startup folder)
  - Starts it now (the receiver shows a welcome notification on its first start)

  The channel comes from settings.txt next to this file (the export PC's installer creates this
  folder with it filled in). Without it, you're asked to paste the "Export notifications" link.
#>
param(
    [switch]$Uninstall,
    [string]$Dir = (Join-Path $env:APPDATA "ExportReceiver"),
    [string]$StartupFolder = [Environment]::GetFolderPath("Startup"),
    [switch]$NoStart,
    [string]$PowerShellExe                 # default: Windows PowerShell 5.1 (overridable for testing)
)

$ErrorActionPreference = "Stop"
$Shortcut = Join-Path $StartupFolder "Export notifications.lnk"
$Receiver = Join-Path $Dir "export-receiver.ps1"
trap { Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }

function Stop-Receiver {
    try {
        Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
            Where-Object { $_.CommandLine -like "*export-receiver.ps1*" } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch {}   # can't list processes: a receiver already running just keeps running (only one runs at a time)
}

if ($Uninstall) {
    Stop-Receiver
    foreach ($f in @($Shortcut, [IO.Path]::ChangeExtension($Shortcut, ".cmd"))) { if (Test-Path $f) { Remove-Item $f } }
    if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force }
    Write-Host "Export notifications removed from this computer." -ForegroundColor Green
    return
}

# Channel: settings.txt next to this installer, or the link pasted by the user.
$settingsSource = Join-Path $PSScriptRoot "settings.txt"
if (Test-Path $settingsSource) {
    $settingsText = [IO.File]::ReadAllText($settingsSource)
} else {
    $link = (Read-Host "Paste the 'Export notifications' link (https://ntfy.sh/...)").Trim()
    if ($link -notmatch '^(https?://[^/\s]+)/([A-Za-z0-9_-]{16,64})/?$') { throw "That doesn't look like the notifications link." }
    $settingsText = "server=$($Matches[1])`r`ntopic=$($Matches[2])`r`n"
}
if ($settingsText -notmatch '(?m)^topic=[A-Za-z0-9_-]{16,64}\s*$') { throw "settings.txt has no valid topic= line." }

Stop-Receiver
New-Item -ItemType Directory -Force $Dir | Out-Null
Copy-Item (Join-Path $PSScriptRoot "export-receiver.ps1") $Receiver -Force
[IO.File]::WriteAllText((Join-Path $Dir "settings.txt"), $settingsText)

# Windows PowerShell 5.1 explicitly: it has the Windows notification API (PowerShell 7 doesn't).
$powershell = if ($PowerShellExe) { $PowerShellExe } else { Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe" }
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Receiver`""
try {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Shortcut)
    $lnk.TargetPath = $powershell
    $lnk.Arguments = $arguments
    $lnk.WindowStyle = 7                   # minimized; the receiver hides itself straight away
    $lnk.Description = "Shows a notification when an InDesign export finishes"
    $lnk.Save()
} catch {
    # Windows Script Host missing or disabled: a start-up file does the same (may flash a window at login).
    [IO.File]::WriteAllText([IO.Path]::ChangeExtension($Shortcut, ".cmd"), "@start `"`" /min `"$powershell`" $arguments`r`n")
}
Write-Host "Starts automatically at every login." -ForegroundColor Green

if (-not $NoStart) {
    Start-Process $powershell -ArgumentList $arguments -WindowStyle Hidden   # shows a welcome notification on its first start
    Write-Host "Running now. You should see an 'Export notifications are on' pop-up." -ForegroundColor Green
}
