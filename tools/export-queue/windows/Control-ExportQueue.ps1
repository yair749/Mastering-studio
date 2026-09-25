<#
  Start, stop or restart the export queue. Used by the Start menu shortcuts
  ("InDesign Export Queue" folder) and at login. Stopping never cuts off an export:
  the job that's in InDesign finishes first, and waiting jobs stay in the queue.
#>
param(
    [ValidateSet("Start", "Stop", "Restart")][string]$Action = "Start",
    [switch]$Quiet                  # at login: no output, no waiting for a key
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

function Finish([bool]$Ok, [string]$Message) {
    if ($Quiet) { if ($Ok) { exit 0 } else { exit 1 } }
    if ($Ok) { Write-Host $Message -ForegroundColor Green; Start-Sleep -Seconds 4; exit 0 }
    Write-Host $Message -ForegroundColor Red
    [void](Read-Host "Press Enter to close")
    exit 1
}

try {
    if ($Action -eq "Stop" -or $Action -eq "Restart") {
        if (-not $Quiet) { Write-Host "Stopping the export queue..." }
        if (-not (Stop-Queue -Quiet:$Quiet)) { Finish $false "The export queue could not be stopped. Restart the PC." }
        if ($Action -eq "Stop") {
            Finish $true "The export queue is stopped. Waiting jobs stay in the queue. It starts again at the next login, or with Start menu > InDesign Export Queue > Restart Export Queue."
        }
    }
    if (-not $Quiet) { Write-Host "Starting the export queue..." }
    $h = Start-Queue
    if ($h) {
        $url = (Get-QueueAddress (Get-QueueConfig)).Url
        Finish $true "The export queue is running (version $($h.version)). Designers open: $url"
    }
    Finish $false "The export queue didn't start. Start menu > InDesign Export Queue > Check Export Queue shows why."
} catch {
    Finish $false "Problem: $($_.Exception.Message)"
}
