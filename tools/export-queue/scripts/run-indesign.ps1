<#
  Bridge between the export queue (Node.js) and Adobe InDesign.

  Connects to InDesign through its COM automation interface (starting InDesign if needed),
  hands it the job file via app.scriptArgs, and runs the given ExtendScript with DoScript.
  DoScript returns when the script has finished, so exports are fully synchronous.

  The script reports its outcome in the result file named in the job; this bridge only
  reports problems reaching InDesign itself (exit code 3: the job never started, so the queue
  keeps it and waits) or running the script (exit code 4).
#>
param(
    [Parameter(Mandatory = $true)][string]$ScriptFile,
    [Parameter(Mandatory = $true)][string]$JobFile,
    [string]$ProgId = "InDesign.Application",
    [int]$BusyRetrySeconds = 120,
    [object]$Application                # tests only: a stand-in for InDesign's COM object
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$JavaScript = 1246973031    # ScriptLanguage.JAVASCRIPT ('JSLg')

# RPC_E_CALL_REJECTED (0x80010001) and RPC_E_SERVERCALL_RETRYLATER (0x8001010A): InDesign is
# still starting, or a dialog is open on its screen. The call was not carried out, so it is
# safe to try again.
$BusyCodes = @(-2147418111, -2147417846)

function Test-Busy($ErrorRecord) {
    $e = $ErrorRecord.Exception
    while ($e) {
        if ($BusyCodes -contains $e.HResult) { return $true }
        $e = $e.InnerException
    }
    return $false
}

function Invoke-WhenReady([scriptblock]$Call, [string]$What) {
    $deadline = (Get-Date).AddSeconds($BusyRetrySeconds)
    while ($true) {
        try {
            return (& $Call)
        } catch {
            if (-not (Test-Busy $_)) { throw }
            if ((Get-Date) -ge $deadline) {
                [Console]::Error.WriteLine("Could not start or connect to InDesign: it is busy or showing a message on the export PC's screen, and didn't accept the $What for $BusyRetrySeconds seconds.")
                exit 3
            }
            Start-Sleep -Seconds 2
        }
    }
}

try {
    if ($Application) { $app = $Application } else { $app = New-Object -ComObject $ProgId }
} catch {
    [Console]::Error.WriteLine("Could not start or connect to InDesign ($ProgId). Is InDesign installed and licensed for this Windows user? $($_.Exception.Message)")
    exit 3
}

try {
    Invoke-WhenReady { $app.ScriptArgs.SetValue("exportQueueJob", $JobFile) } "job"
    $source = [IO.File]::ReadAllText($ScriptFile, [Text.Encoding]::UTF8)
    Invoke-WhenReady { [void]$app.DoScript($source, $JavaScript) } "export script"
    exit 0
} catch {
    [Console]::Error.WriteLine("InDesign stopped the export script: $($_.Exception.Message)")
    exit 4
} finally {
    if (-not $Application) {
        try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
    }
}
