<#
  Keeps the export queue running in the background (no window to close by mistake).
  Started at login and by the Start menu shortcuts; you don't run it yourself.

  When the queue stops:
    exit code 5  stopped on purpose (installer / Stop shortcut)  -> this launcher ends too
    exit code 3  already running (or its port is taken)          -> ends (message if it's another program)
    exit code 2  the settings need fixing                        -> message box, ends
    anything else                                                -> starts it again after 10 seconds;
                 5 stops within 2 minutes -> one message box, then tries every minute
  Node.js missing -> one message box, then checks every minute.
  Everything it does is written to data\logs\launcher.log.

  PowerShell reads a whole script before running it, so an upgrade replacing this file while it
  runs is safe (unlike a .cmd file, which Windows reads line by line from disk).
#>
param(
    [string]$Node = "node.exe",
    [int]$RestartSeconds = 10,
    [int]$RetrySeconds = 60,
    [string]$MessageLog            # tests: write the message boxes to this file instead of showing them
)

$ErrorActionPreference = "Continue"
. "$PSScriptRoot\common.ps1"

$logDir = Join-Path (Get-DataDir) "logs"
try { [void][IO.Directory]::CreateDirectory($logDir) } catch {}
$LogFile = Join-Path $logDir "launcher.log"

function Write-Log([string]$Message) {
    try { [IO.File]::AppendAllText($LogFile, "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message`r`n", $Utf8NoBom) } catch {}
}

function Show-Problem([string]$Text) {
    Write-Log "Message shown: $($Text -replace "`r?`n", ' ')"
    if ($MessageLog) { [IO.File]::AppendAllText($MessageLog, $Text + "`n---`n"); return }
    # In a separate process, so the queue keeps retrying while the message is on screen.
    $cmd = "[void](New-Object -ComObject WScript.Shell).Popup('" + $Text.Replace("'", "''") + "', 0, 'InDesign Export Queue', 48)"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
    try { Start-Process powershell.exe -ArgumentList "-NoProfile -WindowStyle Hidden -EncodedCommand $encoded" -WindowStyle Hidden } catch {}
}

function Find-Node {
    if (Get-Command $Node -ErrorAction SilentlyContinue) { return $true }
    # Installed since this launcher started? Pick up the new PATH.
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + [IO.Path]::PathSeparator + [Environment]::GetEnvironmentVariable("Path", "User")
    return [bool](Get-Command $Node -ErrorAction SilentlyContinue)
}

$logFolder = $logDir
Set-Location -LiteralPath $AppDir
Write-Log "Launcher started (process $PID)."
$crashes = New-Object System.Collections.ArrayList
$warnedNode = $false
$warnedCrash = $false

while ($true) {
    if (-not (Find-Node)) {
        if (-not $warnedNode) {
            Show-Problem "The export queue can't start: Node.js isn't installed on this PC.`n`nDouble-click Install.cmd in the export queue's windows folder ($WinDir). It installs Node.js and starts the queue.`n`nUntil then this PC checks again every minute."
            $warnedNode = $true
        }
        Write-Log "node.exe not found; checking again in $RetrySeconds seconds."
        Start-Sleep -Seconds $RetrySeconds
        continue
    }
    $warnedNode = $false

    $started = Get-Date
    $tail = New-Object System.Collections.Generic.Queue[string]
    & $Node --disable-warning=ExperimentalWarning src/server.js 2>&1 | ForEach-Object {
        $line = [string]$_
        if ($line.Trim()) { $tail.Enqueue($line); if ($tail.Count -gt 12) { [void]$tail.Dequeue() } }
    }
    $code = $LASTEXITCODE
    $ran = [int]((Get-Date) - $started).TotalSeconds
    $lastLines = @($tail.ToArray())
    $last = ($lastLines | Select-Object -Last 3) -join "`n"

    if ($code -eq 5) {
        Write-Log "Stopped on purpose (installer or Stop shortcut). The launcher ends."
        exit 0
    }
    if ($code -eq 2) {
        Write-Log "Stopped: the settings need fixing. $($last -replace "`r?`n", ' ')"
        Show-Problem "The export queue can't start because its settings need fixing:`n`n$last`n`nAfter fixing it: Start menu > InDesign Export Queue > Restart Export Queue."
        exit 2
    }
    if ($code -eq 3) {
        if (Get-QueueHealth) {
            Write-Log "The export queue is already running; this launcher isn't needed."
            exit 0
        }
        Write-Log "Port $(Get-QueuePort) is used by another program. $last"
        Show-Problem "The export queue can't start: another program on this PC is using port $(Get-QueuePort).`n`nRestart the PC. If this message comes back, change `"port`" in config.json (for example to 8090), then double-click windows\Install.cmd."
        exit 3
    }

    Write-Log "The export queue stopped (exit code $code) after $ran seconds. $($last -replace "`r?`n", ' ')"
    if ($ran -ge 600) { $crashes.Clear(); $warnedCrash = $false }
    [void]$crashes.Add((Get-Date))
    $cutoff = (Get-Date).AddMinutes(-2)
    foreach ($t in @($crashes)) { if ($t -lt $cutoff) { [void]$crashes.Remove($t) } }
    if ($crashes.Count -ge 5) {
        if (-not $warnedCrash) {
            Show-Problem "The export queue keeps stopping by itself. It will keep trying every minute.`n`nLast message:`n$last`n`nDetails are in $logFolder. Start menu > InDesign Export Queue > Check Export Queue shows what's wrong."
            $warnedCrash = $true
        }
        Start-Sleep -Seconds $RetrySeconds
    } else {
        Start-Sleep -Seconds $RestartSeconds
    }
}
