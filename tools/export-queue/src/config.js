// Loads and validates config.json. Invalid config stops the server with a clear message
// instead of starting in a half-working state.
import fs from "node:fs";
import path from "node:path";
import { driveLabel } from "./paths.js";

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
    publicUrl: "",                       // address for designers; default: worked out from this PC's network
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

const isUnc = (r) => /^(\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(r.trim());

// v1 installs have no "drives" list. The installer writes every share twice (UNC path and
// drive letter), so only the UNC roots are listed; drive letters only when there is nothing else.
export function deriveDrives(allowedRoots) {
    const unc = allowedRoots.filter(isUnc);
    const source = unc.length ? unc : allowedRoots;
    const seen = new Set();
    const drives = [];
    for (const root of source) {
        const p = root.trim().replace(/[\\/]+$/, "") || root.trim();
        const key = p.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        drives.push({ name: driveLabel(p), path: /^[A-Za-z]:$/.test(p) ? `${p}\\` : p, letter: null });
    }
    return drives;
}

function validateDrives(drives) {
    const valid = Array.isArray(drives) && drives.every((d) => isPlainObject(d) &&
        typeof d.name === "string" && d.name.trim() && typeof d.path === "string" && d.path.trim() &&
        (d.letter === undefined || d.letter === null || (typeof d.letter === "string" && /^[A-Za-z]:\\?$/.test(d.letter))));
    if (!valid) fail("drives must be a list of { \"name\": \"MG_Mega\", \"path\": \"\\\\\\\\server\\\\share\", \"letter\": \"M:\" or null }");
    return drives.map((d) => ({ name: d.name.trim(), path: d.path.trim(), letter: d.letter ? d.letter.slice(0, 2).toUpperCase() : null }));
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
    if (cfg.drives === undefined || cfg.drives === null || (Array.isArray(cfg.drives) && cfg.drives.length === 0)) {
        cfg.drives = deriveDrives(cfg.allowedRoots);
        cfg.drivesDerived = true;
    } else {
        cfg.drives = validateDrives(cfg.drives);
        cfg.drivesDerived = false;
    }
    if (typeof cfg.publicUrl !== "string" || (cfg.publicUrl && !/^https?:\/\/[^\s/]+/i.test(cfg.publicUrl))) {
        fail("publicUrl must be \"\" or an address like \"http://192.168.1.20:8080/\"");
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
    // Not in simulation mode: a trial run must never ping the real notification channel.
    if (!n.topic && cfg.indesign?.executor !== "simulate") {
        const detected = detectNotifierChannel();
        if (detected) Object.assign(n, detected, { autoDetected: true });
    }
    if (n.topic && !n.server) n.server = "https://ntfy.sh";

    cfg.appDir = appDir;
    cfg.dataDir = cfg.dataDir ? path.resolve(appDir, cfg.dataDir) : path.join(appDir, "data");
    return cfg;
}

const stripBom = (text) => text.replace(/^\uFEFF/, "");

// JSON.parse only reports a character position (older Node) or a terse reason; the owner edits
// this file in Notepad, so say where the mistake is and what usually causes it.
export function describeJsonError(text, err) {
    let line = null, column = null;
    const lc = /\(line (\d+) column (\d+)\)/.exec(err.message);
    const pos = /at position (\d+)/.exec(err.message);
    if (lc) {
        line = Number(lc[1]);
        column = Number(lc[2]);
    } else if (pos) {
        const before = text.slice(0, Number(pos[1]));
        line = before.split("\n").length;
        column = before.length - before.lastIndexOf("\n");
    }
    const reason = err.message.replace(/\s*\(line \d+ column \d+\)/, "").replace(/\s+in JSON at position \d+.*$/s, "").replace(/,\s*".*" is not valid JSON$/s, "");
    const hint = /escape/i.test(err.message)
        ? " Every \\ in a path must be written twice in config.json, e.g. \"\\\\\\\\NAS\\\\Projects\"."
        : " Look for a missing comma, quote or bracket just before that point.";
    return `config.json has a mistake${line ? ` on line ${line}, column ${column}` : ""}: ${reason}.${hint}`;
}

// A config.json copied from config.example.json by hand (or by v1 when started before the
// installer) lists drives that don't exist here; starting with it would refuse every path.
function isUnchangedExample(raw, appDir) {
    try {
        const example = JSON.parse(stripBom(fs.readFileSync(path.join(appDir, "config.example.json"), "utf8")));
        return Array.isArray(example.allowedRoots) && example.allowedRoots.length > 0 &&
            JSON.stringify(example.allowedRoots) === JSON.stringify(raw.allowedRoots);
    } catch {
        return false;
    }
}

export function loadConfig(appDir, file = process.env.EXPORT_QUEUE_CONFIG || path.join(appDir, "config.json")) {
    if (!fs.existsSync(file)) {
        if (process.env.EXPORT_QUEUE_CONFIG) throw new ConfigError(`Config file not found: ${file}`);
        throw new ConfigError("config.json is missing. Double-click windows\\Install.cmd; it creates it.");
    }
    const text = stripBom(fs.readFileSync(file, "utf8"));
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (err) {
        throw new ConfigError(describeJsonError(text, err));
    }
    if (isPlainObject(raw) && isUnchangedExample(raw, appDir)) {
        throw new ConfigError(`config.json still lists the example drives (${raw.allowedRoots.join(", ")}). Double-click windows\\Install.cmd; it sets up this PC's drives.`);
    }
    return validateConfig(raw, appDir);
}
