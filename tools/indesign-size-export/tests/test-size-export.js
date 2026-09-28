// Runs the real SizeSortedExport.jsx against a stand-in for InDesign (tests/indesign-stub.js).
//   node --test tools/indesign-size-export/tests/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { A4, loadScript } from "./indesign-stub.js";

const JSX = fs.readFileSync(path.join(import.meta.dirname, "..", "SizeSortedExport.jsx"), "utf8");
const SQUARE = { width: 1080, height: 1080 };
const WIDE = { width: 1920, height: 1080 };
const A4_LANDSCAPE = { width: A4.height, height: A4.width };

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "size-export-")); }

// A root folder with InDesign "files" the stand-in can open.
function setup({ docs = { "Poster.indd": [SQUARE, A4, WIDE, SQUARE] }, presets, failExport, links = {} } = {}) {
    const root = tmpdir();
    const s = loadScript(JSX, { presets, failExport });
    for (const [rel, pages] of Object.entries(docs)) {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "indd");
        s.app.library.set(path.resolve(file), { pages, links: links[rel] });
    }
    const messages = [];
    const log = new s.ns.Log(null);
    log.onMessage((level, line) => messages.push({ level, line }));
    const runner = new s.ns.BatchRunner(log, { guard: new s.ns.FileGuard({ settleMs: 0 }) });
    const job = (over = {}) => ({
        outputRoot: new s.Folder(path.join(root, "_Exports")),
        exporters: [new s.ns.PdfExporter("[High Quality Print]"), new s.ns.JpegExporter(150, "HIGH"), new s.ns.PngExporter(72, true)],
        sizeNamer: new s.ns.SizeNamer({ paperNames: true, units: "px" }),
        fileNamer: new s.ns.FileNamer("{doc}_Page_{page}_{size}"),
        overwrite: true,
        documents: Object.keys(docs).map((rel) => ({ file: new s.File(path.join(root, rel)) })),
        waitForSettle: true,
        ...over,
    });
    const listing = () => {
        const out = [];
        const walk = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out.push(path.relative(path.join(root, "_Exports"), p).split(path.sep).join("/")); } };
        if (fs.existsSync(path.join(root, "_Exports"))) walk(path.join(root, "_Exports"));
        return out;
    };
    return { ...s, root, runner, log, messages, job, listing };
}

test("page sizes become folder names: pixels, paper names, landscape, millimetres", () => {
    const { ns } = loadScript(JSX);
    const px = new ns.SizeNamer({ paperNames: true, units: "px" });
    assert.equal(px.name(1080, 1080), "1080x1080");
    assert.equal(px.name(1920, 1080), "1920x1080");
    assert.equal(px.name(1080.4, 1349.6), "1080x1350");
    assert.equal(px.name(A4.width, A4.height), "A4");
    assert.equal(px.name(A4.height, A4.width), "A4-landscape");
    assert.equal(px.name(612, 792), "Letter");
    assert.equal(px.name(A4.width + 1, A4.height), "A4", "within half a millimetre still counts");
    const mm = new ns.SizeNamer({ paperNames: true, units: "mm" });
    assert.equal(mm.name(200 / (25.4 / 72), 99 / (25.4 / 72)), "200x99mm");
    assert.equal(mm.name(210 / (25.4 / 72), 99 / (25.4 / 72)), "DL-landscape", "a DL envelope on its side");
    assert.equal(mm.name(1080, 1080), "381x381mm");
    assert.equal(new ns.SizeNamer({ paperNames: false, units: "px" }).name(A4.width, A4.height), "595x842");
});

test("file names: tokens, and characters that Windows, Mac and Google Drive refuse", () => {
    const { ns } = loadScript(JSX);
    assert.equal(new ns.FileNamer("Page_{page}_{size}").build({ page: "03", size: "1080x1080" }, "jpg"), "Page_03_1080x1080.jpg");
    assert.equal(new ns.FileNamer("{doc}_{pagename}_{format}").build({ doc: "Menu: Spring/Summer?", pagename: "iv", format: "PDF" }, "pdf"), "Menu- Spring-Summer-_iv_PDF.pdf");
    assert.equal(new ns.FileNamer("").build({ doc: "X", page: "01", size: "A4" }, "png"), "X_Page_01_A4.png", "empty template = default");
    assert.equal(new ns.FileNamer("Page_{page}").hasDocToken(), false);
});

test("mixed page sizes: every page in every ticked format lands in its size folder", () => {
    const t = setup();
    const r = t.runner.run(t.job());
    assert.deepEqual({ exported: r.exported, failed: r.failed, skipped: r.skipped }, { exported: 12, failed: 0, skipped: 0 });
    assert.deepEqual(t.listing(), [
        "1080x1080/Poster_Page_01_1080x1080.jpg", "1080x1080/Poster_Page_01_1080x1080.pdf", "1080x1080/Poster_Page_01_1080x1080.png",
        "1080x1080/Poster_Page_04_1080x1080.jpg", "1080x1080/Poster_Page_04_1080x1080.pdf", "1080x1080/Poster_Page_04_1080x1080.png",
        "1920x1080/Poster_Page_03_1920x1080.jpg", "1920x1080/Poster_Page_03_1920x1080.pdf", "1920x1080/Poster_Page_03_1920x1080.png",
        "A4/Poster_Page_02_A4.jpg", "A4/Poster_Page_02_A4.pdf", "A4/Poster_Page_02_A4.png",
    ]);
    // The settings were switched for each single export: the right page, format options and preset.
    const byFormat = (f) => t.calls.exports.filter((c) => c.format === f);
    assert.deepEqual(byFormat("PDF").map((c) => c.prefs.pageRange), ["1", "2", "3", "4"]);
    assert.deepEqual(byFormat("JPG").map((c) => c.prefs.pageString), ["1", "2", "3", "4"]);
    assert.deepEqual(byFormat("PNG").map((c) => c.prefs.pageString), ["1", "2", "3", "4"]);
    for (const c of byFormat("JPG")) {
        assert.equal(c.prefs.jpegExportRange, "EXPORT_RANGE");
        assert.equal(c.prefs.exportResolution, 150);
        assert.equal(c.prefs.jpegQuality, "HIGH");
        assert.equal(c.prefs.exportingSpread, false);
    }
    for (const c of byFormat("PNG")) assert.deepEqual([c.prefs.exportResolution, c.prefs.transparentBackground, c.prefs.pngExportRange], [72, true, "EXPORT_RANGE"]);
    for (const c of byFormat("PDF")) {
        assert.match(c.preset.name, /^__sizeSortedExport_/, "a copy of the preset, not the locked original");
        assert.equal(c.preset.exportReaderSpreads, false, "one page, not its whole spread");
        assert.equal(c.preset.colorBitmapSamplingDPI, 300, "the preset's own settings were copied");
    }
    // Order inside the loop: page 1 PDF, JPEG, PNG, then page 2 ...
    assert.deepEqual(t.calls.exports.slice(0, 4).map((c) => c.format), ["PDF", "JPG", "PNG", "PDF"]);
    // No dialogs during the batch; everything put back afterwards.
    assert.ok(t.calls.exports.every((c) => c.interaction === "NEVER" && c.showing === false));
    assert.equal(t.app.scriptPreferences.userInteractionLevel, "ALL");
    assert.equal(t.app.scriptPreferences.measurementUnit, "MILLIMETERS");
    assert.deepEqual(t.app.jpegExportPreferences, t.original.jpeg, "the operator's own JPEG export settings are back");
    assert.deepEqual(t.app.pngExportPreferences, t.original.png);
    assert.deepEqual(t.app.pdfExportPreferences, t.original.pdf);
    assert.deepEqual(t.calls.presetsRemoved, t.calls.presetsAdded, "the temporary preset is removed");
    assert.deepEqual(t.calls.opened.map((o) => o.showingWindow), [false], "opened without a window");
    assert.deepEqual(t.calls.closed.map((c) => c.opt), ["NO"], "closed without saving");
    assert.deepEqual(Array.from(r.done).map((f) => path.basename(f.fsName)), ["Poster.indd"]);
});

test("one failing export is reported with page, size and format, and the rest carries on", () => {
    const t = setup({ failExport: (c) => c.format === "JPG" && c.prefs.pageString === "2" });
    const r = t.runner.run(t.job());
    assert.equal(r.exported, 11);
    assert.equal(r.failed, 1);
    const errors = t.messages.filter((m) => m.level === "error").map((m) => m.line);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Poster\.indd page 2 \(A4\) JPEG: The file is in use by another application/);
    assert.equal(t.app.scriptPreferences.userInteractionLevel, "ALL");
    assert.deepEqual(t.calls.closed.length, 1, "the document is still closed");
});

test("a file that is still syncing, empty or locked is skipped with the reason, the others still export", () => {
    const t = setup({ docs: { "Ready.indd": [SQUARE], "Syncing.indd": [SQUARE], "Locked.indd": [SQUARE], "Empty.indd": [SQUARE] } });
    fs.writeFileSync(path.join(t.root, "Empty.indd"), "");
    t.unreadable.add(path.resolve(t.root, "Locked.indd"));
    // Google Drive is still writing Syncing.indd while the guard waits.
    const guard = new t.ns.FileGuard({ settleMs: 1, sleep: () => fs.appendFileSync(path.join(t.root, "Syncing.indd"), "more") });
    const runner = new t.ns.BatchRunner(t.log, { guard });
    const r = runner.run(t.job({ exporters: [new t.ns.JpegExporter(72, "MAXIMUM")] }));
    assert.equal(r.exported, 1);
    assert.equal(r.skipped, 3);
    const warnings = t.messages.filter((m) => m.level === "warning").map((m) => m.line).join("\n");
    assert.match(warnings, /Skipped Syncing\.indd: the file is still changing/);
    assert.match(warnings, /Skipped Locked\.indd: the file is locked by another program/);
    assert.match(warnings, /Skipped Empty\.indd: the file is empty/);
    assert.deepEqual(Array.from(r.done).map((f) => path.basename(f.fsName)), ["Ready.indd"], "skipped files are tried again next time");
});

test("a file InDesign can't open is an error, not a crash", () => {
    const t = setup({ docs: { "Good.indd": [SQUARE] } });
    fs.writeFileSync(path.join(t.root, "Broken.indd"), "not really");
    const r = t.runner.run(t.job({ documents: [{ file: new t.File(path.join(t.root, "Broken.indd")) }, { file: new t.File(path.join(t.root, "Good.indd")) }] }));
    assert.equal(r.exported, 3);
    assert.match(t.messages.find((m) => m.level === "error").line, /Couldn't open Broken\.indd: Cannot open the file.*still syncing/);
});

test("a PDF preset that isn't installed stops the batch before anything is exported, with the list of installed ones", () => {
    const t = setup();
    assert.throws(() => t.runner.run(t.job({ exporters: [new t.ns.PdfExporter("[Agency Print]")] })), /\[Agency Print\]" isn't installed.*\[High Quality Print\], \[Press Quality\]/);
    assert.equal(t.calls.exports.length, 0);
    assert.equal(t.app.scriptPreferences.userInteractionLevel, "ALL", "dialogs are allowed again");
    assert.equal(t.runner.busy, false, "the next batch can run");
});

test("same names from two documents (no {doc} in the template) never overwrite each other", () => {
    const t = setup({ docs: { "A.indd": [SQUARE], "B.indd": [SQUARE] } });
    t.runner.run(t.job({ exporters: [new t.ns.PngExporter(72, false)], fileNamer: new t.ns.FileNamer("Page_{page}_{size}") }));
    assert.deepEqual(t.listing(), ["1080x1080/Page_01_1080x1080 (2).png", "1080x1080/Page_01_1080x1080.png"]);
    // Next run, with "replace" on: the same two files are replaced, no (3).
    t.runner.run(t.job({ exporters: [new t.ns.PngExporter(72, false)], fileNamer: new t.ns.FileNamer("Page_{page}_{size}") }));
    assert.equal(t.listing().length, 2);
    // With "replace" off, earlier exports are kept.
    t.runner.run(t.job({ exporters: [new t.ns.PngExporter(72, false)], fileNamer: new t.ns.FileNamer("Page_{page}_{size}"), overwrite: false }));
    assert.equal(t.listing().length, 4);
});

test("pages with the same name (two sections) are exported by absolute position", () => {
    const t = setup({ docs: { "Book.indd": [{ ...A4, name: "1" }, { ...A4, name: "2" }, { ...A4, name: "1" }] } });
    t.runner.run(t.job({ exporters: [new t.ns.JpegExporter(72, "MAXIMUM")] }));
    assert.deepEqual(t.calls.exports.map((c) => c.prefs.pageString), ["+1", "2", "+3"]);
});

test("a single-page document works", () => {
    const t = setup({ docs: { "One.indd": [WIDE] } });
    const r = t.runner.run(t.job());
    assert.equal(r.exported, 3);
});

test("a document already open on the export machine is used as it is and left open", () => {
    const t = setup({ docs: { "Open.indd": [A4_LANDSCAPE] } });
    const doc = t.app.open(new t.File(path.join(t.root, "Open.indd")), true);
    t.calls.opened.length = 0;
    t.runner.run(t.job({ exporters: [new t.ns.PdfExporter("[Press Quality]")] }));
    assert.equal(t.calls.opened.length, 0);
    assert.equal(t.calls.closed.length, 0);
    assert.ok(t.app.documents.includes(doc));
    assert.deepEqual(t.listing(), ["A4-landscape/Open_Page_01_A4-landscape.pdf"]);
    // The active-document mode passes the document itself.
    const r = t.runner.run(t.job({ documents: [{ doc }], exporters: [new t.ns.JpegExporter(72, "LOW")] }));
    assert.equal(r.exported, 1);
});

test("missing links are reported (Google Drive may not have synced the Links folder yet)", () => {
    const t = setup({ docs: { "Flyer.indd": [SQUARE] }, links: { "Flyer.indd": [{ name: "hero.psd", missing: true }, { name: "logo.ai" }] } });
    t.runner.run(t.job());
    assert.match(t.messages.find((m) => m.level === "warning").line, /Flyer\.indd: 1 missing link\(s\).*hero\.psd.*Links folder/);
});

test("finding documents: subfolders yes; the export folder, lock files, temp and other files no", () => {
    const t = setup({ docs: { "Client A/2026/Flyer.indd": [SQUARE], "Client B/Menu.INDD": [A4], "_Exports/old/Copy.indd": [A4], "~Flyer~abc.idlk": [], ".hidden.indd": [], "notes.txt": [], "~$temp.indd": [] } });
    const files = t.ns.findDocuments(new t.Folder(t.root), new t.Folder(path.join(t.root, "_Exports")), new t.ns.FileGuard());
    assert.deepEqual(Array.from(files).map((f) => path.relative(t.root, f.fsName).split(path.sep).join("/")).sort(), ["Client A/2026/Flyer.indd", "Client B/Menu.INDD"]);
});

test("watching: a file is exported once it looks the same on two checks, and again only after it changes", () => {
    const t = setup({ docs: { "Flyer.indd": [SQUARE] } });
    const state = path.join(t.root, "state.txt");
    const w = new t.ns.FolderWatcher(new t.File(state), t.log);
    const files = () => t.ns.findDocuments(new t.Folder(t.root), new t.Folder(path.join(t.root, "_Exports")), new t.ns.FileGuard());
    assert.equal(w.due(files()).length, 0, "first sight: wait one round");
    const due = w.due(files());
    assert.equal(due.length, 1, "unchanged since the last check: export it");
    w.markExported(due[0]);
    w.save();
    assert.equal(w.due(files()).length, 0, "already exported");
    fs.appendFileSync(path.join(t.root, "Flyer.indd"), " edited");
    assert.equal(w.due(files()).length, 0, "changed: wait until it stops changing");
    const changed = w.due(files());
    assert.equal(changed.length, 1);
    w.markExported(changed[0]);
    w.save();
    // The list of exported files survives an InDesign restart: nothing is exported twice.
    const again = new t.ns.FolderWatcher(new t.File(state), t.log);
    assert.equal(again.due(files()).length, 0);
    assert.equal(again.due(files()).length, 0);
});

test("watching uses one InDesign idle task, and stopping removes it", () => {
    const t = setup();
    const w = new t.ns.FolderWatcher(null, t.log);
    let ticks = 0;
    w.start(2, () => { ticks++; });
    w.start(5, () => { ticks++; });
    assert.equal(t.app.idleTasks._tasks.length, 1, "starting again replaces the old task");
    assert.equal(t.app.idleTasks._tasks[0].sleep, 300000);
    t.app.idleTasks._tasks[0].listeners[0]();
    assert.equal(ticks, 1);
    w.stop();
    assert.equal(t.app.idleTasks._tasks.length, 0);
});

test("settings are remembered between InDesign sessions", () => {
    const t = setup();
    const file = new t.File(path.join(t.root, "settings.txt"));
    const a = new t.ns.Settings(file);
    a.set("rootPath", "G:\\My Drive\\Clients");
    a.set("png", true);
    a.set("template", "Page_{page}_{size}\nsecond line");
    a.save();
    const b = new t.ns.Settings(file);
    b.load();
    assert.equal(b.get("rootPath"), "G:\\My Drive\\Clients");
    assert.equal(b.bool("png"), true);
    assert.equal(b.get("template"), "Page_{page}_{size} second line");
    assert.equal(b.get("outputFolder"), "_Exports", "defaults for the rest");
});

test("the dashboard builds, and Execute Batch Export runs the folder with the chosen options", () => {
    const t = setup({ docs: { "Poster.indd": [SQUARE, A4], "Sub/Banner.indd": [WIDE] } });
    const settings = new t.ns.Settings(new t.File(path.join(t.root, "settings.txt")));
    settings.set("rootPath", t.root);
    settings.set("png", true);
    settings.set("resolution", "300");
    const runner = new t.ns.BatchRunner(t.log, { guard: new t.ns.FileGuard({ settleMs: 0 }) });
    const dash = new t.ns.Dashboard(settings, t.log, runner, new t.ns.FolderWatcher(null, t.log));
    const win = dash.build();
    assert.equal(win.windowType, "palette", "floating, non-modal");
    assert.deepEqual(dash.presetList.items.map((i) => i.text), ["[High Quality Print]", "[Press Quality]"]);
    assert.match(dash.preview.text, /_Exports\/1080x1080\/Poster_Page_01_1080x1080\.jpg/);
    dash.runBtn.onClick();
    assert.equal(t.calls.exports.length, 9, "3 pages x PDF, JPEG, PNG");
    assert.ok(t.calls.exports.filter((c) => c.format !== "PDF").every((c) => c.prefs.exportResolution === 300));
    assert.match(dash.status.text, /Finished: 9 file\(s\) exported/);
    assert.equal(dash.runBtn.enabled, true);
    assert.ok(dash.logList.items.some((i) => /Exporting Banner\.indd \(1 page\)/.test(i.text)));
    // Problems in the form are shown, not thrown.
    dash.pdfBox.value = dash.jpegBox.value = dash.pngBox.value = false;
    dash.runBtn.onClick();
    assert.match(dash.status.text, /Tick at least one format/);
    dash.jpegBox.value = true;
    dash.resList.selection = 4;          // Custom
    dash.resCustom.text = "lots";
    dash.runBtn.onClick();
    assert.match(dash.status.text, /resolution must be a number/);
    // Closing saves the settings and stops watching.
    win.close();
    const saved = fs.readFileSync(path.join(t.root, "settings.txt"), "utf8");
    assert.match(saved, /jpeg=true/);
    assert.match(saved, /pdf=false/);
});

test("the dashboard's watch checkbox exports new files after they've settled", () => {
    const t = setup({ docs: { "Poster.indd": [SQUARE] } });
    const settings = new t.ns.Settings(null);
    settings.set("rootPath", t.root);
    settings.set("pdf", false);
    settings.set("jpeg", true);
    const runner = new t.ns.BatchRunner(t.log, { guard: new t.ns.FileGuard({ settleMs: 0 }) });
    const dash = new t.ns.Dashboard(settings, t.log, runner, new t.ns.FolderWatcher(null, t.log));
    dash.build();
    dash.watchBox.value = true;
    dash.watchBox.onClick();                        // first check: remembers what's there
    assert.equal(t.calls.exports.length, 0);
    const task = t.app.idleTasks._tasks[0];
    task.listeners[0]();                            // next check: unchanged, so export it
    assert.equal(t.calls.exports.length, 1);
    task.listeners[0]();                            // nothing new
    assert.equal(t.calls.exports.length, 1);
    assert.match(dash.status.text, /Watching\. Last check .*nothing new/);
    dash.watchBox.value = false;
    dash.watchBox.onClick();
    assert.equal(t.app.idleTasks._tasks.length, 0);
});

// The export notifier's folder, as Install.cmd leaves it (settings + sender).
function fakeNotifier(t) {
    const dir = path.join(tmpdir(), "InDesignExportNotify");
    fs.mkdirSync(path.join(dir, "app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.txt"), "server=https://ntfy.sh\r\ntopic=indesign-exports-abc123\r\n");
    fs.writeFileSync(path.join(dir, "app", "send-notification.ps1"), "# sender");
    return { dir, alert: new t.ns.PhoneAlert(new t.Folder(dir)), outbox: () => (fs.existsSync(path.join(dir, "outbox")) ? fs.readdirSync(path.join(dir, "outbox")).map((n) => fs.readFileSync(path.join(dir, "outbox", n), "utf8")) : []) };
}
function dashboardFor(t, alert, over = {}) {
    const settings = new t.ns.Settings(null);
    settings.set("rootPath", t.root);
    settings.set("pdf", false);
    settings.set("jpeg", true);
    for (const [k, v] of Object.entries(over)) settings.set(k, v);
    const runner = new t.ns.BatchRunner(t.log, { guard: new t.ns.FileGuard({ settleMs: 0 }) });
    const dash = new t.ns.Dashboard(settings, t.log, runner, new t.ns.FolderWatcher(null, t.log), alert);
    dash.build();
    return dash;
}

test("problems go to the phone through the export notifier's channel; a clean run sends nothing", () => {
    const t = setup({ docs: { "Poster.indd": [SQUARE, A4] }, failExport: (c) => c.prefs.pageString === "2" });
    const n = fakeNotifier(t);
    const dash = dashboardFor(t, n.alert);
    dash.start();
    assert.ok(dash.logList.items.some((i) => /Problems are also sent to your phone/.test(i.text)));
    dash.runBtn.onClick();
    const msgs = n.outbox();
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /^server=https:\/\/ntfy\.sh\ntopic=indesign-exports-abc123\ntoken=\ntitle=Size-sorted export needs a look\ntags=warning\npriority=high\n---\n/);
    assert.match(msgs[0], /1 problem\(s\) in the last export:\nPoster\.indd page 2 \(A4\) JPEG: The file is in use/);
    assert.match(msgs[0], /on EXPORT-PC/);
    assert.equal(t.calls.doScript.length, 1);
    assert.equal(t.calls.doScript[0].language, "VB");
    assert.match(t.calls.doScript[0].code, /send-notification\.ps1"" -MessageFile ""/, "started hidden, like the notifier does");
    // A clean run: no message.
    const t2 = setup({ docs: { "Poster.indd": [SQUARE] } });
    const n2 = fakeNotifier(t2);
    dashboardFor(t2, n2.alert).runBtn.onClick();
    assert.equal(n2.outbox().length, 0);
});

test("without the export notifier, the dashboard says phone alerts are off (and still works)", () => {
    const t = setup({ docs: { "Poster.indd": [SQUARE] }, failExport: () => true });
    const dash = dashboardFor(t, new t.ns.PhoneAlert(new t.Folder(path.join(t.root, "nothing-here"))));
    dash.start();
    assert.ok(dash.logList.items.some((i) => /Phone alerts are off/.test(i.text)));
    dash.runBtn.onClick();
    assert.match(dash.status.text, /Finished with 1 problem/);
});

test("watching: an unreachable Google Drive folder alerts once, not every few minutes", () => {
    const t = setup({ docs: { "Poster.indd": [SQUARE] } });
    const n = fakeNotifier(t);
    const dash = dashboardFor(t, n.alert);
    dash.watchBox.value = true;
    dash.watchBox.onClick();
    const real = t.root, gone = t.root + "-offline";
    fs.renameSync(real, gone);
    const task = t.app.idleTasks._tasks[0];
    task.listeners[0]();
    task.listeners[0]();
    fs.renameSync(gone, real);
    task.listeners[0]();
    assert.equal(n.outbox().length, 1);
    assert.match(n.outbox()[0], /can't reach its folder/);
    assert.ok(dash.logList.items.some((i) => /can be reached again/.test(i.text)));
});

test("watching carries on by itself after InDesign or the dashboard restarts", () => {
    const t = setup({ docs: { "Poster.indd": [SQUARE] } });
    const file = new t.File(path.join(t.root, "settings.txt"));
    const first = new t.ns.Settings(file);
    first.set("rootPath", t.root);
    first.save();
    const runner = new t.ns.BatchRunner(t.log, { guard: new t.ns.FileGuard({ settleMs: 0 }) });
    const d1 = new t.ns.Dashboard(first, t.log, runner, new t.ns.FolderWatcher(null, t.log));
    const w1 = d1.build();
    d1.watchBox.value = true;
    d1.watchBox.onClick();
    w1.close();                                     // e.g. InDesign quits
    assert.equal(t.app.idleTasks._tasks.length, 0);
    const again = new t.ns.Settings(file);
    again.load();
    const d2 = new t.ns.Dashboard(again, t.log, runner, new t.ns.FolderWatcher(null, t.log));
    d2.build();
    d2.start();
    assert.equal(d2.watchBox.value, true);
    assert.equal(t.app.idleTasks._tasks.length, 1, "watching again");
});

test("an older notifier install (channel.txt instead of settings.txt) is recognised too", () => {
    const t = setup();
    const dir = path.join(tmpdir(), "InDesignExportNotify");
    fs.mkdirSync(path.join(dir, "app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app", "send-notification.ps1"), "# sender");
    fs.writeFileSync(path.join(dir, "channel.txt"), "indesign-exports-old123\r\n");
    const alert = new t.ns.PhoneAlert(new t.Folder(dir));
    assert.equal(alert.available(), true);
    alert.send("Size-sorted export needs a look", "test");
    const msg = fs.readFileSync(path.join(dir, "outbox", fs.readdirSync(path.join(dir, "outbox"))[0]), "utf8");
    assert.match(msg, /^server=https:\/\/ntfy\.sh\ntopic=indesign-exports-old123\n/);
});

test("running the script again shows the same dashboard; an updated script replaces it and keeps the settings", () => {
    const t = setup({ docs: { "Poster.indd": [SQUARE] } });
    const data = new t.Folder(path.join(t.root, "data"));
    const noAlert = new t.ns.PhoneAlert(new t.Folder(path.join(t.root, "no-notifier")));
    const first = t.ns.launch(data, noAlert);
    assert.equal(first.win.shown, true);
    first.settings.set("rootPath", t.root);
    first.watchBox.value = true;
    first.watchBox.onClick();                                   // watching, saved in settings
    // Double-click again (same version): the same window comes to the front.
    t.run(JSX);
    assert.equal(t.context.SizeSortedExport.launch(data, noAlert), first);
    // A newer file: the old window closes (saving its settings) and the new one opens and carries on watching.
    t.run(JSX.replace('var VERSION = "1.1.0";', 'var VERSION = "1.2.0";'));
    const second = t.context.SizeSortedExport.launch(data, noAlert);
    assert.notEqual(second, first);
    assert.equal(second.version, "1.2.0");
    assert.equal(first.win.shown, false, "old window closed");
    assert.equal(second.settings.get("rootPath"), t.root);
    assert.equal(second.watchBox.value, true);
    assert.equal(t.app.idleTasks._tasks.length, 1, "one watch task, not two");
});
