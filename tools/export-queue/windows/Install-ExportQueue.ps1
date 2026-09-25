<#
  Sets up (or upgrades) the export queue on the export PC. Run it through Install.cmd: double-click.
  Running it again is always safe: it upgrades, adds newly mapped drives, repairs shortcuts and
  settings, and keeps config.json, the job history and the notification link.

  - Installs Node.js (22.13 or newer) with winget if it's missing
  - Stops a running queue gently (the export in InDesign finishes first), then upgrades it
  - Creates or updates config.json from this PC's mapped network drives (and the Mac names for them)
  - One Windows "Yes" (administrator) prompt, only when something needs it:
      firewall: lets office computers open the page (any network type, but only from the local network)
      removes Windows' "block Node.js" rules (made when someone clicked Cancel on its prompt)
      sets this PC to never sleep on mains power (a sleeping PC exports nothing)
  - Starts the queue at every login (hidden: no window to close by mistake), because InDesign needs
    the logged-in desktop: it can't run as a Windows service
  - Start menu folder "InDesign Export Queue" (Open, Check, Restart, Stop, Log folder) + desktop shortcut
  - Starts the queue and shows (and copies) the address designers open

  -Uninstall removes the shortcuts and the firewall rule and stops the queue; add -RemoveData to
  also delete config.json and the job history.
#>
param(
    [switch]$Uninstall,
    [switch]$RemoveData,
    [switch]$NoStart,
    [switch]$AdminSteps,            # internal: the elevated part (firewall, sleep)
    [switch]$RemoveFirewall,        # internal, with -AdminSteps
    [int]$Port = 0,                 # internal, with -AdminSteps
    [string]$ResultFile             # internal, with -AdminSteps
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. "$PSScriptRoot\common.ps1"

function Say([string]$Text, [string]$Color) { if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text } }
function Ok([string]$Text) { Say "  OK   $Text" Green }
function Warn([string]$Text) { Say "  !!   $Text" Yellow }

# ---------------------------------------------------------------- elevated part (one UAC prompt)

if ($AdminSteps) {
    $done = @(); $failed = @()
    try {
        Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        if (-not $RemoveFirewall) {
            # Profile Any: works even when Windows thinks the office network is "Public".
            # LocalSubnet: only computers on the office network, never the internet.
            New-NetFirewallRule -DisplayName $RuleName -Description "Lets office computers open the InDesign export queue." `
                -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any -RemoteAddress LocalSubnet | Out-Null
            $done += "firewall"
        } else { $done += "firewall-removed" }
    } catch { $failed += "firewall: $($_.Exception.Message)" }
    if (-not $RemoveFirewall) {
        try {
            $blocks = @(Get-NodeBlockRules)
            if ($blocks.Count) { $blocks | Remove-NetFirewallRule; $done += "unblocked" }
        } catch { $failed += "node block rules: $($_.Exception.Message)" }
        try {
            & powercfg.exe /change standby-timeout-ac 0
            & powercfg.exe /change hibernate-timeout-ac 0
            $done += "sleep"
        } catch { $failed += "sleep: $($_.Exception.Message)" }
    }
    if ($ResultFile) { Write-JsonFile $ResultFile ([pscustomobject]@{ done = $done; failed = $failed }) }
    exit 0
}

# Runs the admin part in its own elevated window: one "Yes". Returns the result, or $null if declined.
function Invoke-AdminSteps([int]$QueuePort, [switch]$Remove) {
    $result = Join-Path ([IO.Path]::GetTempPath()) ("export-queue-admin-" + [guid]::NewGuid().ToString("N") + ".json")
    $a = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -AdminSteps -Port $QueuePort -ResultFile `"$result`""
    if ($Remove) { $a += " -RemoveFirewall" }
    try {
        $p = Start-Process powershell.exe -ArgumentList $a -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    } catch {
        return $null        # "No" on the Windows prompt
    }
    try { $r = Read-JsonFile $result; Remove-Item -LiteralPath $result -Force -ErrorAction SilentlyContinue } catch { $r = $null }
    if (-not $r) { $r = [pscustomobject]@{ done = @(); failed = @("the administrator step didn't report back (exit code $($p.ExitCode))") } }
    return $r
}

# ---------------------------------------------------------------- run as the normal user

# Windows hides mapped drives from "Run as administrator" windows, and a queue started from one
# couldn't talk to the user's InDesign. So start again as the normal user, via Explorer.
if (-not $Uninstall -and (Test-Admin)) {
    $marker = Join-Path ([IO.Path]::GetTempPath()) "export-queue-relaunch.txt"
    $recent = (Test-Path -LiteralPath $marker) -and ((Get-Date) - (Get-Item -LiteralPath $marker).LastWriteTime).TotalSeconds -lt 120
    if (-not $recent) {
        [IO.File]::WriteAllText($marker, (Get-Date).ToString("o"))
        Say "This window runs as administrator. Starting the setup again as the normal user (that's needed for the network drives and InDesign)..." Yellow
        Start-Process explorer.exe -ArgumentList "`"$(Join-Path $WinDir 'Install.cmd')`""
        exit 0
    }
    # Explorer itself runs as administrator here (e.g. the built-in Administrator account): carry on.
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    Warn "This Windows account always runs as administrator. Continuing anyway."
}

trap {
    Say ""
    Say "Setup stopped: $($_.Exception.Message)" Red
    if ($script:stoppedQueue -and -not (Get-QueueHealth)) {
        Say "Starting the queue again..." Yellow
        try { [void](Start-Queue) } catch {}
    }
    exit 1
}

$paths = Get-ShortcutPaths

# ---------------------------------------------------------------- uninstall

if ($Uninstall) {
    Say "Removing the export queue from this PC..." Cyan
    if (Stop-Queue) { Ok "Stopped (waiting jobs are kept unless you also remove the data)." } else { Warn "Could not stop it. Restart the PC afterwards." }
    foreach ($p in @($paths.Startup, $paths.Desktop)) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force } }
    if (Test-Path -LiteralPath $paths.Menu) { Remove-Item -LiteralPath $paths.Menu -Recurse -Force }
    Ok "Removed the shortcuts (login, Start menu, desktop)."
    if (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) {
        Say "Windows will ask for permission to remove the firewall rule: click Yes." Cyan
        $r = Invoke-AdminSteps (Get-QueuePort) -Remove
        if ($r -and @($r.done) -contains "firewall-removed") { Ok "Removed the firewall rule." } else { Warn "The firewall rule '$RuleName' is still there (you clicked No). It's harmless; run Uninstall.cmd again to remove it." }
    }
    if ($RemoveData) {
        $data = Get-DataDir
        if (Test-Path -LiteralPath $data) { Remove-Item -LiteralPath $data -Recurse -Force }
        if (Test-Path -LiteralPath $ConfigFile) { Remove-Item -LiteralPath $ConfigFile -Force }
        Ok "Deleted the settings and the job history."
    } else {
        Say "  The settings (config.json) and the job history (data folder) are kept in $AppDir."
        Say "  Double-click Install.cmd to set it up again, or delete the folder to remove it completely."
    }
    exit 0
}

Say "Setting up the InDesign export queue in $AppDir" Cyan
Say ""

# Files from a downloaded zip are marked "from the internet"; Windows would ask before running each one.
try {
    Get-ChildItem -LiteralPath $AppDir -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\(node_modules|data)\\' } |
        Unblock-File -ErrorAction SilentlyContinue
} catch {}

# ---------------------------------------------------------------- Node.js

function Get-NodeVersion {
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { return $null }
    try { return [version]((& node.exe --version) -replace '^v', '') } catch { return $null }
}
$nodeVersion = Get-NodeVersion
if (-not $nodeVersion -or $nodeVersion -lt $MinNode) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw "Node.js 22.13 or newer is needed. Install the LTS version from https://nodejs.org, then double-click Install.cmd again."
    }
    Say "Installing Node.js LTS (free, the official OpenJS Foundation package; Windows may ask for permission)..." Cyan
    & winget.exe install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    $nodeVersion = Get-NodeVersion
    if (-not $nodeVersion -or $nodeVersion -lt $MinNode) {
        throw "Node.js could not be installed by itself. Install the LTS version from https://nodejs.org, then double-click Install.cmd again."
    }
}
Ok "Node.js $nodeVersion"

# ---------------------------------------------------------------- stop the running version (upgrade)

$script:stoppedQueue = $false
$running = Get-QueueHealth
if ($running) {
    Say "The export queue (version $($running.version)) is running: stopping it for the upgrade. Waiting jobs stay in the queue." Cyan
    if (-not (Stop-Queue)) { throw "The running export queue could not be stopped. Restart the PC, then double-click Install.cmd again." }
    $script:stoppedQueue = $true
    Ok "Stopped version $($running.version)"
} elseif (@(Get-LauncherProcesses).Count) {
    [void](Stop-Queue -Quiet)
    $script:stoppedQueue = $true
}

# ---------------------------------------------------------------- dependencies (only when they changed)

# Skipped when every library in package-lock.json is already there in the right version, so an
# upgrade doesn't need the internet (and can't be broken by a failed download).
function Test-DependenciesInstalled {
    $lockData = Read-JsonFile (Join-Path $AppDir "package-lock.json")
    if (-not $lockData -or -not $lockData.packages) { return $false }
    foreach ($p in $lockData.packages.PSObject.Properties) {
        if (-not $p.Name -or $p.Value.dev) { continue }
        $pkg = Join-Path $AppDir (Join-Path $p.Name "package.json")
        if (-not (Test-Path -LiteralPath $pkg)) { if ($p.Value.optional) { continue }; return $false }
        try { if ((Read-JsonFile $pkg).version -ne $p.Value.version) { return $false } } catch { return $false }
    }
    return $true
}
if (-not (Test-DependenciesInstalled)) {
    Say "Installing the web server library (Express, exact versions from package-lock.json)..." Cyan
    Push-Location -LiteralPath $AppDir
    try {
        & npm.cmd ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm could not install the web server library (see the messages above). Is this PC online?" }
    } finally { Pop-Location }
}
Ok "Web server library"

# ---------------------------------------------------------------- settings

$existing = Get-QueueConfig
$drives = @((Get-NetworkDrives))
if (-not $existing -and $drives.Count -eq 0) {
    Say ""
    Warn "No mapped network drive was found on this PC."
    Say "     In File Explorer, open a client drive, click the address bar and copy it (for example \\192.168.1.13\MG_Mega)."
    while ($true) {
        $answer = (Read-Host "     Paste the drive address here").Trim().Trim('"').TrimEnd("\")
        if ($answer -match '^\\\\[^\\]+\\[^\\]+' -and (Test-Path -LiteralPath $answer)) { $drives = @([pscustomobject]@{ Letter = $null; Unc = $answer }); break }
        Say "     That address can't be opened from this PC. Check it in File Explorer and try again." Yellow
    }
}
$merged = Merge-QueueConfig $existing $drives (Read-JsonFile $ExampleFile)
$config = $merged.Config
if (-not $existing) {
    Write-JsonFile $ConfigFile $config
    Ok "Settings created (config.json)"
} elseif ($merged.Added.Count -or -not ($existing.PSObject.Properties.Name -contains "drives")) {
    Copy-Item -LiteralPath $ConfigFile -Destination "$ConfigFile.bak" -Force
    Write-JsonFile $ConfigFile $config
    if ($merged.Added.Count) { Ok "Settings updated: added $($merged.Added -join ', ') (old settings saved as config.json.bak)" } else { Ok "Settings updated with the drive list (old settings saved as config.json.bak)" }
} else {
    Ok "Settings kept (config.json)"
}
Say "     Client drives: $((@($config.drives) | ForEach-Object { if ($_.letter) { "$($_.name) ($($_.letter))" } else { $_.name } }) -join ', ')"
$port = Get-QueuePort

# ---------------------------------------------------------------- firewall + sleep (one "Yes")

$fw = @(Get-FirewallProblems $port)
$sleepOk = Test-SleepNever
if ($fw.Count -or -not $sleepOk) {
    Say ""
    Say "Windows will now ask for permission (administrator). Click Yes. It opens the firewall for the office network and stops this PC from sleeping." Cyan
    $r = Invoke-AdminSteps $port
    if (-not $r) {
        Warn "You clicked No, so the firewall and sleep settings were not changed."
        Say "     Designers' computers may not be able to open the page, and exports stop while this PC sleeps."
        Say "     Double-click Install.cmd again any time and click Yes to fix it."
    } else {
        if (@($r.done) -contains "firewall") { Ok "Firewall: office computers can open the page (port $port, local network only)" }
        if (@($r.done) -contains "unblocked") { Ok "Removed Windows' rule that blocked Node.js" }
        if (@($r.done) -contains "sleep") { Ok "This PC no longer goes to sleep on mains power (the screen can still turn off)" }
        foreach ($f in @($r.failed)) { Warn "Not done: $f" }
    }
} else {
    Ok "Firewall and sleep settings"
}

# ---------------------------------------------------------------- shortcuts

$ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$control = Join-Path $WinDir "Control-ExportQueue.ps1"
$check = Join-Path $WinDir "Check-ExportQueue.ps1"
$address = Get-QueueAddress $config
$localUrl = "http://localhost:$port/"
# At login: start hidden (the shortcut window is minimized, and closes by itself).
New-Shortcut $paths.Startup $ps "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$control`" -Action Start -Quiet" "Starts the InDesign export queue in the background" 7
if (-not (Test-Path -LiteralPath $paths.Menu)) { [void](New-Item -ItemType Directory -Path $paths.Menu) }
New-UrlShortcut (Join-Path $paths.Menu "Open Export Queue.url") $localUrl
New-Shortcut (Join-Path $paths.Menu "Check Export Queue.lnk") $ps "-NoProfile -ExecutionPolicy Bypass -File `"$check`"" "Checks that everything the export queue needs is working"
New-Shortcut (Join-Path $paths.Menu "Restart Export Queue.lnk") $ps "-NoProfile -ExecutionPolicy Bypass -File `"$control`" -Action Restart" "Restarts the export queue (the export in InDesign finishes first)"
New-Shortcut (Join-Path $paths.Menu "Stop Export Queue.lnk") $ps "-NoProfile -ExecutionPolicy Bypass -File `"$control`" -Action Stop" "Stops the export queue until the next login (the export in InDesign finishes first)"
$logs = Join-Path (Get-DataDir) "logs"
[void][IO.Directory]::CreateDirectory($logs)
New-Shortcut (Join-Path $paths.Menu "Export Queue log folder.lnk") (Join-Path $env:SystemRoot "explorer.exe") "`"$logs`"" "The export queue's log files"
New-UrlShortcut $paths.Desktop $localUrl
Ok "Starts by itself at login (in the background); Start menu folder '$MenuName'; desktop shortcut 'Export Queue'"

# ---------------------------------------------------------------- start

Say ""
if ($NoStart) {
    Say "Not started (-NoStart)."
    exit 0
}
Say "Starting the export queue..." Cyan
$h = Start-Queue 40
if (-not $h) {
    throw "The export queue didn't start. Start menu > InDesign Export Queue > Check Export Queue shows why (the log folder has the details)."
}
$script:stoppedQueue = $false
Ok "Running (version $($h.version))"
if ($h.indesign -and $h.indesign.state -eq "unreachable") { Warn "InDesign can't be reached yet: open InDesign on this PC. Jobs wait until it can." }
foreach ($d in @($h.drives)) { if ($d -and $d.PSObject.Properties.Name -contains "ok" -and -not $d.ok) { Warn "Drive $($d.name) can't be opened from this PC right now. Check it's connected in File Explorer." } }

Say ""
Say "=====================================================================" Cyan
Say " Designers open this address in their browser (bookmark it):" Cyan
Say ""
Say "     $($address.Url)" Green
Say ""
try { Set-Clipboard -Value $address.Url; Say " (It's copied: paste it into an email or chat to the staff.)" } catch {}
if ($address.Dhcp) {
    Say " This address was handed out by the router, so it could change one day." Yellow
    Say " Ask whoever manages the router to reserve this address for the export PC so it never changes." Yellow
}
Say " On this PC: the desktop shortcut 'Export Queue', or $localUrl"
Say "=====================================================================" Cyan
