<#
  Bridge between the export queue (Node.js) and Adobe InDesign.

  Connects to InDesign through its COM automation interface (starting InDesign if needed),
  hands it the job file via app.scriptArgs, and runs the given ExtendScript with DoScript.
  DoScript returns when the script has finished, so exports are fully synchronous.

  The script reports its outcome in the result file named in the job; this bridge only
  reports problems reaching InDesign itself (exit code 3) or running the script (exit code 4).
#>
param(
    [Parameter(Mandatory = $true)][string]$ScriptFile,
    [Parameter(Mandatory = $true)][string]$JobFile,
    [string]$ProgId = "InDesign.Application"
)

$ErrorActionPreference = "Stop"
$JavaScript = 1246973031    # ScriptLanguage.JAVASCRIPT ('JSLg')

try {
    $app = New-Object -ComObject $ProgId
} catch {
    [Console]::Error.WriteLine("Could not start or connect to InDesign ($ProgId). Is InDesign installed and licensed for this Windows user? $($_.Exception.Message)")
    exit 3
}

try {
    $app.ScriptArgs.SetValue("exportQueueJob", $JobFile)
    $source = [IO.File]::ReadAllText($ScriptFile, [Text.Encoding]::UTF8)
    [void]$app.DoScript($source, $JavaScript)
    exit 0
} catch {
    [Console]::Error.WriteLine("InDesign stopped the export script: $($_.Exception.Message)")
    exit 4
} finally {
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
}
