// Runs ExtendScript inside Adobe InDesign on this PC.
//
// Real mode (Windows): Node -> powershell.exe scripts/run-indesign.ps1 -> InDesign COM
// "DoScript" -> scripts/indesign-worker.jsx. The job goes in as a JSON file, the result comes back as a
// JSON file, so nothing depends on parsing console output. All calls are serialised through
// one lock: InDesign runs one script at a time, and a second call would block anyway.
//
// Simulate mode: a stand-in for machines without InDesign (development and the test suite).
// It is never used unless config.indesign.executor is "simulate".
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Exit code of run-indesign.ps1 when InDesign couldn't be started or reached at all (the
// script never ran), as opposed to 4: InDesign ran the script and it stopped with an error.
const BRIDGE_UNREACHABLE = 3;

export class InDesignError extends Error {
    constructor(message, { timedOut = false, unreachable = false, details = "" } = {}) {
        super(message);
        this.timedOut = timedOut;
        this.unreachable = unreachable;
        this.details = details;
    }
}

// Calls run one after another. `fn` may call hold(promise) to keep the next call waiting after
// its own result is returned, e.g. until a force-closed InDesign has really gone.
class Lock {
    #tail = Promise.resolve();
    run(fn) {
        let held = null;
        const result = this.#tail.then(() => fn((p) => { held = p; }));
        this.#tail = result.then(() => held, () => held).catch(() => {});
        return result;
    }
}

// ExtendScript is ES3: JSON is read with eval, and ES3 treats U+2028/U+2029 inside strings
// as line breaks, so escape them. The file is written only by this server.
function toExtendScriptJson(value) {
    return JSON.stringify(value).replace(/ /g, "\\u2028").replace(/ /g, "\\u2029");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_TIMINGS = {
    presetTimeoutMs: 10 * 60_000,   // a cold start after updates can take minutes; never killed
    killWaitMs: 60_000,             // how long to wait for a force-closed InDesign to disappear
    killPollMs: 1_000,
    killSettleMs: 5_000,            // then a little longer, so the next start doesn't attach to a dying process
};

export function createInDesign(config, log, { timings = {} } = {}) {
    const t = { ...DEFAULT_TIMINGS, ...timings };
    const lock = new Lock();
    const tmpDir = path.join(config.dataDir, "tmp");
    const scriptsDir = path.join(config.appDir, "scripts");
    const { executor, progId, killInDesignOnTimeout } = config.indesign;

    // What the export PC's InDesign last did, for the dashboard header and /api/health.
    let state = { state: "unknown", version: null, lastOkAt: null, lastError: null };
    const listeners = new Set();
    function record(action, change) {
        const prev = state;
        state = { ...state, ...change };
        if (prev.state !== state.state || prev.version !== state.version || prev.lastError !== state.lastError) {
            for (const fn of listeners) {
                try { fn(state, prev, action); } catch (err) { log.error(`InDesign status listener failed: ${err.stack || err.message}`); }
            }
        }
    }
    const reached = (action, version) => record(action, { state: "ok", version: version ? String(version) : state.version, lastOkAt: Date.now(), lastError: null });

    function execQuiet(file, args, timeout) {
        return new Promise((resolve) => {
            execFile(file, args, { windowsHide: true, timeout }, (err, stdout) => resolve({ err, stdout: String(stdout || "") }));
        });
    }

    // After a forced close, InDesign.exe can take a while to exit. A new job started meanwhile
    // attaches to the dying process and fails with an unrelated "RPC server is unavailable".
    async function closeInDesignAndWait() {
        await execQuiet("taskkill", ["/IM", "InDesign.exe", "/T", "/F"], 15_000);
        const deadline = Date.now() + t.killWaitMs;
        for (;;) {
            const { err, stdout } = await execQuiet("tasklist", ["/FI", "IMAGENAME eq InDesign.exe", "/NH", "/FO", "CSV"], 15_000);
            if (err) {
                log.warn(`Could not check whether InDesign has closed (${err.code || err.message}); waiting ${Math.round(t.killSettleMs / 1000)} s.`);
                break;
            }
            if (!/"InDesign\.exe"/i.test(stdout)) break;
            if (Date.now() >= deadline) {
                log.warn(`InDesign was still closing after ${Math.round(t.killWaitMs / 1000)} s; carrying on.`);
                break;
            }
            await sleep(t.killPollMs);
        }
        await sleep(t.killSettleMs);
    }

    async function runReal(payload, timeoutMs, hold) {
        await fs.mkdir(tmpDir, { recursive: true });
        const id = randomUUID();
        const jobFile = path.join(tmpDir, `${id}.job.json`);
        const resultFile = path.join(tmpDir, `${id}.result.json`);
        await fs.writeFile(jobFile, toExtendScriptJson({ ...payload, resultPath: resultFile }), "utf8");
        const minutes = Math.max(1, Math.round(timeoutMs / 60000));

        try {
            const { code, stderr, timedOut } = await new Promise((resolve, reject) => {
                const child = spawn("powershell.exe", [
                    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                    "-File", path.join(scriptsDir, "run-indesign.ps1"),
                    "-ScriptFile", path.join(scriptsDir, "indesign-worker.jsx"),
                    "-JobFile", jobFile,
                    "-ProgId", progId,
                ], { windowsHide: true });
                let err = "";
                let timedOut = false;
                let settled = false;
                const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
                child.stderr.on("data", (d) => { if (err.length < 20_000) err += d; });
                child.stdout.resume();
                const timer = setTimeout(() => {
                    timedOut = true;
                    child.kill();
                    // If PowerShell doesn't go away, don't wait for its "close" forever.
                    setTimeout(() => done({ code: null, stderr: err.trim(), timedOut }), 10_000).unref();
                }, timeoutMs);
                child.on("error", (e) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    reject(new InDesignError(`Could not start PowerShell: ${e.message}`));
                });
                child.on("close", (c) => done({ code: c, stderr: err.trim(), timedOut }));
            });

            if (timedOut) {
                if (payload.action === "listPresets") {
                    // Usually InDesign is still starting (after a reboot or an update) or busy with
                    // a dialog; closing it here would only make the next start slower.
                    record(payload.action, { state: "unreachable", lastError: "InDesign didn't answer (still starting, or showing a message on the export PC's screen)." });
                    throw new InDesignError("InDesign is still starting or busy. Try again in a minute.", { timedOut: true });
                }
                record(payload.action, { lastError: `An export didn't finish within ${minutes} minutes.` });
                if (killInDesignOnTimeout) {
                    log.warn(`InDesign did not finish within ${minutes} min; closing InDesign so the queue can continue.`);
                    hold(closeInDesignAndWait());
                }
                throw new InDesignError(
                    `InDesign did not finish within ${minutes} minutes.` +
                    (killInDesignOnTimeout ? " InDesign was closed so the queue can continue." : " InDesign may need to be restarted on the export PC."),
                    { timedOut: true },
                );
            }
            let result;
            try {
                result = JSON.parse(await fs.readFile(resultFile, "utf8"));
            } catch {
                if (code === BRIDGE_UNREACHABLE) {
                    const reason = stderr || "Could not start or connect to InDesign.";
                    record(payload.action, { state: "unreachable", lastError: reason });
                    throw new InDesignError(reason, { unreachable: true, details: stderr });
                }
                const message = stderr ? `InDesign could not run the export: ${stderr}` : `InDesign exited without reporting a result (code ${code}).`;
                record(payload.action, { lastError: message });
                throw new InDesignError(message, { details: stderr });
            }
            reached(payload.action, result?.indesignVersion);
            return result;
        } finally {
            await Promise.allSettled([fs.rm(jobFile, { force: true }), fs.rm(resultFile, { force: true })]);
        }
    }

    // Test hooks (file names): "simulate-unreachable" = InDesign can't be reached for the first
    // two attempts of that job, "simulate-slow" = takes 3 s, "simulate-fail", "simulate-hang",
    // "simulate-missing" = missing link and font.
    const attempts = new Map();
    async function runSimulated(payload) {
        const name = payload.sourcePath ? path.basename(String(payload.sourcePath).replace(/\\/g, "/")) : "";
        await sleep(name.includes("simulate-slow") ? 3000 : Number(process.env.EXPORT_QUEUE_SIMULATE_MS ?? 200));
        if (payload.action === "listPresets") {
            reached(payload.action, "simulated");
            return { ok: true, indesignVersion: "simulated", presets: ["[High Quality Print]", "[Press Quality]", "[PDF/X-1a:2001]", "[PDF/X-4:2008]", "[Smallest File Size]"] };
        }
        if (name.includes("simulate-unreachable")) {
            const key = payload.jobId ?? payload.sourcePath;
            const n = (attempts.get(key) ?? 0) + 1;
            attempts.set(key, n);
            if (n <= 2) {
                const reason = "Could not start or connect to InDesign (simulated).";
                record(payload.action, { state: "unreachable", lastError: reason });
                throw new InDesignError(reason, { unreachable: true });
            }
        }
        if (name.includes("simulate-hang")) {
            record(payload.action, { lastError: "An export didn't finish within 1 minutes." });
            throw new InDesignError("InDesign did not finish within 1 minutes.", { timedOut: true });
        }
        reached(payload.action, "simulated");
        if (name.includes("simulate-fail")) return { ok: false, error: "Simulated InDesign error.", warnings: [], outputs: [] };
        const warnings = name.includes("simulate-missing") ? ["Missing link: hero.psd", "Missing font: Brand Sans Bold"] : [];
        if (payload.failOnMissing && warnings.length) {
            return { ok: false, error: "The document has missing links or fonts (see warnings).", warnings, outputs: [] };
        }
        if (payload.format === "package") {
            await fs.mkdir(path.join(payload.outputPath, "Links"), { recursive: true });
            await fs.writeFile(path.join(payload.outputPath, name), "simulated package");
            return { ok: true, warnings, outputs: [{ path: payload.outputPath, bytes: 0, kind: "folder" }] };
        }
        await fs.writeFile(payload.outputPath, `simulated ${payload.format} export`);
        const { size } = await fs.stat(payload.outputPath);
        return { ok: true, warnings, outputs: [{ path: payload.outputPath, bytes: size, kind: "file" }] };
    }

    function run(payload, timeoutMs) {
        return lock.run((hold) => (executor === "simulate" ? runSimulated(payload) : runReal(payload, timeoutMs, hold)));
    }

    return {
        executor,
        exportJob: (payload) => run({ action: "export", ...payload }, config.indesign.jobTimeoutMinutes * 60_000),
        listPresets: () => run({ action: "listPresets" }, t.presetTimeoutMs),
        state: () => ({ ...state }),
        // fn(next, previous, action) whenever InDesign's state, version or last error changes.
        onChange(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
