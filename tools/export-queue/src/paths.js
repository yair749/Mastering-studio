// Turns the path a designer pastes (Mac "/Volumes/...", their own drive letter, a quoted
// "Copy as path" value, file:// or smb:// URLs) into a path on the export PC, refuses anything
// outside the configured allowed roots, and says in plain words why a path can't be used.
import fsp from "node:fs/promises";
import path from "node:path";
import { NETWORK_TIMEOUT_MS, withTimeout } from "./fsutil.js";

export class PathError extends Error {
    constructor(message, field, { timedOut = false } = {}) {
        super(message);
        this.field = field;
        this.timedOut = timedOut;
    }
}

// The name people know a root by: the share for "\\server\share", "P:" for a drive letter.
export function driveLabel(root) {
    const r = String(root).trim().replace(/[\\/]+$/, "");
    if (/^[A-Za-z]:$/.test(r)) return r.toUpperCase();
    if (/^[A-Za-z]:[\\/]/.test(r)) return r;
    return r.split(/[\\/]/).filter(Boolean).pop() || r;
}

const trimSep = (s) => s.replace(/[\\/]+$/, "");

// Mappings handed to indesign-worker.jsx so it can find images that were placed on a Mac.
// InDesign on Windows may report such a link as "/Volumes/Share/...", as the old-style
// "Share:folder:file.psd", or as an smb:// URL, so each drive gets all three forms.
export function buildLinkMappings(pathMappings, drives) {
    const out = [];
    const seen = new Set();
    const add = (from, to) => {
        const key = from.toLowerCase();
        if (!from || !to || seen.has(key)) return;
        seen.add(key);
        out.push({ from, to });
    };
    const sepOf = (to) => (to.includes("\\") ? "\\" : "/");
    for (const m of pathMappings) {
        const from = trimSep(m.from), to = trimSep(m.to);
        add(from, to);
        const volume = /^\/Volumes\/([^/]+)$/i.exec(from);
        if (volume) add(`${volume[1]}:`, to + sepOf(to));
    }
    for (const d of drives) {
        const to = trimSep(d.path);
        add(`/Volumes/${d.name}`, to);
        add(`${d.name}:`, to + sepOf(to));
    }
    return out.sort((a, b) => b.from.length - a.from.length);
}

export function createPathResolver({ allowedRoots, pathMappings, drives = [], platform = "win32", fs = fsp, timeoutMs = NETWORK_TIMEOUT_MS }) {
    const win = platform === "win32";
    const p = win ? path.win32 : path.posix;
    const fold = (s) => (win ? s.toLowerCase() : s);

    const toNative = (s) => (win ? s.replace(/\//g, "\\") : s);
    const roots = allowedRoots.map((r) => p.normalize(toNative(r.trim())));
    // Longest "from" first, so "/Volumes/Projects/Archive" wins over "/Volumes/Projects".
    const mappings = [...pathMappings]
        .map((m) => ({ from: trimSep(m.from), to: trimSep(m.to) }))
        .sort((a, b) => b.from.length - a.from.length);
    // allowedRoots stays the only security boundary: a drive listed outside it isn't offered.
    const allDrives = drives.map((d) => ({
        name: d.name,
        path: trimSep(p.normalize(toNative(d.path))) || d.path,
        letter: d.letter ? d.letter.slice(0, 2).toUpperCase() : null,
    }));
    const driveList = allDrives.filter((d) => roots.some((r) => isUnder(d.path, r)));
    const ignoredDrives = allDrives.filter((d) => !driveList.includes(d));

    function clean(input) {
        let s = String(input ?? "").trim();
        if (/^(["']).*\1$/.test(s)) s = s.slice(1, -1).trim();            // Windows "Copy as path"
        if (/^file:\/\//i.test(s)) {
            try { s = decodeURIComponent(new URL(s).pathname); } catch { /* keep as typed */ }
            if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);                  // file:///C:/...
        } else if (/^smb:\/\//i.test(s)) {
            try { s = decodeURIComponent(s); } catch { /* keep as typed */ }
        }
        return s;
    }

    // Length of the part of `probe` that `from` covers, or -1. macOS names a second mount of the
    // same share "/Volumes/Share-1" (then -2, ...), so a "/Volumes/..." mapping also covers those.
    function matchLength(probe, from) {
        const a = fold(probe), b = fold(from);
        if (a === b || a.startsWith(b + "/")) return from.length;
        if (/^\/volumes\//i.test(from)) {
            const suffix = /^-\d{1,3}(?=\/|$)/.exec(a.slice(b.length));
            if (a.startsWith(b) && suffix) return from.length + suffix[0].length;
        }
        return -1;
    }

    function applyMappings(s) {
        const probe = s.replace(/\\/g, "/");
        for (const m of mappings) {
            const n = matchLength(probe, m.from.replace(/\\/g, "/"));
            if (n >= 0) return { value: m.to + probe.slice(n).replace(/\//g, win ? "\\" : "/"), matched: true };
        }
        return { value: s, matched: false };
    }

    function isUnder(candidate, root) {
        const c = fold(candidate), r = trimSep(fold(root));
        return c === r || c.startsWith(r + p.sep);
    }

    const rootPath = (base) => (/^[A-Za-z]:$/.test(base) ? base + "\\" : base);

    // Which client drive a resolved path is on, and the folder names below the drive's root.
    // Paths under an allowed root that isn't in the drive list get that root as their "drive".
    function locate(resolved) {
        let best = null;
        const consider = (base, drive) => {
            const b = trimSep(base);
            if (isUnder(resolved, base) && (!best || b.length > best.base.length)) best = { base: b, drive };
        };
        for (const d of driveList) {
            consider(d.path, { name: d.name, path: d.path });
            if (d.letter) consider(`${d.letter}\\`, { name: d.name, path: d.path });
        }
        if (!best) for (const r of roots) consider(r, { name: driveLabel(r), path: rootPath(trimSep(r)) });
        if (!best) return null;
        const crumbs = resolved.slice(best.base.length).split(/[\\/]/).filter(Boolean);
        return { drive: best.drive, base: rootPath(best.base), crumbs };
    }

    function driveNames() {
        const names = [...new Set(driveList.map((d) => d.name))];
        if (!names.length) return "";
        return names.length > 20 ? `${names.slice(0, 20).join(", ")} …` : names.join(", ");
    }

    // Why a path that isn't inside the allowed roots can't be used, in the designer's terms.
    // Only reached when the path was refused, so e.g. a "Desktop" folder on a client drive is fine.
    function explainRefusal(raw, { matched, absolute, kind }) {
        const s = raw.replace(/\\/g, "/");
        const noun = kind === "folder" ? "folder" : "file";
        const pick = `Use Browse… to pick the ${noun}`;
        const unknownDrive = (label) => {
            const list = driveNames();
            return `The export PC doesn't have a drive called “${label}”.${list ? ` Client drives: ${list}.` : ""} Use Browse… to pick the ${noun}.`;
        };
        const ownComputer = kind === "folder"
            ? "This folder is on your own computer, not on a client drive. Choose a folder on the client's drive."
            : "This file is on your own computer, not on a client drive. Save it to the client's drive first.";
        if (!matched) {
            if (/^~(\/|$)/.test(s) || /^\/(Users|private)\//i.test(s) || /^\/Volumes\/Macintosh HD(\/|$| - )/i.test(s) || /^C:(\/|$)/i.test(s)) {
                return ownComputer;
            }
            let m = /^\/Volumes\/([^/]+)/i.exec(s);
            if (m) {
                const known = driveList.some((d) => d.name.toLowerCase() === m[1].replace(/-\d{1,3}$/, "").toLowerCase());
                if (!known) return unknownDrive(m[1]);
            } else if ((m = /^(?:smb:)?\/\/([^/]+)\/([^/]+)/i.exec(s))) {
                return unknownDrive(`${m[2]}” on “${m[1]}`);
            } else if (s.split("/").some((seg) => /^(desktop|documents|downloads)$/i.test(seg))) {
                return ownComputer;
            } else if ((m = /^([A-Za-z]):(\/|$)/.exec(s))) {
                return `Drive ${m[1].toUpperCase()}: isn't one of the export PC's drives. Use Browse…, or copy the path again from the client drive.`;
            } else if (!absolute) {
                return s.includes("/")
                    ? `That isn't a full path. ${pick}, or copy the full path from the client drive.`
                    : `That's only the ${noun} name. ${pick}, or copy its full path (see “How do I get the path?”).`;
            }
        }
        return `That isn't on one of the client drives the export PC can use. ${pick}.`;
    }

    // Returns the absolute export-PC path, or throws PathError with a message for the designer.
    function resolve(input, field, { kind = "file", extension } = {}) {
        const raw = clean(input);
        if (!raw) throw new PathError("Enter a path.", field);
        if (raw.length > 1024) throw new PathError("That path is too long.", field);
        if (/[\u0000-\u001f<>|"?*]/.test(raw.replace(/^[A-Za-z]:/, ""))) {
            throw new PathError("The path contains characters that can't appear in a file path.", field);
        }
        if (raw.split(/[\\/]/).includes("..")) {
            throw new PathError("Paths with \"..\" aren't accepted; paste the file's full path instead.", field);
        }
        const { value, matched } = applyMappings(raw);
        const mapped = toNative(value);
        const absolute = p.isAbsolute(mapped) && (!win || /^([A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(mapped));
        if (absolute) {
            let resolved = trimSep(p.normalize(mapped)) || mapped;
            if (/^[A-Za-z]:$/.test(resolved)) resolved += "\\";                  // "P:" means the drive's root
            if (roots.some((r) => isUnder(resolved, r))) {
                if (extension && p.extname(resolved).toLowerCase() !== extension) {
                    throw new PathError(extension === ".indd" ? "That isn't an InDesign file (.indd)." : `Expected a ${extension} file.`, field);
                }
                return resolved;
            }
        }
        throw new PathError(explainRefusal(raw, { matched, absolute, kind }), field);
    }

    function isAllowed(candidate) {
        const n = trimSep(p.normalize(toNative(String(candidate))));
        return p.isAbsolute(n) && !n.split(/[\\/]/).includes("..") && roots.some((r) => isUnder(n, r));
    }

    function notAnswering(where) {
        return `${where?.drive.name ?? "The drive"} isn't answering from the export PC. Try again in a minute.`;
    }

    // A file-system call on a client drive, with the network timeout and a message naming the drive.
    function timed(promise, forPath, field) {
        return withTimeout(promise, timeoutMs, notAnswering(locate(forPath))).catch((err) => {
            if (err.timedOut) throw new PathError(err.message, field, { timedOut: true });
            throw err;
        });
    }

    async function explainMissing(resolved, err, field, kind, where) {
        const name = p.basename(resolved) || resolved;
        if (err.code === "ENOENT" || err.code === "ENOTDIR") {
            // A missing file and an unreachable drive look the same to fs.stat; the drive's root tells them apart.
            const rootOk = where
                ? await timed(fs.stat(where.base), where.base, field).then(() => true, (e) => { if (e.timedOut) throw e; return false; })
                : false;
            if (!rootOk || fold(trimSep(where.base)) === fold(trimSep(resolved))) {
                return new PathError(`The export PC can't reach ${where?.drive.name ?? name} right now. The file server may be off, or the export PC lost its connection to it. Tell whoever looks after the export PC.`, field);
            }
            const folder = [where.drive.name, ...where.crumbs.slice(0, -1)].join(" › ");
            return new PathError(kind === "folder"
                ? `There's no folder “${name}” in ${folder} (as the export PC sees it). Check the name, or whether it was moved.`
                : `“${name}” isn't in ${folder} (as the export PC sees it). Check the name, or whether it was moved.`, field);
        }
        if (err.code === "EACCES" || err.code === "EPERM") return new PathError(`The export PC isn't allowed to open “${name}” (permission denied).`, field);
        return new PathError(`The export PC can't read “${name}” (${err.code || err.message}).`, field);
    }

    // Resolves and checks that the path exists. macOS sends decomposed (NFD) accented names and
    // Windows compares names exactly, so the other Unicode forms are tried before giving up.
    // Returns { path, stat } with the spelling that exists on disk.
    async function inspect(input, field, opts = {}) {
        const kind = opts.kind ?? "file";
        const resolved = resolve(input, field, opts);
        const where = locate(resolved);
        let firstError = null;
        for (const candidate of new Set([resolved, resolved.normalize("NFC"), resolved.normalize("NFD")])) {
            let stat;
            try {
                stat = await timed(fs.stat(candidate), resolved, field);
            } catch (err) {
                if (err instanceof PathError) throw err;
                firstError ??= err;
                if (err.code === "ENOENT" || err.code === "ENOTDIR") continue;
                break;
            }
            const name = p.basename(candidate) || candidate;
            if (kind === "file" && !stat.isFile()) throw new PathError(`“${name}” is a folder, not a file.`, field);
            if (kind === "folder" && !stat.isDirectory()) throw new PathError(`“${name}” is a file, not a folder.`, field);
            return { path: candidate, stat };
        }
        throw await explainMissing(resolved, firstError, field, kind, where);
    }

    async function resolveExisting(input, field, opts) {
        return (await inspect(input, field, opts)).path;
    }

    // Picks an output path that doesn't overwrite anything: "Poster.pdf", then "Poster (2).pdf", ...
    // `renamedFrom` is the name that was already taken, so the designer can be told.
    async function uniqueOutput(target, overwrite, { folder = false } = {}) {
        if (overwrite) return { path: target, renamedFrom: null };
        const dir = p.dirname(target);
        const ext = folder ? "" : p.extname(target);
        const base = p.basename(target, ext);
        for (let n = 1; n < 1000; n++) {
            const candidate = n === 1 ? target : p.join(dir, `${base} (${n})${ext}`);
            const taken = await timed(fs.access(candidate), candidate, "outputFolder").then(() => true, (err) => {
                if (err instanceof PathError) throw err;
                return false;
            });
            if (!taken) return { path: candidate, renamedFrom: n === 1 ? null : p.basename(target) };
        }
        throw new PathError(`Too many existing exports named "${base}${ext}" in ${dir}.`, "outputFolder");
    }

    return {
        resolve: (input, field, opts) => resolve(input, field, opts),
        resolveExisting,
        inspect,
        locate,
        isAllowed,
        uniqueOutput,
        timed,
        notAnswering: (forPath) => notAnswering(locate(forPath)),
        // Compares two export-PC paths the way this PC's file system does.
        key: (s) => fold(String(s).normalize("NFC")),
        drives: driveList,
        ignoredDrives,
        pathApi: p,
        fs,
    };
}
