// Entry point: loads config, opens the job database, starts the queue worker and serves the
// web UI + API on the local network.
//
// Exit codes (read by windows\start.cmd): 2 = config.json needs fixing, 3 = port already in
// use (another copy is running), 5 = stopped on request for maintenance (the installer), 1 = crash.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApi } from "./api.js";
import { createBrowser } from "./browse.js";
import { ConfigError, loadConfig } from "./config.js";
import { JobStore } from "./db.js";
import { createDriveMonitor } from "./drives.js";
import { createEventHub } from "./events.js";
import { createInDesign } from "./indesign.js";
import { createLanUrl } from "./lanurl.js";
import { createLogger } from "./log.js";
import { createNotifier } from "./notify.js";
import { buildLinkMappings, createPathResolver } from "./paths.js";
import { createPresetService } from "./presets.js";
import { createWorker } from "./worker.js";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version;
const STARTUP_ERROR_FILE = path.join(APP_DIR, "data", "logs", "startup-error.txt");

export const EXIT_MAINTENANCE = 5;

const DEFAULT_TIMINGS = {
    networkTimeoutMs: 15_000,   // any single file-system call on a client drive
    driveCheckMs: 60_000,
    unreachableRetryMs: Number(process.env.EXPORT_QUEUE_RETRY_MS) || 60_000,
    pollMs: 5_000,
};

export function createApp(config, {
    log,
    platform = process.platform === "win32" ? "win32" : "posix",
    timings = {},
    fs: fsApi = fsp,
    isLocalRequest,
    onShutdownRequest,
} = {}) {
    const t = { ...DEFAULT_TIMINGS, ...timings };
    const store = new JobStore(config.dbFile ?? path.join(config.dataDir, "jobs.db"));
    const events = createEventHub(log, { heartbeatMs: t.heartbeatMs });
    const indesign = createInDesign(config, log, { timings: t });
    const resolver = createPathResolver({
        allowedRoots: config.allowedRoots, pathMappings: config.pathMappings, drives: config.drives ?? [],
        platform, fs: fsApi, timeoutMs: t.networkTimeoutMs,
    });
    for (const d of resolver.ignoredDrives) {
        log.warn(`config.json lists the drive ${d.name} (${d.path}), but it isn't inside "allowedRoots", so it isn't offered.`);
    }
    const lanUrl = createLanUrl(config);
    const notifier = createNotifier(config, log, { lanUrl });
    const presets = createPresetService({ indesign, store, events, log });
    const startedAt = Date.now();

    const present = (job) => job && {
        ...job,
        drive: resolver.locate(job.sourcePath)?.drive ?? null,
        ...(job.status === "pending" ? { queuePosition: store.queuePosition(job.id) } : {}),
    };

    let worker = null, monitor = null;
    function health() {
        return {
            ok: true,
            version: VERSION,
            serverTime: Date.now(),
            startedAt,
            lanUrl: lanUrl(),
            worker: worker.status(),
            indesign: indesign.state(),
            drives: monitor.snapshot(),
            counts: store.counts(),
            notifications: notifier.enabled,
            presets: store.getMeta("presets"),
        };
    }
    const publishHealth = () => {
        try {
            events.publish("health", health());
        } catch (err) {
            log.error(`Could not send the status to the dashboards: ${err.message}`);
        }
    };

    monitor = createDriveMonitor({ drives: resolver.drives, fs: fsApi, timeoutMs: t.networkTimeoutMs, intervalMs: t.driveCheckMs, log, onChange: publishHealth });
    worker = createWorker({
        store, indesign, resolver, config, events, notifier, log, present,
        linkMappings: buildLinkMappings(config.pathMappings, resolver.drives),
        timings: t,
        onHealthChange: publishHealth,
    });
    indesign.onChange(() => publishHealth());
    const browser = createBrowser({ resolver, monitor, timeoutMs: t.networkTimeoutMs });

    const app = express();
    app.disable("x-powered-by");
    app.set("trust proxy", false);
    app.use((req, res, next) => {
        res.set({
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        });
        next();
    });
    app.use("/api", createApi({
        store, worker, presets, resolver, browser, events, config, log, version: VERSION,
        health, present, isLocalRequest, onShutdownRequest,
    }));
    app.use(express.static(path.join(APP_DIR, "public"), { index: "index.html", maxAge: "5m" }));

    return {
        app, store, worker, events, indesign, presets, monitor, resolver, health, lanUrl,
        // Background work: the queue, the drive checks, and a first look at InDesign (which also
        // fills the preset list), so problems show before the first job instead of during it.
        start() {
            worker.start();
            monitor.start();
            presets.refreshInBackground("start-up");
        },
        async stop() {
            monitor.stop();
            events.close();
            await worker.stop();
            await presets.idle();
            store.close();
        },
    };
}

// config.json problems happen before the log exists, and the queue runs without a console
// window, so the message also goes to a file start.cmd (and the owner) can show.
function reportStartupError(message) {
    console.error(message);
    try {
        fs.mkdirSync(path.dirname(STARTUP_ERROR_FILE), { recursive: true });
        fs.writeFileSync(STARTUP_ERROR_FILE, `${message}\r\n`);
        fs.appendFileSync(path.join(path.dirname(STARTUP_ERROR_FILE), "server.log"), `${new Date().toISOString()} ERROR ${message}\n`);
    } catch {
        // Nowhere to write: the console message is all we can do.
    }
}

async function main() {
    let config;
    try {
        config = loadConfig(APP_DIR);
    } catch (err) {
        if (err instanceof ConfigError) {
            reportStartupError(err.message);
            process.exit(2);
        }
        throw err;
    }
    fs.rmSync(STARTUP_ERROR_FILE, { force: true });
    const log = createLogger(path.join(config.dataDir, "logs"));

    // Job/result files left behind by a crash; nothing is running yet, so all are stale.
    fs.rmSync(path.join(config.dataDir, "tmp"), { recursive: true, force: true });

    let shutdown = () => {};
    const ctx = createApp(config, { log, onShutdownRequest: () => shutdown("Stop requested", EXIT_MAINTENANCE) });
    const { app, store } = ctx;
    ctx.start();

    const purge = () => {
        try {
            const n = store.purgeOlderThan(config.retentionDays);
            if (n) log.info(`Removed ${n} finished job(s) older than ${config.retentionDays} days from the history.`);
        } catch (err) {
            log.error(`History clean-up failed: ${err.message}`);
        }
    };
    purge();
    setInterval(purge, 6 * 3_600_000).unref();

    const server = app.listen(config.port, config.host);
    server.on("listening", () => {
        log.info(`InDesign export queue v${VERSION} running (InDesign mode: ${config.indesign.executor}).`);
        log.info(`Designers open: ${ctx.lanUrl()}`);
        log.info(`Client drives: ${ctx.resolver.drives.map((d) => d.name).join(", ") || "none"}${config.drivesDerived ? " (from allowedRoots)" : ""}`);
        if (config.ntfy.topic) log.info(`Notifications: ${config.ntfy.notifyOn.join(" + ")} jobs -> ${config.ntfy.server}/<channel>${config.ntfy.autoDetected ? " (from the export notifier's settings)" : ""}`);
    });
    server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
            log.error(`Port ${config.port} is already in use. Is the export queue already running? Otherwise change "port" in config.json.`);
            process.exit(3);    // start.cmd stops instead of retrying forever
        }
        log.error(`Web server error: ${err.message}`);
        process.exit(1);
    });

    let stopping = false;
    shutdown = async (reason, code = 0) => {
        if (stopping) return;
        stopping = true;
        log.info(`${reason}: stopping (a job already in InDesign is allowed to finish).`);
        server.close();
        try {
            await ctx.stop();
        } catch (err) {
            log.error(`Problem while stopping: ${err.message}`);
        }
        log.info(code === EXIT_MAINTENANCE ? `Stopped for maintenance (exit code ${code}).` : "Stopped.");
        process.exit(code);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGBREAK", () => shutdown("Ctrl+Break"));
    // Sent when the console window is closed; Windows ends the process a few seconds later,
    // so at least the reason is in the log.
    process.on("SIGHUP", () => shutdown("The export queue's window was closed"));
    process.on("uncaughtException", (err) => {
        log.error(`Unexpected error, restarting: ${err.stack || err.message}`);
        process.exit(1);    // start.cmd restarts the server; interrupted jobs are marked failed on start
    });
    process.on("unhandledRejection", (err) => {
        log.error(`Unexpected error, restarting: ${err?.stack || err}`);
        process.exit(1);
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
