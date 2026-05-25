# Greenhaven contributors, Apache-2.0
#
# N-2 Phase 3 soak driver. Reusable, parameterized harness that launches
# the packaged desktop EXE, submits N turns across configurable languages
# through the real backend HTTP API, captures AppData readiness reports
# before and after, and writes a typed driver-summary.json suitable for
# pasting straight into the master plan.
#
# Supersedes `packages/desktop-electron/_live_turns_driver.ps1` (which is
# now a thin compat shim that delegates here with Turns=1 Languages=en).
#
# Notable contract:
# - Default Turns=8 with Languages=en,ru. Distribution is round-robin so
#   each requested language receives at least floor(Turns/Languages) +1
#   for the first remainder.
# - PowerShell 5.1 quirk: piping into Where-Object and reading `.Count` on
#   the result returns the property count when the pipe yields a single
#   hashtable (not 1). Every count here wraps with @(...).Count so the
#   summary numbers are correct in the single-turn case too.
# - Readiness reports run against AppData pgdata via the existing
#   `telemetry:report -- narrate-sanitiser` CLI. The before snapshot runs
#   pre-launch (when no EXE holds the lock); the after snapshot runs
#   post-shutdown.
# - `ready_for_regex_deletion` is intentionally conservative: it requires
#   `new_inspected_events >= MinInspectedEvents`, `new_phase3_total === 0`,
#   no failed/cancelled/timeout/submit-failed turns, no forced shutdown,
#   AND every configured language must have at least one `terminal=done`
#   turn. Cartridge coverage is derived from the live cartridge id read
#   off `GET /api/world.cartridge_meta.cartridge_id.value` after the soak
#   runs (when `-CartridgesAttempted` is not supplied as an explicit
#   override); the driver never invents a `packaged` default.

[CmdletBinding()]
param(
    [int]$Turns = 8,
    [string[]]$Languages = @('en','ru'),
    [string]$ArtifactRoot = "C:\Greenhaven\packages\web-server\.codex\run-logs\live-playtest",
    [string]$ExePath = "C:\Greenhaven\packages\desktop-electron\release\win-unpacked\GreenHaven.exe",
    [string]$Pgdata = "$env:APPDATA\GreenHaven\pgdata",
    [int]$ReadinessMinutes = 10080,
    [int]$ReadinessLimit = 500,
    [int]$TurnTimeoutSeconds = 240,
    [int]$PerTurnSleepSeconds = 6,
    [int]$MinInspectedEvents = 0,
    [string]$ArtifactPrefix = 'n2-phase3-soak',
    # N-2 deletion-readiness policy axes. `local_soak_passed` ignores
    # these; `ready_for_regex_deletion` only flips true when the
    # exercised cartridge/model-family counts meet the configured
    # minimums. The packaged desktop bundle ships ONE cartridge and
    # exercises ONE model family per run, so the defaults below
    # (2 / 2) intentionally keep a single packaged soak in
    # `local_soak_passed: true / ready_for_regex_deletion: false`
    # until evidence is collected from additional cartridges /
    # families.
    #
    # Both diversity axes are evidence-driven by default:
    #   - When `-CartridgesAttempted` is empty (the default), the
    #     driver reads the live cartridge id off
    #     `GET /api/world.cartridge_meta.cartridge_id.value` after
    #     the soak runs and writes it to
    #     `driver-summary.json.cartridges_attempted`. The driver
    #     never invents a `packaged` default — if the world overview
    #     fails or lacks an id, the cartridge axis is empty and the
    #     deletion gate stays blocked.
    #   - Similarly for `-ModelFamiliesAttempted`: empty default →
    #     derive from `session.snapshot()` providers.
    # Manual overrides remain supported as honest channels and are
    # recorded as `cartridge_source: 'manual'` /
    # `model_family_source: 'manual'`.
    [int]$MinLanguages = 0,
    [int]$MinCartridges = 2,
    [int]$MinModelFamilies = 2,
    [string[]]$CartridgesAttempted = @(),
    [string[]]$ModelFamiliesAttempted = @()
)

$ErrorActionPreference = 'Stop'

if ($Turns -lt 1) { throw "Turns must be >= 1 (got $Turns)" }
if (-not $Languages -or $Languages.Count -lt 1) { throw "Languages must contain >= 1 entry" }
if (-not (Test-Path $ExePath)) { throw "ExePath not found: $ExePath" }
if ($MinInspectedEvents -le 0) { $MinInspectedEvents = $Turns }
if ($MinLanguages -le 0) { $MinLanguages = [Math]::Min($Languages.Count, 2) }
if ($MinCartridges -lt 0) { $MinCartridges = 0 }
if ($MinModelFamilies -lt 0) { $MinModelFamilies = 0 }
if ($null -eq $CartridgesAttempted) { $CartridgesAttempted = @() }
if ($null -eq $ModelFamiliesAttempted) { $ModelFamiliesAttempted = @() }

# Locale prompt banks. Round-robin per language so successive turns vary
# the scene-action enough that the sanitiser sees genuinely different
# narrator outputs, not a single sentence echoed N times.
$promptBank = @{
    en = @(
        'I take a slow breath, look around the room, and describe what I see in front of me.',
        'I step forward toward the nearest table and study the items resting on it.',
        'I sit down on the closest chair and try to remember what brought me here.',
        'I lean against the cold stone wall, close my eyes, and listen to the room.',
        'I walk to the window, glance outside, and describe the view in detail.'
    )
    ru = @(
        'Я делаю медленный вдох, оглядываюсь по сторонам и описываю всё, что вижу перед собой.',
        'Я подхожу к ближайшему столу и внимательно изучаю лежащие на нём предметы.',
        'Я сажусь в ближайшее кресло и пытаюсь вспомнить, что привело меня сюда.',
        'Я опираюсь о холодную каменную стену, закрываю глаза и слушаю звуки комнаты.',
        'Я подхожу к окну, выглядываю наружу и подробно описываю то, что вижу.'
    )
}
foreach ($lang in $Languages) {
    if (-not $promptBank.ContainsKey($lang)) {
        throw "No prompt bank for language '$lang'. Supported: $(($promptBank.Keys | Sort-Object) -join ', ')"
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$webServerDir = Join-Path $repoRoot 'packages\web-server'

$runStamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$artifactDir = Join-Path $ArtifactRoot ("{0}-{1}" -f $ArtifactPrefix, $runStamp)
New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null

$logPath = "$env:APPDATA\GreenHaven\logs\desktop.log"
$baseline = if (Test-Path $logPath) { (Get-Item $logPath).Length } else { 0 }

function Now-Iso { (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") }

$driverStartIso = Now-Iso

function Log {
    param([string]$msg)
    $line = "[{0}] {1}" -f (Now-Iso), $msg
    Write-Host $line
    Add-Content -Path "$artifactDir\driver.log" -Value $line -Encoding UTF8
}

function Get-PromptFor {
    param([string]$lang, [int]$idx)
    $bank = $promptBank[$lang]
    return $bank[$idx % $bank.Count]
}

function Invoke-NarrateSanitiserReadinessReport {
    param(
        [string]$Pgdata,
        [int]$Minutes,
        [int]$Limit,
        [string]$WebServerDir
    )
    # Route through cmd.exe so npm/tsx's chatty stderr ("[db] backend=pglite",
    # the npm script-name header) is dropped at the cmd boundary via `2>nul`.
    # Without this, PowerShell 5.1 raises NativeCommandError for any native
    # stderr the child writes, which trips $ErrorActionPreference='Stop' and
    # aborts the function even when JSON was produced on stdout.
    $cmdLine = ('npm --prefix "{0}" run telemetry:report -- narrate-sanitiser --minutes {1} --limit {2} --pgdata "{3}" 2>nul' -f $WebServerDir, $Minutes, $Limit, $Pgdata)
    $raw = cmd /c $cmdLine | Out-String
    $start = $raw.IndexOf('{')
    $end = $raw.LastIndexOf('}')
    if ($start -lt 0 -or $end -lt $start) {
        throw "telemetry-report did not emit JSON. Raw output:`n$raw"
    }
    $jsonText = $raw.Substring($start, $end - $start + 1)
    return @{
        json = $jsonText
        parsed = ($jsonText | ConvertFrom-Json)
    }
}

Log "Driver kind: $ArtifactPrefix"
Log "Artifact dir: $artifactDir"
Log "Repo root: $repoRoot"
Log "Web-server dir: $webServerDir"
Log "EXE path: $ExePath"
Log "AppData pgdata: $Pgdata"
Log "Turns=$Turns Languages=$($Languages -join ',') TurnTimeoutSeconds=$TurnTimeoutSeconds"
Log "Readiness: minutes=$ReadinessMinutes limit=$ReadinessLimit MinInspectedEvents=$MinInspectedEvents"
Log "Policy: MinLanguages=$MinLanguages MinCartridges=$MinCartridges MinModelFamilies=$MinModelFamilies"
Log "Cartridges attempted: $(($CartridgesAttempted) -join ',')"
Log "Model families attempted: $(($ModelFamiliesAttempted) -join ',')"
Log "Baseline desktop.log size: $baseline"

Set-Content -Path "$artifactDir\_meta.txt" -Value @"
DRIVER_KIND=$ArtifactPrefix
DRIVER_START_ISO=$driverStartIso
ARTIFACT_DIR=$artifactDir
EXE_PATH=$ExePath
PGDATA=$Pgdata
TURNS=$Turns
LANGUAGES=$($Languages -join ',')
TURN_TIMEOUT_SECONDS=$TurnTimeoutSeconds
PER_TURN_SLEEP_SECONDS=$PerTurnSleepSeconds
READINESS_MINUTES=$ReadinessMinutes
READINESS_LIMIT=$ReadinessLimit
MIN_INSPECTED_EVENTS=$MinInspectedEvents
MIN_LANGUAGES=$MinLanguages
MIN_CARTRIDGES=$MinCartridges
MIN_MODEL_FAMILIES=$MinModelFamilies
CARTRIDGES_ATTEMPTED=$($CartridgesAttempted -join ',')
MODEL_FAMILIES_ATTEMPTED=$($ModelFamiliesAttempted -join ',')
BASELINE_LOG_SIZE=$baseline
"@ -Encoding UTF8

# 1. Readiness BEFORE — snapshot AppData pgdata while no EXE holds the
# lock. If the EXE is already running from a prior pass, this will fail
# fast with a lock error and the driver aborts.
$readinessBefore = $null
try {
    Log "Capturing readiness BEFORE against $Pgdata"
    $result = Invoke-NarrateSanitiserReadinessReport `
        -Pgdata $Pgdata `
        -Minutes $ReadinessMinutes `
        -Limit $ReadinessLimit `
        -WebServerDir $webServerDir
    Set-Content -Path "$artifactDir\readiness-before.json" -Value $result.json -Encoding UTF8
    $readinessBefore = $result.parsed
    Log ("Readiness BEFORE: inspected_events={0} phase3_total={1} ready_for_phase3={2}" -f `
        $readinessBefore.inspected_events, $readinessBefore.phase3_total, $readinessBefore.ready_for_phase3)
} catch {
    Log "Readiness BEFORE FAILED: $($_.Exception.Message)"
    Set-Content -Path "$artifactDir\readiness-before-error.txt" -Value $_.Exception.Message -Encoding UTF8
    throw
}

# 2. Launch GreenHaven.exe
Log "Launching $ExePath"
$proc = Start-Process -FilePath $ExePath -PassThru
Log "PID=$($proc.Id)"
Add-Content -Path "$artifactDir\_meta.txt" -Value "PID=$($proc.Id)" -Encoding UTF8

# 3. Wait for backend listening URL.
Log "Waiting for backend listening URL (up to 120s)..."
$url = $null
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
    if ((Test-Path $logPath) -and (Get-Item $logPath).Length -gt $baseline) {
        $fs = [System.IO.File]::Open($logPath, 'Open', 'Read', 'ReadWrite')
        try {
            $fs.Position = $baseline
            $reader = New-Object System.IO.StreamReader($fs)
            $newText = $reader.ReadToEnd()
        } finally { $fs.Close() }
        $m = [regex]::Match($newText, 'gemini-web\] listening on (http://127\.0\.0\.1:\d+)')
        if ($m.Success) { $url = $m.Groups[1].Value; break }
    }
    Start-Sleep -Seconds 1
}
if (-not $url) {
    Log "FAIL: backend URL not seen in 120s"
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    throw "Backend never advertised a listening URL"
}
Log "Backend URL: $url"
Add-Content -Path "$artifactDir\_meta.txt" -Value "BACKEND_URL=$url" -Encoding UTF8

# 4. Anonymous player
Log "POST /api/player/anonymous"
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$resp = Invoke-WebRequest -Uri "$url/api/player/anonymous" -Method POST -ContentType 'application/json' -Body '{}' -WebSession $session -UseBasicParsing
$player = $resp.Content | ConvertFrom-Json
$playerId = $player.entity_id
Log "Player entity_id=$playerId"
Set-Content -Path "$artifactDir\player.json" -Value $resp.Content -Encoding UTF8

# 5. Create / resolve session
Log "POST /api/session"
$resp = Invoke-WebRequest -Uri "$url/api/session" -Method POST -ContentType 'application/json' -Body (@{playerId=$playerId} | ConvertTo-Json) -WebSession $session -UseBasicParsing
$sessionResp = $resp.Content | ConvertFrom-Json
$sessionId = $sessionResp.sessionId
Log "Session id=$sessionId"
Set-Content -Path "$artifactDir\session-create.json" -Value $resp.Content -Encoding UTF8

# 6. Submit turns across configured languages.
$cridStamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$turnResults = New-Object System.Collections.ArrayList

for ($i = 1; $i -le $Turns; $i++) {
    $langIdx = ($i - 1) % $Languages.Count
    $lang = $Languages[$langIdx]
    $promptIdx = [Math]::Floor(($i - 1) / $Languages.Count)
    $text = Get-PromptFor $lang $promptIdx
    $crid = "n2-soak-${cridStamp}-${i}"
    Log ("Turn #{0} lang={1} crid={2} : {3}" -f $i, $lang, $crid, $text)

    $body = @{
        text = $text
        playerId = $playerId
        language = $lang
        clientRequestId = $crid
    } | ConvertTo-Json -Compress

    $turnId = $null
    $submitOk = $false
    try {
        $resp = Invoke-WebRequest `
            -Uri "$url/api/session/$sessionId/turn" `
            -Method POST `
            -ContentType 'application/json; charset=utf-8' `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
            -WebSession $session `
            -UseBasicParsing
        $turnResp = $resp.Content | ConvertFrom-Json
        $turnId = $turnResp.turnId
        Log "Turn #$i accepted, turnId=$turnId status=$($resp.StatusCode)"
        Set-Content -Path "$artifactDir\turn-$i-submit.json" -Value $resp.Content -Encoding UTF8
        $submitOk = $true
    } catch {
        Log "Turn #$i submit FAILED: $($_.Exception.Message)"
        Set-Content -Path "$artifactDir\turn-$i-error.txt" -Value $_.Exception.Message -Encoding UTF8
        [void]$turnResults.Add(@{
            idx = $i
            language = $lang
            crid = $crid
            turn_id = $null
            submit_ok = $false
            completed = $false
            terminal_status = 'submit_failed'
            error = $_.Exception.Message
        })
        continue
    }

    # Poll until turn reaches a terminal status or timeout fires.
    $waitDeadline = (Get-Date).AddSeconds($TurnTimeoutSeconds)
    $terminal = $null
    $lastQ = $null
    $errorMsg = $null
    while ((Get-Date) -lt $waitDeadline) {
        Start-Sleep -Seconds 4
        try {
            $q = Invoke-WebRequest -Uri "$url/api/session/$sessionId/turn-queue?history=1&playerId=$playerId" -WebSession $session -UseBasicParsing
            $qj = $q.Content | ConvertFrom-Json
            $lastQ = $q.Content
            $row = @($qj.rows) | Where-Object { $_.turnId -eq $turnId } | Select-Object -First 1
            if ($row -and ($row.status -in @('done', 'failed', 'cancelled'))) {
                $terminal = $row.status
                $errorMsg = $row.error
                break
            }
        } catch {
            Log "Turn #$i queue poll error: $($_.Exception.Message)"
        }
    }
    if ($terminal) {
        Log "Turn #$i terminal status=$terminal error=$errorMsg"
        Set-Content -Path "$artifactDir\turn-$i-final-queue.json" -Value $lastQ -Encoding UTF8
        [void]$turnResults.Add(@{
            idx = $i
            language = $lang
            crid = $crid
            turn_id = $turnId
            submit_ok = $submitOk
            completed = $true
            terminal_status = $terminal
            error = $errorMsg
        })
    } else {
        Log "Turn #$i TIMED OUT after ${TurnTimeoutSeconds}s"
        if ($lastQ) { Set-Content -Path "$artifactDir\turn-$i-timeout-queue.json" -Value $lastQ -Encoding UTF8 }
        [void]$turnResults.Add(@{
            idx = $i
            language = $lang
            crid = $crid
            turn_id = $turnId
            submit_ok = $submitOk
            completed = $false
            terminal_status = 'timeout'
            error = $null
        })
    }

    # Give the post-turn pipeline a few seconds to flush async writes
    # (gameplay-mirror records its diagnostic lines after the narrate
    # tool returns; per-turn `telemetry.flush()` happens at shutdown).
    if ($i -lt $Turns) {
        Start-Sleep -Seconds $PerTurnSleepSeconds
    }
}

# Final drain before capturing snapshots.
Start-Sleep -Seconds 6

# 7. Capture final state
Log "Capturing final messages/events/queue"
try {
    $resp = Invoke-WebRequest -Uri "$url/api/session/$sessionId/messages?playerId=$playerId&limit=400" -WebSession $session -UseBasicParsing
    Set-Content -Path "$artifactDir\messages.json" -Value $resp.Content -Encoding UTF8
} catch { Log "messages capture failed: $($_.Exception.Message)" }

try {
    $resp = Invoke-WebRequest -Uri "$url/api/session/$sessionId/events?playerId=$playerId&limit=2000" -WebSession $session -UseBasicParsing
    Set-Content -Path "$artifactDir\events.json" -Value $resp.Content -Encoding UTF8
} catch { Log "events capture failed: $($_.Exception.Message)" }

try {
    $resp = Invoke-WebRequest -Uri "$url/api/session/$sessionId/turn-queue?history=1&playerId=$playerId" -WebSession $session -UseBasicParsing
    Set-Content -Path "$artifactDir\final-turn-queue.json" -Value $resp.Content -Encoding UTF8
} catch { Log "queue capture failed: $($_.Exception.Message)" }

# 7b. Capture session provider state AFTER turns ran. The
# `/api/session/:id/state` route returns `session.snapshot()` which
# includes `brokerModelId` / `narratorModelId` populated lazily on
# first provider use; reading after at least one `done` turn means
# the fields are stable. We persist the raw response so future
# auditors can see exactly what the desktop bundle exercised.
$sessionStateAfter = $null
$observedModelIds = @()
try {
    Log "Capturing session state AFTER turns ran"
    $resp = Invoke-WebRequest -Uri "$url/api/session/$sessionId/state?playerId=$playerId" -WebSession $session -UseBasicParsing
    Set-Content -Path "$artifactDir\session-state-after.json" -Value $resp.Content -Encoding UTF8
    $sessionStateAfter = $resp.Content | ConvertFrom-Json
    foreach ($key in @('brokerModelId', 'narratorModelId')) {
        $val = $sessionStateAfter.$key
        if ($val -is [string] -and $val.Trim().Length -gt 0) {
            $observedModelIds += $val
        }
    }
    if ($observedModelIds.Count -gt 0) {
        Log ("Observed model ids: {0}" -f ($observedModelIds -join ', '))
    } else {
        Log "Observed model ids: <none — providers not yet initialized>"
    }
} catch {
    Log "session-state capture failed: $($_.Exception.Message)"
}

# 7c. Capture world overview AFTER turns ran. The `/api/world` route
# (no `entity=` query) returns `WorldService.overview()`, including
# `cartridge_meta` keyed by meta key. Reading it after the desktop EXE
# has bootstrapped the cartridge guarantees the loaded cartridge id is
# stable. We persist the raw response so future auditors can confirm
# what cartridge identity was actually exercised, and feed
# `cartridge_meta.cartridge_id.value` into the deletion-readiness gate
# below (replacing the previous self-reported `packaged` default).
$worldOverviewAfter = $null
$observedCartridgeIds = @()
try {
    Log "Capturing world overview AFTER turns ran"
    $resp = Invoke-WebRequest -Uri "$url/api/world" -WebSession $session -UseBasicParsing
    Set-Content -Path "$artifactDir\world-overview-after.json" -Value $resp.Content -Encoding UTF8
    $worldOverviewAfter = $resp.Content | ConvertFrom-Json
    $meta = $worldOverviewAfter.cartridge_meta
    if ($null -ne $meta) {
        $cartridgeEntry = $meta.cartridge_id
        if ($null -ne $cartridgeEntry) {
            $cartridgeVal = $cartridgeEntry.value
            if ($cartridgeVal -is [string] -and $cartridgeVal.Trim().Length -gt 0) {
                $observedCartridgeIds += $cartridgeVal
            }
        }
    }
    if ($observedCartridgeIds.Count -gt 0) {
        Log ("Observed cartridge ids: {0}" -f ($observedCartridgeIds -join ', '))
    } else {
        Log "Observed cartridge ids: <none — cartridge_meta.cartridge_id missing>"
    }
} catch {
    Log "world-overview capture failed: $($_.Exception.Message)"
}

# 8. Stop the GreenHaven process this pass launched. Graceful first
# (CloseMainWindow sends WM_CLOSE; Electron `before-quit`/`quit` runs
# `stopGreenhavenServer` which drains pending telemetry via
# `telemetry.flush()` before `closeDb()`). Force-kill only as a recorded
# fallback.
$gracefulOk = $false
$forceUsed = $false
try {
    $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if ($p) {
        Log "Sending CloseMainWindow to PID=$($proc.Id)"
        $closed = $p.CloseMainWindow()
        Log "CloseMainWindow returned $closed"
        $shutdownDeadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $shutdownDeadline) {
            $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
            if (-not $p) { $gracefulOk = $true; break }
            Start-Sleep -Milliseconds 500
        }
    } else {
        $gracefulOk = $true
    }
} catch {
    Log "Graceful close threw: $($_.Exception.Message)"
}
if (-not $gracefulOk) {
    $forceUsed = $true
    Log "FALLBACK: graceful shutdown did not exit within 15s; using Stop-Process -Force"
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
} else {
    Log "Graceful shutdown completed"
}
$remain = Get-Process -Name "GreenHaven" -ErrorAction SilentlyContinue
$leftoverCount = @($remain).Count
if ($leftoverCount -gt 0) {
    Log "WARN: $leftoverCount GreenHaven proc(s) still running (not killed by this pass)"
} else {
    Log "All GreenHaven processes stopped"
}

# Wait an extra moment for AppData pgdata file handles to fully release
# before the after-snapshot.
Start-Sleep -Seconds 5

# 9. Snapshot desktop.log section for evidence
try {
    $fs = [System.IO.File]::Open($logPath, 'Open', 'Read', 'ReadWrite')
    try {
        $fs.Position = $baseline
        $reader = New-Object System.IO.StreamReader($fs)
        $newLog = $reader.ReadToEnd()
    } finally { $fs.Close() }
    Set-Content -Path "$artifactDir\desktop-log-excerpt.log" -Value $newLog -Encoding UTF8
} catch { Log "desktop.log snapshot failed: $($_.Exception.Message)" }

# 10. Readiness AFTER
$readinessAfter = $null
$readinessAfterError = $null
try {
    Log "Capturing readiness AFTER against $Pgdata"
    $result = Invoke-NarrateSanitiserReadinessReport `
        -Pgdata $Pgdata `
        -Minutes $ReadinessMinutes `
        -Limit $ReadinessLimit `
        -WebServerDir $webServerDir
    Set-Content -Path "$artifactDir\readiness-after.json" -Value $result.json -Encoding UTF8
    $readinessAfter = $result.parsed
    Log ("Readiness AFTER: inspected_events={0} phase3_total={1} ready_for_phase3={2}" -f `
        $readinessAfter.inspected_events, $readinessAfter.phase3_total, $readinessAfter.ready_for_phase3)
} catch {
    $readinessAfterError = $_.Exception.Message
    Log "Readiness AFTER FAILED: $readinessAfterError"
    Set-Content -Path "$artifactDir\readiness-after-error.txt" -Value $readinessAfterError -Encoding UTF8
}

# 11. Compute corrected counts (PowerShell 5.1 quirk: `.Count` on a
# Where-Object pipe returns the property count of the single hashtable
# when only one item flows through; always wrap with @(...).Count.)
$turnsSubmitted = @($turnResults).Count
$turnsTerminal = @($turnResults | Where-Object { $_.completed -eq $true }).Count
$turnsDone = @($turnResults | Where-Object { $_.terminal_status -eq 'done' }).Count
$turnsFailed = @($turnResults | Where-Object { $_.terminal_status -eq 'failed' }).Count
$turnsCancelled = @($turnResults | Where-Object { $_.terminal_status -eq 'cancelled' }).Count
$turnsTimeout = @($turnResults | Where-Object { $_.terminal_status -eq 'timeout' }).Count
$turnsSubmitFailed = @($turnResults | Where-Object { $_.terminal_status -eq 'submit_failed' }).Count

$languagesAttempted = @($turnResults | ForEach-Object { $_.language } | Sort-Object -Unique)
$languagesCompleted = @($turnResults | Where-Object { $_.terminal_status -eq 'done' } | ForEach-Object { $_.language } | Sort-Object -Unique)

$allLanguagesCompleted = $true
foreach ($lang in $Languages) {
    if ($languagesCompleted -notcontains $lang) {
        $allLanguagesCompleted = $false
        break
    }
}

function As-Int($value) {
    if ($null -eq $value) { return 0 }
    try { return [int]$value } catch { return 0 }
}

# Derive `model_families_attempted` from real session evidence when
# the operator did NOT supply `-ModelFamiliesAttempted`. Reuses the
# TypeScript normalization rules via the tiny CLI shim so PS and TS
# cannot drift. `model_family_source` records whether the list came
# from the live session, an operator override, or neither.
$rawObservedModelIds = @($observedModelIds | Sort-Object -Unique)
$manualOverride = ($ModelFamiliesAttempted -is [System.Array] -and $ModelFamiliesAttempted.Count -gt 0)
$modelFamiliesAttempted = @()
$modelFamilySource = 'none'
if ($manualOverride) {
    $modelFamiliesAttempted = @($ModelFamiliesAttempted | Sort-Object -Unique)
    $modelFamilySource = 'manual'
    Log ("model_families_attempted = manual override: {0}" -f ($modelFamiliesAttempted -join ','))
} elseif ($rawObservedModelIds.Count -gt 0) {
    try {
        $idsJson = ConvertTo-Json -Compress -InputObject $rawObservedModelIds
        if ($idsJson -isnot [string]) { $idsJson = '[]' }
        # Single-quote the JSON for cmd; quotes inside model ids are
        # exceedingly unlikely (provider/family ids are bare strings)
        # but escape any double-quotes defensively just in case.
        $idsEscaped = $idsJson -replace '"', '\"'
        $cmdLine = ('npx --no-install tsx "{0}\src\scripts\n2-normalise-model-family.ts" --ids-json "{1}" 2>nul' -f $webServerDir, $idsEscaped)
        $shimOut = cmd /c $cmdLine | Out-String
        $shimStart = $shimOut.IndexOf('{')
        $shimEnd = $shimOut.LastIndexOf('}')
        if ($shimStart -ge 0 -and $shimEnd -gt $shimStart) {
            $shimJson = $shimOut.Substring($shimStart, $shimEnd - $shimStart + 1)
            $shimParsed = $shimJson | ConvertFrom-Json
            if ($shimParsed.normalized -is [System.Array] -and $shimParsed.normalized.Count -gt 0) {
                $modelFamiliesAttempted = @($shimParsed.normalized | Sort-Object -Unique)
                $modelFamilySource = 'session_state'
                Log ("model_families_attempted = derived from session state: {0}" -f ($modelFamiliesAttempted -join ','))
            } else {
                Log "model-family shim produced empty normalized list"
            }
        } else {
            Log ("model-family shim produced no JSON. Raw output:`n{0}" -f $shimOut)
        }
    } catch {
        Log "model-family normalization threw: $($_.Exception.Message)"
    }
} else {
    Log "model_families_attempted left empty (no session state, no manual override)"
}

# Derive `cartridges_attempted` from real world-overview evidence when
# the operator did NOT supply `-CartridgesAttempted`. The shim runs in
# `--kind cartridge` mode so the same TypeScript helper that drops
# non-string / empty / whitespace entries is used. `cartridge_source`
# records the provenance: `manual` (operator override), `world_overview`
# (live API), or `none` (no observed evidence — the deletion gate stays
# blocked, NEVER auto-filled to `packaged`).
$rawObservedCartridgeIds = @($observedCartridgeIds | Sort-Object -Unique)
$cartridgeManualOverride = ($CartridgesAttempted -is [System.Array] -and $CartridgesAttempted.Count -gt 0)
$cartridgesAttempted = @()
$cartridgeSource = 'none'
if ($cartridgeManualOverride) {
    $cartridgesAttempted = @($CartridgesAttempted | Sort-Object -Unique)
    $cartridgeSource = 'manual'
    Log ("cartridges_attempted = manual override: {0}" -f ($cartridgesAttempted -join ','))
} elseif ($rawObservedCartridgeIds.Count -gt 0) {
    try {
        $cartIdsJson = ConvertTo-Json -Compress -InputObject $rawObservedCartridgeIds
        if ($cartIdsJson -isnot [string]) { $cartIdsJson = '[]' }
        $cartIdsEscaped = $cartIdsJson -replace '"', '\"'
        $cartCmdLine = ('npx --no-install tsx "{0}\src\scripts\n2-normalise-model-family.ts" --kind cartridge --ids-json "{1}" 2>nul' -f $webServerDir, $cartIdsEscaped)
        $cartShimOut = cmd /c $cartCmdLine | Out-String
        $cartShimStart = $cartShimOut.IndexOf('{')
        $cartShimEnd = $cartShimOut.LastIndexOf('}')
        if ($cartShimStart -ge 0 -and $cartShimEnd -gt $cartShimStart) {
            $cartShimJson = $cartShimOut.Substring($cartShimStart, $cartShimEnd - $cartShimStart + 1)
            $cartShimParsed = $cartShimJson | ConvertFrom-Json
            if ($cartShimParsed.normalized -is [System.Array] -and $cartShimParsed.normalized.Count -gt 0) {
                $cartridgesAttempted = @($cartShimParsed.normalized | Sort-Object -Unique)
                $cartridgeSource = 'world_overview'
                Log ("cartridges_attempted = derived from world overview: {0}" -f ($cartridgesAttempted -join ','))
            } else {
                Log "cartridge shim produced empty normalized list"
            }
        } else {
            Log ("cartridge shim produced no JSON. Raw output:`n{0}" -f $cartShimOut)
        }
    } catch {
        Log "cartridge normalization threw: $($_.Exception.Message)"
    }
} else {
    Log "cartridges_attempted left empty (no world overview, no manual override) — deletion gate stays blocked"
}

$beforeInspected = As-Int ($readinessBefore.inspected_events)
$beforePhase3 = As-Int ($readinessBefore.phase3_total)
$afterInspected = if ($readinessAfter) { As-Int ($readinessAfter.inspected_events) } else { 0 }
$afterPhase3 = if ($readinessAfter) { As-Int ($readinessAfter.phase3_total) } else { 0 }
$newInspected = $afterInspected - $beforeInspected
$newPhase3 = $afterPhase3 - $beforePhase3

$readyForPhase3Gate = if ($readinessAfter -and $readinessAfter.ready_for_phase3 -eq $true) { $true } else { $false }

# Apply the deletion-readiness policy. Mirrors
# `packages/web-server/src/devtools/narrateSanitiserDeletionReadiness.ts`
# so the soak driver and the artifact-only CLI produce identical
# decisions. The TS module is the canonical source of truth for the
# semantics; this block exists so the PS driver can emit the verdict
# without launching tsx at run time.
$soakBlockers = New-Object System.Collections.ArrayList
if (-not $readyForPhase3Gate) { [void]$soakBlockers.Add('readiness_gate_not_passing') }
if ($newInspected -lt $MinInspectedEvents) { [void]$soakBlockers.Add("new_inspected_events_below_min:$newInspected/$MinInspectedEvents") }
if ($newPhase3 -ne 0) { [void]$soakBlockers.Add("new_phase3_total_nonzero:$newPhase3") }
if ($turnsFailed -gt 0) { [void]$soakBlockers.Add("turns_failed:$turnsFailed") }
if ($turnsCancelled -gt 0) { [void]$soakBlockers.Add("turns_cancelled:$turnsCancelled") }
if ($turnsTimeout -gt 0) { [void]$soakBlockers.Add("turns_timeout:$turnsTimeout") }
if ($turnsSubmitFailed -gt 0) { [void]$soakBlockers.Add("turns_submit_failed:$turnsSubmitFailed") }
if ($forceUsed) { [void]$soakBlockers.Add('shutdown_force_fallback_used') }

$missingLanguages = @($Languages | Where-Object { $languagesCompleted -notcontains $_ })
if ($missingLanguages.Count -gt 0) { [void]$soakBlockers.Add("languages_not_completed:$($missingLanguages -join ',')") }
$distinctLanguagesCompleted = @($languagesCompleted | Sort-Object -Unique).Count
if ($distinctLanguagesCompleted -lt $MinLanguages) { [void]$soakBlockers.Add("languages_completed_below_min:$distinctLanguagesCompleted/$MinLanguages") }

$distinctCartridges = @($cartridgesAttempted | Sort-Object -Unique).Count
$distinctModelFamilies = @($modelFamiliesAttempted | Sort-Object -Unique).Count
$localSoakPassed = ($soakBlockers.Count -eq 0)

$deletionBlockers = New-Object System.Collections.ArrayList
foreach ($b in $soakBlockers) { [void]$deletionBlockers.Add($b) }
if ($distinctCartridges -lt $MinCartridges) { [void]$deletionBlockers.Add("cartridges_attempted_below_min:$distinctCartridges/$MinCartridges") }
if ($distinctModelFamilies -lt $MinModelFamilies) { [void]$deletionBlockers.Add("model_families_attempted_below_min:$distinctModelFamilies/$MinModelFamilies") }

$readyForRegexDeletion = ($deletionBlockers.Count -eq 0)

$driverEndIso = Now-Iso

$summary = [ordered]@{
    artifact_dir = $artifactDir
    driver_kind = $ArtifactPrefix
    driver_start_iso = $driverStartIso
    driver_end_iso = $driverEndIso
    backend_url = $url
    player_entity_id = $playerId
    session_id = $sessionId
    configured = [ordered]@{
        turns = $Turns
        languages = $Languages
        artifact_root = $ArtifactRoot
        exe_path = $ExePath
        pgdata = $Pgdata
        readiness_minutes = $ReadinessMinutes
        readiness_limit = $ReadinessLimit
        turn_timeout_seconds = $TurnTimeoutSeconds
        per_turn_sleep_seconds = $PerTurnSleepSeconds
        min_inspected_events = $MinInspectedEvents
    }
    policy = [ordered]@{
        min_inspected_events = $MinInspectedEvents
        min_languages = $MinLanguages
        min_cartridges = $MinCartridges
        min_model_families = $MinModelFamilies
    }
    cartridges_attempted = @($cartridgesAttempted)
    cartridges_attempted_raw = @($rawObservedCartridgeIds)
    cartridge_source = $cartridgeSource
    world_overview_after = $worldOverviewAfter
    model_families_attempted = @($modelFamiliesAttempted)
    model_families_attempted_raw = @($rawObservedModelIds)
    model_family_source = $modelFamilySource
    session_state_after = $sessionStateAfter
    languages_attempted = $languagesAttempted
    languages_completed = $languagesCompleted
    all_languages_completed = $allLanguagesCompleted
    turns_submitted = $turnsSubmitted
    turns_terminal = $turnsTerminal
    turns_done = $turnsDone
    turns_failed = $turnsFailed
    turns_cancelled = $turnsCancelled
    turns_timeout = $turnsTimeout
    turns_submit_failed = $turnsSubmitFailed
    turn_results = @($turnResults)
    shutdown_graceful = $gracefulOk
    shutdown_force_fallback_used = $forceUsed
    readiness_before = $readinessBefore
    readiness_after = $readinessAfter
    readiness_after_error = $readinessAfterError
    new_inspected_events = $newInspected
    new_phase3_total = $newPhase3
    ready_for_phase3_gate = $readyForPhase3Gate
    local_soak_passed = $localSoakPassed
    soak_blockers = @($soakBlockers)
    deletion_blockers = @($deletionBlockers)
    ready_for_regex_deletion = $readyForRegexDeletion
    observed = [ordered]@{
        distinct_languages_completed = $distinctLanguagesCompleted
        distinct_cartridges_attempted = $distinctCartridges
        distinct_model_families_attempted = $distinctModelFamilies
    }
}
Set-Content -Path "$artifactDir\driver-summary.json" -Value ($summary | ConvertTo-Json -Depth 8) -Encoding UTF8

Log ("DONE submitted={0} terminal={1} done={2} failed={3} cancelled={4} timeout={5} submit_failed={6} new_inspected={7} new_phase3={8} graceful_shutdown={9} local_soak_passed={10} ready_for_regex_deletion={11} cartridge_source={12} distinct_cartridges={13} model_family_source={14} distinct_model_families={15}" -f `
    $turnsSubmitted, $turnsTerminal, $turnsDone, $turnsFailed, $turnsCancelled, $turnsTimeout, $turnsSubmitFailed, `
    $newInspected, $newPhase3, $gracefulOk, $localSoakPassed, $readyForRegexDeletion, $cartridgeSource, $distinctCartridges, $modelFamilySource, $distinctModelFamilies)
if ($soakBlockers.Count -gt 0) { Log ("soak_blockers={0}" -f ($soakBlockers -join '|')) }
if ($deletionBlockers.Count -gt 0) { Log ("deletion_blockers={0}" -f ($deletionBlockers -join '|')) }
Write-Output "ARTIFACT_DIR=$artifactDir"
