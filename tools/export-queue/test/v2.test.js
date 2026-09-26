// End-to-end tests of the v2 features: batch submission, live path checks, file browser,
// downloads, preset validation, InDesign-unreachable pausing, admin controls, health.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ConfigError, loadConfig, validateConfig } from "../src/config.js";
import { pickLanUrl } from "../src/lanurl.js";
import { createLogger } from "../src/log.js";
import { createApp } from "../src/server.js";

process.env.EXPORT_QUEUE_SIMULATE_MS = "40";
const APP_DIR = path.resolve(import.meta.dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEnv(extra = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "export-queue-v2-"));
    const mega = path.join(root, "MG_Mega");
    const agency = path.join(root, "One Agency");
    const files = [
        "2026/Spring Campaign/Poster A1.indd", "2026/Spring Campaign/Flyer.indd", "2026/Spring Campaign/._Poster A1.indd",
        "2026/Spring Campaign/.DS_Store", "2026/Spring Campaign/~Poster A1~lock.idlk", "2026/Spring Campaign/notes.pdf",
        "2026/Job 10/Ad.indd", "2026/Job 9/Ad.indd", "2026/#recycle/Old.indd", "Café Menü.indd",
        "simulate-unreachable Brochure.indd", "simulate-fail Banner.indd",
    ];
    for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(mega, f)), { recursive: true });
        fs.writeFileSync(path.join(mega, f), "indd");
    }
    fs.mkdirSync(path.join(agency, "Out"), { recursive: true });
    fs.writeFileSync(path.join(agency, "Logo.indd"), "indd");
    const config = validateConfig({
        port: 1,
        allowedRoots: [mega, agency],
        drives: [{ name: "MG_Mega", path: mega, letter: "M:" }, { name: "One Agency", path: agency, letter: "N:" }],
        pathMappings: [{ from: "/Volumes/MG_Mega", to: mega }, { from: "/Volumes/One Agency", to: agency }],
        indesign: { executor: "simulate" },
        dataDir: path.join(root, "data"),
        ...extra,
    }, APP_DIR);
    return { root, mega, agency, config };
}

async function startServer(env, appOptions = {}) {
    const log = createLogger(null, { quiet: true });
    const { app, worker, store, events } = createApp(env.config, {
        log, platform: "posix", timings: { unreachableRetryMs: 150, pollMs: 50, driveCheckMs: 60_000 }, ...appOptions,
    });
    worker.start();
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const call = async (method, url, body, headers = {}) => {
        const res = await fetch(base + url, {
            method, headers: { "Content-Type": "application/json", ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, body: json, text, headers: res.headers };
    };
    const waitFor = async (id, statuses = ["completed", "failed", "cancelled"], tries = 300) => {
        for (let i = 0; i < tries; i++) {
            const { body } = await call("GET", `/jobs/${id}`);
            if (statuses.includes(body.status)) return body;
            await sleep(20);
        }
        throw new Error(`job ${id} did not reach ${statuses}`);
    };
    const stop = async () => {
        events.close();
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
        await worker.stop();
        store.close();
    };
    return { base, call, waitFor, stop, store, worker };
}

const job = (over = {}) => ({
    submittedBy: "Dana",
    sourcePaths: ["/Volumes/MG_Mega/2026/Spring Campaign/Poster A1.indd"],
    formats: ["pdf-print"],
    pdfPreset: "[High Quality Print]",
    pageRange: "All",
    useDocumentBleed: true,
    ...over,
});

let env, srv;
before(async () => {
    env = makeEnv();
    srv = await startServer(env);
    for (let i = 0; i < 100 && !(await srv.call("GET", "/presets")).body.presets.length; i++) await sleep(20);
});
after(async () => { await srv.stop(); fs.rmSync(env.root, { recursive: true, force: true }); });

test("several files x several formats become one job each, in order, with one batch id", async () => {
    const res = await srv.call("POST", "/jobs", job({
        sourcePaths: ["/Volumes/MG_Mega/2026/Spring Campaign/Poster A1.indd", "/Volumes/One Agency/Logo.indd"],
        formats: ["pdf-print", "idml"],
    }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const jobs = res.body.jobs;
    assert.equal(jobs.length, 4);
    assert.deepEqual(jobs.map((j) => [path.basename(j.sourcePath), j.format]),
        [["Poster A1.indd", "pdf-print"], ["Poster A1.indd", "idml"], ["Logo.indd", "pdf-print"], ["Logo.indd", "idml"]]);
    assert.equal(new Set(jobs.map((j) => j.batchId)).size, 1);
    assert.ok(jobs[0].batchId);
    assert.equal(jobs[2].drive.name, "One Agency");
    const done = await Promise.all(jobs.map((j) => srv.waitFor(j.id)));
    assert.ok(done.every((j) => j.status === "completed"), JSON.stringify(done.map((j) => j.error)));
});

test("a batch with one bad path creates nothing and says which line is wrong", async () => {
    const before = srv.store.counts();
    const res = await srv.call("POST", "/jobs", job({
        sourcePaths: ["/Volumes/MG_Mega/2026/Spring Campaign/Flyer.indd", "/Volumes/MG_Mega/nope.indd", "/Volumes/MG_Mega/2026/Spring Campaign/Flyer.indd"],
    }));
    assert.equal(res.status, 422);
    assert.deepEqual(res.body.pathErrors.map((e) => e.index), [1, 2]);
    assert.match(res.body.pathErrors[1].message, /same file as line 1/);
    assert.deepEqual(srv.store.counts(), before, "nothing queued");
});

test("path and preset problems are reported together, the preset must be installed", async () => {
    const res = await srv.call("POST", "/jobs", job({ sourcePaths: ["/Users/dana/Desktop/Poster.indd"], pdfPreset: "[Magazine Ads]" }));
    assert.equal(res.status, 422);
    assert.match(res.body.errors.pdfPreset, /isn't installed on the export PC/);
    assert.match(res.body.errors.sourcePaths ?? res.body.errors.sourcePath, /your own computer/);
});

test("the live check describes each file: drive, folders, name, date; or a plain reason", async () => {
    const res = await srv.call("POST", "/check", {
        sourcePaths: ["/Volumes/MG_Mega/2026/Spring Campaign/Poster A1.indd", "/Volumes/Studio/x.indd", "/Volumes/MG_Mega/Cafe\u0301 Menu\u0308.indd"],
        outputFolder: "/Volumes/One Agency/Out",
    });
    assert.equal(res.status, 200);
    const [ok, bad, nfd] = res.body.items;
    assert.equal(ok.ok, true);
    assert.equal(ok.drive.name, "MG_Mega");
    assert.deepEqual(ok.crumbs, ["2026", "Spring Campaign"]);
    assert.equal(ok.name, "Poster A1.indd");
    assert.ok(ok.modified > 0);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /doesn't have a drive called “Studio”/);
    assert.equal(nfd.ok, true, "a decomposed (Mac-style) name still finds the file: " + nfd.error);
    assert.equal(res.body.outputFolder.ok, true);
    assert.equal(res.body.outputFolder.drive.name, "One Agency");
});

test("browse: drive list, folders then .indd files only, hidden/system files skipped, numeric sort, filter", async () => {
    const roots = await srv.call("GET", "/browse");
    assert.deepEqual(roots.body.roots.map((r) => r.name), ["MG_Mega", "One Agency"]);

    const top = await srv.call("GET", `/browse?path=${encodeURIComponent(env.mega + "/2026")}`);
    assert.equal(top.status, 200, JSON.stringify(top.body));
    assert.deepEqual(top.body.folders.map((f) => f.name), ["Job 9", "Job 10", "Spring Campaign"], "numeric sort, #recycle hidden");
    assert.deepEqual(top.body.crumbs.map((c) => c.name), ["MG_Mega", "2026"]);

    const spring = await srv.call("GET", `/browse?path=${encodeURIComponent(env.mega + "/2026/Spring Campaign")}`);
    assert.deepEqual(spring.body.files.map((f) => f.name), ["Flyer.indd", "Poster A1.indd"], "no ._ files, .DS_Store, locks or PDFs");
    assert.ok(spring.body.files[0].modified > 0);

    const filtered = await srv.call("GET", `/browse?path=${encodeURIComponent(env.mega + "/2026/Spring Campaign")}&q=post`);
    assert.deepEqual(filtered.body.files.map((f) => f.name), ["Poster A1.indd"]);
});

test("browse refuses anything outside the client drives", async () => {
    for (const p of ["/etc", env.root, env.mega + "/../", env.mega + "/2026/../../x"]) {
        const res = await srv.call("GET", `/browse?path=${encodeURIComponent(p)}`);
        assert.equal(res.status, 422, `${p}: ${res.text}`);
        assert.ok(!JSON.stringify(res.body).includes("passwd"));
    }
});

test("finished files can be opened and downloaded; only completed file outputs inside the drives", async () => {
    const [done] = await Promise.all((await srv.call("POST", "/jobs", job({ sourcePaths: ["/Volumes/One Agency/Logo.indd"] }))).body.jobs.map((j) => srv.waitFor(j.id)));
    assert.equal(done.status, "completed");
    const inline = await fetch(`${srv.base}/jobs/${done.id}/file/0`);
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get("content-type"), "application/pdf");
    assert.match(inline.headers.get("content-disposition"), /^inline; filename="Logo.*\.pdf"/);
    assert.equal(inline.headers.get("content-security-policy"), null, "PDF viewers need the page policy off");
    assert.match(await inline.text(), /simulated/);
    const dl = await fetch(`${srv.base}/jobs/${done.id}/file/0?download=1`);
    assert.match(dl.headers.get("content-disposition"), /^attachment;/);
    await dl.arrayBuffer();

    assert.equal((await srv.call("GET", `/jobs/${done.id}/file/7`)).status, 404);
    fs.rmSync(done.outputPaths[0].path);
    const gone = await srv.call("GET", `/jobs/${done.id}/file/0`);
    assert.equal(gone.status, 404);
    assert.match(gone.body.error, /isn't there any more/);

    const pkg = await srv.waitFor((await srv.call("POST", "/jobs", job({ sourcePaths: ["/Volumes/One Agency/Logo.indd"], formats: ["package"] }))).body.jobs[0].id);
    assert.equal((await srv.call("GET", `/jobs/${pkg.id}/file/0`)).status, 422);
});

test("an existing output is kept and the new one is marked 'renamedFrom'; 'Run again, replacing it' replaces", async () => {
    const first = await srv.waitFor((await srv.call("POST", "/jobs", job({ sourcePaths: ["/Volumes/MG_Mega/2026/Job 9/Ad.indd"] }))).body.jobs[0].id);
    assert.equal(first.outputPaths[0].renamedFrom, undefined);
    const second = await srv.waitFor((await srv.call("POST", "/jobs", job({ sourcePaths: ["/Volumes/MG_Mega/2026/Job 9/Ad.indd"] }))).body.jobs[0].id);
    assert.equal(path.basename(second.outputPaths[0].path), "Ad (2).pdf");
    assert.equal(second.outputPaths[0].renamedFrom, "Ad.pdf");
    const rerun = await srv.call("POST", `/jobs/${first.id}/retry`, { overwrite: true });
    assert.equal(rerun.status, 201);
    const replaced = await srv.waitFor(rerun.body.jobs[0].id);
    assert.equal(path.basename(replaced.outputPaths[0].path), "Ad.pdf");
});

test("'Run again' re-checks the file: a deleted source is refused with a clear message", async () => {
    fs.writeFileSync(path.join(env.mega, "Temp.indd"), "indd");
    const done = await srv.waitFor((await srv.call("POST", "/jobs", job({ sourcePaths: ["/Volumes/MG_Mega/Temp.indd"], formats: ["idml"] }))).body.jobs[0].id);
    fs.rmSync(path.join(env.mega, "Temp.indd"));
    const res = await srv.call("POST", `/jobs/${done.id}/retry`, {});
    assert.equal(res.status, 422);
    assert.ok(res.body.errors.sourcePath);
});

test("when InDesign can't be reached the queue waits (job stays pending), then carries on", async () => {
    const id = (await srv.call("POST", "/jobs", job({ sourcePaths: ["/Volumes/MG_Mega/simulate-unreachable Brochure.indd"], formats: ["idml"] }))).body.jobs[0].id;
    let sawPaused = false, sawUnreachable = false;
    for (let i = 0; i < 200; i++) {
        const h = (await srv.call("GET", "/health")).body;
        if (h.worker.state === "paused") { sawPaused = true; assert.match(h.worker.pausedReason, /can't be reached/); }
        if (h.indesign.state === "unreachable") sawUnreachable = true;
        const j = (await srv.call("GET", `/jobs/${id}`)).body;
        assert.notEqual(j.status, "failed", "must never fail just because InDesign was unreachable");
        if (j.status === "completed") break;
        await sleep(15);
    }
    const done = await srv.waitFor(id);
    assert.equal(done.status, "completed");
    assert.ok(sawPaused && sawUnreachable, `paused=${sawPaused} unreachable=${sawUnreachable}`);
    const h = (await srv.call("GET", "/health")).body;
    assert.equal(h.indesign.state, "ok");
    assert.notEqual(h.worker.state, "paused");
});

test("health and ui-config report what the dashboard needs", async () => {
    const h = (await srv.call("GET", "/health")).body;
    for (const k of ["version", "serverTime", "startedAt", "lanUrl", "worker", "indesign", "drives", "counts"]) assert.ok(k in h, k);
    assert.deepEqual(h.drives.map((d) => d.name), ["MG_Mega", "One Agency"]);
    const ui = (await srv.call("GET", "/ui-config")).body;
    assert.deepEqual(ui.drives.map((d) => d.name), ["MG_Mega", "One Agency"]);
    assert.ok(Array.isArray(ui.pathMappings) && ui.pathMappings.length === 2);
    assert.ok("pdf-print" in ui.estimates);
    assert.ok(ui.serverTime > 0);
});

test("job list: search, odd limits and paging don't break", async () => {
    assert.equal((await srv.call("GET", "/jobs?limit=abc")).status, 200);
    const found = (await srv.call("GET", "/jobs?q=logo")).body.jobs;
    assert.ok(found.length > 0 && found.every((j) => /logo/i.test(j.sourcePath)));
    const page = (await srv.call("GET", "/jobs?limit=2")).body;
    assert.equal(page.jobs.length, 2);
    assert.equal(page.hasMore, true);
    const older = (await srv.call("GET", `/jobs?limit=2&before=${page.jobs[1].id}`)).body.jobs;
    assert.ok(older.every((j) => j.id < page.jobs[1].id));
});

test("admin controls work on the export PC only; drain stops new jobs, resume starts them", async () => {
    const remoteEnv = makeEnv();
    const remote = await startServer(remoteEnv, { isLocalRequest: () => false });
    try {
        assert.equal((await remote.call("POST", "/admin/drain")).status, 403);
        assert.equal((await remote.call("POST", "/admin/shutdown")).status, 403);
    } finally {
        await remote.stop();
        fs.rmSync(remoteEnv.root, { recursive: true, force: true });
    }
    const drained = await srv.call("POST", "/admin/drain");
    assert.equal(drained.status, 200);
    const id = (await srv.call("POST", "/jobs", job({ sourcePaths: ["/Volumes/One Agency/Logo.indd"], formats: ["idml"] }))).body.jobs[0].id;
    await sleep(300);
    assert.equal((await srv.call("GET", `/jobs/${id}`)).body.status, "pending", "no new job starts while draining");
    assert.equal((await srv.call("GET", "/health")).body.worker.state, "draining");
    assert.equal((await srv.call("POST", "/admin/resume")).status, 200);
    assert.equal((await srv.waitFor(id)).status, "completed");
});

test("shutdown asks the process to exit with code 5 (used by upgrades)", async () => {
    const e2 = makeEnv();
    let requested = null;
    const s = await startServer(e2, { onShutdownRequest: (code) => { requested = code ?? 5; } });
    try {
        assert.equal((await s.call("POST", "/admin/shutdown")).status, 200);
        for (let i = 0; i < 50 && requested === null; i++) await sleep(20);
        assert.equal(requested, 5);
    } finally {
        await s.stop().catch(() => {});
        fs.rmSync(e2.root, { recursive: true, force: true });
    }
});

test("config.json: a Notepad BOM is fine, a missing file gives the Install.cmd message, JSON errors say where", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-queue-cfg-"));
    const file = path.join(dir, "config.json");
    assert.throws(() => loadConfig(APP_DIR, file), (e) => e instanceof ConfigError && /Install\.cmd/.test(e.message));
    assert.ok(!fs.existsSync(file), "the example is no longer copied in");
    fs.writeFileSync(file, "\uFEFF" + JSON.stringify({ allowedRoots: ["P:\\"] }));
    assert.equal(loadConfig(APP_DIR, file).port, 8080);
    fs.writeFileSync(file, '{\n  "allowedRoots": ["P:\\\\"],\n  "port": 8080,\n}');
    assert.throws(() => loadConfig(APP_DIR, file), /line \d+/i);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("the address shown to designers is on the file servers' network, not a virtual adapter", () => {
    const interfaces = {
        "vEthernet (WSL)": [{ family: "IPv4", address: "172.20.16.1", internal: false }],
        "VirtualBox Host-Only Network": [{ family: "IPv4", address: "192.168.56.1", internal: false }],
        "Ethernet 2": [{ family: "IPv4", address: "10.0.0.5", internal: false }],
        Ethernet: [{ family: "IPv4", address: "192.168.1.42", internal: false }, { family: "IPv4", address: "169.254.3.3", internal: false }],
    };
    assert.equal(pickLanUrl({ interfaces, serverIps: ["192.168.1.13"], port: 8080, hostname: "PC" }), "http://192.168.1.42:8080/");
    assert.equal(pickLanUrl({ interfaces: { "vEthernet (WSL)": interfaces["vEthernet (WSL)"] }, serverIps: [], port: 8080, hostname: "PC" }), "http://PC:8080/");
});

test("the export notifier's channel is reused for real exports, but never in simulation mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-queue-appdata-"));
    fs.mkdirSync(path.join(dir, "InDesignExportNotify"));
    fs.writeFileSync(path.join(dir, "InDesignExportNotify", "settings.txt"), "server=https://ntfy.sh\r\ntopic=real-channel\r\n");
    const saved = process.env.APPDATA;
    process.env.APPDATA = dir;
    try {
        assert.equal(validateConfig({ allowedRoots: ["P:\\"] }, APP_DIR).ntfy.topic, "real-channel");
        assert.equal(validateConfig({ allowedRoots: ["P:\\"], indesign: { executor: "simulate" } }, APP_DIR).ntfy.topic, "");
        assert.equal(validateConfig({ allowedRoots: ["P:\\"], indesign: { executor: "simulate" }, ntfy: { topic: "test-channel" } }, APP_DIR).ntfy.topic, "test-channel");
    } finally {
        if (saved === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
