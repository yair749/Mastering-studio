// HTTP API used by the web UI. Every error a designer can cause comes back as
// 422 { errors: { field: message } } so the form can show it next to the right field.
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { STATUSES } from "./db.js";
import { FORMATS, ValidationError, validateSubmission } from "./jobs.js";
import { PathError } from "./paths.js";

function httpError(status, message) {
    return Object.assign(new Error(message), { status });
}

function parseId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 1) throw httpError(400, "Invalid job id.");
    return id;
}

export function createApi({ store, worker, indesign, resolver, events, notifier, config, log, version }) {
    const api = express.Router();
    api.use(express.json({ limit: "32kb" }));

    // Optional shared key for the office (config.accessKey). EventSource can't send headers,
    // so the event stream also accepts it as ?key=.
    if (config.accessKey) {
        const expected = Buffer.from(config.accessKey);
        api.use((req, res, next) => {
            if (req.path === "/ui-config") return next();
            const given = Buffer.from(String(req.get("X-Access-Key") ?? req.query.key ?? ""));
            if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
            res.status(401).json({ error: "Access key required.", accessKeyRequired: true });
        });
    }

    const withPosition = (job) => (job?.status === "pending" ? { ...job, queuePosition: store.queuePosition(job.id) } : job);

    api.get("/ui-config", (req, res) => {
        res.json({
            version,
            accessKeyRequired: Boolean(config.accessKey),
            formats: Object.entries(FORMATS).map(([id, f]) => ({ id, ...f })),
            allowedRoots: config.allowedRoots,
            pathExamples: config.pathMappings.map((m) => m.from),
            defaultOutputSubfolder: config.defaultOutputSubfolder,
        });
    });

    api.get("/health", (req, res) => {
        res.json({
            ok: true,
            version,
            worker: worker.status(),
            counts: store.counts(),
            notifications: notifier.enabled,
            presets: store.getMeta("presets"),
        });
    });

    api.get("/presets", (req, res) => {
        res.json(store.getMeta("presets") ?? { presets: [], fetchedAt: null, indesignVersion: null });
    });

    // Asks InDesign for its installed PDF presets. Waits for the current job (InDesign runs
    // one script at a time), so the UI shows a "waiting for InDesign" state meanwhile.
    api.post("/presets/refresh", async (req, res, next) => {
        try {
            const result = await indesign.listPresets();
            if (!result?.ok) throw httpError(502, `InDesign could not list presets: ${result?.error ?? "no details"}`);
            const value = { presets: result.presets, indesignVersion: result.indesignVersion, fetchedAt: Date.now() };
            store.setMeta("presets", value);
            events.publish("presets", value);
            res.json(value);
        } catch (err) {
            next(err.status ? err : httpError(502, err.message));
        }
    });

    api.get("/jobs", (req, res) => {
        const status = req.query.status ? String(req.query.status) : undefined;
        if (status && !STATUSES.includes(status)) throw httpError(400, "Unknown status.");
        const limit = req.query.limit ? Number(req.query.limit) : 200;
        const beforeId = req.query.before ? parseId(req.query.before) : undefined;
        res.json({ jobs: store.list({ status, limit, beforeId }).map(withPosition), counts: store.counts(), worker: worker.status() });
    });

    api.get("/jobs/:id", (req, res) => {
        const job = store.get(parseId(req.params.id));
        if (!job) throw httpError(404, "Job not found.");
        res.json(withPosition(job));
    });

    api.post("/jobs", async (req, res) => {
        const { sourceInput, submittedBy, format, params } = validateSubmission(req.body);
        // Check the paths now so the designer gets instant feedback instead of a failed job later.
        const sourcePath = await resolver.resolveExisting(sourceInput, "sourcePath", { kind: "file", extension: ".indd" });
        if (params.outputFolderInput) {
            await resolver.resolveExisting(params.outputFolderInput, "outputFolder", { kind: "folder" });
        }
        const job = store.create({ submittedBy, clientIp: req.ip, sourceInput, sourcePath, format, params });
        log.info(`Job #${job.id} queued by ${submittedBy} (${req.ip}): ${format} of ${sourcePath}`);
        worker.wakeUp();
        const out = withPosition(job);
        events.publish("job", out);
        res.status(201).json(out);
    });

    api.post("/jobs/:id/cancel", (req, res) => {
        const id = parseId(req.params.id);
        const by = typeof req.body?.by === "string" && req.body.by.trim() ? req.body.by.trim().slice(0, 80) : "a designer";
        const job = store.cancel(id, by);
        if (!job) {
            const existing = store.get(id);
            if (!existing) throw httpError(404, "Job not found.");
            throw httpError(409, existing.status === "processing"
                ? "This job is already running in InDesign and can't be cancelled."
                : `This job is already ${existing.status}.`);
        }
        log.info(`Job #${id} cancelled by ${by}`);
        events.publish("job", job);
        res.json(job);
    });

    api.post("/jobs/:id/retry", (req, res) => {
        const original = store.get(parseId(req.params.id));
        if (!original) throw httpError(404, "Job not found.");
        if (!["failed", "cancelled", "completed"].includes(original.status)) {
            throw httpError(409, "Only finished jobs can be run again.");
        }
        const by = typeof req.body?.by === "string" && req.body.by.trim() ? req.body.by.trim().slice(0, 80) : original.submittedBy;
        const job = store.create({
            submittedBy: by,
            clientIp: req.ip,
            sourceInput: original.sourceInput,
            sourcePath: original.sourcePath,
            format: original.format,
            params: original.params,
            retryOf: original.id,
        });
        log.info(`Job #${job.id} queued as a re-run of #${original.id} by ${by}`);
        worker.wakeUp();
        const out = withPosition(job);
        events.publish("job", out);
        res.status(201).json(out);
    });

    api.get("/events", (req, res) => {
        events.subscribe(req, res);
        res.write(`event: worker\ndata: ${JSON.stringify(worker.status())}\n\n`);
    });

    api.use((req, res) => res.status(404).json({ error: "Not found." }));

    // eslint-disable-next-line no-unused-vars
    api.use((err, req, res, next) => {
        if (err instanceof ValidationError) return res.status(422).json({ error: err.message, errors: err.errors });
        if (err instanceof PathError) return res.status(422).json({ error: err.message, errors: { [err.field || "form"]: err.message } });
        if (err.type === "entity.parse.failed") return res.status(400).json({ error: "The request was not valid JSON." });
        if (err.type === "entity.too.large") return res.status(413).json({ error: "The request is too large." });
        const status = err.status && err.status < 600 ? err.status : 500;
        if (status >= 500) log.error(`${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
        res.status(status).json({ error: status >= 500 && !err.status ? "Internal error; see the server log on the export PC." : err.message });
    });

    return api;
}
