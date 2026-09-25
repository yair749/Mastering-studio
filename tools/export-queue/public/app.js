// Export Queue web UI: submission form + live queue dashboard. No build step, no framework;
// all job data is rendered with textContent (never innerHTML) so file names can't inject HTML.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const local = {
    get(key, fallback) {
        try {
            const v = localStorage.getItem(`exportQueue.${key}`);
            return v === null ? fallback : JSON.parse(v);
        } catch {
            return fallback;
        }
    },
    set(key, value) {
        try { localStorage.setItem(`exportQueue.${key}`, JSON.stringify(value)); } catch { /* private mode: not remembered */ }
    },
};

const state = {
    config: null,
    jobs: new Map(),
    counts: {},
    worker: null,
    filter: "all",
    mineOnly: local.get("mineOnly", false),
};

// ---------------------------------------------------------------- API

class ApiError extends Error {
    constructor(message, status, errors) {
        super(message);
        this.status = status;
        this.errors = errors;
    }
}

let keyPrompt = null;
function askForAccessKey(message) {
    if (keyPrompt) return keyPrompt;
    const dialog = $("#keyDialog");
    $("#keyError").textContent = message || "";
    keyPrompt = new Promise((resolve) => {
        dialog.addEventListener("close", () => {
            local.set("accessKey", $("#accessKey").value.trim());
            keyPrompt = null;
            resolve();
        }, { once: true });
    });
    dialog.showModal();
    return keyPrompt;
}

async function api(path, { method = "GET", body } = {}, attempt = 0) {
    const headers = { Accept: "application/json" };
    const key = local.get("accessKey", "");
    if (key) headers["X-Access-Key"] = key;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
        res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
        throw new ApiError("Can't reach the export PC. Is it switched on and is the export queue running?", 0);
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (res.status === 401 && data?.accessKeyRequired && attempt < 5) {
        await askForAccessKey(key ? "That key didn't work. Try again." : "");
        connectEvents();
        return api(path, { method, body }, attempt + 1);
    }
    if (!res.ok) throw new ApiError(data?.error || `The export PC returned an error (${res.status}).`, res.status, data?.errors);
    return data;
}

// ---------------------------------------------------------------- small helpers

let toastTimer = null;
function toast(message, bad = false) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.toggle("bad", bad);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 7000 : 4000);
}

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
    }
    for (const child of children.flat()) if (child) node.append(child);
    return node;
}

// navigator.clipboard only works on https or localhost; the queue runs on plain http on the LAN.
async function copyText(text) {
    try {
        if (window.isSecureContext && navigator.clipboard) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall back */ }
    const area = el("textarea", { readonly: true, class: "offscreen" });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
}

function fileName(path) {
    return String(path).split(/[\\/]/).filter(Boolean).pop() || path;
}

function duration(ms) {
    if (ms < 0 || !Number.isFinite(ms)) return "";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function ago(ts) {
    const diff = Date.now() - ts;
    if (diff < 45_000) return "just now";
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
    const d = new Date(ts);
    const today = new Date();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === today.toDateString() ? `today ${time}` : `${d.toLocaleDateString()} ${time}`;
}

const STATUS_LABEL = { pending: "Pending", processing: "Processing", completed: "Completed", failed: "Failed", cancelled: "Cancelled" };

// ---------------------------------------------------------------- form

const form = $("#jobForm");

function currentFormat() {
    return form.elements.format?.value || "";
}

function updateVisibility() {
    const format = currentFormat();
    const pkgPdf = format === "package" && $("#packageIncludePdf").checked;
    for (const node of $$("[data-show-for]")) {
        const tokens = node.dataset.showFor.split(" ");
        node.hidden = !(tokens.includes(format) || (pkgPdf && tokens.includes("package-pdf")));
    }
}

function renderFormats() {
    const box = $("#formatOptions");
    const saved = local.get("lastForm", {});
    box.replaceChildren(...state.config.formats.map((f, i) => el("label", {},
        el("input", { type: "radio", name: "format", value: f.id, checked: saved.format ? saved.format === f.id : i === 0, onchange: updateVisibility }),
        f.label)));
}

function restoreForm() {
    const saved = local.get("lastForm", {});
    form.elements.submittedBy.value = local.get("name", "");
    for (const name of ["pdfPreset", "outputFolder"]) {
        if (typeof saved[name] === "string") form.elements[name].value = saved[name];
    }
    for (const name of ["useDocumentBleed", "includeSlug", "packageIncludeIdml", "packageIncludePdf", "failOnMissing"]) {
        if (typeof saved[name] === "boolean") form.elements[name].checked = saved[name];
    }
    $("#packageIncludePdf").addEventListener("change", updateVisibility);
    updateVisibility();
}

function readForm() {
    const data = {};
    for (const input of form.elements) {
        if (!input.name) continue;
        if (input.type === "checkbox") data[input.name] = input.checked;
        else if (input.type === "radio") { if (input.checked) data[input.name] = input.value; }
        else data[input.name] = input.value.trim();
    }
    return data;
}

function clearErrors() {
    for (const p of $$("[data-error-for]")) p.textContent = "";
    for (const f of $$(".has-error")) f.classList.remove("has-error");
}

function showErrors(errors) {
    let first = null;
    for (const [field, message] of Object.entries(errors || {})) {
        const slot = $(`[data-error-for="${field}"]`) || $('[data-error-for="form"]');
        slot.textContent = message;
        slot.closest(".field")?.classList.add("has-error");
        if (field === "outputFolder") $(".advanced").open = true;
        first ??= form.elements[field];
    }
    first?.focus?.();
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearErrors();
    const data = readForm();
    const button = $("#submitBtn");
    button.disabled = true;
    button.textContent = "Adding…";
    try {
        const job = await api("/jobs", { method: "POST", body: data });
        local.set("name", data.submittedBy);
        const { sourcePath, submittedBy, ...remember } = data;
        local.set("lastForm", remember);
        upsertJob(job);
        render();
        refreshSoon();
        toast(job.queuePosition > 1 ? `Job #${job.id} queued: number ${job.queuePosition} in line.` : `Job #${job.id} queued: next in line.`);
    } catch (err) {
        if (err.errors) showErrors(err.errors);
        else showErrors({ form: err.message });
    } finally {
        button.disabled = false;
        button.textContent = "Add to queue";
    }
});

// ---------------------------------------------------------------- presets

function renderPresets(info) {
    const list = info?.presets || [];
    $("#presetList").replaceChildren(...list.map((name) => el("option", { value: name })));
    $("#presetHint").textContent = list.length
        ? `${list.length} presets installed on the export PC (InDesign ${info.indesignVersion}, checked ${ago(info.fetchedAt)}).`
        : "Type the exact preset name, or load the list from the export PC.";
}

$("#refreshPresets").addEventListener("click", async () => {
    const button = $("#refreshPresets");
    button.disabled = true;
    button.textContent = state.worker?.state === "processing" ? "Waiting for InDesign…" : "Asking InDesign…";
    try {
        renderPresets(await api("/presets/refresh", { method: "POST" }));
        toast("Preset list updated from InDesign.");
    } catch (err) {
        toast(err.message, true);
    } finally {
        button.disabled = false;
        button.textContent = "Load from InDesign";
    }
});

// ---------------------------------------------------------------- queue dashboard

// A job only moves forward (pending -> processing -> finished). Updates can arrive out of
// order (e.g. the live "processing" event before the reply to the submission), so an older
// status never overwrites a newer one.
const STATUS_RANK = { pending: 0, processing: 1, completed: 2, failed: 2, cancelled: 2 };
function upsertJob(job) {
    const known = state.jobs.get(job.id);
    if (known && STATUS_RANK[known.status] > STATUS_RANK[job.status]) return;
    state.jobs.set(job.id, job);
}

function matchesFilter(job) {
    if (state.mineOnly) {
        const me = (local.get("name", "") || "").toLowerCase();
        if (!me || job.submittedBy.toLowerCase() !== me) return false;
    }
    if (state.filter === "all") return true;
    if (state.filter === "failed") return job.status === "failed" || job.status === "cancelled";
    return job.status === state.filter;
}

function describeParams(job) {
    const f = state.config?.formats.find((x) => x.id === job.format);
    const parts = [f ? f.label : job.format];
    if (job.params.pdfPreset && (job.format === "pdf-print" || job.params.packageIncludePdf)) parts.push(job.params.pdfPreset);
    if (job.params.pageRange && job.params.pageRange !== "all") parts.push(`pages ${job.params.pageRange}`);
    if (job.format === "pdf-print") {
        parts.push(job.params.useDocumentBleed ? "bleed" : "no bleed");
        if (job.params.includeSlug) parts.push("slug");
    }
    return parts.join(" · ");
}

function jobTiming(job) {
    if (job.status === "pending") return `queued ${ago(job.createdAt)}${job.queuePosition ? ` · #${job.queuePosition} in line` : ""}`;
    if (job.status === "processing") return `running for ${duration(Date.now() - job.startedAt)}`;
    const took = job.startedAt && job.finishedAt ? ` in ${duration(job.finishedAt - job.startedAt)}` : "";
    return `${job.status === "cancelled" ? "cancelled" : "finished"} ${ago(job.finishedAt || job.createdAt)}${took}`;
}

async function jobAction(job, action) {
    const by = local.get("name", "") || "";
    if (action === "cancel" && !confirm(`Cancel job #${job.id} (${fileName(job.sourcePath)})?`)) return;
    try {
        const updated = await api(`/jobs/${job.id}/${action}`, { method: "POST", body: { by } });
        upsertJob(updated);
        render();
        toast(action === "cancel" ? `Job #${job.id} cancelled.` : `Queued again as job #${updated.id}.`);
    } catch (err) {
        toast(err.message, true);
        refreshSoon();
    }
}

function pathRow(label, path) {
    return el("div", { class: "path-row" },
        el("span", { class: "muted", text: label }),
        el("span", { class: "path", text: path }),
        el("button", {
            type: "button", class: "btn btn-small btn-ghost", text: "Copy",
            onclick: async (e) => {
                const ok = await copyText(path);
                e.target.textContent = ok ? "Copied" : "Select & copy manually";
                setTimeout(() => { e.target.textContent = "Copy"; }, 1500);
            },
        }));
}

function renderJob(job) {
    const node = $("#jobTemplate").content.firstElementChild.cloneNode(true);
    node.dataset.id = job.id;
    const pill = $(".job-status", node);
    pill.textContent = STATUS_LABEL[job.status] || job.status;
    pill.classList.add(job.status);
    const file = $(".job-file", node);
    file.textContent = `#${job.id}  ${fileName(job.sourcePath)}`;
    file.title = job.sourcePath;
    const meta = $(".job-meta", node);
    meta.textContent = `${describeParams(job)} · ${job.submittedBy} · ${jobTiming(job)}`;
    if (job.status === "processing") meta.dataset.live = "1";

    const actions = $(".job-actions", node);
    if (job.status === "pending") actions.append(el("button", { type: "button", class: "btn btn-small", text: "Cancel", onclick: () => jobAction(job, "cancel") }));
    if (["completed", "failed", "cancelled"].includes(job.status)) {
        actions.append(el("button", { type: "button", class: "btn btn-small", text: "Run again", onclick: () => jobAction(job, "retry") }));
    }

    const detail = $(".job-detail", node);
    if (job.error) detail.append(el("div", { class: "error-box", text: job.error }));
    for (const out of job.outputPaths || []) detail.append(pathRow(out.kind === "folder" ? "Folder" : "Output", out.path));
    if (job.status !== "completed") detail.append(pathRow("Source", job.sourcePath));
    if (job.warnings?.length) {
        detail.append(el("details", { class: "warn-box" },
            el("summary", { text: `${job.warnings.length} warning${job.warnings.length > 1 ? "s" : ""}` }),
            el("ul", {}, job.warnings.map((w) => el("li", { text: w })))));
    }
    return node;
}

function render() {
    const jobs = [...state.jobs.values()].sort((a, b) => b.id - a.id).filter(matchesFilter);
    $("#jobList").replaceChildren(...jobs.map(renderJob));
    $("#emptyState").hidden = jobs.length > 0;
    $("#emptyState").textContent = state.mineOnly && !local.get("name", "") ? "Enter your name in the form to see only your jobs." : "No jobs here yet.";

    const c = state.counts;
    const counts = {
        all: Object.values(c).reduce((a, b) => a + b, 0),
        pending: c.pending, processing: c.processing, completed: c.completed,
        failed: (c.failed || 0) + (c.cancelled || 0),
    };
    for (const span of $$("[data-count]")) span.textContent = counts[span.dataset.count] ? String(counts[span.dataset.count]) : "";
}

function renderWorker() {
    const pill = $("#workerState");
    const w = state.worker;
    pill.className = "pill pill-muted";
    if (!w) { pill.textContent = "Offline"; pill.classList.add("failed"); return; }
    if (w.state === "processing") {
        pill.textContent = `Exporting job #${w.currentJobId}`;
        pill.classList.add("processing");
    } else {
        pill.textContent = "InDesign ready";
        pill.classList.add("completed");
    }
    if (w.executor === "simulate") pill.textContent += " (simulation)";
}

async function loadJobs() {
    try {
        const data = await api("/jobs?limit=200");
        const previous = state.jobs;
        state.jobs = new Map();
        for (const job of data.jobs) {
            const known = previous.get(job.id);
            state.jobs.set(job.id, known && STATUS_RANK[known.status] > STATUS_RANK[job.status] ? known : job);
        }
        state.counts = data.counts;
        state.worker = data.worker;
        render();
        renderWorker();
    } catch (err) {
        toast(err.message, true);
    }
}

let refreshTimer = null;
function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadJobs, 600);
}

// Live timers for running jobs.
setInterval(() => {
    for (const meta of $$('.job-meta[data-live="1"]')) {
        const job = state.jobs.get(Number(meta.closest(".job").dataset.id));
        if (job) meta.textContent = `${describeParams(job)} · ${job.submittedBy} · ${jobTiming(job)}`;
    }
}, 1000);

// ---------------------------------------------------------------- live updates

let source = null;
function connectEvents() {
    source?.close();
    const key = local.get("accessKey", "");
    source = new EventSource(`/api/events${key ? `?key=${encodeURIComponent(key)}` : ""}`);
    const conn = $("#connection");
    source.addEventListener("open", () => {
        conn.className = "conn live";
        conn.title = "Live updates on";
        loadJobs();                     // catch up on anything missed while disconnected
    });
    source.addEventListener("error", () => {
        conn.className = "conn down";
        conn.title = "Reconnecting to the export PC…";
        state.worker = null;
        renderWorker();
    });
    source.addEventListener("job", (e) => {
        const job = JSON.parse(e.data);
        const before = state.jobs.get(job.id);
        upsertJob(job);
        render();
        refreshSoon();                  // counts and queue positions
        const me = (local.get("name", "") || "").toLowerCase();
        if (before && before.status !== job.status && job.submittedBy.toLowerCase() === me) {
            if (job.status === "completed") toast(`Your export #${job.id} is done: ${fileName(job.outputPaths[0]?.path || "")}`);
            if (job.status === "failed") toast(`Your export #${job.id} failed: ${job.error}`, true);
        }
    });
    source.addEventListener("worker", (e) => {
        state.worker = JSON.parse(e.data);
        renderWorker();
    });
    source.addEventListener("presets", (e) => renderPresets(JSON.parse(e.data)));
}

// ---------------------------------------------------------------- start

for (const tab of $$("#tabs button")) {
    tab.addEventListener("click", () => {
        state.filter = tab.dataset.filter;
        for (const t of $$("#tabs button")) t.setAttribute("aria-selected", String(t === tab));
        render();
    });
}
$("#mineOnly").checked = state.mineOnly;
$("#mineOnly").addEventListener("change", (e) => {
    state.mineOnly = e.target.checked;
    local.set("mineOnly", state.mineOnly);
    render();
});
form.elements.submittedBy.addEventListener("change", (e) => {
    local.set("name", e.target.value.trim());
    render();
});

async function start() {
    try {
        state.config = await api("/ui-config");
    } catch (err) {
        showErrors({ form: err.message });
        return;
    }
    renderFormats();
    restoreForm();
    if (state.config.pathExamples.length) {
        $("#pathHint").textContent = `Paste the full path of the .indd file. Mac paths (${state.config.pathExamples.join(", ")}) work too.`;
    }
    if (state.config.defaultOutputSubfolder) {
        $("#outputFolder").placeholder = `"${state.config.defaultOutputSubfolder}" folder next to the InDesign file`;
    }
    try {
        renderPresets(await api("/presets"));
    } catch { /* shown when refreshed */ }
    connectEvents();
    await loadJobs();
}

start();
