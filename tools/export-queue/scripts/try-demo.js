// Try the export queue on any computer, without InDesign: double-click "Try it (Windows).cmd"
// or "Try it (Mac).command", which run this script.
//
// It makes a "demo" folder next to this app with two pretend client drives and some InDesign
// files, starts the queue in simulation mode (nothing is really exported: small placeholder
// files are written instead) and opens it in the browser. It only listens on this computer
// (localhost:8090), keeps its own settings and history in the demo folder, never talks to
// InDesign and never sends notifications, so it can't disturb a real queue running on this PC.
// Close the window to stop it. Delete the demo folder to start over.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
    console.log(`\n  This computer has Node.js ${process.versions.node}; the export queue needs 22.13 or newer.`);
    console.log("  Install the LTS version from https://nodejs.org, then try again.\n");
    process.exit(1);
}

const APP_DIR = path.resolve(import.meta.dirname, "..");
const DEMO = path.join(APP_DIR, "demo");
const PORT = Number(process.env.EXPORT_QUEUE_DEMO_PORT || 8090);
const URL = `http://localhost:${PORT}/`;

// file name → what it shows (the simulation reacts to "simulate-..." in the name)
const FILES = {
    "Acme Foods/2026/Spring Campaign/Flyer A5.indd": "exports normally",
    "Acme Foods/2026/Spring Campaign/Poster A1.indd": "exports normally",
    "Acme Foods/2026/Spring Campaign/simulate-slow Catalogue.indd": "takes a few seconds, so you can watch it run",
    "Acme Foods/2026/Spring Campaign/simulate-missing Menu.indd": "finishes with warnings (a missing link and font)",
    "Acme Foods/2026/Spring Campaign/simulate-fail Banner.indd": "fails, to show what a failure looks like",
    "Harbour Hotel/Brochures/Brochure 2026.indd": "exports normally",
    "Harbour Hotel/Brochures/Room Card.indd": "exports normally",
};

async function running() {
    try {
        const res = await fetch(`${URL}api/health`, { signal: AbortSignal.timeout(1500) });
        const body = await res.json();
        return body?.ok === true && body.worker?.executor === "simulate";
    } catch {
        return false;
    }
}

function openBrowser() {
    const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", URL]]
        : process.platform === "darwin" ? ["open", [URL]] : ["xdg-open", [URL]];
    try {
        spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    } catch { /* the address is printed anyway */ }
}

function setUp() {
    const drives = path.join(DEMO, "client drives");
    for (const rel of Object.keys(FILES)) {
        const file = path.join(drives, ...rel.split("/"));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (!fs.existsSync(file)) fs.writeFileSync(file, "Demo file for the export queue (not a real InDesign document).\n");
    }
    const names = ["Acme Foods", "Harbour Hotel"];
    const config = {
        port: PORT,
        host: "127.0.0.1",
        publicUrl: URL,
        allowedRoots: names.map((n) => path.join(drives, n)),
        drives: names.map((n) => ({ name: n, path: path.join(drives, n), letter: null })),
        // So a Mac-style path like /Volumes/Acme Foods/... works too.
        pathMappings: names.map((n) => ({ from: `/Volumes/${n}`, to: path.join(drives, n) })),
        indesign: { executor: "simulate" },
        ntfy: { server: "", topic: "", notifyOn: ["failed"] },
        dataDir: path.join(DEMO, "data"),
    };
    const file = path.join(DEMO, "config.json");
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
    return file;
}

if (await running()) {
    console.log(`The demo is already running: opening ${URL}`);
    openBrowser();
    process.exit(0);
}

const configFile = setUp();
console.log("");
console.log("  InDesign Export Queue - DEMO (simulation: nothing is really exported)");
console.log("  -------------------------------------------------------------------");
console.log(`  Opening ${URL} in your browser.`);
console.log("  Pretend client drives: Acme Foods, Harbour Hotel (click Browse... on the page).");
console.log("  Files to try:");
for (const [rel, what] of Object.entries(FILES)) console.log(`    ${rel.split("/").pop().padEnd(34)} ${what}`);
console.log("");
console.log("  CLOSE THIS WINDOW TO STOP THE DEMO.  (To start over, delete the \"demo\" folder.)");
console.log("");

const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(APP_DIR, "src", "server.js")], {
    cwd: APP_DIR,
    stdio: "inherit",
    env: { ...process.env, EXPORT_QUEUE_CONFIG: configFile, EXPORT_QUEUE_SIMULATE_MS: "2500", EXPORT_QUEUE_RETRY_MS: "15000" },
});
server.on("exit", (code) => {
    if (code === 3) console.log(`\n  Port ${PORT} is used by another program. Close it, or restart the computer, then try again.`);
    else if (code) console.log(`\n  The demo stopped (code ${code}). See the messages above.`);
    process.exit(code ?? 0);
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => server.kill(sig));

let opened = false;
for (let i = 0; i < 60 && !opened; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await running()) {
        openBrowser();
        opened = true;
    }
}
if (!opened) console.log(`\n  The demo is taking a while to start. If no browser opens, open ${URL} yourself.`);
