// Export Queue web UI: submission form, live queue and the "Your exports" strip. No build step,
// no framework. Job data is only ever rendered with textContent (never innerHTML), so file names
// can't inject HTML, and nothing here needs inline scripts or styles (strict CSP).
import { createBrowser } from "./browse.js";
import {
    FINAL, agoShort, dropToPath, duration, fileName, formatBytes, matchesQuery, ordinal, parseLines,
    placeLabel, placeOf, plural, roughly, sameName, shortVersion, toMyPath, when,
} from "./util.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Browser storage can be missing or throw (private windows, blocked site data): nothing here
// may depend on it, it only saves the designer some typing.
function storage(kind) {
    return {
        get(key, fallback) {
            try {
                const v = window[kind].getItem(`exportQueue.${key}`);
                return v === null ? fallback : JSON.parse(v);
            } catch {
                return fallback;
            }
        },
        set(key, value) {
            try { window[kind].setItem(`exportQueue.${key}`, JSON.stringify(value)); } catch { /* not remembered */ }
        },
        remove(key) {
            try { window[kind].removeItem(`exportQueue.${key}`); } catch { /* nothing to remove */ }
        },
    };
}
const local = storage("localStorage");
const session = storage("sessionStorage");

// Right after an upgrade a browser can briefly pair a cached old page with this script. Reload
// once to get both new, rather than failing half-way with buttons that do nothing.
if (!document.getElementById("sourcePaths") || !document.getElementById("browseDialog")) {
    if (!session.get("layoutReload", false)) {
        session.set("layoutReload", true);
        location.reload();
    }
    throw new Error("Export Queue: the page and its script are from different versions. Reload the page.");
}
session.remove("layoutReload");

const PLATFORM = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "";
const OS = /mac|iphone|ipad|ipod/i.test(PLATFORM) ? "mac" : /win/i.test(PLATFORM) ? "windows" : "other";
const COPY_HINT = {
    mac: "Copied. In Finder press Shift-Cmd-G, paste, then press Return.",
    windows: "Copied. Paste it into the File Explorer address bar and press Enter.",
    other: "Copied.",
};
const BASE_TITLE = "Export Queue";
const MAX_FILES = 50;
const KEY_NEEDED = "This export queue needs the office access key.";
const OFFLINE = "Can't reach the export PC. Check that you're on the office network; this page keeps trying.";

const state = {
    config: null,           // /api/ui-config
    bootVersion: null,      // server version this page was loaded with
    presets: null,          // { presets, indesignVersion, fetchedAt }
    presetChoice: "[High Quality Print]",
    health: null,
    worker: null,
    workerSeenAt: 0,
    counts: null,           // server-wide counts per status
    jobs: new Map(),        // every job this page knows about, by id
    seenAt: new Map(),      // id → performance.now() of the last update (drops stale HTTP replies)
    floors: new Map(),      // view key → oldest id loaded without gaps for that view (0 = all)
    viewLoading: false,
    viewError: null,
    filter: "all",
    q: "",
    mineOnly: local.get("mineOnly", false) === true,
    offset: 0,              // export PC clock minus this computer's clock
    offline: false,
    keyDeclined: false,
    lastSyncAt: 0,
    check: { items: [], folder: null, paths: [], duplicates: 0, extra: 0, error: null },
    pickedFolder: null,     // { path, label } from Browse, until the check answers
};

// Timers use the export PC's clock: a designer's laptop that is a few minutes off would
// otherwise show "running for " with nothing after it, or "just now" for old jobs.
const now = () => Date.now() + state.offset;

// Read once and kept in step with the dialog and other tabs, because it's used for every row.
let accessKey = local.get("accessKey", "") || "";
function setAccessKey(value) {
    accessKey = value;
    local.set("accessKey", value);
}
function noteServerTime(t) {
    if (Number.isFinite(t)) state.offset = t - Date.now();
}

// ---------------------------------------------------------------- small helpers

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? "" : v);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
}

// Only touches the DOM when the text really changes, so a selection inside stays put.
function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const myName = () => $("#submittedBy").value.trim() || local.get("name", "") || "";
const isMine = (job) => sameName(job.submittedBy, myName());
const drives = () => state.config?.drives || [];
const formatSpec = (id) => state.config?.formats?.find((f) => f.id === id);
const myPath = (pcPath, job) => toMyPath(pcPath, job, { os: OS, mappings: state.config?.pathMappings || [] });

let announceTimer = null;
// The page's only live region: short messages about the viewer's own actions and jobs, never
// the list itself (a screen reader would otherwise read the queue on every change).
function announce(text) {
    const box = $("#announcer");
    clearTimeout(announceTimer);
    box.textContent = "";
    announceTimer = setTimeout(() => { box.textContent = text; }, 80);
}

// Toasts stack instead of replacing each other, so a failure can't be wiped out by the next
// "added" message before anyone has read it. Problems stay longer and can be closed.
function toast(message, { bad = false } = {}) {
    const box = $("#toasts");
    const item = el("div", { class: `toast${bad ? " bad" : ""}` },
        el("p", { text: message }),
        el("button", { type: "button", class: "toast-close", "aria-label": "Dismiss", text: "×", onclick: () => item.remove() }));
    box.append(item);
    const items = [...box.children];
    if (items.length > 3) (items.find((t) => !t.classList.contains("bad")) || items[0]).remove();
    setTimeout(() => item.remove(), bad ? 12_000 : 5_000);
    announce(message);
}

// ---------------------------------------------------------------- API

class ApiError extends Error {
    constructor(message, status, data) {
        super(message);
        this.status = status;
        this.data = data;
    }
}

let keyPrompt = null;
function askForAccessKey(message) {
    if (keyPrompt) return keyPrompt;
    const dialog = $("#keyDialog");
    $("#keyError").textContent = message || "";
    $("#accessKey").value = "";
    dialog.returnValue = "";
    keyPrompt = new Promise((resolve) => {
        dialog.addEventListener("close", () => {
            keyPrompt = null;
            const value = $("#accessKey").value.trim();
            const entered = dialog.returnValue === "ok" && Boolean(value);
            if (entered) setAccessKey(value);
            // Escape or Cancel: stop asking (no prompt loop) until the designer asks for it again.
            state.keyDeclined = !entered;
            renderStatus();
            resolve(entered);
            if (entered) setTimeout(afterKeyChange, 0);
        }, { once: true });
    });
    dialog.showModal();
    return keyPrompt;
}

async function api(path, { method = "GET", body, signal } = {}) {
    for (let attempt = 0; ; attempt++) {
        const key = accessKey;
        const headers = { Accept: "application/json" };
        if (key) headers["X-Access-Key"] = key;
        if (body !== undefined) headers["Content-Type"] = "application/json";
        let res;
        try {
            res = await fetch(`/api${path}`, {
                method, headers, signal, cache: "no-store",
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch (err) {
            if (err.name === "AbortError") throw err;
            throw new ApiError(OFFLINE, 0);
        }
        let data = null;
        try { data = await res.json(); } catch { /* not JSON */ }
        noteServerTime(data?.serverTime);
        if (res.status === 401 && data?.accessKeyRequired) {
            if (state.keyDeclined || attempt >= 3) throw new ApiError(KEY_NEEDED, 401, data);
            const entered = await askForAccessKey(key ? "That key didn't work. Check it and try again." : "");
            if (!entered) throw new ApiError(KEY_NEEDED, 401, data);
            continue;
        }
        if (!res.ok) throw new ApiError(data?.error || `The export PC answered with an error (${res.status}).`, res.status, data);
        return data;
    }
}

// Links (Open, Download) can't send headers, so the key goes in the URL like for the event stream.
function withKey(url) {
    return accessKey ? `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(accessKey)}` : url;
}

async function copyText(text) {
    const active = document.activeElement;
    try {
        if (window.isSecureContext && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall back below */ }
    // Plain http on the office network has no Clipboard API. The old copy command still works
    // from a click, but it needs a selected text field, which steals focus: give it back.
    const area = el("textarea", { readonly: true, class: "offscreen", "aria-hidden": "true", tabindex: "-1" });
    area.value = text;
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    active?.focus?.({ preventScroll: true });
    return ok;
}

const hintTimers = new WeakMap();
async function copyPath(text, button, hint, pathEl) {
    const label = button.textContent;
    const ok = await copyText(text);
    if (ok) {
        hint.textContent = COPY_HINT[OS];
        button.textContent = "Copied";
    } else {
        // Leave the path selected so the designer only has to press the copy keys.
        window.getSelection()?.selectAllChildren(pathEl);
        hint.textContent = `Couldn't copy by itself. The path is selected: press ${OS === "mac" ? "Cmd" : "Ctrl"}+C.`;
    }
    hint.hidden = false;
    announce(hint.textContent);
    clearTimeout(hintTimers.get(hint));
    hintTimers.set(hint, setTimeout(() => {
        hint.hidden = true;
        if (button.isConnected && button.textContent === "Copied") button.textContent = label;
    }, 12_000));
}

// ---------------------------------------------------------------- sound

let audio = null;
function primeAudio() {
    if (!$("#soundOn").checked || audio) return;
    try {
        audio = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
        audio = null;
    }
}
// Browsers only allow sound after the page was clicked, so the context is created on the first
// click or key press (primeAudio) and reused when an export finishes later.
function beep(good) {
    if (!$("#soundOn").checked || !audio) return;
    try {
        if (audio.state === "suspended") audio.resume();
        const t = audio.currentTime + 0.02;
        (good ? [784, 1175] : [523, 392]).forEach((freq, i) => {
            const osc = audio.createOscillator();
            const gain = audio.createGain();
            const start = t + i * 0.18;
            osc.type = "sine";
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
            osc.connect(gain).connect(audio.destination);
            osc.start(start);
            osc.stop(start + 0.18);
        });
    } catch { /* no sound available */ }
}

// ---------------------------------------------------------------- form

const form = $("#jobForm");
const F = {
    name: $("#submittedBy"),
    paths: $("#sourcePaths"),
    preset: $("#pdfPreset"),
    presetSelect: $("#presetSelect"),
    pages: $("#pageRange"),
    bleed: $("#useDocumentBleed"),
    slug: $("#includeSlug"),
    pkgIdml: $("#packageIncludeIdml"),
    pkgPdf: $("#packageIncludePdf"),
    folder: $("#outputFolder"),
    overwrite: $("#overwrite"),
    failOnMissing: $("#failOnMissing"),
    submit: $("#submitBtn"),
};

const FORMAT_NOTES = {
    "pdf-print": "for printing",
    "pdf-interactive": "for screens",
    idml: "for older InDesign",
    package: "with fonts and links",
};

const selectedFormats = () => $$("#formatOptions input:checked").map((i) => i.value);
const presetKnown = () => (state.presets?.presets?.length || 0) > 0;
const presetValue = () => (presetKnown() ? F.presetSelect.value : F.preset.value.trim());

function needs() {
    const specs = selectedFormats().map(formatSpec).filter(Boolean);
    const pkg = specs.some((s) => s.id === "package");
    return {
        preset: specs.some((s) => s.usesPreset) || (pkg && F.pkgPdf.checked),
        pages: specs.some((s) => s.usesPageRange),
        bleed: specs.some((s) => s.usesBleed),
        package: pkg,
    };
}

function updateVisibility() {
    const n = needs();
    for (const node of $$("[data-needs]")) node.hidden = !n[node.dataset.needs];
    updateButton();
    updateSummary();
}

function renderFormats() {
    const saved = local.get("lastForm", {}) || {};
    const ids = state.config.formats.map((f) => f.id);
    let chosen = Array.isArray(saved.formats) ? saved.formats : saved.format ? [saved.format] : [];
    chosen = chosen.filter((id) => ids.includes(id));
    if (!chosen.length && ids.length) chosen = [ids[0]];
    $("#formatOptions").replaceChildren(...state.config.formats.map((f) => el("label", { class: "chip" },
        el("input", { type: "checkbox", value: f.id, checked: chosen.includes(f.id), onchange: onFormatsChange }),
        el("span", { class: "chip-body" },
            el("span", { class: "chip-label", text: f.label }),
            FORMAT_NOTES[f.id] ? el("span", { class: "chip-note", text: FORMAT_NOTES[f.id] }) : null))));
}

function onFormatsChange() {
    if (selectedFormats().length) clearFieldError("formats");
    updateVisibility();
}

function lineCount() {
    return F.paths.value.split(/\r\n|\r|\n/).length;
}

// Grows with the list (up to 8 lines, then it scrolls). Lines don't wrap, so rows = paths.
function autoGrow() {
    F.paths.rows = Math.min(8, Math.max(2, lineCount()));
}

function exportCount() {
    const files = parseLines(F.paths.value).paths.length;
    return files > MAX_FILES ? 0 : files * selectedFormats().length;
}

function updateButton() {
    if (F.submit.disabled) return;
    const n = exportCount();
    F.submit.textContent = n ? `Add ${plural(n, "export")} to queue` : "Add to queue";
}

function restoreForm() {
    const saved = local.get("lastForm", {}) || {};
    if (!F.name.value) F.name.value = local.get("name", "") || "";
    if (typeof saved.pdfPreset === "string" && saved.pdfPreset.trim()) state.presetChoice = saved.pdfPreset.trim();
    F.preset.value = state.presetChoice;
    const bools = [["useDocumentBleed", F.bleed], ["includeSlug", F.slug], ["packageIncludeIdml", F.pkgIdml],
        ["packageIncludePdf", F.pkgPdf], ["failOnMissing", F.failOnMissing]];
    for (const [key, input] of bools) if (typeof saved[key] === "boolean") input.checked = saved[key];
    // Version 1 remembered "Save to folder" inside a closed section, which silently sent later
    // exports (other clients' files too) into the old folder. It is never restored; drop it.
    if ("outputFolder" in saved || "overwrite" in saved || "pageRange" in saved) {
        const { outputFolder, overwrite, pageRange, sourcePath, submittedBy, ...rest } = saved;
        local.set("lastForm", rest);
    }
    // A draft saved when the page reloaded itself (new version) or was closed by accident.
    // Only minutes old, so a tab restored days later doesn't bring back an old output folder.
    const draft = session.get("draft", null);
    if (draft && typeof draft === "object" && Date.now() - (draft.at || 0) < 10 * 60_000) {
        if (!F.paths.value && typeof draft.paths === "string") F.paths.value = draft.paths;
        if (!F.folder.value && typeof draft.folder === "string") F.folder.value = draft.folder;
    }
    session.remove("draft");
    if (F.folder.value) $("#moreOptions").open = true;
    autoGrow();
}

function saveDraft() {
    if (F.paths.value.trim() || F.folder.value.trim()) session.set("draft", { paths: F.paths.value, folder: F.folder.value, at: Date.now() });
    else session.remove("draft");
}

function hasUnsentInput() {
    return Boolean(F.paths.value.trim() || F.folder.value.trim());
}

function readForm() {
    const n = needs();
    return {
        submittedBy: F.name.value.trim(),
        sourcePaths: parseLines(F.paths.value).paths,
        formats: selectedFormats(),
        pdfPreset: n.preset ? presetValue() : "",
        pageRange: F.pages.value.trim() || "All",
        useDocumentBleed: F.bleed.checked,
        includeSlug: F.slug.checked,
        packageIncludeIdml: F.pkgIdml.checked,
        packageIncludePdf: F.pkgPdf.checked,
        outputFolder: F.folder.value.trim(),
        overwrite: F.overwrite.checked,
        failOnMissing: F.failOnMissing.checked,
    };
}

// ---------------------------------------------------------------- field errors

const FIELD_ALIASES = { sourcePath: "sourcePaths", format: "formats", preset: "pdfPreset" };
function fieldInput(field) {
    switch (field) {
        case "submittedBy": return F.name;
        case "sourcePaths": return F.paths;
        case "formats": return $("#formatOptions input");
        case "pdfPreset": return presetKnown() ? F.presetSelect : F.preset;
        case "pageRange": return F.pages;
        case "outputFolder": return F.folder;
        default: return null;
    }
}

function clearFieldError(field) {
    const slot = $(`#err-${field}`);
    if (slot) slot.replaceChildren();
    const input = fieldInput(field);
    input?.removeAttribute("aria-invalid");
    input?.closest(".field")?.classList.remove("has-error");
}

function clearErrors() {
    for (const field of ["submittedBy", "sourcePaths", "formats", "pdfPreset", "pageRange", "outputFolder", "form"]) clearFieldError(field);
}

function showErrors(errors, pathErrors = []) {
    let first = null;
    for (const [rawField, message] of Object.entries(errors || {})) {
        const field = FIELD_ALIASES[rawField] || rawField;
        const slot = $(`#err-${field}`) || $("#err-form");
        slot.append(el("p", { text: String(message) }));
        const input = fieldInput(field);
        if (input) {
            input.setAttribute("aria-invalid", "true");
            input.closest(".field")?.classList.add("has-error");
            first ??= input;
        }
        if (field === "outputFolder") $("#moreOptions").open = true;
    }
    if (pathErrors.length) {
        F.paths.setAttribute("aria-invalid", "true");
        F.paths.closest(".field").classList.add("has-error");
        if (!errors?.sourcePaths && !errors?.sourcePath) {
            $("#err-sourcePaths").append(el("p", {
                text: pathErrors.length === 1 ? "One of the files can't be used: see the line marked ✗ above."
                    : `${pathErrors.length} of the files can't be used: see the lines marked ✗ above.`,
            }));
        }
        first ??= F.paths;
    }
    if (first) first.focus();
    else $("#err-form").scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------- live check of the files

let checkTimer = null;
let checkSeq = 0;
function scheduleCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(runCheck, 400);
}

async function runCheck() {
    clearTimeout(checkTimer);
    const { paths, duplicates } = parseLines(F.paths.value);
    const folder = F.folder.value.trim();
    const send = paths.slice(0, MAX_FILES);
    const base = { paths: send, duplicates, extra: paths.length - send.length, items: [], folder: null, error: null };
    const seq = ++checkSeq;
    if (!send.length || !state.config) {
        state.check = base;
        renderCheck();
        updateSummary();
        return;
    }
    $("#checkList").classList.add("checking");
    try {
        const data = await api("/check", { method: "POST", body: { sourcePaths: send, ...(folder ? { outputFolder: folder } : {}) } });
        if (seq !== checkSeq) return;
        state.check = { ...base, items: Array.isArray(data?.items) ? data.items : [], folder: data?.outputFolder || null };
    } catch (err) {
        if (seq !== checkSeq) return;
        state.check = { ...base, error: err.status === 401 ? KEY_NEEDED : err.message };
    }
    $("#checkList").classList.remove("checking");
    renderCheck();
    updateSummary();
}

function checkLine(ok, text, { title, name } = {}) {
    return el("li", { class: ok ? "ok" : "bad", title },
        el("span", { class: "mark", "aria-hidden": "true", text: ok ? "✓" : "✗" }),
        el("span", { class: "visually-hidden", text: ok ? "Found: " : "Problem: " }),
        el("span", { class: "check-text" }, name ? el("strong", { text: `${name}: ` }) : null, text));
}

function sourceLabel(item) {
    return [item.drive?.name, ...(item.crumbs || []), item.name || fileName(item.path)].filter(Boolean).join(" › ");
}

function folderLabel(item) {
    const place = placeOf(item.path, drives(), { isFile: false });
    if (place) return placeLabel(place);
    const crumbs = item.crumbs || [];
    const own = fileName(item.path);
    const atRoot = item.drive && item.path === item.drive.path;
    return [item.drive?.name, ...crumbs, ...(atRoot || crumbs[crumbs.length - 1] === own ? [] : [own])].filter(Boolean).join(" › ");
}

function renderCheck() {
    const c = state.check;
    const many = c.paths.length > 1;
    const rows = c.items.map((item) => (item.ok
        ? checkLine(true, `${sourceLabel(item)}${item.modified ? ` · saved ${agoShort(item.modified, now())}` : ""}`, { title: item.path })
        : checkLine(false, item.error || "This path can't be used.", { name: many ? fileName(item.input) : "" })));
    if (c.error) rows.push(el("li", { class: "note", text: `Couldn't check the files just now. ${c.error} They're checked again when you add them.` }));
    if (c.duplicates) rows.push(el("li", { class: "note", text: `${plural(c.duplicates, "line")} listed twice; each file is exported once.` }));
    if (c.extra > 0) rows.push(checkLine(false, `That's ${c.paths.length + c.extra} files. Add up to ${MAX_FILES} at a time.`));
    $("#checkList").replaceChildren(...rows);

    const f = c.folder && c.folder.input === F.folder.value.trim() ? c.folder : null;
    const line = $("#folderCheck");
    if (f) line.replaceChildren(checkLine(f.ok, f.ok ? folderLabel(f) : f.error || "This folder can't be used."));
    else line.replaceChildren();
}

function updateSummary() {
    const files = parseLines(F.paths.value).paths.length;
    const folder = F.folder.value.trim();
    const where = $("#summaryWhere");
    let text;
    let warn = false;
    if (!folder) {
        const sub = state.config?.defaultOutputSubfolder;
        const next = files === 1 ? "the InDesign file" : "each InDesign file";
        text = sub ? `Saved in a “${sub}” folder next to ${next}` : `Saved next to ${next}`;
    } else {
        const f = state.check.folder && state.check.folder.input === folder ? state.check.folder : null;
        if (f?.ok) {
            text = `Saved to ${folderLabel(f)}`;
            // A folder on another client's drive is the classic "wrong client" mistake: say so.
            const sourceDrives = new Set(state.check.items.filter((i) => i.ok && i.drive).map((i) => i.drive.name));
            if (f.drive && sourceDrives.size && !sourceDrives.has(f.drive.name)) {
                text += `, a different client drive from the InDesign ${files === 1 ? "file" : "files"}`;
                warn = true;
            }
        } else if (f) {
            text = "The “Save to folder” can't be used: see below";
            warn = true;
        } else {
            text = `Saved to ${state.pickedFolder?.path === folder ? state.pickedFolder.label : folder}`;
        }
    }
    setText(where, text);
    $("#summary").classList.toggle("warn", warn);
    const options = [F.overwrite.checked && "replaces existing files", F.failOnMissing.checked && "stops if links or fonts are missing"].filter(Boolean);
    const optionsEl = $("#summaryOptions");
    optionsEl.hidden = !options.length;
    setText(optionsEl, options.length ? options.join(" · ").replace(/^./, (c) => c.toUpperCase()) : "");
    $("#useSourceFolder").hidden = !folder;
}

// ---------------------------------------------------------------- presets

function renderPresets() {
    const info = state.presets;
    const list = info?.presets || [];
    const known = list.length > 0;
    F.presetSelect.hidden = !known;
    F.preset.hidden = known;
    $("#presetLabel").htmlFor = known ? "presetSelect" : "pdfPreset";
    const hint = $("#presetHint");
    const button = $("#refreshPresets");
    if (!button.disabled) button.textContent = known ? "Refresh list" : "Load from InDesign";
    button.title = "Ask InDesign on the export PC for its installed PDF presets";
    if (!known) {
        if (!button.disabled) setText(hint, "The preset list hasn't been loaded yet. Type the exact name, or click Load from InDesign.");
        return;
    }
    const wanted = state.presetChoice;
    const pick = list.includes(wanted) ? wanted : list.includes("[High Quality Print]") ? "[High Quality Print]" : list[0];
    F.presetSelect.replaceChildren(...list.map((name) => el("option", { value: name, text: name })));
    F.presetSelect.value = pick;
    const from = `${plural(list.length, "preset")} from ${info.indesignVersion ? `InDesign ${shortVersion(info.indesignVersion)}` : "InDesign"} on the export PC`;
    const checked = info.fetchedAt ? ` · checked ${agoShort(info.fetchedAt, now())}` : "";
    const missing = wanted && wanted !== pick ? `“${wanted}” isn't installed on the export PC, so ${pick} is selected. ` : "";
    if (!button.disabled) setText(hint, `${missing}${from}${checked}.`);
}

function setPresetChoice(name) {
    state.presetChoice = name;
    F.preset.value = name;
    renderPresets();
}

F.presetSelect.addEventListener("change", () => {
    state.presetChoice = F.presetSelect.value;
    clearFieldError("pdfPreset");
    renderPresets();
});
F.preset.addEventListener("input", () => {
    state.presetChoice = F.preset.value.trim();
    clearFieldError("pdfPreset");
});

$("#refreshPresets").addEventListener("click", async () => {
    const button = $("#refreshPresets");
    button.disabled = true;
    const waiting = state.worker?.state === "processing";
    button.textContent = waiting ? "Waiting for InDesign…" : "Asking InDesign…";
    setText($("#presetHint"), waiting
        ? "InDesign is busy with an export. The list loads as soon as it's done."
        : "Asking InDesign on the export PC for its presets. This can take a minute if InDesign has to start.");
    clearFieldError("pdfPreset");
    try {
        state.presets = await api("/presets/refresh", { method: "POST" });
        announce(`Loaded ${plural(state.presets?.presets?.length || 0, "preset")} from InDesign.`);
    } catch (err) {
        showErrors({ pdfPreset: `Couldn't load the presets: ${err.message}` });
    } finally {
        button.disabled = false;
        renderPresets();
    }
});

// ---------------------------------------------------------------- submit

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    primeAudio();
    clearErrors();
    if (!state.config) {
        showErrors({ form: "Still connecting to the export PC. Try again in a moment." });
        return;
    }
    const body = readForm();
    const errors = {};
    if (!body.submittedBy) errors.submittedBy = "Type your name, so everyone can see whose export it is.";
    if (!body.sourcePaths.length) errors.sourcePaths = "Add at least one InDesign file: click Browse…, or paste its path.";
    else if (body.sourcePaths.length > MAX_FILES) errors.sourcePaths = `That's ${body.sourcePaths.length} files. Add up to ${MAX_FILES} at a time.`;
    if (!body.formats.length) errors.formats = "Choose at least one format.";
    if (Object.keys(errors).length) {
        showErrors(errors);
        return;
    }

    F.submit.disabled = true;
    F.submit.textContent = "Adding…";
    const sentAt = performance.now();
    try {
        const data = await api("/jobs", { method: "POST", body });
        const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
        local.set("name", body.submittedBy);
        local.set("lastForm", {
            formats: body.formats,
            pdfPreset: presetValue() || state.presetChoice,
            useDocumentBleed: body.useDocumentBleed,
            includeSlug: body.includeSlug,
            packageIncludeIdml: body.packageIncludeIdml,
            packageIncludePdf: body.packageIncludePdf,
            failOnMissing: body.failOnMissing,
        });
        for (const job of jobs) {
            watch(job.id);
            upsertJob(job, sentAt);
        }
        F.paths.value = "";
        autoGrow();
        state.check = { items: [], folder: null, paths: [], duplicates: 0, extra: 0, error: null };
        renderCheck();
        saveDraft();
        renderList();
        scheduleCounts();
        toast(addedMessage(jobs));
    } catch (err) {
        if (err.status === 422 && err.data) {
            const pathErrors = Array.isArray(err.data.pathErrors) ? err.data.pathErrors : [];
            markPathErrors(body.sourcePaths, pathErrors);
            showErrors(err.data.errors && Object.keys(err.data.errors).length ? err.data.errors : pathErrors.length ? {} : { form: err.message }, pathErrors);
            runCheck();
        } else {
            showErrors({ form: err.message });
        }
    } finally {
        F.submit.disabled = false;
        updateButton();
        updateSummary();
    }
});

// Shows the server's per-file problems right away in the check list, before the fresh check.
function markPathErrors(sent, pathErrors) {
    if (!pathErrors.length) return;
    const items = sent.map((input, i) => state.check.items[i]?.input === input ? state.check.items[i] : { input, ok: true, name: fileName(input) });
    for (const e of pathErrors) {
        if (Number.isInteger(e.index) && items[e.index]) items[e.index] = { input: e.input ?? sent[e.index], ok: false, error: e.message };
    }
    state.check = { ...state.check, paths: sent, items };
    renderCheck();
}

function addedMessage(jobs) {
    if (!jobs.length) return "Added to the queue.";
    if (jobs.length > 1) return `Added ${plural(jobs.length, "export")} to the queue.`;
    const job = jobs[0];
    const label = formatSpec(job.format)?.label || job.format;
    const pos = job.queuePosition;
    const where = !pos ? "" : pos === 1 ? " It's next in line." : ` It's ${ordinal(pos)} in line.`;
    return `Added ${fileName(job.sourcePath)} as ${label}.${where}`;
}

// ---------------------------------------------------------------- form events

F.paths.addEventListener("input", () => {
    autoGrow();
    updateButton();
    updateSummary();
    clearFieldError("sourcePaths");
    $("#dropNotice").hidden = true;
    scheduleCheck();
});

// Pasting a second path straight after the first (cursor at the end of a line) would glue the
// two together; start a new line instead.
F.paths.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return;
    const { selectionStart: start, selectionEnd: end, value } = F.paths;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const before = value.slice(lineStart, start);
    const after = value.slice(end).split(/\r?\n/)[0];
    if (!before.trim() || after.trim() || !dropToPath(text.trim().split(/\r?\n/)[0])) return;
    event.preventDefault();
    const insert = `\n${text.trim()}`;
    if (!document.execCommand?.("insertText", false, insert)) {
        F.paths.setRangeText(insert, start, end, "end");
        F.paths.dispatchEvent(new Event("input", { bubbles: true }));
    }
});

F.paths.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        form.requestSubmit();
    }
});

F.folder.addEventListener("input", () => {
    clearFieldError("outputFolder");
    updateSummary();
    renderCheck();
    scheduleCheck();
});
for (const box of [F.overwrite, F.failOnMissing]) box.addEventListener("change", updateSummary);
F.pkgPdf.addEventListener("change", updateVisibility);
F.pages.addEventListener("input", () => clearFieldError("pageRange"));
F.name.addEventListener("input", () => clearFieldError("submittedBy"));
F.name.addEventListener("change", () => {
    local.set("name", F.name.value.trim());
    renderList();
    loadView();
});

$("#useSourceFolder").addEventListener("click", () => {
    F.folder.value = "";
    state.pickedFolder = null;
    clearFieldError("outputFolder");
    updateSummary();
    renderCheck();
    announce("Exports are saved next to the InDesign files.");
});

function addPaths(paths) {
    const current = F.paths.value.replace(/\s+$/, "");
    const existing = new Set(parseLines(current).paths);
    const fresh = paths.filter((p) => p && !existing.has(p));
    if (!fresh.length) return 0;
    F.paths.value = (current ? `${current}\n` : "") + fresh.join("\n");
    autoGrow();
    updateButton();
    updateSummary();
    clearFieldError("sourcePaths");
    runCheck();
    return fresh.length;
}

const browser = createBrowser({
    api, local, el, now, announce,
    onFiles(paths) {
        const added = addPaths(paths);
        $("#dropNotice").hidden = true;
        announce(added ? `Added ${plural(added, "file")}.` : "Those files are already in the list.");
    },
    onFolder(path, label) {
        F.folder.value = path;
        state.pickedFolder = { path, label };
        $("#moreOptions").open = true;
        clearFieldError("outputFolder");
        updateSummary();
        runCheck();
        announce(`Exports will be saved to ${label}.`);
    },
});
$("#browseFiles").addEventListener("click", (e) => browser.open("files", e.currentTarget));
$("#browseFolder").addEventListener("click", (e) => browser.open("folder", e.currentTarget));

// Dropping a file on the page must never navigate away (and lose the form). Browsers don't tell
// a page where a dropped file lives, so only dropped paths or file:// links can be used.
let dragTimer = null;
document.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    document.body.classList.add("dragging");
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => document.body.classList.remove("dragging"), 200);
});
document.addEventListener("drop", (event) => {
    event.preventDefault();
    document.body.classList.remove("dragging");
    const dt = event.dataTransfer;
    if (!dt) return;
    const uris = (dt.getData("text/uri-list") || "").split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
    const candidates = uris.length ? uris : parseLines(dt.getData("text/plain") || "").paths;
    const paths = candidates.map(dropToPath).filter(Boolean);
    const notice = $("#dropNotice");
    if (paths.length) {
        const added = addPaths(paths);
        notice.hidden = true;
        announce(added ? `Added ${plural(added, "file")}.` : "That file is already in the list.");
    } else if (dt.files?.length || [...(dt.types || [])].includes("Files")) {
        notice.textContent = "Browsers can't pass on where a file is. Use Browse… or paste the path.";
        notice.hidden = false;
        $("#pathHelp").open = true;
        announce(notice.textContent);
        F.paths.focus();
    }
});

// ---------------------------------------------------------------- edit & send again

function fillForm(job) {
    const p = job.params || {};
    F.paths.value = job.sourceInput || job.sourcePath || "";
    for (const box of $$("#formatOptions input")) box.checked = box.value === job.format;
    if (!selectedFormats().length) $("#formatOptions input")?.click();
    if (p.pdfPreset) setPresetChoice(p.pdfPreset);
    F.pages.value = !p.pageRange || p.pageRange === "all" ? "All" : p.pageRange;
    if (typeof p.useDocumentBleed === "boolean") F.bleed.checked = p.useDocumentBleed;
    if (typeof p.includeSlug === "boolean") F.slug.checked = p.includeSlug;
    if (typeof p.packageIncludeIdml === "boolean") F.pkgIdml.checked = p.packageIncludeIdml;
    if (typeof p.packageIncludePdf === "boolean") F.pkgPdf.checked = p.packageIncludePdf;
    F.folder.value = p.outputFolderInput || "";
    state.pickedFolder = null;
    F.overwrite.checked = Boolean(p.overwrite);
    F.failOnMissing.checked = Boolean(p.failOnMissing);
    if (F.folder.value || F.overwrite.checked) $("#moreOptions").open = true;
    clearErrors();
    autoGrow();
    updateVisibility();
    runCheck();
    $("#formTitle").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    F.paths.focus({ preventScroll: true });
    toast(`The settings of job #${job.id} are in the form. Change anything you like, then add it to the queue.`);
}

// ---------------------------------------------------------------- jobs cache

// Live events arrive in order; HTTP replies can be older than an event that overtook them (the
// "processing" event often beats the reply to the submission). A reply is only applied if the
// job hasn't changed since the request was sent. A finished job never goes back.
function upsertJob(job, sentAt = Infinity) {
    if (!job || !Number.isInteger(job.id)) return false;
    const known = state.jobs.get(job.id);
    if (known) {
        if (FINAL.has(known.status) && !FINAL.has(job.status)) return false;
        if ((state.seenAt.get(job.id) ?? -1) > sentAt) return false;
    }
    state.jobs.set(job.id, job);
    state.seenAt.set(job.id, performance.now());
    noticeOwnJob(known, job);
    return true;
}

function applyWorker(worker, sentAt = Infinity) {
    if (!worker || state.workerSeenAt > sentAt) return;
    const before = state.worker?.state;
    state.worker = worker;
    state.workerSeenAt = performance.now();
    if (worker.state === "paused" && before && before !== "paused") announce(worker.pausedReason || "InDesign can't be reached on the export PC. Jobs will wait.");
    if (before === "paused" && worker.state !== "paused") announce("InDesign answers again; the queue carries on.");
}

function mergeResponse(data, sentAt, { counts = false } = {}) {
    if (!data) return;
    applyWorker(data.worker, sentAt);
    if (counts && data.counts) state.counts = data.counts;
    for (const job of Array.isArray(data.jobs) ? data.jobs : []) upsertJob(job, sentAt);
}

const viewParams = () => ({
    status: state.filter === "all" ? "" : state.filter,
    // "Only my jobs" without a search asks the server for jobs mentioning the name, then keeps
    // exact submitter matches here (the API has no "by" filter).
    q: state.q || (state.mineOnly ? myName() : ""),
});
const viewKey = () => {
    const { status, q } = viewParams();
    return `${status}|${q.toLowerCase()}`;
};
const isPlainView = () => state.filter === "all" && !state.q && !state.mineOnly;

let viewSeq = 0;
async function loadView({ older = false } = {}) {
    if (!state.config) return;
    const key = viewKey();
    const { status, q } = viewParams();
    const prev = state.floors.get(key);
    if (older && !(prev > 0)) return;
    if (state.mineOnly && !state.q && !q) {
        renderList();
        return;
    }
    const limit = older ? 100 : 200;
    const params = new URLSearchParams({ limit: String(limit) });
    if (status) params.set("status", status);
    if (q) params.set("q", q);
    if (older) params.set("before", String(prev));
    const seq = ++viewSeq;
    state.viewLoading = true;
    state.viewError = null;
    renderList();
    const sentAt = performance.now();
    try {
        const data = await api(`/jobs?${params}`);
        mergeResponse(data, sentAt, { counts: !status && !q });
        const ids = (data?.jobs || []).map((j) => j.id);
        const more = typeof data?.hasMore === "boolean" ? data.hasMore : ids.length >= limit;
        const oldest = ids.length ? Math.min(...ids) : 0;
        let floor;
        if (older) floor = more ? oldest : 0;
        else floor = !more ? 0 : prev === undefined ? oldest : Math.min(prev, oldest);
        state.floors.set(key, floor);
        if (seq === viewSeq) state.viewLoading = false;
    } catch (err) {
        if (seq === viewSeq) {
            state.viewLoading = false;
            state.viewError = err.message;
        }
    }
    renderAll();
}

async function loadNewest(limit = 200) {
    const sentAt = performance.now();
    const data = await api(`/jobs?limit=${limit}`);
    mergeResponse(data, sentAt, { counts: true });
    renderAll();
}

let countsTimer = null;
// Counts and queue positions change with every job event; one small request a moment later
// keeps them right without reloading the whole list.
function scheduleCounts() {
    clearTimeout(countsTimer);
    countsTimer = setTimeout(async () => {
        const sentAt = performance.now();
        try {
            const data = await api("/jobs?limit=1");
            mergeResponse(data, sentAt, { counts: true });
            renderCounts();
            renderStatus();
        } catch { /* the connection status shows it */ }
    }, 1500);
}

// ---------------------------------------------------------------- queue list (keyed rendering)

const rows = new Map();          // job id → { node, sig, tick, live }
const openDetails = new Set();   // "<id>:warnings" boxes the viewer opened, kept across updates
let pendingOrder = new Map();    // pending job id → its index among pending jobs (oldest first)

// Updates a list in place: a row is only rebuilt when its own data changed, and new rows are
// inserted around the existing ones, so open boxes, keyboard focus and selections survive
// other people's jobs coming and going.
function syncKeyed(container, cache, items, { key, sig, build }) {
    const wanted = new Set();
    let i = 0;
    for (const item of items) {
        const k = key(item);
        wanted.add(k);
        const s = sig(item);
        let entry = cache.get(k);
        if (!entry || entry.sig !== s) {
            const fresh = build(item);
            fresh.sig = s;
            if (entry) {
                const active = document.activeElement;
                const focusAction = entry.node.contains(active) ? (active.dataset?.action || "") : null;
                entry.node.replaceWith(fresh.node);
                if (focusAction !== null) {
                    const target = (focusAction && [...fresh.node.querySelectorAll("[data-action]")].find((b) => b.dataset.action === focusAction))
                        || fresh.node.querySelector("[data-action]") || fresh.node.querySelector("[tabindex='-1']");
                    target?.focus({ preventScroll: true });
                }
            }
            cache.set(k, fresh);
            entry = fresh;
        }
        const at = container.children[i];
        if (at !== entry.node) container.insertBefore(entry.node, at || null);
        i++;
    }
    for (const [k, entry] of cache) {
        if (!wanted.has(k)) {
            entry.node.remove();
            cache.delete(k);
        }
    }
}

function matchesView(job, { ignoreStatus = false } = {}) {
    if (state.mineOnly && !isMine(job)) return false;
    if (!matchesQuery(job, state.q)) return false;
    return ignoreStatus || state.filter === "all" || job.status === state.filter;
}

function renderList() {
    if (!state.config) {
        renderListState(0);
        return;
    }
    const floor = state.floors.get(viewKey()) ?? state.floors.get("|") ?? 0;
    const jobs = [...state.jobs.values()].filter((j) => j.id >= floor && matchesView(j)).sort((a, b) => b.id - a.id);
    if (state.mineOnly && !myName()) jobs.length = 0;
    syncKeyed($("#jobList"), rows, jobs, { key: (j) => j.id, sig: rowSig, build: buildRow });
    tickRows(true);
    renderListState(jobs.length);
    renderCounts();
    $("#showOlder").hidden = !(floor > 0) || state.viewLoading;
}

function renderAll() {
    renderList();
    renderStrip();
    renderStatus();
}

const EMPTY = {
    all: "No exports yet. Add an InDesign file in the form to get started.",
    pending: "Nothing is waiting.",
    processing: "Nothing is exporting right now.",
    completed: "No finished exports yet.",
    failed: "Nothing has failed.",
};

function renderListState(count) {
    const box = $("#listState");
    const btn = $("#listStateBtn");
    let text = "";
    let action = null;
    if (!state.config) text = "Connecting to the export PC…";
    else if (count) text = "";
    else if (state.viewLoading) text = "Loading the queue…";
    else if (state.viewError) {
        text = `Couldn't load the queue. ${state.viewError}`;
        action = ["Try again", () => loadView()];
    } else if (state.q) {
        text = `No jobs match “${state.q}”${state.filter === "all" ? "" : " here"}.`;
        action = ["Clear search", clearSearch];
    } else if (state.mineOnly && !myName()) {
        text = "Type your name in the form to see only your jobs.";
    } else if (state.mineOnly && state.filter === "all") {
        text = `No exports from ${myName()} yet. Untick “Only my jobs” to see everyone's.`;
    } else {
        text = EMPTY[state.filter] || EMPTY.all;
    }
    box.hidden = !text;
    setText($("#listStateText"), text);
    btn.hidden = !action;
    if (action) {
        btn.textContent = action[0];
        btn.onclick = action[1];
    }
}

// With a search or "Only my jobs", the counts are worked out from the jobs loaded here, so they
// always match the list below them; otherwise they're the export PC's totals.
function renderCounts() {
    let counts;
    if (!state.q && !state.mineOnly) {
        const c = state.counts || {};
        counts = {
            all: Object.values(c).reduce((a, b) => a + (Number(b) || 0), 0),
            pending: c.pending, processing: c.processing, completed: c.completed, failed: c.failed,
        };
        if (!state.counts) counts = {};
    } else {
        counts = { all: 0, pending: 0, processing: 0, completed: 0, failed: 0 };
        if (!(state.mineOnly && !myName())) {
            for (const job of state.jobs.values()) {
                if (!matchesView(job, { ignoreStatus: true })) continue;
                counts.all++;
                if (job.status in counts) counts[job.status]++;
            }
        }
    }
    for (const span of $$("[data-count]")) setText(span, counts[span.dataset.count] ? String(counts[span.dataset.count]) : "");
}

function rowSig(job) {
    const { queuePosition, ...rest } = job;
    return `${JSON.stringify(rest)}|${isMine(job)}|${accessKey}|${drives().length}`;
}

function statusOf(job) {
    switch (job.status) {
        case "pending": return { label: "Waiting", tone: "pending" };
        case "processing": return { label: "Exporting", tone: "processing" };
        case "completed": return job.warnings?.length ? { label: "Warnings", tone: "warn" } : { label: "Done", tone: "ok" };
        case "failed": return { label: "Failed", tone: "bad" };
        case "cancelled": return { label: "Cancelled", tone: "muted" };
        default: return { label: String(job.status), tone: "muted" };
    }
}

function describeParams(job) {
    const p = job.params || {};
    const spec = formatSpec(job.format);
    const parts = [spec?.label || job.format];
    if (job.format === "package") {
        const extra = [p.packageIncludeIdml && "IDML", p.packageIncludePdf && `PDF ${p.pdfPreset || ""}`.trim()].filter(Boolean);
        if (extra.length) parts.push(`with ${extra.join(" and ")}`);
    } else if (p.pdfPreset && (spec?.usesPreset ?? job.format === "pdf-print")) {
        parts.push(p.pdfPreset);
    }
    if (spec?.usesPageRange) parts.push(!p.pageRange || p.pageRange === "all" ? "all pages" : `pages ${p.pageRange}`);
    if (spec?.usesBleed) {
        parts.push(p.useDocumentBleed ? "bleed" : "no bleed");
        if (p.includeSlug) parts.push("slug");
    }
    if (p.overwrite) parts.push("replaces existing files");
    if (p.failOnMissing) parts.push("stops if links or fonts are missing");
    return parts.join(" · ");
}

const estimate = (format) => {
    const ms = state.config?.estimates?.[format];
    return Number.isFinite(ms) && ms > 0 ? ms : null;
};

// When a waiting job will probably start: the estimates of the jobs before it plus what's
// left of the running one. Nothing is shown when any of them has no history yet.
function startsIn(job) {
    let total = 0;
    for (const other of state.jobs.values()) {
        if (other.status !== "pending" || other.id >= job.id) continue;
        const e = estimate(other.format);
        if (e === null) return null;
        total += e;
    }
    const currentId = state.worker?.currentJobId;
    if (state.worker?.state === "processing" && currentId) {
        const current = state.jobs.get(currentId);
        const e = current && estimate(current.format);
        if (!e) return null;
        total += Math.max(0, e - (now() - (current.startedAt || now())));
    }
    return total;
}

function liveText(job) {
    if (job.status === "processing") {
        const ran = Math.max(0, now() - (job.startedAt || now()));
        const est = estimate(job.format);
        let text = `running ${duration(ran)}`;
        if (est) text += ran > 2 * est && ran > 120_000 ? ` · taking longer than usual (usually ${roughly(est)})` : ` · usually ${roughly(est)}`;
        return text;
    }
    if (job.status === "pending") {
        const w = state.worker?.state;
        if (w === "paused") return "on hold until InDesign can be reached";
        if (w === "draining") return "waits until the export PC has been updated";
        const index = pendingOrder.get(job.id) ?? 0;
        if (index === 0 && w === "idle") return "starting…";
        let text = index === 0 ? "next in line" : `${ordinal(index + 1)} in line`;
        const wait = startsIn(job);
        if (wait !== null) text += wait < 45_000 ? " · starts in less than a minute" : ` · starts in ${roughly(wait)}`;
        return text;
    }
    return "";
}

function whoText(job) {
    const t = now();
    const who = isMine(job) ? `${job.submittedBy} (you)` : job.submittedBy;
    let time;
    if (job.status === "pending") time = `added ${when(job.createdAt, t)}`;
    else if (job.status === "processing") time = `started ${when(job.startedAt || job.createdAt, t)}`;
    else {
        const verb = { completed: "finished", failed: "failed", cancelled: "cancelled" }[job.status] || job.status;
        time = `${verb} ${when(job.finishedAt || job.createdAt, t)}`;
        if (job.status !== "cancelled" && job.startedAt && job.finishedAt) time += ` · took ${duration(job.finishedAt - job.startedAt)}`;
    }
    return `${who} · ${time} · job #${job.id}`;
}

function fileUrl(job, n, download = false) {
    return withKey(`/api/jobs/${job.id}/file/${n}${download ? "?download=1" : ""}`);
}

function actionButton(text, action, onclick, extra = {}) {
    return el("button", { type: "button", class: "btn btn-small", "data-action": action, text, onclick, ...extra });
}

// One exported file or package folder: where it is, in the viewer's own path style, with
// Open / Download / Copy path.
function outputBlock(job, out, n, { compact = false } = {}) {
    const name = fileName(out.path);
    const isFolder = out.kind === "folder";
    const shown = myPath(out.path, job);
    const place = placeOf(out.path, drives());
    const meta = [isFolder ? "folder" : formatBytes(out.bytes), !compact && place ? `in ${placeLabel(place)}` : ""].filter(Boolean).join(" · ");
    const pathEl = el("p", { class: "path", text: shown, title: shown !== out.path ? `On the export PC: ${out.path}` : null });
    const hint = el("p", { class: "copy-hint", hidden: true });
    const buttons = el("div", { class: "output-actions" });
    if (!isFolder && job.status === "completed") {
        buttons.append(
            el("a", { class: "btn btn-small", href: fileUrl(job, n), target: "_blank", rel: "noopener", "data-action": `open-${n}`, "aria-label": `Open ${name}`, text: "Open" }),
            el("a", { class: "btn btn-small", href: fileUrl(job, n, true), download: name, "data-action": `download-${n}`, "aria-label": `Download ${name}`, text: "Download" }));
    }
    buttons.append(actionButton(isFolder ? "Copy folder path" : "Copy path", `copy-${n}`,
        (e) => copyPath(shown, e.currentTarget, hint, pathEl), { "aria-label": `Copy the path of ${name}` }));
    const block = el("div", { class: "output" },
        el("p", { class: "output-name" }, el("strong", { text: name }), meta ? el("span", { class: "muted", text: ` · ${meta}` }) : null),
        compact ? null : pathEl, buttons, hint);
    if (compact) block.append(pathEl);
    return block;
}

function buildRow(job) {
    const st = statusOf(job);
    const mine = isMine(job);
    const node = el("li", { class: `job tone-${st.tone}${mine ? " mine" : ""}`, "data-id": job.id });
    const place = placeOf(job.sourcePath, job.drive ? [job.drive] : drives()) || placeOf(job.sourcePath, drives());
    const placeText = place ? placeLabel(place) : job.drive?.name || "";

    const liveEl = el("p", { class: "job-live" });
    const whoEl = el("p", { class: "job-who", title: new Date(job.createdAt).toLocaleString() });
    const body = el("div", { class: "job-body" },
        el("h3", { class: "job-file", tabindex: "-1", title: myPath(job.sourcePath, job), text: fileName(job.sourcePath) }),
        placeText ? el("p", { class: "job-place", text: placeText }) : null,
        el("p", { class: "job-settings", text: describeParams(job) }),
        job.status === "pending" || job.status === "processing" ? liveEl : null,
        whoEl);

    const actions = el("div", { class: "job-actions" });
    if (job.status === "pending") actions.append(actionButton("Cancel", "cancel", () => cancelJob(job)));
    if (FINAL.has(job.status)) {
        actions.append(actionButton("Run again", "retry", () => retryJob(job), {
            title: job.params?.overwrite ? "Send the same export again. It replaces the file."
                : "Send the same export again. The new file is saved as “Name (2)” unless “Replace existing files” was ticked.",
        }));
    }
    actions.append(actionButton("Edit & send again", "edit", () => fillForm(job), { title: "Put this job's file and settings into the form" }));

    const detail = el("div", { class: "job-detail" });
    const outputs = Array.isArray(job.outputPaths) ? job.outputPaths : [];
    if (job.status === "processing") {
        for (const out of outputs) {
            const where = placeOf(out.path, drives());
            detail.append(el("p", { class: "note", text: `Saving as ${fileName(out.path)}${where ? ` in ${placeLabel(where)}` : ""}`, title: myPath(out.path, job) }));
        }
    }
    if (job.status === "completed") {
        outputs.forEach((out, n) => {
            detail.append(outputBlock(job, out, n));
            if (out.renamedFrom) {
                const note = el("div", { class: "note note-warn" },
                    el("p", { text: `Saved as ${fileName(out.path)} because ${out.renamedFrom} already existed.` }));
                if (out.kind !== "folder") {
                    note.append(actionButton(`Run again, replacing ${out.renamedFrom}`, `replace-${n}`, () => retryJob(job, { overwrite: true, replacing: out.renamedFrom })));
                }
                detail.append(note);
            }
        });
        if (job.warnings?.length) detail.append(el("p", { class: "note note-warn", text: `Finished with ${plural(job.warnings.length, "warning")}. Check the file before you send it on.` }));
    }
    if (job.status === "failed") {
        detail.append(el("div", { class: "error-box", text: job.error || "The export failed, with no reason given." }));
        detail.append(el("p", { class: "path", title: job.sourcePath, text: myPath(job.sourcePath, job) }));
    }
    if (job.status === "cancelled") detail.append(el("p", { class: "note", text: job.error || "Cancelled." }));
    if (job.warnings?.length) {
        const keep = `${job.id}:warnings`;
        const box = el("details", { class: "warn-box", open: openDetails.has(keep) },
            el("summary", { text: job.warnings.length === 1 ? "1 warning" : `${job.warnings.length} warnings` }),
            el("ul", {}, job.warnings.map((w) => el("li", { text: w }))));
        box.addEventListener("toggle", () => (box.open ? openDetails.add(keep) : openDetails.delete(keep)));
        detail.append(box);
    }

    node.append(el("span", { class: `pill tone-${st.tone}`, text: st.label }), body, actions);
    if (detail.childElementCount) node.append(detail);
    const tick = () => {
        setText(liveEl, liveText(job));
        setText(whoEl, whoText(job));
    };
    return { node, tick, live: job.status === "processing" };
}

function tickRows(all) {
    const pending = [...state.jobs.values()].filter((j) => j.status === "pending").sort((a, b) => a.id - b.id);
    pendingOrder = new Map(pending.map((j, i) => [j.id, i]));
    for (const entry of rows.values()) if (all || entry.live) entry.tick();
    if (all) for (const entry of stripRows.values()) entry.tick?.();
}

async function cancelJob(job) {
    if (!confirm(`Remove ${fileName(job.sourcePath)} (job #${job.id}) from the queue? It hasn't started yet.`)) return;
    try {
        const updated = await api(`/jobs/${job.id}/cancel`, { method: "POST", body: { by: myName() } });
        upsertJob(updated);
        unwatch(job.id);
        renderList();
        scheduleCounts();
        toast(`Removed ${fileName(job.sourcePath)} from the queue.`);
    } catch (err) {
        toast(err.message, { bad: true });
        loadView();
    }
}

async function retryJob(job, { overwrite, replacing } = {}) {
    if (replacing && !confirm(`Export ${fileName(job.sourcePath)} again and replace the existing ${replacing}?`)) return;
    const body = { by: myName() || undefined };
    if (typeof overwrite === "boolean") body.overwrite = overwrite;
    const sentAt = performance.now();
    try {
        const data = await api(`/jobs/${job.id}/retry`, { method: "POST", body });
        const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
        for (const j of jobs) {
            watch(j.id);
            upsertJob(j, sentAt);
        }
        renderList();
        scheduleCounts();
        toast(jobs.length ? `Queued again as job #${jobs[0].id}.` : "Queued again.");
    } catch (err) {
        toast(err.data?.errors?.sourcePath || err.message, { bad: true });
    }
}

// ---------------------------------------------------------------- "Your exports" strip

// Jobs sent from this browser are watched until they finish, even across reloads, sleep and
// closed tabs; their result then waits in the strip until it's dismissed.
const WATCH_DAYS = 7;
function loadIds(key) {
    const v = local.get(key, []);
    return Array.isArray(v) ? v : [];
}
function watchList() {
    const cutoff = Date.now() - WATCH_DAYS * 86_400_000;
    return loadIds("watch").filter((w) => w && Number.isInteger(w.id) && w.at > cutoff);
}
const watching = (id) => watchList().some((w) => w.id === id);
function watch(id) {
    const list = watchList().filter((w) => w.id !== id);
    list.push({ id, at: Date.now() });
    local.set("watch", list.slice(-200));
}
function unwatch(id) {
    local.set("watch", watchList().filter((w) => w.id !== id));
}
const stripIds = () => loadIds("strip").filter(Number.isInteger);

function noticeOwnJob(before, job) {
    if (!FINAL.has(job.status) || (before && FINAL.has(before.status))) return;
    const watched = watching(job.id);
    if (!watched && !(before && isMine(job))) return;
    if (watched) unwatch(job.id);
    if (job.status === "cancelled") return;
    const ids = stripIds().filter((id) => id !== job.id);
    ids.unshift(job.id);
    local.set("strip", ids.slice(0, 20));
    finishedSignal(job);
}

const badge = { done: 0, failed: 0 };
function updateTitle() {
    const parts = [];
    if (badge.failed) parts.push(`${badge.failed} !`);
    if (badge.done) parts.push(`${badge.done} ✓`);
    document.title = parts.length ? `(${parts.join(", ")}) ${BASE_TITLE}` : BASE_TITLE;
}

function finishedSignal(job) {
    const good = job.status === "completed";
    if (document.hidden) {
        if (good) badge.done++;
        else badge.failed++;
        updateTitle();
    }
    beep(good);
    const name = good ? fileName(job.outputPaths?.[0]?.path || job.sourcePath) : fileName(job.sourcePath);
    announce(good ? `${name} is ready${job.warnings?.length ? `, with ${plural(job.warnings.length, "warning")}` : ""}.` : `${name} failed: ${job.error || "no reason given"}`);
}

const stripRows = new Map();
// Strip entries that aren't loaded yet are fetched by fetchMissing() after each (re)sync.
function renderStrip() {
    const jobs = stripIds().map((id) => state.jobs.get(id)).filter(Boolean);
    syncKeyed($("#stripList"), stripRows, jobs, { key: (j) => j.id, sig: (j) => `${JSON.stringify(j)}|${accessKey}`, build: buildStripItem });
    $("#strip").hidden = !jobs.length;
    $("#stripClear").hidden = jobs.length < 2;
}

function dismiss(id) {
    local.set("strip", stripIds().filter((x) => x !== id));
    const next = stripRows.get(id)?.node.nextElementSibling || stripRows.get(id)?.node.previousElementSibling;
    renderStrip();
    (next?.querySelector(".strip-dismiss") || $("#queueTitle")).focus({ preventScroll: true });
}

function buildStripItem(job) {
    const st = statusOf(job);
    const out = (job.outputPaths || [])[0];
    const warnings = job.warnings?.length || 0;
    let text;
    if (job.status === "completed") text = `${fileName(out?.path || job.sourcePath)} is ready${warnings ? `, with ${plural(warnings, "warning")}` : ""}`;
    else text = `${fileName(job.sourcePath)} failed: ${job.error || "no reason given"}`;
    const metaEl = el("p", { class: "strip-meta" });
    const node = el("li", { class: `strip-item tone-${st.tone}` },
        el("span", { class: "strip-mark", "aria-hidden": "true", text: job.status === "completed" ? (warnings ? "!" : "✓") : "✗" }),
        el("div", { class: "strip-body" }, el("p", { class: "strip-text", text }), metaEl,
            job.status === "completed" && out ? outputBlock(job, out, 0, { compact: true }) : null),
        el("div", { class: "strip-actions" },
            actionButton("Details", "details", () => showJobInList(job.id)),
            el("button", { type: "button", class: "btn btn-small btn-ghost strip-dismiss", "data-action": "dismiss", "aria-label": `Dismiss ${text}`, text: "×", onclick: () => dismiss(job.id) })));
    const tick = () => setText(metaEl, `${formatSpec(job.format)?.label || job.format} · ${when(job.finishedAt || job.createdAt, now())} · job #${job.id}`);
    return { node, tick };
}

async function fetchMissing() {
    const wanted = new Set([...stripIds(), ...watchList().map((w) => w.id)]);
    for (const id of wanted) {
        if (state.jobs.has(id)) continue;
        const sentAt = performance.now();
        try {
            upsertJob(await api(`/jobs/${id}`), sentAt);
        } catch (err) {
            if (err.status === 404) {
                unwatch(id);
                local.set("strip", stripIds().filter((x) => x !== id));
            } else {
                return;
            }
        }
    }
    renderAll();
}

function showJobInList(id) {
    const job = state.jobs.get(id);
    if (!job) return;
    let changed = false;
    if (!matchesView(job)) {
        state.filter = "all";
        state.q = "";
        $("#search").value = "";
        if (state.mineOnly && !isMine(job)) {
            state.mineOnly = false;
            $("#mineOnly").checked = false;
        }
        syncFilterButtons();
        changed = true;
    }
    if (job.warnings?.length) openDetails.add(`${id}:warnings`);
    rows.delete(id);    // rebuild it, so the warnings box opens
    $(`#jobList > [data-id="${id}"]`)?.remove();
    renderList();
    if (changed) loadView();
    const node = rows.get(id)?.node;
    if (!node) return;
    node.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 2000);
    node.querySelector(".job-file")?.focus({ preventScroll: true });
}

$("#stripClear").addEventListener("click", () => {
    local.set("strip", []);
    renderStrip();
    $("#queueTitle").focus({ preventScroll: true });
});

// Another tab of this browser dismissed or added something.
window.addEventListener("storage", (event) => {
    if (event.key === "exportQueue.strip") fetchMissing().catch(() => renderStrip());
    if (event.key === "exportQueue.accessKey") {
        accessKey = local.get("accessKey", "") || "";
        state.keyDeclined = false;
        if (state.config) afterKeyChange();
    }
});

// ---------------------------------------------------------------- header status

function statusInfo() {
    if (!state.config) return { text: "Connecting to the export PC…", tone: "muted" };
    if (state.keyDeclined) return { text: "Access key needed", tone: "warn" };
    if (state.offline) return { text: "Offline — reconnecting…", tone: "bad" };
    const w = state.worker;
    const id = state.health?.indesign;
    if (w?.state === "processing") return { text: w.currentJobId ? `Exporting job #${w.currentJobId}` : "Exporting", tone: "processing" };
    if (w?.state === "draining") {
        return w.currentJobId ? { text: `Finishing job #${w.currentJobId}, then updating`, tone: "processing" }
            : { text: "Paused for an update", tone: "warn" };
    }
    if (w?.state === "paused") return { text: "Waiting: InDesign can't be reached", tone: "bad", title: w.pausedReason };
    if (id?.state === "unreachable") return { text: "InDesign can't be reached", tone: "bad", title: id.lastError };
    if (id?.state === "ok") return { text: id.version ? `Ready · InDesign ${shortVersion(id.version)}` : "Ready", tone: "ok", title: id.lastOkAt ? `InDesign last answered ${when(id.lastOkAt, now())}` : "" };
    return { text: "InDesign not checked yet", tone: "muted", title: "The export PC hasn't talked to InDesign since it started. The first export (or Load from InDesign) checks it." };
}

function renderStatus() {
    const s = statusInfo();
    const pill = $("#workerState");
    setText(pill, s.text);
    pill.className = `chip-status tone-${s.tone}`;
    pill.title = s.title || "";

    $("#offlineBanner").hidden = !state.offline;
    $("#keyBanner").hidden = !state.keyDeclined;
    const paused = Boolean(state.config) && !state.offline && state.worker?.state === "paused";
    $("#pausedBanner").hidden = !paused;
    if (paused) setText($("#pausedText"), state.worker.pausedReason || "InDesign can't be reached on the export PC. Jobs will wait.");
    const executor = state.worker?.executor || state.health?.worker?.executor;
    $("#simChip").hidden = executor !== "simulate";

    const down = state.offline ? [] : (state.health?.drives || []).filter((d) => d.ok === false);
    $("#driveStatus").hidden = !down.length;
    const chip = $("#driveChip");
    setText(chip, down.length === 1 ? "1 client drive not reachable" : `${down.length} client drives not reachable`);
    chip.title = down.map((d) => d.name).join(", ");
    $("#driveProblems").replaceChildren(...down.map((d) => el("li", { title: d.error || "" },
        el("strong", { text: d.name }), d.checkedAt ? el("span", { class: "muted", text: ` · checked ${when(d.checkedAt, now())}` }) : null)));
    if (!down.length) closeDrivePopover();

    const lan = state.health?.lanUrl;
    $("#lanLine").hidden = !lan;
    if (lan) setText($("#lanUrl"), lan);
}

function closeDrivePopover() {
    $("#drivePopover").hidden = true;
    $("#driveChip").setAttribute("aria-expanded", "false");
}
$("#driveChip").addEventListener("click", () => {
    const pop = $("#drivePopover");
    pop.hidden = !pop.hidden;
    $("#driveChip").setAttribute("aria-expanded", String(!pop.hidden));
});
document.addEventListener("click", (e) => {
    if (!$("#driveStatus").contains(e.target)) closeDrivePopover();
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#drivePopover").hidden) {
        closeDrivePopover();
        $("#driveChip").focus();
    }
    primeAudio();
}, true);
document.addEventListener("pointerdown", primeAudio, true);

$("#copyLan").addEventListener("click", async (e) => {
    const button = e.currentTarget;
    const ok = await copyText($("#lanUrl").textContent);
    button.textContent = ok ? "Copied" : "Select the address and copy it";
});

function applyHealth(health, sentAt = Infinity) {
    if (!health) return;
    state.health = health;
    applyWorker(health.worker, sentAt);
    renderStatus();
    tickRows(true);
}

// ---------------------------------------------------------------- live updates

const live = {
    source: null,
    backoff: 2000,
    retryTimer: null,
    offlineTimer: null,
    lastEventAt: 0,
    paused: false,          // hidden tab: live stream closed, polling instead
    hiddenTimer: null,
    pollTimer: null,
};

function setOnline(on) {
    if (on) {
        clearTimeout(live.offlineTimer);
        live.offlineTimer = null;
        if (state.offline) {
            state.offline = false;
            announce("Connected to the export PC again.");
        }
        renderStatus();
        return;
    }
    // A short blip (the server restarting) shouldn't flash a red banner.
    if (state.offline || live.offlineTimer) return;
    live.offlineTimer = setTimeout(() => {
        live.offlineTimer = null;
        state.offline = true;
        renderStatus();
        announce("Lost the connection to the export PC. This page keeps trying.");
    }, 3000);
}

function parse(data) {
    try { return JSON.parse(data); } catch { return null; }
}

function connectEvents() {
    clearTimeout(live.retryTimer);
    live.retryTimer = null;
    live.source?.close();
    live.paused = false;
    const source = new EventSource(`/api/events${accessKey ? `?key=${encodeURIComponent(accessKey)}` : ""}`);
    live.source = source;
    live.lastEventAt = Date.now();
    const on = (type, handler) => source.addEventListener(type, (e) => {
        if (source !== live.source) return;
        live.lastEventAt = Date.now();
        const data = e.data === undefined ? null : parse(e.data);
        if (handler) handler(data);
    });
    on("open", () => {
        live.backoff = 2000;
        setOnline(true);
    });
    source.addEventListener("error", () => {
        if (source !== live.source) return;
        setOnline(false);
        // CONNECTING: the browser retries by itself. CLOSED (e.g. a 401 after the access key
        // changed): it never will, so the page has to.
        if (source.readyState === EventSource.CLOSED) scheduleReconnect();
    });
    on("hello", (d) => {
        noteServerTime(d?.serverTime);
        checkVersion(d?.version);
        if (Date.now() - state.lastSyncAt > 3000) resync();
    });
    on("worker", (d) => {
        applyWorker(d);
        renderStatus();
        tickRows(true);
    });
    on("job", (job) => {
        if (upsertJob(job)) {
            renderList();
            renderStrip();
        }
        scheduleCounts();
    });
    on("presets", (d) => {
        if (d) {
            state.presets = d;
            renderPresets();
        }
    });
    on("health", (d) => applyHealth(d));
    on("message", null);
}

function scheduleReconnect() {
    clearTimeout(live.retryTimer);
    const wait = live.backoff;
    live.backoff = Math.min(live.backoff * 2, 30_000);
    live.retryTimer = setTimeout(async () => {
        live.retryTimer = null;
        if (live.paused) return;
        // An ordinary request shows the access-key prompt if that's why the stream was refused.
        try {
            await refreshHealth();
        } catch (err) {
            if (err.status === 401) return;
        }
        connectEvents();
    }, wait);
}

// The server's keep-alives are invisible to the page, so a connection that silently died
// (Wi-Fi change, laptop sleep) looks open. Reconnecting after two quiet minutes costs one
// small request and catches up on anything missed.
setInterval(() => {
    if (live.paused || !live.source || !state.config) return;
    if (live.source.readyState === EventSource.OPEN && Date.now() - live.lastEventAt > 120_000) connectEvents();
    else if (live.source.readyState === EventSource.CLOSED && !live.retryTimer) scheduleReconnect();
}, 15_000);

function afterKeyChange() {
    if (!state.config) return;
    connectEvents();
    resync();
}

// Browsers allow only 6 connections per server; a designer with the queue open in many tabs
// would lock up the newest one. Tabs hidden for 5 minutes close their live stream and check
// every minute instead (enough for the "done" badge), and reconnect when shown again.
document.addEventListener("visibilitychange", () => {
    clearTimeout(live.hiddenTimer);
    if (document.hidden) {
        live.hiddenTimer = setTimeout(() => {
            if (!document.hidden || !state.config) return;
            live.paused = true;
            live.source?.close();
            live.source = null;
            clearTimeout(live.retryTimer);
            live.retryTimer = null;
            clearInterval(live.pollTimer);
            live.pollTimer = setInterval(pollWhileHidden, 60_000);
        }, 5 * 60_000);
        return;
    }
    badge.done = 0;
    badge.failed = 0;
    updateTitle();
    if (live.paused) {
        clearInterval(live.pollTimer);
        live.pollTimer = null;
        connectEvents();
    }
    tickRows(true);
});

async function pollWhileHidden() {
    try {
        await loadNewest(50);
        await fetchMissing();
        setOnline(true);
    } catch (err) {
        if (err.status === 0) setOnline(false);
    }
}

async function refreshHealth() {
    const sentAt = performance.now();
    applyHealth(await api("/health"), sentAt);
}

async function refreshPresets() {
    const data = await api("/presets");
    if (data) {
        state.presets = data;
        renderPresets();
    }
}

async function refreshConfig() {
    const data = await api("/ui-config");
    if (!data) return;
    checkVersion(data.version);
    // Only what can change while the server runs; formats change with a new version (reload).
    for (const key of ["estimates", "drives", "pathMappings", "defaultOutputSubfolder", "accessKeyRequired"]) {
        if (key in data) state.config[key] = data[key];
    }
    updateSummary();
}

// Everything after (re)connecting: missed events are simply fetched again.
async function resync() {
    state.lastSyncAt = Date.now();
    await Promise.allSettled([refreshHealth(), refreshPresets(), refreshConfig()]);
    await Promise.allSettled([loadView(), isPlainView() ? null : loadNewest(200)]);
    await fetchMissing().catch(() => {});
}

// ---------------------------------------------------------------- new version

function checkVersion(version) {
    if (!version || !state.bootVersion || version === state.bootVersion) return;
    const dialogOpen = $$("dialog").some((d) => d.open);
    if (hasUnsentInput() || dialogOpen) {
        $("#versionBanner").hidden = false;
        return;
    }
    reloadForUpdate(version);
}

function reloadForUpdate(version) {
    // Guard against a reload loop if something keeps reporting a different version.
    const last = session.get("reloadedFor", null);
    if (last && last.version === version && Date.now() - last.at < 60_000) {
        $("#versionBanner").hidden = false;
        return;
    }
    session.set("reloadedFor", { version, at: Date.now() });
    saveDraft();
    location.reload();
}

$("#reloadBtn").addEventListener("click", () => {
    saveDraft();
    location.reload();
});
$("#enterKeyBtn").addEventListener("click", async () => {
    state.keyDeclined = false;
    renderStatus();
    const entered = await askForAccessKey("");
    if (!entered) return;
    if (!state.config) return;
    afterKeyChange();
});
window.addEventListener("pagehide", saveDraft);

// ---------------------------------------------------------------- queue controls

let searchTimer = null;
$("#search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        state.q = e.target.value.trim();
        renderList();
        loadView();
    }, 250);
});

function clearSearch() {
    $("#search").value = "";
    state.q = "";
    renderList();
    loadView();
    $("#search").focus();
}

function syncFilterButtons() {
    for (const b of $$("#filters button")) b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter));
}
for (const b of $$("#filters button")) {
    b.addEventListener("click", () => {
        state.filter = b.dataset.filter;
        syncFilterButtons();
        renderList();
        loadView();
    });
}

$("#mineOnly").checked = state.mineOnly;
$("#mineOnly").addEventListener("change", (e) => {
    state.mineOnly = e.target.checked;
    local.set("mineOnly", state.mineOnly);
    renderList();
    loadView();
});

$("#showOlder").addEventListener("click", () => loadView({ older: true }));

const soundBox = $("#soundOn");
soundBox.checked = local.get("sound", false) === true;
soundBox.addEventListener("change", () => {
    local.set("sound", soundBox.checked);
    if (soundBox.checked) {
        primeAudio();
        beep(true);
    }
});

// The help shows the viewer's own system first.
if (OS === "windows") $('#pathHelp [data-os="mac"]').before($('#pathHelp [data-os="windows"]'));

// Every second for running jobs; every 30 s for all the "5 min ago" texts on the page.
setInterval(() => tickRows(false), 1000);
setInterval(() => {
    tickRows(true);
    if (state.check.items.length) renderCheck();
    if (presetKnown() && !$("#refreshPresets").disabled) renderPresets();
    renderStatus();
}, 30_000);

// ---------------------------------------------------------------- start

async function boot() {
    renderStatus();
    renderListState(0);
    autoGrow();
    updateSummary();
    let delay = 1500;
    for (;;) {
        try {
            state.config = await api("/ui-config");
            if (state.config && Array.isArray(state.config.formats)) break;
            throw new ApiError("The export PC sent an unexpected answer.", 500);
        } catch (err) {
            state.config = null;
            setOnline(false);
            setText($("#listStateText"), `Connecting to the export PC… ${err.status === 0 ? "" : `(${err.message}) `}It keeps trying by itself.`);
            await sleep(delay);
            delay = Math.min(delay * 1.6, 15_000);
        }
    }
    setOnline(true);
    state.bootVersion = state.config.version;
    noteServerTime(state.config.serverTime);
    setText($("#versionLine"), state.config.version ? `Export Queue ${state.config.version}` : "");
    renderFormats();
    restoreForm();
    renderPresets();
    updateVisibility();
    renderStatus();
    connectEvents();
    await resync();
    if (F.paths.value.trim()) runCheck();
}

boot();
