// Turns the path a designer pastes (Mac "/Volumes/...", their own drive letter, a quoted
// "Copy as path" value, file:// or smb:// URLs) into a path on the export PC, and refuses
// anything outside the configured allowed roots.
import fs from "node:fs/promises";
import path from "node:path";

export class PathError extends Error {
    constructor(message, field) {
        super(message);
        this.field = field;
    }
}

export function createPathResolver({ allowedRoots, pathMappings, platform = "win32" }) {
    const p = platform === "win32" ? path.win32 : path.posix;
    const caseInsensitive = platform === "win32";
    const fold = (s) => (caseInsensitive ? s.toLowerCase() : s);

    const toNative = (s) => (platform === "win32" ? s.replace(/\//g, "\\") : s);
    const roots = allowedRoots.map((r) => p.normalize(toNative(r.trim())));
    // Longest "from" first, so "/Volumes/Projects/Archive" wins over "/Volumes/Projects".
    const mappings = [...pathMappings]
        .map((m) => ({ from: m.from.replace(/[\\/]+$/, ""), to: m.to.replace(/[\\/]+$/, "") }))
        .sort((a, b) => b.from.length - a.from.length);

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
            if (n >= 0) return m.to + probe.slice(n).replace(/\//g, platform === "win32" ? "\\" : "/");
        }
        return s;
    }

    function isUnder(candidate, root) {
        const c = fold(candidate), r = fold(root).replace(/[\\/]+$/, "");
        return c === r || c.startsWith(r + p.sep);
    }

    // Returns the absolute export-PC path, or throws PathError with a message for the designer.
    function resolve(input, field, { mustExist = true, kind = "file", extension } = {}) {
        const raw = clean(input);
        if (!raw) throw new PathError("Enter a path.", field);
        if (raw.length > 1024) throw new PathError("That path is too long.", field);
        if (/[\u0000-\u001f<>|"?*]/.test(raw.replace(/^[A-Za-z]:/, ""))) {
            throw new PathError("The path contains characters that can't appear in a file path.", field);
        }
        if (raw.split(/[\\/]/).includes("..")) {
            throw new PathError("Paths with \"..\" aren't accepted; paste the file's full path instead.", field);
        }
        const mapped = toNative(applyMappings(raw));
        if (!p.isAbsolute(mapped) || (platform === "win32" && !/^([A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(mapped))) {
            throw new PathError("Use the full path, starting with the network drive (e.g. \\\\NAS\\Projects\\... or /Volumes/Projects/...).", field);
        }
        let resolved = p.normalize(mapped).replace(/[\\/]+$/, "") || mapped;
        if (/^[A-Za-z]:$/.test(resolved)) resolved += "\\";                  // "P:" means the drive's root
        if (!roots.some((r) => isUnder(resolved, r))) {
            throw new PathError(`That location isn't on a drive the export PC is allowed to use (${allowedRoots.join(", ")}).`, field);
        }
        if (extension && p.extname(resolved).toLowerCase() !== extension) {
            throw new PathError(`Expected a ${extension} file.`, field);
        }
        return { resolved, mustExist, kind };
    }

    async function resolveExisting(input, field, opts = {}) {
        const { resolved, kind } = resolve(input, field, opts);
        let stat;
        try {
            stat = await fs.stat(resolved);
        } catch (err) {
            const reason = err.code === "ENOENT" ? "doesn't exist or the export PC can't see it"
                : err.code === "EACCES" || err.code === "EPERM" ? "can't be opened (permission denied)"
                : `can't be read (${err.code || err.message})`;
            throw new PathError(`${resolved} ${reason}.`, field);
        }
        if (kind === "file" && !stat.isFile()) throw new PathError(`${resolved} is a folder, not a file.`, field);
        if (kind === "folder" && !stat.isDirectory()) throw new PathError(`${resolved} is not a folder.`, field);
        return resolved;
    }

    return { resolve: (input, field, opts) => resolve(input, field, opts).resolved, resolveExisting, pathApi: p };
}

// Picks an output path that doesn't overwrite anything: "Poster.pdf", then "Poster (2).pdf", ...
export async function uniquePath(pathApi, target, overwrite, { folder = false } = {}) {
    if (overwrite) return target;
    const dir = pathApi.dirname(target);
    const ext = folder ? "" : pathApi.extname(target);
    const base = pathApi.basename(target, ext);
    for (let n = 1; n < 1000; n++) {
        const candidate = n === 1 ? target : pathApi.join(dir, `${base} (${n})${ext}`);
        try {
            await fs.access(candidate);
        } catch {
            return candidate;
        }
    }
    throw new PathError(`Too many existing exports named "${base}${ext}" in ${dir}.`, "outputFolder");
}
