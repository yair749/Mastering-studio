// Job store on SQLite (built into Node.js 22+, no database server to install or run).
// The queue lives here too: a job is claimed with one atomic UPDATE, so a job can never
// be picked twice, and pending jobs survive restarts of the server or the PC.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const STATUSES = ["pending", "processing", "completed", "failed", "cancelled"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    status        TEXT    NOT NULL CHECK (status IN ('pending','processing','completed','failed','cancelled')),
    created_at    INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER,
    submitted_by  TEXT    NOT NULL,
    client_ip     TEXT,
    source_input  TEXT    NOT NULL,   -- path exactly as the designer entered it
    source_path   TEXT    NOT NULL,   -- resolved path on the export PC
    format        TEXT    NOT NULL,
    params        TEXT    NOT NULL,   -- JSON: validated export options
    output_paths  TEXT    NOT NULL DEFAULT '[]',
    warnings      TEXT    NOT NULL DEFAULT '[]',
    error         TEXT,
    retry_of      INTEGER REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, id);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function rowToJob(row) {
    if (!row) return null;
    return {
        id: row.id,
        status: row.status,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        submittedBy: row.submitted_by,
        sourceInput: row.source_input,
        sourcePath: row.source_path,
        format: row.format,
        params: JSON.parse(row.params),
        outputPaths: JSON.parse(row.output_paths),
        warnings: JSON.parse(row.warnings),
        error: row.error,
        retryOf: row.retry_of,
        batchId: row.batch_id ?? null,
    };
}

// Case-insensitive, accent-form-insensitive text for the search box: macOS sends decomposed
// (NFD) names, and SQLite's own lower() only folds A-Z.
const searchText = (value) => (value == null ? "" : String(value).normalize("NFC").toLowerCase());
const baseName = (value) => (value == null ? "" : String(value).split(/[\\/]/).pop());

export class JobStore {
    constructor(file) {
        if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
        this.db.exec(SCHEMA);
        // Added in 2.0; databases from 1.x get the column on first start.
        if (!this.db.prepare("PRAGMA table_info(jobs)").all().some((c) => c.name === "batch_id")) {
            this.db.exec("ALTER TABLE jobs ADD COLUMN batch_id TEXT");
        }
        this.db.function("eq_search", { deterministic: true }, searchText);
        this.db.function("eq_basename", { deterministic: true }, baseName);
        this.stmt = {
            insert: this.db.prepare(`INSERT INTO jobs (status, created_at, submitted_by, client_ip, source_input, source_path, format, params, retry_of, batch_id)
                                     VALUES ('pending', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
            get: this.db.prepare("SELECT * FROM jobs WHERE id = ?"),
            claim: this.db.prepare(`UPDATE jobs SET status = 'processing', started_at = ?
                                    WHERE id = (SELECT id FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1)
                                    RETURNING *`),
            finish: this.db.prepare(`UPDATE jobs SET status = ?, finished_at = ?, output_paths = ?, warnings = ?, error = ?
                                     WHERE id = ? AND status = 'processing' RETURNING *`),
            setOutputs: this.db.prepare("UPDATE jobs SET output_paths = ? WHERE id = ? AND status = 'processing' RETURNING *"),
            requeue: this.db.prepare(`UPDATE jobs SET status = 'pending', started_at = NULL, output_paths = '[]'
                                      WHERE id = ? AND status = 'processing' RETURNING *`),
            cancel: this.db.prepare(`UPDATE jobs SET status = 'cancelled', finished_at = ?, error = 'Cancelled by ' || ?
                                     WHERE id = ? AND status = 'pending' RETURNING *`),
            interrupted: this.db.prepare("SELECT id, output_paths FROM jobs WHERE status = 'processing'"),
            recover: this.db.prepare(`UPDATE jobs SET status = 'failed', finished_at = ?, output_paths = '[]', error = ?
                                      WHERE id = ? AND status = 'processing'`),
            counts: this.db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"),
            position: this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending' AND id < ?"),
            purge: this.db.prepare(`DELETE FROM jobs WHERE status IN ('completed','failed','cancelled') AND finished_at < ?
                                    AND id NOT IN (SELECT retry_of FROM jobs WHERE retry_of IS NOT NULL)`),
            durations: this.db.prepare(`SELECT finished_at - started_at AS ms FROM jobs
                                        WHERE status = 'completed' AND format = ? AND started_at IS NOT NULL AND finished_at >= started_at
                                        ORDER BY id DESC LIMIT 20`),
            getMeta: this.db.prepare("SELECT value FROM meta WHERE key = ?"),
            setMeta: this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
        };
    }

    create({ submittedBy, clientIp, sourceInput, sourcePath, format, params, retryOf = null, batchId = null }) {
        return rowToJob(this.stmt.insert.get(Date.now(), submittedBy, clientIp ?? null, sourceInput, sourcePath,
            format, JSON.stringify(params), retryOf, batchId));
    }

    // All or nothing: a batch of files x formats is queued in one transaction.
    createMany(jobs) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const created = jobs.map((j) => this.create(j));
            this.db.exec("COMMIT");
            return created;
        } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
    }

    get(id) {
        return rowToJob(this.stmt.get.get(id));
    }

    // Atomically moves the oldest pending job to "processing" and returns it (or null).
    claimNext() {
        return rowToJob(this.stmt.claim.get(Date.now()));
    }

    finish(id, { ok, outputPaths = [], warnings = [], error = null }) {
        return rowToJob(this.stmt.finish.get(ok ? "completed" : "failed", Date.now(),
            JSON.stringify(outputPaths), JSON.stringify(warnings), ok ? null : error, id));
    }

    // The planned output while a job runs, so the dashboard (and crash recovery) know where it goes.
    setOutputs(id, outputPaths) {
        return rowToJob(this.stmt.setOutputs.get(JSON.stringify(outputPaths), id));
    }

    // Back to the queue with its place kept (its id is still the oldest), e.g. when InDesign
    // couldn't be reached and the job never started.
    requeue(id) {
        return rowToJob(this.stmt.requeue.get(id));
    }

    cancel(id, by) {
        return rowToJob(this.stmt.cancel.get(Date.now(), by, id));
    }

    // Jobs left "processing" by a crash or power cut are marked failed (never silently re-run:
    // the export may have half-finished) so the designer can check and retry.
    recoverInterrupted() {
        const ids = [];
        for (const row of this.stmt.interrupted.all()) {
            const planned = JSON.parse(row.output_paths || "[]")[0]?.path;
            const name = planned ? String(planned).split(/[\\/]/).pop() : null;
            const error = "The export server stopped while this job was running. " +
                (name ? `InDesign may already have written ${name}: check it, then run the job again.` : "Check the output, then run the job again.");
            this.stmt.recover.run(Date.now(), error, row.id);
            ids.push(row.id);
        }
        return ids;
    }

    // Newest first. `q` matches the file name, the path as typed, or the person's name.
    list({ status, limit = 200, beforeId, q } = {}) {
        const where = [], args = [];
        const statuses = Array.isArray(status) ? status : status ? [status] : [];
        if (statuses.length) { where.push(`status IN (${statuses.map(() => "?").join(", ")})`); args.push(...statuses); }
        if (beforeId) { where.push("id < ?"); args.push(beforeId); }
        const needle = searchText(q).trim();
        if (needle) {
            where.push("(instr(eq_search(eq_basename(source_path)), ?) > 0 OR instr(eq_search(source_input), ?) > 0 OR instr(eq_search(submitted_by), ?) > 0)");
            args.push(needle, needle, needle);
        }
        const n = Math.min(Math.max(limit, 1), 500);
        const sql = `SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
        const rows = this.db.prepare(sql).all(...args, n + 1).map(rowToJob);
        return { jobs: rows.slice(0, n), hasMore: rows.length > n };
    }

    // Median duration of the last 20 successful jobs of a format, or null with fewer than 3.
    estimate(format) {
        const ms = this.stmt.durations.all(format).map((r) => r.ms).sort((a, b) => a - b);
        if (ms.length < 3) return null;
        const mid = Math.floor(ms.length / 2);
        return Math.round(ms.length % 2 ? ms[mid] : (ms[mid - 1] + ms[mid]) / 2);
    }

    counts() {
        const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
        for (const { status, n } of this.stmt.counts.all()) out[status] = n;
        return out;
    }

    queuePosition(id) {
        return this.stmt.position.get(id).n + 1;
    }

    purgeOlderThan(days) {
        return Number(this.stmt.purge.run(Date.now() - days * 86_400_000).changes);
    }

    getMeta(key) {
        const row = this.stmt.getMeta.get(key);
        return row ? JSON.parse(row.value) : null;
    }

    setMeta(key, value) {
        this.stmt.setMeta.run(key, JSON.stringify(value));
    }

    close() {
        this.db.close();
    }
}
