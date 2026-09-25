<#
  Shared by the export queue's Windows scripts (Install, launcher, Check, the Start menu controls).
  Dot-source it: . "$PSScriptRoot\common.ps1"
  Windows PowerShell 5.1 compatible: no ??, no ternary, no -AsHashtable.
#>

$AppDir = Split-Path -Parent $PSScriptRoot
$WinDir = $PSScriptRoot
$ConfigFile = Join-Path $AppDir "config.json"
$ExampleFile = Join-Path $AppDir "config.example.json"
$Launcher = Join-Path $WinDir "launcher.ps1"
$RuleName = "InDesign Export Queue"
$MenuName = "InDesign Export Queue"
$MinNode = [version]"22.13.0"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
# Names of network adapters that are never the office network.
$VirtualAdapterPattern = "vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Tailscale|ZeroTier|Bluetooth"

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---------------------------------------------------------------- settings

function Read-JsonFile([string]$File) {
    if (-not (Test-Path -LiteralPath $File)) { return $null }
    # ReadAllText drops a UTF-8 byte order mark (Notepad adds one).
    $text = [IO.File]::ReadAllText($File)
    if (-not $text.Trim()) { return $null }
    return $text | ConvertFrom-Json
}

function Write-JsonFile([string]$File, $Value) {
    $json = $Value | ConvertTo-Json -Depth 10
    $tmp = "$File.tmp"
    [IO.File]::WriteAllText($tmp, $json, $Utf8NoBom)
    Move-Item -LiteralPath $tmp -Destination $File -Force
}

function Get-QueueConfig { return Read-JsonFile $ConfigFile }

function Get-QueuePort {
    try { $c = Get-QueueConfig } catch { $c = $null }
    if ($c -and $c.port) { return [int]$c.port }
    return 8080
}

function Get-DataDir {
    try { $c = Get-QueueConfig } catch { $c = $null }
    if ($c -and $c.dataDir) {
        if ([IO.Path]::IsPathRooted($c.dataDir)) { return $c.dataDir }
        return (Join-Path $AppDir $c.dataDir)
    }
    return (Join-Path $AppDir "data")
}

# ---------------------------------------------------------------- network drives

# "\\server\share" from "\\server\share\sub\folder".
function Get-ShareRoot([string]$Unc) {
    $parts = @($Unc.TrimStart("\") -split "\\" | Where-Object { $_ })
    if ($parts.Count -lt 2) { return $Unc.TrimEnd("\") }
    return "\\" + $parts[0] + "\" + $parts[1]
}

# The mapped network drives of this Windows user: [{ Letter = "M:"; Unc = "\\192.168.1.13\MG_Mega" }].
# Also reads the registry, which lists drives that are mapped but not connected right now, and
# which elevated windows can still see.
function Get-NetworkDrives {
    $found = [ordered]@{}
    try {
        foreach ($d in @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType = 4" -ErrorAction Stop)) {
            if ($d.ProviderName) { $found[$d.DeviceID.ToUpper()] = $d.ProviderName.TrimEnd("\") }
        }
    } catch {}
    try {
        foreach ($key in @(Get-ChildItem -LiteralPath "HKCU:\Network" -ErrorAction Stop)) {
            $letter = ($key.PSChildName + ":").ToUpper()
            $remote = (Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop).RemotePath
            if ($remote -and -not $found.Contains($letter)) { $found[$letter] = $remote.TrimEnd("\") }
        }
    } catch {}
    $out = @()
    foreach ($letter in $found.Keys) {
        if ($found[$letter] -match '^\\\\[^\\]+\\[^\\]+') { $out += [pscustomobject]@{ Letter = $letter; Unc = $found[$letter] } }
    }
    return $out
}

function Test-SamePath([string]$A, [string]$B) {
    return [string]::Equals($A.TrimEnd("\", "/"), $B.TrimEnd("\", "/"), [StringComparison]::OrdinalIgnoreCase)
}

function Test-ListHas($List, [string]$Value) {
    foreach ($x in @($List)) { if ($x -is [string] -and (Test-SamePath $x $Value)) { return $true } }
    return $false
}

# Creates the settings (from config.example.json) or adds newly mapped drives to them. Never removes
# or changes anything that's already there, so the owner's own edits survive every upgrade.
# Returns @{ Config = <object>; Added = @("MG_Mega", ...) }.
function Merge-QueueConfig($Config, $Drives, $Example) {
    if (-not $Config) {
        $o = [ordered]@{}
        foreach ($p in $Example.PSObject.Properties) { $o[$p.Name] = $p.Value }
        $o["allowedRoots"] = @()
        $o["pathMappings"] = @()
        $o["drives"] = @()
        $Config = [pscustomobject]$o
    }
    $roots = New-Object System.Collections.ArrayList
    foreach ($r in @($Config.allowedRoots)) { if ($r) { [void]$roots.Add($r) } }
    $maps = New-Object System.Collections.ArrayList
    foreach ($m in @($Config.pathMappings)) { if ($m) { [void]$maps.Add($m) } }
    $list = New-Object System.Collections.ArrayList
    $hadDrives = ($Config.PSObject.Properties.Name -contains "drives") -and @($Config.drives).Count -gt 0
    foreach ($d in @($Config.drives)) { if ($d) { [void]$list.Add($d) } }
    if (-not $hadDrives) {
        # Settings from 1.x have no drive list: list the shares that are already allowed.
        foreach ($r in $roots) {
            if ($r -match '^\\\\[^\\]+\\[^\\]+') {
                $root = Get-ShareRoot $r
                $known = $false
                foreach ($d in $list) { if (Test-SamePath $d.path $root) { $known = $true } }
                if (-not $known) { [void]$list.Add([pscustomobject][ordered]@{ name = ($root -split "\\")[-1]; path = $root; letter = $null }) }
            }
        }
    }
    $added = @()
    foreach ($d in @($Drives)) {
        if (-not $d.Unc) { continue }
        $unc = $d.Unc.TrimEnd("\")
        $root = Get-ShareRoot $unc
        $parts = @($root.TrimStart("\") -split "\\")
        $server = $parts[0]; $share = $parts[1]
        # A Mac mounts the whole share, so allow the whole share even when this letter is a subfolder of it.
        if (-not (Test-ListHas $roots $root)) { [void]$roots.Add($root); $added += $share }
        if ($d.Letter -and -not (Test-ListHas $roots ($d.Letter + "\"))) { [void]$roots.Add($d.Letter + "\") }
        foreach ($from in @("/Volumes/$share", "smb://$server/$share")) {
            $has = $false
            foreach ($m in $maps) { if ($m.from -and [string]::Equals($m.from.TrimEnd("/"), $from, [StringComparison]::OrdinalIgnoreCase)) { $has = $true } }
            if (-not $has) { [void]$maps.Add([pscustomobject][ordered]@{ from = $from; to = $root }) }
        }
        $entry = $null
        foreach ($x in $list) { if (Test-SamePath $x.path $root) { $entry = $x } }
        # The letter is shown next to the share only when it opens the share itself, not a subfolder.
        $letter = $null
        if ($d.Letter -and (Test-SamePath $unc $root)) { $letter = $d.Letter }
        if (-not $entry) {
            [void]$list.Add([pscustomobject][ordered]@{ name = $share; path = $root; letter = $letter })
        } elseif (-not $entry.letter -and $letter) {
            $entry.letter = $letter
        }
    }
    $Config | Add-Member -NotePropertyName allowedRoots -NotePropertyValue ([object[]]$roots.ToArray()) -Force
    $Config | Add-Member -NotePropertyName pathMappings -NotePropertyValue ([object[]]$maps.ToArray()) -Force
    $Config | Add-Member -NotePropertyName drives -NotePropertyValue ([object[]]$list.ToArray()) -Force
    return @{ Config = $Config; Added = $added }
}

# ---------------------------------------------------------------- address

# The server part of "\\192.168.1.13\Share" as IPv4 addresses (names are looked up).
function Get-ServerIps($Config) {
    $ips = @()
    foreach ($p in @($Config.allowedRoots) + @($Config.drives | ForEach-Object { $_.path })) {
        if ($p -is [string] -and $p -match '^\\\\([^\\]+)\\') {
            $h = $Matches[1]
            if ($h -match '^\d+\.\d+\.\d+\.\d+$') { $ips += $h; continue }
            try { $ips += @([Net.Dns]::GetHostAddresses($h) | Where-Object { $_.AddressFamily -eq "InterNetwork" } | ForEach-Object { $_.ToString() }) } catch {}
        }
    }
    return @($ips | Select-Object -Unique)
}

function Get-Prefix24([string]$Ip) { return ($Ip -split "\.")[0..2] -join "." }

# Picks the address designers should use. Candidates: [{ Ip; Alias; HasGateway; Dhcp }].
# Prefers: not a virtual adapter, on the same network as the file servers, has a router.
function Select-BestAddress($Candidates, $ServerIps) {
    $nets = @($ServerIps | ForEach-Object { Get-Prefix24 $_ })
    $best = $null; $bestScore = -1
    foreach ($c in @($Candidates)) {
        if (-not $c.Ip -or $c.Ip -like "127.*" -or $c.Ip -like "169.254.*") { continue }
        if ($c.Alias -match $VirtualAdapterPattern) { continue }
        $score = 0
        if ($nets -contains (Get-Prefix24 $c.Ip)) { $score += 4 }
        if ($c.HasGateway) { $score += 2 }
        if ($c.Ip -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)') { $score += 1 }
        if ($score -gt $bestScore) { $best = $c; $bestScore = $score }
    }
    return $best
}

function Get-AddressCandidates {
    $out = @()
    try {
        foreach ($cfg in @(Get-NetIPConfiguration -ErrorAction Stop)) {
            if ($cfg.NetAdapter -and $cfg.NetAdapter.Status -ne "Up") { continue }
            foreach ($a in @($cfg.IPv4Address)) {
                $dhcp = $false
                try { $dhcp = ((Get-NetIPInterface -InterfaceIndex $cfg.InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop).Dhcp -eq "Enabled") } catch {}
                $out += [pscustomobject]@{ Ip = $a.IPAddress; Alias = "$($cfg.InterfaceAlias) $($cfg.InterfaceDescription)"; HasGateway = [bool]$cfg.IPv4DefaultGateway; Dhcp = $dhcp }
            }
        }
    } catch {}
    return $out
}

# @{ Url = "http://192.168.1.20:8080/"; Ip; Dhcp }
function Get-QueueAddress($Config) {
    $port = Get-QueuePort
    $best = Select-BestAddress (Get-AddressCandidates) (Get-ServerIps $Config)
    if ($best) { return @{ Url = "http://$($best.Ip):$port/"; Ip = $best.Ip; Dhcp = $best.Dhcp } }
    return @{ Url = "http://$($env:COMPUTERNAME):$port/"; Ip = $null; Dhcp = $false }
}

# ---------------------------------------------------------------- the running queue

function Invoke-Queue([string]$Method, [string]$Path, [int]$TimeoutSec = 5) {
    $req = @{ Uri = "http://127.0.0.1:$(Get-QueuePort)$Path"; Method = $Method; TimeoutSec = $TimeoutSec; UseBasicParsing = $true }
    if ($Method -eq "POST") { $req.ContentType = "application/json"; $req.Body = "{}" }
    return Invoke-RestMethod @req
}

# The queue's health, or $null when it isn't running (an open port alone doesn't count).
function Get-QueueHealth {
    try {
        $h = Invoke-Queue GET "/api/health" 5
        if ($h -and $h.ok -and $h.version) { return $h }
    } catch {}
    return $null
}

function Get-ListenerProcessId {
    try {
        $c = @(Get-NetTCPConnection -LocalPort (Get-QueuePort) -State Listen -ErrorAction Stop)[0]
        if ($c) { return [int]$c.OwningProcess }
    } catch {}
    return $null
}

# Launchers of this copy of the queue: launcher.ps1 (2.x) and start.cmd windows (1.x).
function Get-LauncherProcesses {
    $mine = @()
    try {
        foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'cmd.exe'" -ErrorAction Stop)) {
            $cl = [string]$p.CommandLine
            if ($p.ProcessId -eq $PID) { continue }
            if ($cl.IndexOf($AppDir, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
            if ($cl -match 'launcher\.ps1|\\windows\\start\.cmd') { $mine += $p }
        }
    } catch {}
    return $mine
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return [bool](& $Condition)
}

# Stops the queue without cutting off an export: no new job starts, the current one finishes.
# Returns $true when it's stopped. Works with 1.x (no maintenance API) as well.
function Stop-Queue([switch]$Quiet) {
    $say = { param($m, $c) if (-not $Quiet) { if ($c) { Write-Host $m -ForegroundColor $c } else { Write-Host $m } } }
    $h = Get-QueueHealth
    $admin = $false
    if ($h) {
        try { [void](Invoke-Queue POST "/api/admin/drain" 10); $admin = $true } catch {}
        $shown = $null
        while ($true) {
            $h = Get-QueueHealth
            if (-not $h -or -not $h.worker.currentJobId) { break }
            if ($shown -ne $h.worker.currentJobId) {
                $shown = $h.worker.currentJobId
                & $say "Waiting for job #$shown to finish in InDesign (no new jobs start)..." Yellow
            }
            Start-Sleep -Seconds 2
        }
    }
    # 1.x windows restart the queue by themselves: close them first.
    foreach ($p in Get-LauncherProcesses) {
        if ([string]$p.CommandLine -match 'start\.cmd') { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }
    }
    if ($admin) {
        # Exit code 5 tells the launcher to stop instead of restarting it.
        try { [void](Invoke-Queue POST "/api/admin/shutdown" 10) } catch {}
        [void](Wait-Until { -not (Get-ListenerProcessId) -and -not (Get-QueueHealth) } 60)
    }
    $left = Get-ListenerProcessId
    if ($left) {
        $proc = Get-Process -Id $left -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq "node") {
            try { Stop-Process -Id $left -Force -ErrorAction Stop } catch {}
            [void](Wait-Until { -not (Get-ListenerProcessId) } 15)
        }
    }
    foreach ($p in Get-LauncherProcesses) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }
    if (Get-ListenerProcessId) {
        & $say "Port $(Get-QueuePort) is still in use by another program (process $(Get-ListenerProcessId))." Red
        return $false
    }
    return $true
}

# Starts the queue in the background (no window) and waits until it answers.
function Start-Queue([int]$WaitSeconds = 30) {
    $h = Get-QueueHealth
    if ($h) { return $h }
    $start = @{ FilePath = "powershell.exe"; ArgumentList = (Get-HiddenStartArguments); WorkingDirectory = $AppDir }
    if ($env:OS -eq "Windows_NT") { $start.WindowStyle = "Hidden" }     # (tests run elsewhere)
    Start-Process @start
    $script:startedHealth = $null
    [void](Wait-Until { $script:startedHealth = Get-QueueHealth; [bool]$script:startedHealth } $WaitSeconds)
    return $script:startedHealth
}

function Show-MessageBox([string]$Text, [int]$Icon = 48) {
    try { [void](New-Object -ComObject WScript.Shell).Popup($Text, 0, "InDesign Export Queue", $Icon) } catch {}
}

# ---------------------------------------------------------------- firewall + sleep (read-only checks)

function Get-FirewallProblems([int]$Port) {
    $problems = @()
    try {
        $rules = @(Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq "True" })
        if (-not $rules.Count) {
            $problems += "no firewall rule"
        } else {
            $r = $rules[0]
            $pf = $r | Get-NetFirewallPortFilter
            $af = $r | Get-NetFirewallAddressFilter
            if ([string]$pf.LocalPort -ne [string]$Port) { $problems += "firewall rule is for port $($pf.LocalPort)" }
            if ([string]$r.Profile -ne "Any") { $problems += "firewall rule only covers $($r.Profile) networks" }
            if ($r.Action -ne "Allow") { $problems += "firewall rule blocks" }
            if ((@($af.RemoteAddress) -join ",") -notmatch "LocalSubnet|Any") { $problems += "firewall rule addresses" }
        }
        $blocks = @(Get-NodeBlockRules)
        if ($blocks.Count) { $problems += "Windows blocks node.exe ($($blocks.Count) rule(s))" }
    } catch { $problems += "could not read the firewall: $($_.Exception.Message)" }
    return $problems
}

# Rules Windows creates when someone clicks Cancel on the "allow Node.js" prompt. Block wins over allow.
function Get-NodeBlockRules {
    return @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
        Where-Object { $_.Program -like "*\node.exe" } |
        Get-NetFirewallRule -ErrorAction SilentlyContinue |
        Where-Object { $_.Direction -eq "Inbound" -and $_.Action -eq "Block" })
}

# Minutes until sleep / hibernate on mains power (0 = never); $null if unknown.
function Get-PowerTimeout([string]$Setting) {
    try {
        $out = & powercfg.exe /query SCHEME_CURRENT SUB_SLEEP $Setting 2>$null
        foreach ($line in $out) {
            if ($line -match 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)') { return [int]([Convert]::ToInt32($Matches[1], 16) / 60) }
        }
    } catch {}
    return $null
}

function Test-SleepNever {
    $s = Get-PowerTimeout "STANDBYIDLE"
    $h = Get-PowerTimeout "HIBERNATEIDLE"
    return (($s -eq 0 -or $s -eq $null) -and ($h -eq 0 -or $h -eq $null))
}

# ---------------------------------------------------------------- shortcuts

function New-Shortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$Description, [int]$WindowStyle = 1, [string]$Icon) {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath = $Target
    $lnk.Arguments = $Arguments
    $lnk.WorkingDirectory = $AppDir
    $lnk.WindowStyle = $WindowStyle
    $lnk.Description = $Description
    if ($Icon) { $lnk.IconLocation = $Icon }
    $lnk.Save()
}

function New-UrlShortcut([string]$Path, [string]$Url) {
    [IO.File]::WriteAllText($Path, "[InternetShortcut]`r`nURL=$Url`r`n", [Text.Encoding]::ASCII)
}

function Get-ShortcutPaths {
    $menu = Join-Path ([Environment]::GetFolderPath("Programs")) $MenuName
    return @{
        Startup = Join-Path ([Environment]::GetFolderPath("Startup")) "InDesign Export Queue.lnk"
        Menu = $menu
        Desktop = Join-Path ([Environment]::GetFolderPath("Desktop")) "Export Queue.url"
    }
}

# The hidden start used by the login shortcut and the Start menu.
function Get-HiddenStartArguments {
    return "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`""
}
