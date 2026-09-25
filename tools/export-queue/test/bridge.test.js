// Tests the real InDesign bridge code (src/indesign.js "indesign" mode) with a fake
// powershell.exe that behaves like run-indesign.ps1 in each situation. Skipped on Windows,
// where the real powershell.exe would be found first.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createInDesign } from "../src/indesign.js";
import { createLogger } from "../src/log.js";

const skip = process.platform === "win32" ? "uses a fake powershell.exe (not on Windows)" : false;

function setup(mode, timeoutMinutes = 1) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    // Fake bridge: finds -JobFile, reads resultPath from it, then acts according to FAKE_MODE.
    fs.writeFileSync(path.join(bin, "powershell.exe"), `#!/usr/bin/env node
const args = process.argv.slice(2);
const val = (k) => args[args.indexOf(k) + 1];
const fs = require("fs");
const job = eval("(" + fs.readFileSync(val("-JobFile"), "utf8") + ")");
fs.writeFileSync(${JSON.stringify(path.join(dir, "seen.json"))}, JSON.stringify({ args, job }));
const mode = process.env.FAKE_MODE;
if (mode === "ok") { fs.writeFileSync(job.resultPath, JSON.stringify({ ok: true, outputs: [{ path: job.outputPath, bytes: 5, kind: "file" }], warnings: [] })); process.exit(0); }
if (mode === "indesign-error") { fs.writeFileSync(job.resultPath, JSON.stringify({ ok: false, error: "Cannot open file", outputs: [], warnings: [] })); process.exit(0); }
if (mode === "no-indesign") { process.stderr.write("Could not start or connect to InDesign (InDesign.Application)."); process.exit(3); }
if (mode === "no-result") process.exit(0);
if (mode === "hang") setTimeout(() => {}, 600000);
`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    process.env.FAKE_MODE = mode;
    const config = {
        appDir: path.resolve(import.meta.dirname, ".."),
        dataDir: path.join(dir, "data"),
        indesign: { executor: "indesign", progId: "InDesign.Application.2026", jobTimeoutMinutes: timeoutMinutes, killInDesignOnTimeout: true },
    };
    return { dir, indesign: createInDesign(config, createLogger(null, { quiet: true })) };
}

const payload = { sourcePath: "\\\\NAS\\Projects\\Poster.indd", outputPath: "\\\\NAS\\Projects\\Poster.pdf", format: "pdf-print", pdfPreset: "[High Quality Print] " };

test("passes the job file, script and ProgID to the bridge and returns InDesign's result", { skip }, async () => {
    const { dir, indesign } = setup("ok");
    const result = await indesign.exportJob(payload);
    assert.equal(result.ok, true);
    const seen = JSON.parse(fs.readFileSync(path.join(dir, "seen.json"), "utf8"));
    assert.equal(seen.args[seen.args.indexOf("-ProgId") + 1], "InDesign.Application.2026");
    assert.match(seen.args[seen.args.indexOf("-ScriptFile") + 1], /scripts[\\/]indesign-worker\.jsx$/);
    assert.equal(seen.job.action, "export");
    assert.equal(seen.job.pdfPreset, payload.pdfPreset, "U+2028 survives the ES3-safe encoding");
    assert.deepEqual(fs.readdirSync(path.join(dir, "data", "tmp")), [], "job and result files cleaned up");
});

test("InDesign's own error message is passed on", { skip }, async () => {
    const { indesign } = setup("indesign-error");
    const result = await indesign.exportJob(payload);
    assert.equal(result.ok, false);
    assert.equal(result.error, "Cannot open file");
});

test("problems reaching InDesign, or no result, become clear errors", { skip }, async () => {
    // Exit code 3 = InDesign couldn't be reached: flagged so the queue keeps the job waiting instead of failing it.
    await assert.rejects(setup("no-indesign").indesign.exportJob(payload), (e) => e.unreachable === true && /Could not start or connect to InDesign/.test(e.message));
    await assert.rejects(setup("no-result").indesign.exportJob(payload), /exited without reporting a result/);
});

test("a hung InDesign is stopped after the timeout and the next call still works", { skip }, async () => {
    const { indesign } = setup("hang", 0.02);     // ~1.2 s
    const started = Date.now();
    await assert.rejects(indesign.exportJob(payload), (e) => e.timedOut && /did not finish/.test(e.message));
    assert.ok(Date.now() - started < 10_000);
    process.env.FAKE_MODE = "ok";
    assert.equal((await indesign.exportJob(payload)).ok, true, "the lock is released after a timeout");
});

test("calls are serialised: a second call waits for the first", { skip }, async () => {
    const { indesign } = setup("ok");
    const order = [];
    await Promise.all([
        indesign.exportJob(payload).then(() => order.push("export")),
        indesign.listPresets().then(() => order.push("presets")),
    ]);
    assert.deepEqual(order, ["export", "presets"]);
});
