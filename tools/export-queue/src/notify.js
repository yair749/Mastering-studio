// Optional push notification (ntfy) when a job fails or completes, and when the queue has to
// wait because InDesign can't be reached. Failures to notify are logged, never allowed to
// affect the job itself.
import { FORMATS } from "./jobs.js";

export function createNotifier(config, log, { lanUrl = () => "" } = {}) {
    const { server, topic, notifyOn } = config.ntfy;
    const off = async () => {};
    if (!topic) return { enabled: false, jobFinished: off, queuePaused: off, queueResumed: off };
    const url = `${server.replace(/\/+$/, "")}/${topic}`;

    async function send({ title, body, tags, priority, what }) {
        let click = "";
        try { click = lanUrl(); } catch { /* notify without a link */ }
        try {
            const res = await fetch(url, {
                method: "POST",
                body,
                headers: { Title: title, Tags: tags, Priority: priority, ...(click ? { Click: click } : {}) },
                signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
            log.warn(`Could not send the ntfy notification ${what}: ${err.message}`);
        }
    }

    return {
        enabled: true,
        async jobFinished(job) {
            const event = job.status === "completed" ? "completed" : "failed";
            if (!notifyOn.includes(event)) return;
            const file = job.sourcePath.split(/[\\/]/).pop();
            const warnings = event === "completed" ? job.warnings.length : 0;
            const lines = [
                `${file} -> ${FORMATS[job.format]?.label ?? job.format} (job #${job.id}, ${job.submittedBy})`,
                event === "failed" ? `Reason: ${job.error}` : job.outputPaths.map((o) => o.path).join("\n"),
            ];
            if (warnings) lines.push(`${warnings} warning${warnings === 1 ? "" : "s"}: ${job.warnings[0]}${warnings > 1 ? " …" : ""}`);
            await send({
                title: event === "failed" ? "Export queue: job FAILED" : warnings ? "Export queue: finished with warnings" : "Export queue: job finished",
                body: lines.join("\n"),
                tags: event === "failed" || warnings ? "warning" : "white_check_mark",
                priority: event === "failed" ? "high" : "default",
                what: `for job #${job.id}`,
            });
        },
        // Sent regardless of notifyOn: nothing moves until someone looks at the export PC.
        async queuePaused({ reason, waiting }) {
            await send({
                title: "Export queue: waiting for InDesign",
                body: `${reason} ${waiting} job${waiting === 1 ? " is" : "s are"} waiting.\n` +
                    "Someone needs to look at the export PC's screen (sign-in, update or recovery message). The queue retries every minute.",
                tags: "warning",
                priority: "high",
                what: "about the paused queue",
            });
        },
        async queueResumed({ waiting }) {
            await send({
                title: "Export queue: running again",
                body: `InDesign answered again.${waiting ? ` ${waiting} waiting job${waiting === 1 ? " is" : "s are"} starting now.` : ""}`,
                tags: "white_check_mark",
                priority: "default",
                what: "about the resumed queue",
            });
        },
    };
}
