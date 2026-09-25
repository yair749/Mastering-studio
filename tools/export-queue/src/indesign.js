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

export class InDesignError extends Error {
    constructor(message, { timedOut = false, details = "" } = {}) {
        super(message);
        this.timedOut = timedOut;
        this.details = details;
    }
}

class Lock {
    #tail = Promise.resolve();
    run(fn) {
        const result = this.#tail.then(fn, fn);
        this.#tail = result.catch(() => {});
        return result;
    }
}

// ExtendScript is ES3: JSON is read with eval, and ES3 treats U+2028/U+2029 inside strings
// as line breaks, so escape them. The file is written only by this server.
function toExtendScriptJson(value) {
    return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function createInDesign(config, log) {
    const lock = new Lock();
    const tmpDir = path.join(config.dataDir, "tmp");
    const scriptsDir = path.join(config.appDir, "scripts");
    const { executor, progId, killInDesignOnTimeout } = config.indesign;

    async function runReal(payload, timeoutMs) {
        await fs.mkdir(tmpDir, { recursive: true });
        const id = randomUUID();
        const jobFile = path.join(tmpDir, `${id}.job.json`);
        const resultFile = path.join(tmpDir, `${id}.result.json`);
        await fs.writeFile(jobFile, toExtendScriptJson({ ...payload, resultPath: resultFile }), "utf8");

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
                child.stderr.on("data", (d) => { if (err.length < 20_000) err += d; });
                child.stdout.resume();
                const timer = setTimeout(() => {
                    timedOut = true;
                    child.kill();
                    if (killInDesignOnTimeout) {
                        log.warn(`InDesign did not finish within ${Math.round(timeoutMs / 60000)} min; restarting InDesign.`);
                        execFile("taskkill", ["/IM", "InDesign.exe", "/T", "/F"], { windowsHide: true }, () => {});
                    }
                }, timeoutMs);
                child.on("error", (e) => { clearTimeout(timer); reject(new InDesignError(`Could not start PowerShell: ${e.message}`)); });
                child.on("close", (c) => { clearTimeout(timer); resolve({ code: c, stderr: err.trim(), timedOut }); });
            });

            if (timedOut) {
                throw new InDesignError(
                    `InDesign did not finish within ${Math.round(timeoutMs / 60000)} minutes.` +
                    (killInDesignOnTimeout ? " InDesign was closed so the queue can continue." : " InDesign may need to be restarted on the export PC."),
                    { timedOut: true },
                );
            }
            let result;
            try {
                result = JSON.parse(await fs.readFile(resultFile, "utf8"));
            } catch {
                throw new InDesignError(
                    stderr ? `InDesign could not run the export: ${stderr}` : `InDesign exited without reporting a result (code ${code}).`,
                    { details: stderr },
                );
            }
            return result;
        } finally {
            await Promise.allSettled([fs.rm(jobFile, { force: true }), fs.rm(resultFile, { force: true })]);
        }
    }

    async function runSimulated(payload) {
        const delay = Number(process.env.EXPORT_QUEUE_SIMULATE_MS ?? 200);
        await new Promise((r) => setTimeout(r, delay));
        if (payload.action === "listPresets") {
            return { ok: true, indesignVersion: "simulated", presets: ["[High Quality Print]", "[Press Quality]", "[PDF/X-1a:2001]", "[PDF/X-4:2008]", "[Smallest File Size]"] };
        }
        const name = path.basename(payload.sourcePath);
        if (name.includes("simulate-fail")) return { ok: false, error: "Simulated InDesign error.", warnings: [], outputs: [] };
        if (name.includes("simulate-hang")) throw new InDesignError("InDesign did not finish within 1 minutes.", { timedOut: true });
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
        return { ok: true, warnings, outputs: [{ path: payload.outputPath, bytes: 17, kind: "file" }] };
    }

    function run(payload, timeoutMs) {
        return lock.run(() => (executor === "simulate" ? runSimulated(payload) : runReal(payload, timeoutMs)));
    }

    return {
        executor,
        exportJob: (payload) => run({ action: "export", ...payload }, config.indesign.jobTimeoutMinutes * 60_000),
        listPresets: () => run({ action: "listPresets" }, 3 * 60_000),
    };
}
