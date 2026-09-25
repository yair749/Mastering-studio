// Loads and validates config.json. Invalid config stops the server with a clear message
// instead of starting in a half-working state.
import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
    port: 8080,
    host: "0.0.0.0",
    accessKey: "",
    allowedRoots: [],
    pathMappings: [],
    defaultOutputSubfolder: "",
    indesign: {
        executor: "indesign",            // "indesign" (real, Windows) or "simulate" (development/tests only)
        progId: "InDesign.Application",
        jobTimeoutMinutes: 60,
        killInDesignOnTimeout: true,
    },
    retentionDays: 30,
    ntfy: { server: "", topic: "", notifyOn: ["failed"] },
    dataDir: "",                         // default: <app>/data
};

export class ConfigError extends Error {}

function fail(message) {
    throw new ConfigError(`config.json: ${message}`);
}

function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Reuse the channel of the InDesign export notifier (tools/indesign-export-notify) if it is
// installed on this PC and no ntfy settings were given, so failed jobs reach the same people.
function detectNotifierChannel() {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    try {
        const text = fs.readFileSync(path.join(appData, "InDesignExportNotify", "settings.txt"), "utf8");
        const settings = Object.fromEntries(
            text.split(/\r?\n/).map((l) => l.split(/=(.*)/s).slice(0, 2)).filter(([k]) => k),
        );
        if (settings.topic) return { server: settings.server || "https://ntfy.sh", topic: settings.topic.trim() };
    } catch {
        // Not installed: notifications stay off unless configured.
    }
    return null;
}

export function validateConfig(raw, appDir) {
    if (!isPlainObject(raw)) fail("must contain a JSON object");
    const cfg = {
        ...DEFAULTS,
        ...raw,
        indesign: { ...DEFAULTS.indesign, ...(raw.indesign || {}) },
        ntfy: { ...DEFAULTS.ntfy, ...(raw.ntfy || {}) },
    };

    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) fail("port must be a number from 1 to 65535");
    if (typeof cfg.host !== "string" || !cfg.host) fail("host must be a text value such as \"0.0.0.0\"");
    if (typeof cfg.accessKey !== "string") fail("accessKey must be text (use \"\" for none)");

    if (!Array.isArray(cfg.allowedRoots) || cfg.allowedRoots.length === 0 ||
        !cfg.allowedRoots.every((r) => typeof r === "string" && r.trim())) {
        fail("allowedRoots must list at least one folder that jobs may read from and write to, e.g. \"\\\\\\\\NAS\\\\Projects\"");
    }
    if (!Array.isArray(cfg.pathMappings) ||
        !cfg.pathMappings.every((m) => isPlainObject(m) && typeof m.from === "string" && m.from && typeof m.to === "string" && m.to)) {
        fail("pathMappings must be a list of { \"from\": \"...\", \"to\": \"...\" }");
    }
    if (typeof cfg.defaultOutputSubfolder !== "string" || /[\\/:*?"<>|]|^\.+$/.test(cfg.defaultOutputSubfolder)) {
        fail("defaultOutputSubfolder must be a plain folder name (no slashes) or \"\"");
    }

    const id = cfg.indesign;
    if (!["indesign", "simulate"].includes(id.executor)) fail("indesign.executor must be \"indesign\" or \"simulate\"");
    if (typeof id.progId !== "string" || !/^[A-Za-z0-9_.]+$/.test(id.progId)) fail("indesign.progId must look like \"InDesign.Application\"");
    if (typeof id.jobTimeoutMinutes !== "number" || id.jobTimeoutMinutes < 1 || id.jobTimeoutMinutes > 1440) {
        fail("indesign.jobTimeoutMinutes must be between 1 and 1440");
    }
    if (typeof id.killInDesignOnTimeout !== "boolean") fail("indesign.killInDesignOnTimeout must be true or false");

    if (!Number.isInteger(cfg.retentionDays) || cfg.retentionDays < 1) fail("retentionDays must be a whole number of days, 1 or more");

    const n = cfg.ntfy;
    if (typeof n.server !== "string" || typeof n.topic !== "string") fail("ntfy.server and ntfy.topic must be text");
    if (!Array.isArray(n.notifyOn) || !n.notifyOn.every((e) => ["completed", "failed"].includes(e))) {
        fail("ntfy.notifyOn must list \"completed\" and/or \"failed\"");
    }
    if (!n.topic) {
        const detected = detectNotifierChannel();
        if (detected) Object.assign(n, detected, { autoDetected: true });
    }
    if (n.topic && !n.server) n.server = "https://ntfy.sh";

    cfg.appDir = appDir;
    cfg.dataDir = cfg.dataDir ? path.resolve(appDir, cfg.dataDir) : path.join(appDir, "data");
    return cfg;
}

export function loadConfig(appDir, file = process.env.EXPORT_QUEUE_CONFIG || path.join(appDir, "config.json")) {
    if (!fs.existsSync(file)) {
        if (process.env.EXPORT_QUEUE_CONFIG) throw new ConfigError(`Config file not found: ${file}`);
        fs.copyFileSync(path.join(appDir, "config.example.json"), file);
        throw new ConfigError(
            `Created ${file} from the example. Edit "allowedRoots" and "pathMappings" for your network drives, then start again.`,
        );
    }
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
        throw new ConfigError(`config.json is not valid JSON: ${err.message}`);
    }
    return validateConfig(raw, appDir);
}
