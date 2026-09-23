<#
  Background receiver for staff PCs: shows a normal Windows notification for every export message.
  Started hidden at login by the Startup-folder shortcut that Install.cmd (in this folder) creates.

  - Keeps one connection open to the ntfy channel (no browser needed)
  - After sleep, reboot or a network drop it reconnects and catches up on missed messages
  - Can't connect for 10+ minutes: shows one "can't connect" notification, then "reconnected"
  - Only one copy runs at a time; activity and problems go to %APPDATA%\ExportReceiver\receiver.log

  Must run in Windows PowerShell 5.1 (powershell.exe), which has the Windows notification API.
#>
param(
    [string]$Dir = (Join-Path $env:APPDATA "ExportReceiver"),
    [switch]$TestMode,                       # print notifications instead of showing them (for testing)
    [int]$StaleSeconds = 120,                # ntfy sends a keepalive every ~45s; silence longer than this = dead connection
    [double]$WarnAfterMinutes = 10
)

$ErrorActionPreference = "Stop"
$SettingsFile = Join-Path $Dir "settings.txt"
$StateFile = Join-Path $Dir "last-seen.txt"
$Log = Join-Path $Dir "receiver.log"

function Write-Log($text) {
    try {
        if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 1MB) { Set-Content $Log (Get-Content $Log -Tail 500) -Encoding UTF8 }
        Add-Content $Log ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $text) -Encoding UTF8
    } catch {}
}

function Read-Settings {
    $s = @{}
    foreach ($line in Get-Content $SettingsFile) {
        $eq = $line.IndexOf("=")
        if ($eq -gt 0) { $s[$line.Substring(0, $eq).Trim()] = $line.Substring($eq + 1).Trim() }
    }
    return $s
}

# A notification that Windows refuses to show is logged and skipped, never retried forever.
function Show-Notification($title, $body, $link) {
    try { Show-Toast $title $body $link } catch { Write-Log "Could not show notification '$title': $($_.Exception.Message)" }
}

function Show-Toast($title, $body, $link) {
    if ($TestMode) {
        if ($body -like "*FAIL-TOAST*") { throw "simulated Windows notification failure" }
        Write-Host "NOTIFY | $title | $($body -replace "`n", ' / ')"; return
    }
    $esc = { param($t) [Security.SecurityElement]::Escape([string]$t) }
    $xmlText = "<toast activationType=`"protocol`" launch=`"$(& $esc $link)`"><visual><binding template=`"ToastGeneric`">" +
               "<text>$(& $esc $title)</text><text>$(& $esc $body)</text></binding></visual></toast>"
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($xmlText)
    $appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show((New-Object Windows.UI.Notifications.ToastNotification $xml))
}

# Remembers the newest message time plus recent ids, so reconnecting never repeats or skips a message.
function Read-State {
    $state = @{ time = 0; ids = @() }
    if (Test-Path $StateFile) {
        $lines = @(Get-Content $StateFile)
        if ($lines.Count -gt 0) { $state.time = [long]$lines[0] }
        if ($lines.Count -gt 1) { $state.ids = @($lines[1..($lines.Count - 1)]) }
    }
    return $state
}

function Save-State($state) {
    $ids = @($state.ids | Select-Object -Last 50)
    Set-Content $StateFile (@([string]$state.time) + $ids) -Encoding ASCII
}

# Only one receiver per Windows user.
$created = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\ExportReceiver", [ref]$created)
if (-not $created) { exit 0 }

$settings = Read-Settings
$server = $settings.server.TrimEnd("/")
$topic = $settings.topic
$webLink = "$server/$topic"
$state = Read-State
if ($state.time -eq 0) {
    # First start on this computer: only new messages from now on, and say hello.
    $state.time = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    Save-State $state
    Show-Notification "Export notifications are on" "You'll get a notification here when an InDesign export finishes." $webLink
}

Add-Type -AssemblyName System.Net.Http
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Write-Log "Receiver started for $webLink"

$failingSince = $null
$warned = $false
$delay = 5
while ($true) {
    $client = $null
    try {
        $client = New-Object System.Net.Http.HttpClient
        $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
        if ($settings.token) { $client.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", $settings.token) }
        # "since" = newest message time we have seen; the ids list removes the one(s) already shown.
        $uri = "$server/$topic/json?since=$($state.time)"
        $response = $client.GetAsync($uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        [void]$response.EnsureSuccessStatusCode()
        $reader = New-Object IO.StreamReader($response.Content.ReadAsStreamAsync().GetAwaiter().GetResult(), [Text.Encoding]::UTF8)

        while ($true) {
            $read = $reader.ReadLineAsync()
            if (-not $read.Wait($StaleSeconds * 1000)) { throw "No data from the server for $StaleSeconds seconds" }
            $line = $read.Result
            if ($null -eq $line) { throw "Server closed the connection" }
            if (-not $line.Trim()) { continue }
            $m = $line | ConvertFrom-Json

            if ($m.event -eq "open") {
                if ($warned) { Show-Notification "Export notifications reconnected" "Any exports you missed will appear now." $webLink }
                if ($failingSince) { Write-Log "Connected again" }
                $failingSince = $null; $warned = $false; $delay = 5
                continue
            }
            if ($m.event -ne "message") { continue }        # keepalives
            if ($state.ids -contains $m.id) { continue }    # already shown before a reconnect

            $title = if ($m.title) { $m.title } else { "Export notification" }
            Show-Notification $title $m.message $webLink
            $state.ids = @($state.ids) + $m.id
            if ([long]$m.time -gt $state.time) { $state.time = [long]$m.time }
            Save-State $state
        }
    } catch {
        $msg = $_.Exception.Message
        if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
        if (-not $failingSince) { $failingSince = Get-Date; Write-Log "Connection problem: $msg" }
        if (-not $warned -and ((Get-Date) - $failingSince).TotalMinutes -ge $WarnAfterMinutes) {
            Show-Notification "Export notifications can't connect" "Still trying. Check this computer's internet connection." $webLink
            Write-Log "Still can't connect after $WarnAfterMinutes minutes: $msg"
            $warned = $true
        }
    } finally {
        if ($client) { $client.Dispose() }
    }
    Start-Sleep -Seconds $delay
    $delay = [Math]::Min($delay * 2, 60)
}
