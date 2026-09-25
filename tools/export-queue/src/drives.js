// Watches the client drives, so the page can say "MG_Mega isn't reachable" before anyone
// submits a job, instead of every file on it looking like a typo. Several shares live on the
// same NAS, so one outage shows up on many drives at once.
import { createLimiter } from "./fsutil.js";

export function createDriveMonitor({ drives, fs, timeoutMs, intervalMs, log, onChange }) {
    const limiter = createLimiter(2);
    const state = drives.map((d) => ({ name: d.name, path: d.path, ok: null, checkedAt: null, error: null, busy: false }));
    let timer = null;

    function describe(err) {
        if (err.timedOut) return `didn't answer within ${Math.round(timeoutMs / 1000)} seconds`;
        if (err.code === "ENOENT" || err.code === "ENOTDIR") return "can't be found";
        if (err.code === "EACCES" || err.code === "EPERM") return "permission denied";
        return `can't be reached (${err.code || err.message})`;
    }

    async function checkOne(s) {
        // A stat that is still hanging from the last round keeps its slot; don't queue another.
        if (s.busy) return false;
        s.busy = true;
        let ok, error;
        try {
            const stat = await limiter.runTimed(() => fs.stat(s.path).finally(() => { s.busy = false; }), timeoutMs, "timeout");
            ok = stat.isDirectory();
            error = ok ? null : "isn't a folder";
        } catch (err) {
            ok = false;
            error = describe(err);
        }
        const changed = s.ok !== ok || s.error !== error;
        if (changed && !ok) log.warn(`Client drive ${s.name} (${s.path}) ${error}.`);
        else if (changed && s.ok === false) log.info(`Client drive ${s.name} is reachable again.`);
        Object.assign(s, { ok, error, checkedAt: Date.now() });
        return changed;
    }

    async function checkAll() {
        const changes = await Promise.all(state.map(checkOne));
        if (changes.some(Boolean)) onChange?.();
    }

    return {
        start() {
            checkAll().catch((err) => log.error(`Drive check failed: ${err.message}`));
            timer = setInterval(() => checkAll().catch((err) => log.error(`Drive check failed: ${err.message}`)), intervalMs);
            timer.unref();
        },
        stop() {
            clearInterval(timer);
        },
        checkAll,
        snapshot: () => state.map(({ name, path, ok, checkedAt, error }) => ({ name, path, ok, checkedAt, error })),
        okFor: (drivePath) => state.find((s) => s.path === drivePath)?.ok ?? null,
    };
}
