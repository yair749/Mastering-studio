// Console + rotating log file (data/logs/server.log, 5 MB x 3), so problems on an unattended
// export PC can be read afterwards.
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

export function createLogger(dir, { quiet = false } = {}) {
    let file = null;
    if (dir) {
        fs.mkdirSync(dir, { recursive: true });
        file = path.join(dir, "server.log");
    }

    function rotate() {
        try {
            if (fs.statSync(file).size < MAX_BYTES) return;
        } catch {
            return;
        }
        for (let i = KEEP - 1; i >= 1; i--) {
            try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* missing is fine */ }
        }
        try { fs.renameSync(file, `${file}.1`); } catch { /* ignore */ }
    }

    function write(level, message) {
        const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}`;
        if (!quiet) (level === "ERROR" ? console.error : console.log)(line);
        if (!file) return;
        try {
            rotate();
            fs.appendFileSync(file, line + "\n");
        } catch (err) {
            if (!quiet) console.error(`Could not write the log file: ${err.message}`);
        }
    }

    return {
        info: (m) => write("INFO", m),
        warn: (m) => write("WARN", m),
        error: (m) => write("ERROR", m),
    };
}
