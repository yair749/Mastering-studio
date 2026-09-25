// End-to-end tests of the server: real HTTP, real SQLite, real files, and the "simulate"
// InDesign executor in place of Adobe InDesign.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { validateConfig } from "../src/config.js";
import { JobStore } from "../src/db.js";
import { createLogger } from "../src/log.js";
import { createApp } from "../src/server.js";

process.env.EXPORT_QUEUE_SIMULATE_MS = "50";
const APP_DIR = path.resolve(import.meta.dirname, "..");

function makeEnv({ accessKey = "" } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "export-queue-test-"));
    const projects = path.join(root, "Projects");
    fs.mkdirSync(path.join(projects, "Client", "Out"), { recursive: true });
    for (const f of ["Poster.indd", "Brochure.indd", "simulate-fail.indd", "simulate-missing.indd", "Catalog.v2.indd"]) {
        fs.writeFileSync(path.join(projects, "Client", f), "indd");
    }
    const config = validateConfig({
        port: 1,
        accessKey,
        allowedRoots: [projects],
        pathMappings: [{ from: "/Volumes/Projects", to: projects }],
        indesign: { executor: "simulate" },
        dataDir: path.join(root, "data"),
    }, APP_DIR);
    return { root, projects, config };
}

async function startServer(env, appOptions = {}) {
    const log = createLogger(null, { quiet: true });
    const { app, worker, store, events } = createApp(env.config, { log, platform: "posix", ...appOptions });
    worker.start();
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const call = async (method, url, body, headers = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: { "Content-Type": "application/json", ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const waitFor = async (id, statuses = ["completed", "failed", "cancelled"]) => {
        for (let i = 0; i < 200; i++) {
            const { body } = await call("GET", `/jobs/${id}`);
            if (statuses.includes(body.status)) return body;
            await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`job ${id} did not finish`);
    };
    const stop = async () => {
        events.close();
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
        await worker.stop();
        store.close();
    };
    return { base, call, waitFor, stop, store };
}

const job = (over = {}) => ({
    submittedBy: "Dana",
    sourcePath: "/Volumes/Projects/Client/Poster.indd",
    format: "pdf-print",
    pdfPreset: "[High Quality Print]",
    pageRange: "All",
    useDocumentBleed: true,
    ...over,
});

let env, srv;
before(async () => { env = makeEnv(); srv = await startServer(env); });
after(async () => { await srv.stop(); fs.rmSync(env.root, { recursive: true, force: true }); });

test("a PDF job runs and writes next to the source; a second one doesn't overwrite it", async () => {
    const first = await srv.call("POST", "/jobs", job());
    assert.equal(first.status, 201);
    assert.equal(first.body.sourcePath, path.join(env.projects, "Client", "Poster.indd"));
    const done = await srv.waitFor(first.body.id);
    assert.equal(done.status, "completed", done.error);
    assert.equal(done.outputPaths[0].path, path.join(env.projects, "Client", "Poster.pdf"));
    assert.ok(fs.existsSync(done.outputPaths[0].path));

    const second = await srv.waitFor((await srv.call("POST", "/jobs", job())).body.id);
    assert.equal(second.outputPaths[0].path, path.join(env.projects, "Client", "Poster (2).pdf"));

    const replaced = await srv.waitFor((await srv.call("POST", "/jobs", job({ overwrite: true }))).body.id);
    assert.equal(replaced.outputPaths[0].path, path.join(env.projects, "Client", "Poster.pdf"));
});

test("jobs run one at a time, in submission order", async () => {
    const ids = [];
    for (const f of ["Poster", "Brochure", "Poster"]) {
        ids.push((await srv.call("POST", "/jobs", job({ sourcePath: `/Volumes/Projects/Client/${f}.indd`, format: "idml" }))).body.id);
    }
    const jobs = await Promise.all(ids.map((id) => srv.waitFor(id)));
    for (let i = 1; i < jobs.length; i++) {
        assert.ok(jobs[i].startedAt >= jobs[i - 1].finishedAt, "a job started before the previous one finished");
    }
});

test("invalid submissions get field-specific errors and are not queued", async () => {
    const before = srv.store.counts();
    const cases = [
        [{ submittedBy: "" }, "submittedBy"],
        [{ format: "jpeg" }, "format"],
        [{ pdfPreset: "" }, "pdfPreset"],
        [{ pageRange: "1-3; rm -rf" }, "pageRange"],
        [{ sourcePath: "/Volumes/Projects/Client/Missing.indd" }, "sourcePath"],
        [{ sourcePath: "/etc/hosts.indd" }, "sourcePath"],
        [{ sourcePath: "/Volumes/Projects/Client/Poster.pdf" }, "sourcePath"],
        [{ outputFolder: "/Volumes/Projects/Client/NoSuchFolder" }, "outputFolder"],
        [{ useDocumentBleed: "sometimes" }, "useDocumentBleed"],
    ];
    for (const [over, field] of cases) {
        const res = await srv.call("POST", "/jobs", job(over));
        assert.equal(res.status, 422, JSON.stringify(over));
        assert.ok(res.body.errors[field], `expected an error for ${field}: ${JSON.stringify(res.body)}`);
    }
    assert.deepEqual(srv.store.counts(), before);
    assert.equal((await srv.call("POST", "/jobs", "not an object")).status, 400);
    assert.equal((await srv.call("POST", "/jobs", [1, 2])).status, 422);
});

test("a failed export reports InDesign's reason; missing links are warnings or a failure", async () => {
    const failed = await srv.waitFor((await srv.call("POST", "/jobs", job({ sourcePath: "/Volumes/Projects/Client/simulate-fail.indd" }))).body.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /Simulated InDesign error/);

    const warned = await srv.waitFor((await srv.call("POST", "/jobs", job({ sourcePath: "/Volumes/Projects/Client/simulate-missing.indd" }))).body.id);
    assert.equal(warned.status, "completed");
    assert.equal(warned.warnings.length, 2);

    const strict = await srv.waitFor((await srv.call("POST", "/jobs", job({ sourcePath: "/Volumes/Projects/Client/simulate-missing.indd", failOnMissing: true }))).body.id);
    assert.equal(strict.status, "failed");
    assert.match(strict.error, /missing links or fonts/);
});

test("package jobs create a folder, a custom output folder is honoured", async () => {
    const pkg = await srv.waitFor((await srv.call("POST", "/jobs", job({ sourcePath: "/Volumes/Projects/Client/Catalog.v2.indd", format: "package" }))).body.id);
    assert.equal(pkg.status, "completed", pkg.error);
    assert.equal(pkg.outputPaths[0].path, path.join(env.projects, "Client", "Catalog.v2 Folder"));
    const again = await srv.waitFor((await srv.call("POST", "/jobs", job({ sourcePath: "/Volumes/Projects/Client/Catalog.v2.indd", format: "package" }))).body.id);
    assert.equal(again.outputPaths[0].path, path.join(env.projects, "Client", "Catalog.v2 Folder (2)"));

    const custom = await srv.waitFor((await srv.call("POST", "/jobs", job({ format: "pdf-interactive", outputFolder: "/Volumes/Projects/Client/Out" }))).body.id);
    assert.equal(custom.outputPaths[0].path, path.join(env.projects, "Client", "Out", "Poster.pdf"));
});

test("pending jobs can be cancelled, finished jobs can be run again", async () => {
    const r1 = await srv.call("POST", "/jobs", job({ format: "idml" }));
    const r2 = await srv.call("POST", "/jobs", job({ format: "idml" }));
    const cancelled = await srv.call("POST", `/jobs/${r2.body.id}/cancel`, { by: "Sam" });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");
    assert.match(cancelled.body.error, /Sam/);
    await srv.waitFor(r1.body.id);
    assert.equal((await srv.call("POST", `/jobs/${r1.body.id}/cancel`, {})).status, 409);

    const rerun = await srv.call("POST", `/jobs/${r2.body.id}/retry`, { by: "Sam" });
    assert.equal(rerun.status, 201);
    assert.equal(rerun.body.retryOf, r2.body.id);
    assert.equal((await srv.waitFor(rerun.body.id)).status, "completed");
    assert.equal((await srv.call("POST", "/jobs/999999/retry", {})).status, 404);
});

test("the event stream pushes job updates", async () => {
    const res = await fetch(`${srv.base}/events`);
    const reader = res.body.getReader();
    const id = (await srv.call("POST", "/jobs", job({ format: "idml" }))).body.id;
    let text = "";
    const deadline = Date.now() + 5000;
    while (!text.includes(`"id":${id},"status":"completed"`) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    assert.match(text, new RegExp(`event: job\\ndata: \\{"id":${id},"status":"pending"`));
    assert.match(text, new RegExp(`"id":${id},"status":"completed"`));
});

test("presets are fetched from InDesign by themselves at startup, cached, and refreshable", async () => {
    let cached;
    for (let i = 0; i < 100 && !(cached = (await srv.call("GET", "/presets")).body).presets.length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(cached.presets.includes("[High Quality Print]"), "loaded at startup without anyone clicking");
    const fresh = await srv.call("POST", "/presets/refresh");
    assert.deepEqual(fresh.body.presets, cached.presets);
});

test("with an access key, the API refuses requests without it", async () => {
    const keyEnv = makeEnv({ accessKey: "office-secret" });
    // Requests from the export PC itself skip the key; act like a designer's computer here.
    const s = await startServer(keyEnv, { isLocalRequest: () => false });
    try {
        assert.equal((await s.call("GET", "/jobs")).status, 401);
        assert.equal((await s.call("GET", "/jobs", undefined, { "X-Access-Key": "wrong" })).status, 401);
        assert.equal((await s.call("GET", "/jobs", undefined, { "X-Access-Key": "office-secret" })).status, 200);
        assert.equal((await s.call("GET", "/ui-config")).status, 200, "the page must be able to ask whether a key is needed");
        assert.equal((await fetch(`${s.base}/events?key=office-secret`).then((r) => { r.body.cancel(); return r.status; })), 200);
    } finally {
        await s.stop();
        fs.rmSync(keyEnv.root, { recursive: true, force: true });
    }
});

test("a job interrupted by a crash is marked failed on restart, not re-run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-queue-db-"));
    const file = path.join(dir, "jobs.db");
    let store = new JobStore(file);
    const created = store.create({ submittedBy: "Dana", sourceInput: "x", sourcePath: "/x.indd", format: "idml", params: { format: "idml" } });
    store.create({ submittedBy: "Dana", sourceInput: "y", sourcePath: "/y.indd", format: "idml", params: { format: "idml" } });
    assert.equal(store.claimNext().id, created.id);
    store.close();                                  // "power cut" while processing

    store = new JobStore(file);
    assert.deepEqual(store.recoverInterrupted(), [created.id]);
    assert.equal(store.get(created.id).status, "failed");
    assert.match(store.get(created.id).error, /stopped while this job was running/);
    assert.equal(store.claimNext().sourcePath, "/y.indd", "the pending job survives the restart");
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("config validation rejects mistakes with a clear message", () => {
    assert.throws(() => validateConfig({ allowedRoots: [] }, APP_DIR), /allowedRoots/);
    assert.throws(() => validateConfig({ allowedRoots: ["P:\\"], port: "80" }, APP_DIR), /port/);
    assert.throws(() => validateConfig({ allowedRoots: ["P:\\"], indesign: { executor: "magic" } }, APP_DIR), /executor/);
    assert.throws(() => validateConfig({ allowedRoots: ["P:\\"], defaultOutputSubfolder: "a/b" }, APP_DIR), /defaultOutputSubfolder/);
    assert.equal(validateConfig({ allowedRoots: ["P:\\"] }, APP_DIR).indesign.jobTimeoutMinutes, 60);
});
