// The export PC's installed PDF presets, cached in the database so the form can offer a real
// list and a mistyped or missing preset is refused at submit time instead of after waiting in
// line. Refreshed at start-up and whenever InDesign becomes reachable again.
export function createPresetService({ indesign, store, events, log }) {
    let inflight = null;

    function cached() {
        return store.getMeta("presets") ?? { presets: [], indesignVersion: null, fetchedAt: null };
    }

    // Every caller during a refresh shares the same InDesign call, so repeated clicks on
    // "Load from InDesign" can't queue up several PowerShell runs.
    function refresh(reason) {
        if (inflight) return inflight;
        inflight = (async () => {
            try {
                const result = await indesign.listPresets();
                if (!result?.ok) {
                    throw Object.assign(new Error(`InDesign could not list presets: ${result?.error ?? "no details"}`), { status: 502 });
                }
                const value = { presets: result.presets, indesignVersion: result.indesignVersion, fetchedAt: Date.now() };
                store.setMeta("presets", value);
                events.publish("presets", value);
                log.info(`Loaded ${value.presets.length} PDF presets from InDesign ${value.indesignVersion}${reason ? ` (${reason})` : ""}.`);
                return value;
            } finally {
                inflight = null;
            }
        })();
        return inflight;
    }

    function refreshInBackground(reason) {
        refresh(reason).catch((err) => log.warn(`Could not load the PDF presets (${reason}): ${err.message}`));
    }

    // A job that reached InDesign after it was unknown or unreachable: the list may have
    // changed (InDesign updated, presets installed), and this is a good moment to ask.
    indesign.onChange((next, prev, action) => {
        if (next.state === "ok" && prev.state !== "ok" && action !== "listPresets") refreshInBackground("InDesign answered");
    });

    return {
        cached,
        refresh,
        refreshInBackground,
        installed: () => cached().presets ?? [],
    };
}
