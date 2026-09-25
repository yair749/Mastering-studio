// The queue worker: takes the oldest pending job, runs it in InDesign, records the result,
// one job at a time. It wakes immediately when a job is submitted and also re-checks every
// few seconds, so a missed wake-up can never leave jobs waiting.
//
// If InDesign can't be reached at all (not installed/licensed for this user, stuck on a
// sign-in or recovery dialog), the job goes back to the queue instead of failing, and the
// queue waits and retries every minute. Otherwise one bad morning would turn every waiting
// job into a failure that each designer has to re-run.
import { FORMATS } from "./jobs.js";
import { PathError } from "./paths.js";

export const PAUSED_REASON = "InDesign can't be reached on the export PC. Jobs will wait.";

export function createWorker({ store, indesign, resolver, config, events, notifier, log, present = (j) => j,
    linkMappings = [], timings = {}, onHealthChange = () => {} }) {
    const pollMs = timings.pollMs ?? 5_000;
    const retryMs = timings.unreachableRetryMs ?? 60_000;
    const p = resolver.pathApi;
    let stopped = false;
    let draining = false;
    let current = null;
    let paused = null;          // { reason, since } while InDesign can't be reached
    let nextAttemptAt = 0;
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

    function status() {
        return {
            state: draining ? "draining" : paused ? "paused" : current ? "processing" : "idle",
            currentJobId: current?.id ?? null,
            currentStartedAt: current?.startedAt ?? null,
            executor: indesign.executor,
            pausedReason: paused?.reason ?? null,
        };
    }

    const publishJob = (job) => events.publish("job", present(job));
    const publishWorker = () => events.publish("worker", status());

    function pause() {
        nextAttemptAt = Date.now() + retryMs;
        if (paused) return;
        paused = { reason: PAUSED_REASON, since: Date.now() };
        log.warn(`${PAUSED_REASON} Trying again every ${Math.round(retryMs / 1000)} s.`);
        notifier.queuePaused({ reason: PAUSED_REASON, waiting: store.counts().pending }).catch(() => {});
        publishWorker();
        onHealthChange();
    }

    // Any successful contact with InDesign (a job or the preset list) ends the pause.
    indesign.onChange((next) => {
        if (next.state !== "ok" || !paused) return;
        paused = null;
        nextAttemptAt = 0;
        log.info("InDesign answered again; the queue continues.");
        notifier.queueResumed({ waiting: store.counts().pending }).catch(() => {});
        publishWorker();
        onHealthChange();
        wakeUp();
    });

    async function planOutput(job) {
        const { params } = job;
        let folder;
        if (params.outputFolderInput) {
            folder = await resolver.resolveExisting(params.outputFolderInput, "outputFolder", { kind: "folder" });
        } else {
            folder = p.dirname(job.sourcePath);
            if (config.defaultOutputSubfolder) {
                folder = p.join(folder, config.defaultOutputSubfolder);
                await resolver.timed(resolver.fs.mkdir(folder, { recursive: true }), folder, "outputFolder");
            }
        }
        const base = p.basename(job.sourcePath, p.extname(job.sourcePath));
        const isFolder = job.format === "package";
        const name = isFolder ? `${base} Folder` : base + FORMATS[job.format].extension;
        const target = await resolver.uniqueOutput(p.join(folder, name), params.overwrite && !isFolder, { folder: isFolder });
        return { ...target, kind: isFolder ? "folder" : "file" };
    }

    async function runJob(claimed) {
        let job = claimed;
        current = job;
        publishJob(job);
        publishWorker();
        log.info(`Job #${job.id} started: ${job.format} of ${job.sourcePath} (${job.submittedBy})`);
        let finished = null;
        try {
            // Checked again now: the drive may have gone away (or the settings changed) since it was queued.
            await resolver.inspect(job.sourcePath, "sourcePath", { kind: "file" });
            const target = await planOutput(job);
            const renamed = target.renamedFrom ? { renamedFrom: target.renamedFrom } : {};
            job = store.setOutputs(job.id, [{ path: target.path, bytes: 0, kind: target.kind, ...renamed, planned: true }]) ?? job;
            current = job;
            publishJob(job);
            const result = await indesign.exportJob({
                jobId: job.id,
                sourcePath: job.sourcePath,
                outputPath: target.path,
                format: job.format,
                pdfPreset: job.params.pdfPreset ?? "",
                pageRange: job.params.pageRange ?? "all",
                useDocumentBleed: job.params.useDocumentBleed ?? false,
                includeSlug: job.params.includeSlug ?? false,
                packageIncludeIdml: job.params.packageIncludeIdml ?? false,
                packageIncludePdf: job.params.packageIncludePdf ?? false,
                failOnMissing: job.params.failOnMissing,
                linkMappings,
            });
            const outputs = (Array.isArray(result?.outputs) ? result.outputs : []).map((o, i) => ({
                path: String(o.path),
                bytes: Number(o.bytes) || 0,
                kind: o.kind === "folder" ? "folder" : "file",
                ...(i === 0 ? renamed : {}),
            }));
            finished = store.finish(job.id, {
                ok: Boolean(result?.ok),
                outputPaths: outputs,
                warnings: Array.isArray(result?.warnings) ? result.warnings.map(String) : [],
                error: result?.ok ? null : String(result?.error || "InDesign reported a failure without details."),
            });
        } catch (err) {
            if (err.unreachable) {
                // The script never started, so nothing was exported: the job keeps its place.
                const back = store.requeue(job.id);
                current = null;
                log.warn(`Job #${job.id} put back in the queue: ${err.message}`);
                pause();
                if (back) publishJob(back);
                publishWorker();
                return;
            }
            if (!(err instanceof PathError) && !err.timedOut) log.error(`Job #${job.id} error: ${err.stack || err.message}`);
            finished = store.finish(job.id, { ok: false, error: err.message });
        } finally {
            current = null;
        }
        if (!finished) finished = store.get(job.id);   // e.g. database already updated by recovery
        log.info(`Job #${job.id} ${finished.status}${finished.error ? `: ${finished.error}` : ""}`);
        publishJob(finished);
        publishWorker();
        notifier.jobFinished(finished).catch(() => {});
    }

    async function loop() {
        while (!stopped) {
            if (draining) {
                await sleep(pollMs);
                continue;
            }
            const wait = paused ? nextAttemptAt - Date.now() : 0;
            if (wait > 0) {
                await sleep(Math.min(wait, pollMs));
                continue;
            }
            let job = null;
            try {
                job = store.claimNext();
            } catch (err) {
                log.error(`Could not read the queue: ${err.message}`);
            }
            if (job) await runJob(job);
            else await sleep(pollMs);
        }
    }

    return {
        start() {
            const recovered = store.recoverInterrupted();
            if (recovered.length) log.warn(`Marked interrupted job(s) as failed: #${recovered.join(", #")}`);
            loopDone = loop();
        },
        wakeUp,
        status,
        // Stop starting new jobs (the current one finishes), e.g. before an upgrade.
        drain() {
            if (!draining) {
                draining = true;
                log.info(current ? `Draining: job #${current.id} finishes, no new jobs start.` : "Draining: no new jobs start.");
                publishWorker();
                onHealthChange();
            }
            return status();
        },
        // Back to normal; also retries at once if the queue was waiting for InDesign.
        resume() {
            const was = draining;
            draining = false;
            nextAttemptAt = 0;
            if (was) log.info("Draining ended: jobs start again.");
            publishWorker();
            onHealthChange();
            wakeUp();
            return status();
        },
        async stop() {
            stopped = true;
            wakeUp();
            await loopDone;
        },
    };
}
