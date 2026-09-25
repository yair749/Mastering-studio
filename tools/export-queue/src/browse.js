// Folder browser for the client drives. Browsers never reveal where a picked or dropped file
// lives, so the reliable picker is one where the export PC lists its own drives: whatever the
// designer picks is then exactly the path the export PC will open.
import { createLimiter, mapLimit } from "./fsutil.js";
import { PathError } from "./paths.js";

// Mac resource files ("._Poster.indd" looks like an InDesign file!), InDesign lock files,
// Windows/NAS system folders and temp files.
const HIDDEN = /^[.~$]|^#recycle$|^@eaDir$|^System Volume Information$|\.idlk$/i;
const MAX_ENTRIES = 1000;

export class BrowseError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

export function createBrowser({ resolver, monitor, timeoutMs }) {
    // Two listings at once at most: a hung share must not tie up all of Node's file threads,
    // which the worker and the web page need too.
    const limiter = createLimiter(2);
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "accent" });
    const p = resolver.pathApi;
    const fs = resolver.fs;
    const fold = (s) => s.normalize("NFC").toLowerCase();

    function roots() {
        return resolver.drives.map((d) => ({ name: d.name, path: d.path, ok: monitor ? monitor.okFor(d.path) : null }));
    }

    async function readFolder(resolved, needle) {
        let entries = null, dir = resolved, lastError = null;
        for (const candidate of new Set([resolved, resolved.normalize("NFC"), resolved.normalize("NFD")])) {
            try {
                entries = await fs.readdir(candidate, { withFileTypes: true });
                dir = candidate;
                break;
            } catch (err) {
                lastError = err;
                if (err.code !== "ENOENT") break;
            }
        }
        if (!entries) throw lastError;

        const folders = [], files = [];
        for (const entry of entries) {
            if (HIDDEN.test(entry.name) || (needle && !fold(entry.name).includes(needle))) continue;
            if (entry.isDirectory()) folders.push(entry.name);
            else if (entry.isFile() && /\.indd$/i.test(entry.name)) files.push(entry.name);
        }
        folders.sort(collator.compare);
        files.sort(collator.compare);
        const keptFolders = folders.slice(0, MAX_ENTRIES);
        const keptFiles = files.slice(0, MAX_ENTRIES - keptFolders.length);
        // Only the listed .indd files are stat'ed (for "saved 2 days ago"); folders need nothing.
        const fileInfo = await mapLimit(keptFiles, 2, async (name) => {
            const full = p.join(dir, name);
            try {
                const stat = await fs.stat(full);
                return { name, path: full, modified: Math.round(stat.mtimeMs), bytes: stat.size };
            } catch {
                return { name, path: full, modified: null, bytes: null };
            }
        });
        return {
            dir,
            folders: keptFolders.map((name) => ({ name, path: p.join(dir, name) })),
            files: fileInfo,
            truncated: folders.length + files.length > MAX_ENTRIES,
        };
    }

    async function list(input, q = "") {
        const resolved = resolver.resolve(input, "path", { kind: "folder" });
        const needle = fold(String(q).trim().slice(0, 200));
        const busy = "The export PC is busy reading other folders. Try again in a minute.";
        let listing;
        try {
            listing = await limiter.runTimed(() => readFolder(resolved, needle), timeoutMs, resolver.notAnswering(resolved),
                { maxWaitMs: timeoutMs, waitMessage: busy });
        } catch (err) {
            if (err.timedOut) throw new BrowseError(err.message, err.message === busy ? 503 : 504);
            // inspect() explains a missing folder (or an unreachable drive) the same way as elsewhere.
            if (err.code === "ENOENT" || err.code === "ENOTDIR") await resolver.inspect(resolved, "path", { kind: "folder" });
            const name = p.basename(resolved) || resolved;
            if (err.code === "EACCES" || err.code === "EPERM") throw new PathError(`The export PC isn't allowed to open “${name}” (permission denied).`, "path");
            throw new PathError(`The export PC can't read “${name}” (${err.code || err.message}).`, "path");
        }
        const where = resolver.locate(listing.dir);
        const crumbs = [{ name: where.drive.name, path: where.base }];
        let at = where.base;
        for (const name of where.crumbs) {
            at = p.join(at, name);
            crumbs.push({ name, path: at });
        }
        return { path: listing.dir, drive: where.drive, crumbs, folders: listing.folders, files: listing.files, truncated: listing.truncated };
    }

    return { roots, list };
}
