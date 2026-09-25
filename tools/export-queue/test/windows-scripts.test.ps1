<#
  Tests for the Windows setup scripts (windows\*.ps1), runnable with PowerShell 7 on Linux/macOS
  or Windows PowerShell 5.1:   pwsh -NoProfile -File test/windows-scripts.test.ps1
  Covers the settings merge, the address choice, the launcher's exit-code handling, and a real
  start / drain / stop cycle of the queue (in simulate mode) through Start-Queue and Stop-Queue.
  Windows-only parts (firewall, shortcuts, UAC, CIM) are not covered here.
#>
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $PSCommandPath
$app = Split-Path -Parent $here
$failures = 0
$count = 0
function Check([string]$Name, [bool]$Condition, [string]$Detail = "") {
    $script:count++
    if ($Condition) { Write-Host "ok   $Name" -ForegroundColor Green }
    else { $script:failures++; Write-Host "FAIL $Name $Detail" -ForegroundColor Red }
}

# A private copy of the app, so config.json and data\ are the test's own.
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("eq-win-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$copy = Join-Path $tmp "ExportQueue"
[void](New-Item -ItemType Directory -Path $copy)
foreach ($item in "src", "public", "scripts", "windows", "package.json", "package-lock.json", "config.example.json") {
    Copy-Item -LiteralPath (Join-Path $app $item) -Destination $copy -Recurse
}
$isWin = $env:OS -eq "Windows_NT"
if ($isWin) { cmd /c mklink /J "$copy\node_modules" "$app\node_modules" | Out-Null }
else { [void](New-Item -ItemType SymbolicLink -Path (Join-Path $copy "node_modules") -Target (Join-Path $app "node_modules")) }

. (Join-Path $copy "windows/common.ps1")

# ---------------------------------------------------------------- settings

Check "share root of a subfolder" ((Get-ShareRoot "\\192.168.1.14\One Agency\Projects\2026") -eq "\\192.168.1.14\One Agency")
Check "share root of a share" ((Get-ShareRoot "\\192.168.1.13\MG_Mega\") -eq "\\192.168.1.13\MG_Mega")

$example = Read-JsonFile (Join-Path $copy "config.example.json")
$drives = @(
    [pscustomobject]@{ Letter = "M:"; Unc = "\\192.168.1.13\MG_Mega" },
    [pscustomobject]@{ Letter = "N:"; Unc = "\\192.168.1.14\One Agency\Projects" },
    [pscustomobject]@{ Letter = "X:"; Unc = "\\192.168.1.13\CH_CCH Commercial Cold Holdings" }
)
$new = Merge-QueueConfig $null $drives $example
$c = $new.Config
Check "new settings allow each share and letter" ((@($c.allowedRoots) -join "|") -eq "\\192.168.1.13\MG_Mega|M:\|\\192.168.1.14\One Agency|N:\|\\192.168.1.13\CH_CCH Commercial Cold Holdings|X:\") (@($c.allowedRoots) -join "|")
$mac = @($c.pathMappings | Where-Object { $_.from -eq "/Volumes/One Agency" })
Check "Mac name maps to the share root, even for a letter on a subfolder" ($mac.Count -eq 1 -and $mac[0].to -eq "\\192.168.1.14\One Agency")
Check "smb:// name mapped" (@($c.pathMappings | Where-Object { $_.from -eq "smb://192.168.1.13/MG_Mega" }).Count -eq 1)
$n = @($c.drives | Where-Object { $_.name -eq "One Agency" })[0]
Check "drive list: letter only when it opens the share itself" ($n.letter -eq $null -and @($c.drives | Where-Object { $_.name -eq "MG_Mega" })[0].letter -eq "M:")
Check "defaults kept from the example" ($c.port -eq 8080 -and $c.indesign.executor -eq "indesign")
Check "every share reported as added" ($new.Added.Count -eq 3)

# 1.x settings (as on the export PC): no drive list, the owner's own mapping and port.
$v1 = '{"port":8080,"host":"0.0.0.0","allowedRoots":["\\\\192.168.1.13\\MG_Mega","M:\\"],"pathMappings":[{"from":"/Volumes/MG_Mega","to":"\\\\192.168.1.13\\MG_Mega"},{"from":"/Volumes/Old Name","to":"\\\\192.168.1.13\\MG_Mega"}],"indesign":{"executor":"indesign","progId":"InDesign.Application","jobTimeoutMinutes":60,"killInDesignOnTimeout":true},"ntfy":{"server":"https://ntfy.sh","topic":"secret-topic","notifyOn":["failed"]}}'
$bomFile = Join-Path $tmp "bom.json"
[IO.File]::WriteAllText($bomFile, $v1, (New-Object System.Text.UTF8Encoding($true)))
$old = Read-JsonFile $bomFile
Check "reads settings saved with a byte order mark" ($old.port -eq 8080)
$up = Merge-QueueConfig $old @($drives[0]) $example
Check "upgrade with the same drive adds nothing" ($up.Added.Count -eq 0)
Check "upgrade keeps the owner's own mapping and notification link" (@($up.Config.pathMappings | Where-Object { $_.from -eq "/Volumes/Old Name" }).Count -eq 1 -and $up.Config.ntfy.topic -eq "secret-topic")
Check "upgrade writes a drive list with the letter" (@($up.Config.drives).Count -eq 1 -and $up.Config.drives[0].name -eq "MG_Mega" -and $up.Config.drives[0].letter -eq "M:")
Check "no duplicate mappings" (@($up.Config.pathMappings | Where-Object { $_.from -eq "/Volumes/MG_Mega" }).Count -eq 1)
$more = Merge-QueueConfig $up.Config $drives $example
Check "a newly mapped drive is added" (($more.Added -join ",") -eq "One Agency,CH_CCH Commercial Cold Holdings")
$again = Merge-QueueConfig $more.Config $drives $example
Check "running it again changes nothing" ($again.Added.Count -eq 0 -and ((ConvertTo-Json $again.Config -Depth 10) -eq (ConvertTo-Json $more.Config -Depth 10)))
$drop = Merge-QueueConfig $more.Config @() $example
Check "a drive that's no longer mapped is not removed" (@($drop.Config.allowedRoots).Count -eq @($more.Config.allowedRoots).Count)

# Single drive: the lists must stay JSON arrays, and the server must accept the file.
$one = Merge-QueueConfig $null @($drives[0]) $example
$cfgFile = Join-Path $tmp "one.json"
Write-JsonFile $cfgFile $one.Config
$raw = [IO.File]::ReadAllText($cfgFile)
Check "one drive is still written as lists" ($raw -match '"allowedRoots":\s*\[' -and $raw -match '"drives":\s*\[' -and $raw -match '"pathMappings":\s*\[')
Check "written without a byte order mark" ([IO.File]::ReadAllBytes($cfgFile)[0] -ne 0xEF)
$validate = "import { validateConfig } from './src/config.js'; const fs = await import('node:fs'); const c = validateConfig(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')), '.'); console.log(JSON.stringify({ drives: c.drives, roots: c.allowedRoots.length }));"
Push-Location $copy
$out = & node --input-type=module -e $validate $cfgFile 2>&1
Pop-Location
Check "the server accepts the settings the installer writes" ($LASTEXITCODE -eq 0 -and "$out" -match '"name":"MG_Mega"') "$out"
Write-JsonFile $cfgFile $more.Config
Push-Location $copy
$out = & node --input-type=module -e $validate $cfgFile 2>&1
Pop-Location
Check "the server accepts upgraded 1.x settings" ($LASTEXITCODE -eq 0 -and "$out" -match 'One Agency') "$out"

# ---------------------------------------------------------------- address

$cands = @(
    [pscustomobject]@{ Ip = "172.22.160.1"; Alias = "vEthernet (WSL)"; HasGateway = $false; Dhcp = $false },
    [pscustomobject]@{ Ip = "10.8.0.2"; Alias = "Ethernet 3 VPN"; HasGateway = $true; Dhcp = $true },
    [pscustomobject]@{ Ip = "169.254.3.4"; Alias = "Ethernet 2"; HasGateway = $false; Dhcp = $true },
    [pscustomobject]@{ Ip = "192.168.1.20"; Alias = "Ethernet Realtek"; HasGateway = $true; Dhcp = $true }
)
Check "address on the file servers' network wins" ((Select-BestAddress $cands @("192.168.1.13", "192.168.1.14")).Ip -eq "192.168.1.20")
Check "without server info: an adapter with a router" ((Select-BestAddress @($cands[0], $cands[2], $cands[1]) @()).Ip -eq "10.8.0.2")
Check "virtual and self-assigned only: none" ($null -eq (Select-BestAddress @($cands[0], $cands[2]) @()))
$ips = (@(Get-ServerIps $c) -join ",")
Check "server addresses read from the settings" ($ips -eq "192.168.1.13,192.168.1.14") $ips

# ---------------------------------------------------------------- launcher exit codes

$bin = Join-Path $tmp "bin"
[void](New-Item -ItemType Directory -Path $bin)
$codes = Join-Path $tmp "codes.txt"
$fake = Join-Path $bin "fake-node.ps1"
# Exits with the next code from codes.txt (the last one repeats); prints a line like the server does.
@'
$f = $env:FAKE_CODES
$list = @(Get-Content -LiteralPath $f)
$code = [int]$list[0]
if ($list.Count -gt 1) { Set-Content -LiteralPath $f -Value $list[1..($list.Count - 1)] }
[Console]::Error.WriteLine("config.json: allowedRoots must be a list (exit $code)")
exit $code
'@ | Set-Content -LiteralPath $fake
$pw = (Get-Process -Id $PID).Path
if ($isWin) {
    $fakeNode = Join-Path $bin "fake-node.cmd"
    "@`"$pw`" -NoProfile -File `"$fake`" %*" | Set-Content -LiteralPath $fakeNode
} else {
    $fakeNode = Join-Path $bin "fake-node"
    "#!/bin/sh`nexec `"$pw`" -NoProfile -File `"$fake`" `"`$@`"" | Set-Content -LiteralPath $fakeNode
    chmod +x $fakeNode
}
$env:FAKE_CODES = $codes
$launcherPs = Join-Path $copy "windows/launcher.ps1"
[IO.File]::WriteAllText((Join-Path $copy "config.json"), '{"port":8197,"host":"127.0.0.1","allowedRoots":["' + ($tmp -replace '\\', '\\') + '"],"indesign":{"executor":"simulate"}}')
$launchLog = Join-Path $copy "data/logs/launcher.log"

function Invoke-Launcher([string[]]$Sequence, [string]$Node = $fakeNode, [int]$TimeoutSec = 60) {
    Set-Content -LiteralPath $codes -Value $Sequence
    $msgs = Join-Path $tmp ("msgs-" + [guid]::NewGuid().ToString("N") + ".txt")
    $p = Start-Process -FilePath $pw -ArgumentList @("-NoProfile", "-File", "`"$launcherPs`"", "-Node", "`"$Node`"", "-RestartSeconds", "0", "-RetrySeconds", "1", "-MessageLog", "`"$msgs`"") -PassThru
    $finished = $p.WaitForExit($TimeoutSec * 1000)
    if (-not $finished) { $p.Kill() }
    $text = ""
    if (Test-Path -LiteralPath $msgs) { $text = [IO.File]::ReadAllText($msgs) }
    return @{ Finished = $finished; Code = $(if ($finished) { $p.ExitCode } else { $null }); Messages = $text; Count = ([regex]::Matches($text, "---")).Count }
}

$r = Invoke-Launcher @("5")
Check "exit 5 (stopped on purpose): launcher ends quietly" ($r.Finished -and $r.Code -eq 0 -and $r.Count -eq 0) "$($r.Code) $($r.Messages)"
$r = Invoke-Launcher @("2")
Check "exit 2 (bad settings): one message with the reason, then ends" ($r.Finished -and $r.Code -eq 2 -and $r.Count -eq 1 -and $r.Messages -match "allowedRoots must be a list") $r.Messages
$r = Invoke-Launcher @("1", "1", "5")
Check "a crash is restarted" ($r.Finished -and $r.Code -eq 0 -and $r.Count -eq 0)
$r = Invoke-Launcher @("1", "1", "1", "1", "1", "1", "1", "5")
Check "keeps crashing: one message (not one per crash), keeps trying" ($r.Finished -and $r.Code -eq 0 -and $r.Count -eq 1 -and $r.Messages -match "keeps stopping") "$($r.Count) $($r.Messages)"
$r = Invoke-Launcher @("3")
Check "exit 3 with nothing answering: 'port is used' message" ($r.Finished -and $r.Code -eq 3 -and $r.Messages -match "port 8197") $r.Messages
$r = Invoke-Launcher @("5") -Node (Join-Path $bin "no-such-node") -TimeoutSec 5
Check "Node.js missing: one message, keeps checking" ((-not $r.Finished) -and $r.Count -eq 1 -and $r.Messages -match "Node.js isn't installed") $r.Messages
$logText = [IO.File]::ReadAllText($launchLog)
Check "launcher.log records what happened" ($logText -match "exit code 1" -and $logText -match "Stopped on purpose" -and $logText -match "node.exe not found")

# ---------------------------------------------------------------- real start / stop (simulate mode)

# Stand-ins for powershell.exe and node.exe, so Start-Queue and the launcher run unchanged.
if (-not $isWin) {
    # (drops -WindowStyle, which PowerShell only has on Windows)
    "#!/bin/sh`nfor a; do shift; if [ `"`$skip`" = 1 ]; then skip=0; continue; fi; if [ `"`$a`" = -WindowStyle ]; then skip=1; continue; fi; set -- `"`$@`" `"`$a`"; done`nexec `"$pw`" `"`$@`"" | Set-Content -LiteralPath (Join-Path $bin "powershell.exe")
    "#!/bin/sh`nexec node `"`$@`"" | Set-Content -LiteralPath (Join-Path $bin "node.exe")
    chmod +x (Join-Path $bin "powershell.exe") (Join-Path $bin "node.exe")
    $env:PATH = "$bin$([IO.Path]::PathSeparator)$env:PATH"
}
$share = Join-Path $tmp "share"
[void](New-Item -ItemType Directory -Path $share)
Set-Content -LiteralPath (Join-Path $share "simulate-slow Catalog.indd") -Value "x"
[IO.File]::WriteAllText((Join-Path $copy "config.json"), (@{ port = 8197; host = "127.0.0.1"; allowedRoots = @($share); indesign = @{ executor = "simulate" } } | ConvertTo-Json -Depth 5))
$env:EXPORT_QUEUE_SIMULATE_MS = "1500"

$h = Start-Queue 30
Check "Start-Queue starts it in the background and it answers" ($null -ne $h -and $h.ok)
Check "Start-Queue again doesn't start a second copy" ((Start-Queue 5).startedAt -eq $h.startedAt)
# Submit a slow job and stop while it runs: Stop-Queue must wait for it.
$body = @{ sourcePaths = @((Join-Path $share "simulate-slow Catalog.indd")); formats = @("idml"); submittedBy = "Test" } | ConvertTo-Json
$job = Invoke-RestMethod -Uri "http://127.0.0.1:8197/api/jobs" -Method Post -Body $body -ContentType "application/json"
$id = $job.jobs[0].id
[void](Wait-Until { (Get-QueueHealth).worker.currentJobId -eq $id } 15)
$stopped = Stop-Queue -Quiet
Check "Stop-Queue stops it" ($stopped -and -not (Get-QueueHealth))
$restarted = Start-Queue 30
$after = Invoke-RestMethod -Uri "http://127.0.0.1:8197/api/jobs/$id"
Check "the export that was running finished before the stop" ($after.status -eq "completed") "status: $($after.status)"
$logText = [IO.File]::ReadAllText($launchLog)
Check "launcher ended on the maintenance stop (no restart loop)" ($logText -match "Stopped on purpose")
[void](Stop-Queue -Quiet)
Check "stopped again at the end" (-not (Get-QueueHealth))

Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ""
if ($failures) { Write-Host "$failures of $count checks failed" -ForegroundColor Red; exit 1 }
Write-Host "All $count checks passed" -ForegroundColor Green
