// Optional push notification (ntfy) when a job fails or completes. Failures to notify are
// logged, never allowed to affect the job itself.
import { FORMATS } from "./jobs.js";

export function createNotifier(config, log) {
    const { server, topic, notifyOn } = config.ntfy;
    if (!topic) return { enabled: false, jobFinished: async () => {} };
    const url = `${server.replace(/\/+$/, "")}/${topic}`;

    return {
        enabled: true,
        async jobFinished(job, dashboardUrl) {
            const event = job.status === "completed" ? "completed" : "failed";
            if (!notifyOn.includes(event)) return;
            const file = job.sourcePath.split(/[\\/]/).pop();
            const title = event === "completed" ? "Export queue: job finished" : "Export queue: job FAILED";
            const lines = [
                `${file} -> ${FORMATS[job.format]?.label ?? job.format} (job #${job.id}, ${job.submittedBy})`,
                event === "failed" ? `Reason: ${job.error}` : job.outputPaths.map((o) => o.path).join("\n"),
            ];
            try {
                const res = await fetch(url, {
                    method: "POST",
                    body: lines.join("\n"),
                    headers: {
                        Title: title,
                        Tags: event === "completed" ? "white_check_mark" : "warning",
                        Priority: event === "completed" ? "default" : "high",
                        ...(dashboardUrl ? { Click: dashboardUrl } : {}),
                    },
                    signal: AbortSignal.timeout(15_000),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            } catch (err) {
                log.warn(`Could not send the ntfy notification for job #${job.id}: ${err.message}`);
            }
        },
    };
}
