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
    };
}

export class JobStore {
    constructor(file) {
        if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
        this.db.exec(SCHEMA);
        this.stmt = {
            insert: this.db.prepare(`INSERT INTO jobs (status, created_at, submitted_by, client_ip, source_input, source_path, format, params, retry_of)
                                     VALUES ('pending', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
            get: this.db.prepare("SELECT * FROM jobs WHERE id = ?"),
            claim: this.db.prepare(`UPDATE jobs SET status = 'processing', started_at = ?
                                    WHERE id = (SELECT id FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1)
                                    RETURNING *`),
            finish: this.db.prepare(`UPDATE jobs SET status = ?, finished_at = ?, output_paths = ?, warnings = ?, error = ?
                                     WHERE id = ? AND status = 'processing' RETURNING *`),
            cancel: this.db.prepare(`UPDATE jobs SET status = 'cancelled', finished_at = ?, error = 'Cancelled by ' || ?
                                     WHERE id = ? AND status = 'pending' RETURNING *`),
            recover: this.db.prepare(`UPDATE jobs SET status = 'failed', finished_at = ?,
                                      error = 'The export server stopped while this job was running. Check the output, then retry.'
                                      WHERE status = 'processing' RETURNING id`),
            counts: this.db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"),
            position: this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending' AND id < ?"),
            purge: this.db.prepare(`DELETE FROM jobs WHERE status IN ('completed','failed','cancelled') AND finished_at < ?
                                    AND id NOT IN (SELECT retry_of FROM jobs WHERE retry_of IS NOT NULL)`),
            getMeta: this.db.prepare("SELECT value FROM meta WHERE key = ?"),
            setMeta: this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
        };
    }

    create({ submittedBy, clientIp, sourceInput, sourcePath, format, params, retryOf = null }) {
        return rowToJob(this.stmt.insert.get(Date.now(), submittedBy, clientIp ?? null, sourceInput, sourcePath,
            format, JSON.stringify(params), retryOf));
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

    cancel(id, by) {
        return rowToJob(this.stmt.cancel.get(Date.now(), by, id));
    }

    // Jobs left "processing" by a crash or power cut are marked failed (never silently re-run:
    // the export may have half-finished) so the designer can check and retry.
    recoverInterrupted() {
        return this.stmt.recover.all(Date.now()).map((r) => r.id);
    }

    list({ status, limit = 200, beforeId } = {}) {
        const where = [], args = [];
        if (status) { where.push("status = ?"); args.push(status); }
        if (beforeId) { where.push("id < ?"); args.push(beforeId); }
        const sql = `SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
        return this.db.prepare(sql).all(...args, Math.min(Math.max(limit, 1), 500)).map(rowToJob);
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
