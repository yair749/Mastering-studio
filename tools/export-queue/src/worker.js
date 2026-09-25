// The queue worker: takes the oldest pending job, runs it in InDesign, records the result,
// one job at a time. It wakes immediately when a job is submitted and also re-checks every
// few seconds, so a missed wake-up can never leave jobs waiting.
import fs from "node:fs/promises";
import { FORMATS } from "./jobs.js";
import { PathError, uniquePath } from "./paths.js";

const POLL_MS = 5_000;

export function createWorker({ store, indesign, resolver, config, events, notifier, log }) {
    const p = resolver.pathApi;
    let stopped = false;
    let current = null;
    let wake = null;
    let loopDone = null;

    function wakeUp() {
        if (wake) wake();
    }

    function sleep(ms) {
        return new Promise((resolve) => {
            const timer = setTimeout(done, ms);
            function done() { clearTimeout(timer); wake = null; resolve(); }
            wake = done;
        });
    }

    async function planOutput(job) {
        const { params } = job;
        let folder;
        if (params.outputFolderInput) {
            folder = await resolver.resolveExisting(params.outputFolderInput, "outputFolder", { kind: "folder" });
        } else {
            folder = p.dirname(job.sourcePath);
            if (config.defaultOutputSubfolder) {
                folder = p.join(folder, config.defaultOutputSubfolder);
                await fs.mkdir(folder, { recursive: true });
            }
        }
        const base = p.basename(job.sourcePath, p.extname(job.sourcePath));
        const name = job.format === "package" ? `${base} Folder` : base + FORMATS[job.format].extension;
        const isFolder = job.format === "package";
        return uniquePath(p, p.join(folder, name), params.overwrite && !isFolder, { folder: isFolder });
    }

    async function runJob(job) {
        current = job;
        events.publish("job", job);
        events.publish("worker", status());
        log.info(`Job #${job.id} started: ${job.format} of ${job.sourcePath} (${job.submittedBy})`);
        let finished;
        try {
            try {
                await fs.access(job.sourcePath);
            } catch {
                throw new PathError(`The source file is no longer reachable from the export PC: ${job.sourcePath}`);
            }
            const outputPath = await planOutput(job);
            const result = await indesign.exportJob({
                sourcePath: job.sourcePath,
                outputPath,
                format: job.format,
                pdfPreset: job.params.pdfPreset ?? "",
                pageRange: job.params.pageRange ?? "all",
                useDocumentBleed: job.params.useDocumentBleed ?? false,
                includeSlug: job.params.includeSlug ?? false,
                packageIncludeIdml: job.params.packageIncludeIdml ?? false,
                packageIncludePdf: job.params.packageIncludePdf ?? false,
                failOnMissing: job.params.failOnMissing,
            });
            finished = store.finish(job.id, {
                ok: Boolean(result?.ok),
                outputPaths: Array.isArray(result?.outputs) ? result.outputs : [],
                warnings: Array.isArray(result?.warnings) ? result.warnings.map(String) : [],
                error: result?.ok ? null : String(result?.error || "InDesign reported a failure without details."),
            });
        } catch (err) {
            if (!(err instanceof PathError) && !err.timedOut) log.error(`Job #${job.id} error: ${err.stack || err.message}`);
            finished = store.finish(job.id, { ok: false, error: err.message });
        } finally {
            current = null;
        }
        if (!finished) finished = store.get(job.id);   // e.g. database already updated by recovery
        log.info(`Job #${job.id} ${finished.status}${finished.error ? `: ${finished.error}` : ""}`);
        events.publish("job", finished);
        events.publish("worker", status());
        notifier.jobFinished(finished, config.publicUrl).catch(() => {});
    }

    async function loop() {
        while (!stopped) {
            let job = null;
            try {
                job = store.claimNext();
            } catch (err) {
                log.error(`Could not read the queue: ${err.message}`);
            }
            if (job) await runJob(job);
            else await sleep(POLL_MS);
        }
    }

    function status() {
        return {
            state: current ? "processing" : "idle",
            currentJobId: current?.id ?? null,
            currentStartedAt: current?.startedAt ?? null,
            executor: indesign.executor,
        };
    }

    return {
        start() {
            const recovered = store.recoverInterrupted();
            if (recovered.length) log.warn(`Marked interrupted job(s) as failed: #${recovered.join(", #")}`);
            loopDone = loop();
        },
        wakeUp,
        status,
        async stop() {
            stopped = true;
            wakeUp();
            await loopDone;
        },
    };
}
