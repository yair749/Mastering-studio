// Pure helpers for the web UI: path display, times, sizes, wording. Nothing here touches the
// DOM or browser globals, so the same file can be imported by a plain Node script to check it.

// ---------------------------------------------------------------- pasted paths

// One path per line. Finder's "Copy … as Pathnames" and Explorer's "Copy as path" both give one
// per line, but Explorer can also put several quoted paths on one line: "N:\a.indd" "N:\b.indd".
// Exact duplicates are dropped (and counted) so a double paste doesn't queue everything twice.
export function parseLines(text) {
    const seen = new Set();
    const paths = [];
    let duplicates = 0;
    for (const raw of String(text ?? "").split(/\r\n|\r|\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const parts = /^("[^"]+"\s*){2,}$/.test(line) ? line.match(/"[^"]+"/g) : [line];
        for (const part of parts) {
            if (seen.has(part)) { duplicates++; continue; }
            seen.add(part);
            paths.push(part);
        }
    }
    return { paths, duplicates };
}

// A dropped file:// URL or pasted-looking path, as a path the server understands; null otherwise.
export function dropToPath(value) {
    const s = String(value ?? "").trim();
    if (!s) return null;
    if (/^file:\/\//i.test(s)) {
        try {
            const url = new URL(s);
            const p = decodeURIComponent(url.pathname);
            if (url.host && url.host !== "localhost") return `\\\\${url.host}${p.replace(/\//g, "\\")}`;
            return /^\/[A-Za-z]:\//.test(p) ? p.slice(1).replace(/\//g, "\\") : p;
        } catch {
            return null;
        }
    }
    if (/^(["']?)(\/|\\\\|[A-Za-z]:[\\/]|smb:\/\/)/i.test(s)) return s;
    return null;
}

// ---------------------------------------------------------------- path display

// Mirrors clean() in src/paths.js, so the designer's input lines up with what the server resolved.
export function cleanInput(input) {
    let s = String(input ?? "").trim();
    if (/^(["']).*\1$/.test(s)) s = s.slice(1, -1).trim();
    if (/^file:\/\//i.test(s)) {
        try { s = decodeURIComponent(new URL(s).pathname); } catch { /* keep as typed */ }
        if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
    } else if (/^smb:\/\//i.test(s)) {
        try { s = decodeURIComponent(s); } catch { /* keep as typed */ }
    }
    return s;
}

// { prefix, segs, sep }: "\\srv\share\a" → prefix "\\", segs [srv, share, a]; "M:\a" keeps "M:"
// as the first segment; "/Volumes/X/a" → prefix "/"; "smb://srv/share/a" → prefix "smb://".
export function splitPath(input) {
    let s = cleanInput(input);
    let prefix = "";
    let sep = "/";
    const smb = /^smb:\/+/i.exec(s);
    if (smb) {
        prefix = "smb://";
        s = s.slice(smb[0].length);
    } else if (/^[\\/]{2}(?=[^\\/])/.test(s)) {
        prefix = "\\\\";
        sep = "\\";
        s = s.slice(2);
    } else if (/^[A-Za-z]:/.test(s)) {
        sep = "\\";
    } else if (s.startsWith("/")) {
        prefix = "/";
    }
    return { prefix, segs: s.split(/[\\/]+/).filter(Boolean), sep };
}

export function joinPath({ prefix, segs, sep }) {
    if (!prefix && segs.length === 1 && /^[A-Za-z]:$/.test(segs[0])) return segs[0] + sep;
    return prefix + segs.join(sep);
}

// Case-insensitive and Unicode-normalised, because macOS hands out decomposed names (NFD)
// while the export PC usually stores composed ones.
const segKey = (s) => s.normalize("NFC").toLowerCase();

function startsWithSegs(segs, head) {
    if (head.length > segs.length) return false;
    return head.every((h, i) => segKey(h) === segKey(segs[i]));
}

export function fileName(path) {
    const segs = splitPath(path).segs;
    return segs.length ? segs[segs.length - 1] : String(path ?? "");
}

export function isMacStyle(path) {
    return String(path).startsWith("/");
}

// Replaces the export PC's share root with how the designer sees it, via config.pathMappings
// ({ from: "/Volumes/MG_Mega", to: "\\\\192.168.1.13\\MG_Mega" }). Longest matching "to" wins.
export function reverseMap(pcPath, mappings) {
    const out = splitPath(pcPath);
    let best = null;
    for (const m of mappings || []) {
        const to = splitPath(m.to);
        if (to.prefix !== out.prefix || !to.segs.length || !startsWithSegs(out.segs, to.segs)) continue;
        if (!best || to.segs.length > best.to.segs.length) best = { from: splitPath(m.from), to };
    }
    if (!best) return null;
    return joinPath({ ...best.from, segs: [...best.from.segs, ...out.segs.slice(best.to.segs.length)] });
}

// Shows an export-PC path the way the viewer can use it. The job's own input tells us how its
// submitter reached the share: lining up the end of sourceInput with the end of sourcePath gives
// the pair of roots (e.g. "/Volumes/MG_Mega-1" ↔ "\\192.168.1.13\MG_Mega", or "M:" ↔ "M:"),
// which is applied to the output. That root is only used if it suits the viewer's computer
// (a Windows viewer can't use a colleague's /Volumes path); otherwise a Mac viewer gets the
// /Volumes mapping and everyone else the export PC's path, which works in File Explorer.
export function toMyPath(pcPath, job, { os = "other", mappings = [] } = {}) {
    if (!pcPath) return "";
    let mine = null;
    if (job?.sourceInput && job?.sourcePath) {
        const a = splitPath(job.sourceInput);
        const b = splitPath(job.sourcePath);
        let tail = 0;
        while (tail < a.segs.length && tail < b.segs.length
               && segKey(a.segs[a.segs.length - 1 - tail]) === segKey(b.segs[b.segs.length - 1 - tail])) tail++;
        const myRoot = { prefix: a.prefix, segs: a.segs.slice(0, a.segs.length - tail), sep: a.sep };
        const pcRoot = b.segs.slice(0, b.segs.length - tail);
        const out = splitPath(pcPath);
        if (tail > 0 && (myRoot.prefix || myRoot.segs.length) && out.prefix === b.prefix && startsWithSegs(out.segs, pcRoot)) {
            mine = joinPath({ ...myRoot, segs: [...myRoot.segs, ...out.segs.slice(pcRoot.length)] });
        }
    }
    if (mine && /^smb:/i.test(mine)) mine = null;               // Finder's Go to Folder can't open smb://
    if (os === "mac") {
        if (mine && isMacStyle(mine)) return mine;
        return reverseMap(pcPath, (mappings || []).filter((m) => /^\/Volumes\//i.test(m.from))) || mine || pcPath;
    }
    if (mine && !isMacStyle(mine)) return mine;
    return pcPath;
}

// Where a path is, in the designer's words: { drive, crumbs } with crumbs = folder names below
// the share root. `drives` = ui-config drives [{ name, path }]; the longest matching root wins.
export function placeOf(pcPath, drives, { isFile = true } = {}) {
    if (!pcPath) return null;
    const out = splitPath(pcPath);
    let best = null;
    for (const d of drives || []) {
        const root = splitPath(d.path);
        if (root.prefix !== out.prefix || !root.segs.length || !startsWithSegs(out.segs, root.segs)) continue;
        if (!best || root.segs.length > best.root.segs.length) best = { drive: d, root };
    }
    if (!best) return null;
    const rest = out.segs.slice(best.root.segs.length);
    return { drive: best.drive, crumbs: isFile ? rest.slice(0, -1) : rest };
}

export function placeLabel(place) {
    if (!place) return "";
    return [place.drive.name, ...place.crumbs].join(" › ");
}

// ---------------------------------------------------------------- time, size, numbers

export function duration(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// "about 2 min": estimates are medians, so never more precise than a minute.
export function roughly(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    if (ms < 45_000) return "less than a minute";
    const min = Math.round(ms / 60_000);
    if (min < 60) return `about ${Math.max(1, min)} min`;
    return `about ${Math.round(ms / 360_000) / 10} h`;
}

// Coarse "how long ago" for file dates: "just now", "5 min ago", "2 h ago", "3 days ago".
export function agoShort(ts, now) {
    if (!Number.isFinite(ts)) return "";
    const diff = Math.max(0, now - ts);
    if (diff < 45_000) return "just now";
    if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} min ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
    const days = Math.round(diff / 86_400_000);
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    return new Date(ts).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

// Job times: relative while recent, then a clock time people can match to their day.
export function when(ts, now) {
    if (!Number.isFinite(ts)) return "";
    const diff = Math.max(0, now - ts);
    if (diff < 45_000) return "just now";
    if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} min ago`;
    const d = new Date(ts);
    const today = new Date(now);
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === today.toDateString()) return `today ${time}`;
    const yesterday = new Date(now - 86_400_000);
    if (d.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
    if (diff < 6 * 86_400_000) return `${d.toLocaleDateString([], { weekday: "long" })} ${time}`;
    return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

// Decimal units, like Finder.
export function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return "";
    if (n < 1000) return `${n} bytes`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n;
    let u = -1;
    do { v /= 1000; u++; } while (v >= 1000 && u < units.length - 1);
    return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")} ${units[u]}`;
}

export function ordinal(n) {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
}

export function plural(n, one, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`;
}

export function shortVersion(v) {
    return v ? String(v).split(".").slice(0, 2).join(".") : "";
}

// ---------------------------------------------------------------- jobs

export const FINAL = new Set(["completed", "failed", "cancelled"]);

export function sameName(a, b) {
    const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    return Boolean(norm(a)) && norm(a) === norm(b);
}

// Same rule as the server's ?q=: file name, the path as typed, or the submitter.
export function matchesQuery(job, q) {
    const needle = String(q ?? "").trim().toLowerCase();
    if (!needle) return true;
    return [fileName(job.sourcePath), job.sourceInput, job.submittedBy]
        .some((s) => String(s ?? "").toLowerCase().includes(needle));
}
