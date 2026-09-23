<#
  Delivers one notification written by export-notify.jsx (or the installer) to ntfy.

  - Retries for about 15 minutes if the internet or ntfy is unreachable
  - Messages that still fail are kept as .failed and re-sent after the next successful send
  - Every failure is written to %APPDATA%\InDesignExportNotify\notifier.log

  Message file format (UTF-8):  key=value lines (server, topic, token, title, tags, priority),
  then a line "---", then the message body.
#>
param(
    [Parameter(Mandatory = $true)][string]$MessageFile,
    [int]$Attempts = 7                     # 7 attempts = 0s, 15s, 30s, 1m, 2m, 4m, 8m
)

$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $PSScriptRoot    # ...\InDesignExportNotify (this script lives in \app)
$Log = Join-Path $Dir "notifier.log"
$Delays = @(15, 30, 60, 120, 240, 480)

function Write-Log($text) {
    try {
        if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 1MB) {
            $keep = Get-Content $Log -Tail 500
            Set-Content $Log $keep -Encoding UTF8
        }
        Add-Content $Log ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $text) -Encoding UTF8
    } catch {}
}

function Read-Message($path) {
    $raw = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) -replace "`r", ""
    $split = $raw.IndexOf("`n---`n")
    if ($split -lt 0) { throw "Not a notification file: $path" }
    $msg = @{ body = $raw.Substring($split + 5) }
    foreach ($line in $raw.Substring(0, $split).Split("`n")) {
        $eq = $line.IndexOf("=")
        if ($eq -gt 0) { $msg[$line.Substring(0, $eq)] = $line.Substring($eq + 1) }
    }
    return $msg
}

function Send-Message($msg, $titlePrefix) {
    $headers = @{ Title = $titlePrefix + $msg.title }
    if ($msg.tags) { $headers.Tags = $msg.tags }
    if ($msg.priority) { $headers.Priority = $msg.priority }
    if ($msg.token) { $headers.Authorization = "Bearer " + $msg.token }
    $uri = $msg.server.TrimEnd("/") + "/" + $msg.topic
    $body = [Text.Encoding]::UTF8.GetBytes($msg.body)
    Invoke-RestMethod -Method Post -Uri $uri -Body $body -Headers $headers -TimeoutSec 20 | Out-Null
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$msg = Read-Message $MessageFile
for ($i = 0; $i -lt $Attempts; $i++) {
    try {
        Send-Message $msg ""
        Remove-Item $MessageFile -ErrorAction SilentlyContinue
        break
    } catch {
        Write-Log "Send failed (attempt $($i + 1) of $Attempts): $($msg.title) - $($_.Exception.Message)"
        if ($i -eq $Attempts - 1) {
            Move-Item $MessageFile ([IO.Path]::ChangeExtension($MessageFile, ".failed")) -Force
            Write-Log "Gave up for now; will re-send after the next successful notification: $($msg.title)"
            exit 1
        }
        Start-Sleep -Seconds $Delays[[Math]::Min($i, $Delays.Count - 1)]
    }
}

# Connection works again: deliver anything that failed earlier.
foreach ($old in Get-ChildItem (Split-Path -Parent $MessageFile) -Filter *.failed -ErrorAction SilentlyContinue | Sort-Object Name) {
    try {
        Send-Message (Read-Message $old.FullName) "(Delayed) "
        Remove-Item $old.FullName
        Write-Log "Delivered delayed message: $($old.Name)"
    } catch {
        break
    }
}
exit 0
