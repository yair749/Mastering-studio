// Entry point: loads config, opens the job database, starts the queue worker and serves the
// web UI + API on the local network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApi } from "./api.js";
import { ConfigError, loadConfig } from "./config.js";
import { JobStore } from "./db.js";
import { createEventHub } from "./events.js";
import { createInDesign } from "./indesign.js";
import { createLogger } from "./log.js";
import { createNotifier } from "./notify.js";
import { createPathResolver } from "./paths.js";
import { createWorker } from "./worker.js";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version;

function lanUrls(port) {
    return Object.values(os.networkInterfaces()).flat()
        .filter((a) => a && a.family === "IPv4" && !a.internal)
        .map((a) => `http://${a.address}:${port}/`);
}

export function createApp(config, { log, platform = process.platform === "win32" ? "win32" : "posix" } = {}) {
    const store = new JobStore(config.dbFile ?? path.join(config.dataDir, "jobs.db"));
    const events = createEventHub(log);
    const indesign = createInDesign(config, log);
    const resolver = createPathResolver({ allowedRoots: config.allowedRoots, pathMappings: config.pathMappings, platform });
    const notifier = createNotifier(config, log);
    const worker = createWorker({ store, indesign, resolver, config, events, notifier, log });

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
    app.use("/api", createApi({ store, worker, indesign, resolver, events, notifier, config, log, version: VERSION }));
    app.use(express.static(path.join(APP_DIR, "public"), { index: "index.html", maxAge: "5m" }));

    return { app, store, worker, events };
}

async function main() {
    let config;
    try {
        config = loadConfig(APP_DIR);
    } catch (err) {
        if (err instanceof ConfigError) {
            console.error(err.message);
            process.exit(2);
        }
        throw err;
    }
    const log = createLogger(path.join(config.dataDir, "logs"));
    const urls = lanUrls(config.port);
    config.publicUrl = urls[0] ?? `http://localhost:${config.port}/`;

    // Job/result files left behind by a crash; nothing is running yet, so all are stale.
    fs.rmSync(path.join(config.dataDir, "tmp"), { recursive: true, force: true });

    const { app, store, worker, events } = createApp(config, { log });
    worker.start();

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
        log.info(`Designers open: ${urls.join("  ") || `http://localhost:${config.port}/`}`);
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
    const shutdown = async (signal) => {
        if (stopping) return;
        stopping = true;
        log.info(`${signal}: stopping (a job already in InDesign is allowed to finish).`);
        server.close();
        events.close();
        await worker.stop();
        store.close();
        process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
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
