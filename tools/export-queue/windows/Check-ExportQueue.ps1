<#
  Checks everything the export queue needs, in plain words, with a fix for each problem.
  Start menu > InDesign Export Queue > Check Export Queue (or double-click windows\Check.cmd).
  Only reads: it changes nothing.
#>
param([switch]$NoPause)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
. "$PSScriptRoot\common.ps1"

$script:problems = 0
function Pass([string]$Text) { Write-Host "  [OK]  $Text" -ForegroundColor Green }
function Fail([string]$Text, [string]$Fix) {
    $script:problems++
    Write-Host "  [!!]  $Text" -ForegroundColor Red
    if ($Fix) { Write-Host "        Fix: $Fix" -ForegroundColor Yellow }
}
function Info([string]$Text) { Write-Host "        $Text" -ForegroundColor Gray }

$install = "double-click Install.cmd in $WinDir"
Write-Host ""
Write-Host "InDesign export queue: checking this PC" -ForegroundColor Cyan
Write-Host ""

# Node.js
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
    Fail "Node.js isn't installed." $install
} else {
    $v = $null
    try { $v = [version]((& node.exe --version) -replace '^v', '') } catch {}
    if ($v -and $v -ge $MinNode) { Pass "Node.js $v" } else { Fail "Node.js $v is too old (22.13 or newer is needed)." $install }
}

# Settings
$config = $null
try { $config = Get-QueueConfig } catch { Fail "config.json can't be read: $($_.Exception.Message)" "Open $ConfigFile in Notepad and fix it, or rename it and $install (it makes a new one)." }
if (-not $config -and (Test-Path -LiteralPath $ConfigFile) -eq $false) { Fail "There are no settings (config.json)." $install }
$port = Get-QueuePort

# Running
$h = Get-QueueHealth
if ($h) {
    Pass "The export queue is running (version $($h.version), port $port)"
} else {
    Fail "The export queue isn't running." "Start menu > InDesign Export Queue > Restart Export Queue. If it stops again, look at the newest lines of launcher.log and server.log in $(Join-Path (Get-DataDir) 'logs')."
}

# InDesign
if ($h) {
    Write-Host "  ...   Asking InDesign for its PDF presets (the first time after starting InDesign this can take a few minutes)..." -ForegroundColor Gray
    try {
        $r = Invoke-Queue POST "/api/presets/refresh" 300
        $count = @($r.presets).Count
        Pass "InDesign answers ($($r.indesignVersion); $count PDF presets)"
    } catch {
        $msg = $_.Exception.Message
        try { $msg = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch {}
        Fail "InDesign can't be reached: $msg" "Open InDesign on this PC (logged in as the same Windows user), close any message it shows, then check again."
    }
    if ($h.worker.state -eq "paused") { Info "Jobs are waiting for InDesign: $($h.worker.pausedReason)" }
    if ($h.worker.state -eq "draining") { Info "The queue was told to finish the current job and not start new ones. Restart Export Queue to go back to normal." }
}

# Drives
$drives = @()
if ($h -and $h.drives) { $drives = @($h.drives) } elseif ($config) { $drives = @($config.drives) }
foreach ($d in $drives) {
    if (-not $d) { continue }
    $ok = $false
    if ($d.PSObject.Properties.Name -contains "ok") { $ok = [bool]$d.ok } else { $ok = Test-Path -LiteralPath $d.path }
    if ($ok) { Pass "Drive $($d.name) ($($d.path))" } else { Fail "Drive $($d.name) can't be opened from this PC ($($d.path))." "Open it in File Explorer; if Windows asks for a password, enter it and tick 'Remember my credentials'. Check the file server is switched on." }
}
if (-not $drives.Count) { Fail "No client drives are set up." "Map the client drives in File Explorer, then $install" }

# Firewall
$fw = @(Get-FirewallProblems $port)
if ($fw.Count) { Fail "Firewall: $($fw -join '; '). Office computers may not be able to open the page." "$install and click Yes when Windows asks for permission." } else { Pass "Firewall lets office computers in (port $port, local network only)" }

# Address
$address = Get-QueueAddress $config
if ($address.Ip) {
    Pass "Designers open: $($address.Url)"
    if ($address.Dhcp) { Info "The router hands out this address, so it could change. Ask whoever manages the router to reserve it for the export PC." }
} else {
    Fail "This PC has no office network address right now." "Check the network cable or Wi-Fi."
}
if ($h -and $h.lanUrl -and $address.Ip -and ($h.lanUrl -ne $address.Url)) { Info "The queue itself shows the address $($h.lanUrl) in the page footer." }

# Start at login
$paths = Get-ShortcutPaths
if (Test-Path -LiteralPath $paths.Startup) { Pass "Starts by itself when this Windows user logs in" } else { Fail "It won't start by itself after a restart." $install }

# Sleep
if (Test-SleepNever) { Pass "This PC doesn't go to sleep on mains power" } else { Fail "This PC goes to sleep after a while, and a sleeping PC exports nothing." "$install and click Yes when Windows asks (it sets sleep to Never)." }

Write-Host ""
if ($script:problems -eq 0) {
    Write-Host "Everything is working." -ForegroundColor Green
} else {
    Write-Host "$($script:problems) problem(s) found. Follow the Fix lines above, then check again." -ForegroundColor Yellow
}
Write-Host ""
if (-not $NoPause) { [void](Read-Host "Press Enter to close") }
exit $script:problems
