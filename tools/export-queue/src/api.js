// HTTP API used by the web UI. Every error a designer can cause comes back as
// 422 { errors: { field: message } } so the form can show it next to the right field.
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import express from "express";
import { BrowseError } from "./browse.js";
import { STATUSES } from "./db.js";
import { mapLimit } from "./fsutil.js";
import { FORMATS, MAX_FILES, ValidationError, checkSubmission, presetNotInstalled } from "./jobs.js";
import { PathError } from "./paths.js";

function httpError(status, message) {
    return Object.assign(new Error(message), { status });
}

function parseId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 1) throw httpError(400, "Invalid job id.");
    return id;
}

// Requests from the export PC itself (the installer, Check.cmd, the owner's own browser).
export function isLoopback(req) {
    const a = req.socket?.remoteAddress || "";
    return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

const CONTENT_TYPES = { ".pdf": "application/pdf", ".idml": "application/vnd.adobe.indesign-idml-package" };

// filename="..." for old browsers (ASCII only), filename*= for the real, possibly accented or Hebrew name.
function contentDisposition(type, name) {
    const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function createApi({ store, worker, indesign, presets, resolver, browser, events, notifier, config, log, version,
    health, present, isLocalRequest = isLoopback, onShutdownRequest = () => {} }) {
    const api = express.Router();
    // 50 paths of up to 1024 characters each.
    api.use(express.json({ limit: "128kb" }));
    const p = resolver.pathApi;
    const byName = (body, fallback) => (typeof body?.by === "string" && body.by.trim() ? body.by.trim().slice(0, 80) : fallback);

    // Local maintenance for the installer and the Start menu shortcuts: never from the network.
    const admin = express.Router();
    admin.use((req, res, next) => (isLocalRequest(req) ? next() : res.status(403).json({ error: "This only works on the export PC itself." })));
    admin.post("/drain", (req, res) => res.json({ ok: true, worker: worker.drain() }));
    admin.post("/resume", (req, res) => res.json({ ok: true, worker: worker.resume() }));
    admin.post("/shutdown", (req, res) => {
        log.info("Stop requested on the export PC (e.g. by the installer).");
        res.on("finish", () => onShutdownRequest());
        res.json({ ok: true });
    });
    api.use("/admin", admin);

    // Optional shared key for the office (config.accessKey). EventSource can't send headers,
    // so the event stream also accepts it as ?key=. Not needed on the export PC itself, so the
    // installer and Check.cmd keep working when a key is set.
    if (config.accessKey) {
        const expected = Buffer.from(config.accessKey);
        api.use((req, res, next) => {
            if (req.path === "/ui-config" || isLocalRequest(req)) return next();
            const given = Buffer.from(String(req.get("X-Access-Key") ?? req.query.key ?? ""));
            if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
            res.status(401).json({ error: "Access key required.", accessKeyRequired: true });
        });
    }

    api.get("/ui-config", (req, res) => {
        res.json({
            version,
            serverTime: Date.now(),
            accessKeyRequired: Boolean(config.accessKey) && !isLocalRequest(req),
            formats: Object.entries(FORMATS).map(([id, f]) => ({ id, ...f })),
            drives: resolver.drives.map(({ name, path }) => ({ name, path })),
            pathMappings: config.pathMappings.map(({ from, to }) => ({ from, to })),
            defaultOutputSubfolder: config.defaultOutputSubfolder,
            estimates: Object.fromEntries(Object.keys(FORMATS).map((f) => [f, store.estimate(f)])),
            // Still read by pages running the 1.x script until they reload.
            allowedRoots: config.allowedRoots,
            pathExamples: config.pathMappings.map((m) => m.from),
        });
    });

    api.get("/health", (req, res) => res.json(health()));

    api.get("/presets", (req, res) => res.json(presets.cached()));

    // Asks InDesign for its installed PDF presets. Waits for the current job (InDesign runs
    // one script at a time), so the UI shows a "waiting for InDesign" state meanwhile.
    api.post("/presets/refresh", async (req, res) => {
        try {
            res.json(await presets.refresh("asked from the page"));
        } catch (err) {
            throw err.status ? err : httpError(502, err.message);
        }
    });

    // Checks paths while the designer types: each path gets its own answer, so one bad line
    // doesn't hide what's wrong (or right) with the others.
    async function checkPath(input, kind) {
        const field = kind === "file" ? "sourcePath" : "outputFolder";
        try {
            const { path, stat } = await resolver.inspect(input, field, kind === "file" ? { kind, extension: ".indd" } : { kind });
            const where = resolver.locate(path);
            if (kind === "folder") return { input, ok: true, path, drive: where.drive, crumbs: where.crumbs };
            return { input, ok: true, path, drive: where.drive, crumbs: where.crumbs.slice(0, -1), name: p.basename(path),
                modified: Math.round(stat.mtimeMs), bytes: stat.size };
        } catch (err) {
            if (err instanceof PathError) return { input, ok: false, error: err.message };
            throw err;
        }
    }

    api.post("/check", async (req, res) => {
        const { sourcePaths, outputFolder } = req.body ?? {};
        if (!Array.isArray(sourcePaths) || sourcePaths.length < 1 || sourcePaths.length > MAX_FILES || !sourcePaths.every((s) => typeof s === "string")) {
            throw new ValidationError({ sourcePaths: `Send 1 to ${MAX_FILES} paths.` });
        }
        if (outputFolder !== undefined && outputFolder !== null && typeof outputFolder !== "string") {
            throw new ValidationError({ outputFolder: "Invalid value." });
        }
        const out = { items: await mapLimit(sourcePaths, 4, (input) => checkPath(input, "file")) };
        if (typeof outputFolder === "string" && outputFolder.trim()) out.outputFolder = await checkPath(outputFolder, "folder");
        res.json(out);
    });

    api.get("/jobs", (req, res) => {
        const statuses = req.query.status ? String(req.query.status).split(",").map((s) => s.trim()).filter(Boolean) : [];
        if (statuses.some((s) => !STATUSES.includes(s))) throw httpError(400, "Unknown status.");
        const n = typeof req.query.limit === "string" && req.query.limit.trim() ? Number(req.query.limit) : NaN;
        const limit = Number.isFinite(n) ? Math.trunc(n) : 200;     // the store keeps it within 1–500
        const beforeId = req.query.before ? parseId(req.query.before) : undefined;
        const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
        const { jobs, hasMore } = store.list({ status: statuses, limit, beforeId, q });
        res.json({ jobs: jobs.map(present), counts: store.counts(), worker: worker.status(), serverTime: Date.now(), hasMore });
    });

    api.get("/jobs/:id", (req, res) => {
        const job = store.get(parseId(req.params.id));
        if (!job) throw httpError(404, "Job not found.");
        res.json(present(job));
    });

    // One job per file x format, all or nothing. The paths are checked now (and every problem
    // reported at once, including the other fields'), so typos fail instantly instead of
    // leaving failed jobs for later.
    api.post("/jobs", async (req, res) => {
        const sub = checkSubmission(req.body, { installedPresets: presets.installed() });
        if (sub.errors.form) throw new ValidationError(sub.errors);
        const errors = { ...sub.errors };
        const pathErrors = [...sub.pathErrors];
        const resolved = await mapLimit(sub.sources, 4, async ({ index, input }) => {
            try {
                return { index, input, path: await resolver.resolveExisting(input, sub.sourceField, { kind: "file", extension: ".indd" }) };
            } catch (err) {
                if (!(err instanceof PathError)) throw err;
                pathErrors.push({ index, input, message: err.message });
                return null;
            }
        });
        const seen = new Map();
        for (const r of resolved) {
            if (!r) continue;
            const key = resolver.key(r.path);
            if (seen.has(key)) pathErrors.push({ index: r.index, input: r.input, message: `This is the same file as line ${seen.get(key) + 1}.` });
            else seen.set(key, r.index);
        }
        if (sub.outputFolder && !errors.outputFolder) {
            try {
                await resolver.resolveExisting(sub.outputFolder, "outputFolder", { kind: "folder" });
            } catch (err) {
                if (!(err instanceof PathError)) throw err;
                errors.outputFolder = err.message;
            }
        }
        if (pathErrors.length) {
            pathErrors.sort((a, b) => a.index - b.index);
            const total = sub.sources.length + sub.pathErrors.length;
            const first = pathErrors[0];
            errors[sub.sourceField] ??= total === 1 ? first.message
                : pathErrors.length === 1 ? `Line ${first.index + 1}: ${first.message}`
                : `${pathErrors.length} of ${total} files can't be used. Line ${first.index + 1}: ${first.message}`;
        }
        if (Object.keys(errors).length) throw new ValidationError(errors, pathErrors.length ? pathErrors : undefined);

        const batchId = randomUUID();
        const specs = [];
        for (const r of resolved) {
            for (const format of sub.formats) {
                specs.push({ submittedBy: sub.submittedBy, clientIp: req.ip, sourceInput: r.input, sourcePath: r.path, format,
                    params: sub.paramsByFormat[format], batchId });
            }
        }
        const jobs = store.createMany(specs).map(present);
        for (const job of jobs) log.info(`Job #${job.id} queued by ${job.submittedBy} (${req.ip}): ${job.format} of ${job.sourcePath}`);
        worker.wakeUp();
        for (const job of jobs) events.publish("job", job);
        // The first job's fields at the top level keep pages still running the 1.x script working.
        res.status(201).json({ ...jobs[0], jobs });
    });

    api.post("/jobs/:id/cancel", (req, res) => {
        const id = parseId(req.params.id);
        const by = byName(req.body, "a designer");
        const job = store.cancel(id, by);
        if (!job) {
            const existing = store.get(id);
            if (!existing) throw httpError(404, "Job not found.");
            throw httpError(409, existing.status === "processing"
                ? "This job is already running in InDesign and can't be cancelled."
                : `This job is already ${existing.status}.`);
        }
        log.info(`Job #${id} cancelled by ${by}`);
        const out = present(job);
        events.publish("job", out);
        res.json(out);
    });

    // "Run again" goes through the same checks as a new submission, with today's settings: a
    // drive that was removed, or a mapping that was fixed, applies to re-runs too.
    api.post("/jobs/:id/retry", async (req, res) => {
        const original = store.get(parseId(req.params.id));
        if (!original) throw httpError(404, "Job not found.");
        if (!["failed", "cancelled", "completed"].includes(original.status)) {
            throw httpError(409, "Only finished jobs can be run again.");
        }
        const by = byName(req.body, original.submittedBy);
        const overwrite = req.body?.overwrite;
        const errors = {};
        if (overwrite !== undefined && overwrite !== null && typeof overwrite !== "boolean") errors.overwrite = "Invalid value.";
        let sourcePath = null;
        try {
            sourcePath = await resolver.resolveExisting(original.sourceInput, "sourcePath", { kind: "file", extension: ".indd" });
        } catch (err) {
            if (!(err instanceof PathError)) throw err;
            errors.sourcePath = err.message;
        }
        if (original.params.outputFolderInput) {
            try {
                await resolver.resolveExisting(original.params.outputFolderInput, "outputFolder", { kind: "folder" });
            } catch (err) {
                if (!(err instanceof PathError)) throw err;
                errors.outputFolder = err.message;
            }
        }
        const installed = presets.installed();
        if (original.params.pdfPreset && installed.length && !installed.includes(original.params.pdfPreset)) {
            errors.pdfPreset = presetNotInstalled(original.params.pdfPreset);
        }
        if (Object.keys(errors).length) throw new ValidationError(errors);

        const params = typeof overwrite === "boolean" ? { ...original.params, overwrite } : original.params;
        const job = present(store.create({
            submittedBy: by,
            clientIp: req.ip,
            sourceInput: original.sourceInput,
            sourcePath,
            format: original.format,
            params,
            retryOf: original.id,
        }));
        log.info(`Job #${job.id} queued as a re-run of #${original.id} by ${by}${params.overwrite ? " (replacing existing files)" : ""}`);
        worker.wakeUp();
        events.publish("job", job);
        res.status(201).json({ ...job, jobs: [job] });
    });

    // Opens or downloads a finished export, so a designer on a Mac never needs the export PC's
    // \\server\share path. Only completed jobs, only files, only inside the allowed drives.
    api.get("/jobs/:id/file/:n", async (req, res) => {
        const job = store.get(parseId(req.params.id));
        if (!job) throw httpError(404, "Job not found.");
        const n = Number(req.params.n);
        const output = Number.isInteger(n) && n >= 0 ? job.outputPaths[n] : undefined;
        if (!output || output.planned) throw httpError(404, "This export has no such file.");
        if (job.status !== "completed") throw httpError(409, "This export isn't finished, so there is no file to open yet.");
        if (output.kind === "folder") throw httpError(422, "This export is a folder (a package). Use “Copy folder path” to open it.");
        const file = String(output.path);
        const name = p.basename(file);
        if (!resolver.isAllowed(file)) throw httpError(403, `${name} isn't on one of the client drives the export PC can use any more.`);
        let stat;
        try {
            stat = await resolver.timed(resolver.fs.stat(file), file, "file");
        } catch (err) {
            if (err instanceof PathError) throw httpError(504, err.message);
            if (err.code === "ENOENT" || err.code === "ENOTDIR") throw httpError(404, `${name} isn't there any more (moved, renamed or deleted).`);
            throw httpError(502, `The export PC can't read ${name} (${err.code || err.message}).`);
        }
        if (stat.isDirectory()) throw httpError(422, `${name} is a folder, not a file.`);

        // Browsers' built-in PDF viewers don't work under the page's script policy; this is a
        // PDF or IDML file, not HTML, so the policy isn't needed here.
        res.removeHeader("Content-Security-Policy");
        res.set({
            "Content-Type": CONTENT_TYPES[p.extname(name).toLowerCase()] ?? "application/octet-stream",
            "Content-Length": String(stat.size),
            "Content-Disposition": contentDisposition(req.query.download === "1" ? "attachment" : "inline", name),
            "Cache-Control": "no-cache",
        });
        if (req.method === "HEAD") return res.end();
        try {
            await pipeline(fs.createReadStream(file), res);
        } catch (err) {
            if (!res.headersSent) throw httpError(502, `The export PC couldn't read ${name} (${err.code || err.message}).`);
            if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") log.warn(`Sending ${file} stopped: ${err.message}`);
            res.destroy();
        }
    });

    api.get("/browse", async (req, res) => {
        const folder = typeof req.query.path === "string" ? req.query.path : "";
        if (!folder.trim()) return res.json({ roots: browser.roots() });
        try {
            res.json(await browser.list(folder, typeof req.query.q === "string" ? req.query.q : ""));
        } catch (err) {
            if (err instanceof PathError && err.timedOut) throw new BrowseError(err.message, 504);
            throw err;
        }
    });

    api.get("/events", (req, res) => {
        events.subscribe(req, res);
        res.write(`event: hello\ndata: ${JSON.stringify({ version, serverTime: Date.now() })}\n\n`);
        res.write(`event: worker\ndata: ${JSON.stringify(worker.status())}\n\n`);
    });

    api.use((req, res) => res.status(404).json({ error: "Not found." }));

    // eslint-disable-next-line no-unused-vars
    api.use((err, req, res, next) => {
        if (err instanceof ValidationError) {
            return res.status(422).json({ error: err.message, errors: err.errors, ...(err.pathErrors ? { pathErrors: err.pathErrors } : {}) });
        }
        if (err instanceof PathError) return res.status(422).json({ error: err.message, errors: { [err.field || "form"]: err.message } });
        if (err instanceof BrowseError) return res.status(err.status).json({ error: err.message });
        if (err.type === "entity.parse.failed") return res.status(400).json({ error: "The request was not valid JSON." });
        if (err.type === "entity.too.large") return res.status(413).json({ error: "The request is too large." });
        const status = err.status && err.status < 600 ? err.status : 500;
        if (status >= 500 && !err.status) log.error(`${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
        else if (status >= 500) log.warn(`${req.method} ${req.originalUrl}: ${err.message}`);
        if (res.headersSent) return res.destroy();
        res.status(status).json({ error: status >= 500 && !err.status ? "Internal error; see the server log on the export PC." : err.message });
    });

    return api;
}
