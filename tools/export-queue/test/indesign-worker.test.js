// Runs the real scripts/indesign-worker.jsx against a stand-in for InDesign's scripting model
// and checks exactly what it asks InDesign to do.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runWorkerScript } from "./indesign-mock.js";

const JSX = fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", "indesign-worker.jsx"), "utf8");
const PRESETS = [
    ["[High Quality Print]", { useDocumentBleedWithPDF: false, bleedTop: 3, bleedBottom: 3, bleedInside: 3, bleedOutside: 3, includeSlugWithPDF: false, colorBitmapSampling: "BICUBIC" }],
    ["[PDF/X-4:2008]", { standardsCompliance: "PDFX42010", pdfXProfile: "Coated FOGRA39", useDocumentBleedWithPDF: true }],
    ["__export_queue_123", {}, false],                   // left behind by a crashed run
];

function setup(jobOver = {}, opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "indesign-worker-"));
    const source = path.join(dir, "Poster.indd");
    fs.writeFileSync(source, "indd");
    const job = {
        action: "export",
        resultPath: path.join(dir, "result.json"),
        sourcePath: source,
        outputPath: path.join(dir, "Poster.pdf"),
        format: "pdf-print",
        pdfPreset: "[High Quality Print]",
        pageRange: "all",
        useDocumentBleed: true,
        includeSlug: false,
        packageIncludeIdml: false,
        packageIncludePdf: false,
        failOnMissing: false,
        ...jobOver,
    };
    const jobFile = path.join(dir, "job.json");
    fs.writeFileSync(jobFile, JSON.stringify(job));
    const run = runWorkerScript({ jsxSource: JSX, jobFile, presets: opts.presets || PRESETS, documents: opts.documents?.(source) || [],
        openDocs: opts.openDocs?.(source) || [], exportWritesFile: opts.exportWritesFile ?? true });
    const result = JSON.parse(fs.readFileSync(job.resultPath, "utf8"));
    return { ...run, result, job, dir, source };
}

test("PDF (Print): preset copied to a temp preset with bleed/slug/page range applied, then cleaned up", () => {
    const { calls, result, app, presets, job } = setup({ useDocumentBleed: false, includeSlug: true, pageRange: "1-3, 7" });
    assert.equal(result.ok, true, result.error);
    assert.equal(calls.exported.length, 1);
    const e = calls.exported[0];
    assert.equal(e.format, "PDF");
    assert.equal(e.showing, false);
    assert.match(e.presetName, /^__export_queue_/);
    assert.equal(e.presetSettings.colorBitmapSampling, "BICUBIC", "preset settings copied");
    assert.equal(e.presetSettings.useDocumentBleedWithPDF, false);
    assert.deepEqual([e.presetSettings.bleedTop, e.presetSettings.bleedBottom, e.presetSettings.bleedInside, e.presetSettings.bleedOutside], [0, 0, 0, 0]);
    assert.equal(e.presetSettings.includeSlugWithPDF, true);
    assert.equal(e.pdfPageRange, "1-3, 7");
    assert.equal(e.interaction, "NEVER", "dialogs suppressed during export");

    assert.equal(app.pdfExportPreferences.pageRange, "ALL_PAGES", "page range reset afterwards");
    assert.equal(app.scriptPreferences.userInteractionLevel, "ALL", "dialog setting restored");
    assert.deepEqual(presets.map((p) => p.name), ["[High Quality Print]", "[PDF/X-4:2008]"], "temp presets removed, leftovers too");
    assert.deepEqual(calls.opened, [{ path: job.sourcePath, showingWindow: false }]);
    assert.deepEqual(calls.closed.map((c) => c.option), ["NO"], "closed without saving");
    assert.equal(result.outputs[0].path, job.outputPath);
    assert.ok(result.outputs[0].bytes > 0);
    assert.equal(result.indesignVersion, "21.0.1");
});

test("PDF (Print): settings that depend on others (PDF/X) survive the copy; document bleed kept when asked", () => {
    const { calls, result } = setup({ pdfPreset: "[PDF/X-4:2008]", useDocumentBleed: true });
    assert.equal(result.ok, true, result.error);
    const s = calls.exported[0].presetSettings;
    assert.equal(s.standardsCompliance, "PDFX42010");
    assert.equal(s.pdfXProfile, "Coated FOGRA39");
    assert.equal(s.useDocumentBleedWithPDF, true);
});

test("an unknown preset fails with the list of installed presets; nothing is left open", () => {
    const { calls, result, presets } = setup({ pdfPreset: "[Magazine Ads]" });
    assert.equal(result.ok, false);
    assert.match(result.error, /"\[Magazine Ads\]" is not installed/);
    assert.match(result.error, /\[High Quality Print\], \[PDF\/X-4:2008\]/);
    assert.equal(calls.exported.length, 0);
    assert.equal(calls.closed.length, 1);
    assert.ok(!presets.some((p) => p.name.startsWith("__export_queue_")));
});

test("missing links and fonts become warnings, or stop the export when asked", () => {
    const documents = (source) => [{
        path: source,
        links: [{ name: "hero.psd", status: "MISSING" }, { name: "logo.ai", status: "OUT_OF_DATE" }, { name: "ok.jpg", status: "NORMAL" }],
        fonts: [{ name: "Brand Sans\tBold", status: "NOT_AVAILABLE" }, { name: "Arial\tRegular", status: "INSTALLED" }],
    }];
    const lenient = setup({}, { documents });
    assert.equal(lenient.result.ok, true);
    assert.deepEqual(lenient.result.warnings, ["Missing link: hero.psd", "Modified link (exported as last placed): logo.ai", "Missing font: Brand Sans Bold"]);

    const strict = setup({ failOnMissing: true }, { documents });
    assert.equal(strict.result.ok, false);
    assert.match(strict.result.error, /2 missing link\(s\)\/font\(s\)/);
    assert.equal(strict.calls.exported.length, 0);
    assert.equal(strict.calls.closed.length, 1);
});

test("a document open on the export PC WITH unsaved changes is refused, not exported stale", () => {
    const { calls, result } = setup({}, { openDocs: (source) => [{ path: source, modified: true }] });
    assert.equal(result.ok, false);
    assert.match(result.error, /open on the export PC with unsaved changes/);
    assert.equal(calls.exported.length, 0);
    assert.equal(calls.closed.length, 0, "the unsaved document is left alone");
});

test("a document open on the export PC without changes is closed and reopened fresh from disk", () => {
    const { calls, result } = setup({}, { openDocs: (source) => [{ path: source, modified: false }] });
    assert.equal(result.ok, true, result.error);
    assert.equal(calls.opened.length, 2, "asked once (got the open copy), then opened fresh");
    assert.equal(calls.closed.length, 2, "old copy closed, fresh copy closed after export");
    assert.ok(calls.closed.every((c) => c.option === "NO"), "never saved");
    assert.equal(calls.exported.length, 1);
});

test("an open document is recognised under another spelling of its path (M:\\ vs \\\\server)", () => {
    const { calls, result } = setup({}, { openDocs: (source) => [{ path: "M:\\Client\\Poster.indd", aliases: [source], modified: true }] });
    assert.equal(result.ok, false);
    assert.match(result.error, /unsaved changes/);
    assert.equal(calls.exported.length, 0);
});

test("PDF (Interactive) and IDML use the right export formats", () => {
    const interactive = setup({ format: "pdf-interactive", pageRange: "2-5" });
    assert.equal(interactive.result.ok, true);
    assert.equal(interactive.calls.exported[0].format, "INTERACTIVE_PDF");
    assert.equal(interactive.calls.exported[0].interactivePageRange, "2-5");
    assert.equal(interactive.calls.exported[0].presetName, undefined);
    assert.equal(interactive.app.interactivePDFExportPreferences.pageRange, "ALL_PAGES");

    const idml = setup({ format: "idml", outputPath: undefined }, {});
    assert.equal(idml.calls.exported.length, 0, "no output path: the job must fail, not guess");
    assert.match(idml.result.error, /missing "outputPath"/);
    const idml2 = setup({ format: "idml" });
    assert.equal(idml2.calls.exported[0].format, "IDML");
});

test("Package: packageForPrint gets fonts, links, report, IDML/PDF options in InDesign's argument order", () => {
    const pkg = setup({ format: "package", packageIncludeIdml: true, packageIncludePdf: true, outputPath: path.join(os.tmpdir(), `pkg-${Date.now()}`, "Poster Folder") });
    assert.equal(pkg.result.ok, true, pkg.result.error);
    assert.equal(pkg.calls.packaged[0].folder, pkg.job.outputPath);
    //                                        fonts links  profiles update hidden ignorePreflight report idml  pdf   pdfStyle               hyph   comments forceSave
    assert.deepEqual(pkg.calls.packaged[0].args, [true, true, false,   true,  false, true,           true,  true, true, "[High Quality Print]", false, "",      false]);
    assert.equal(pkg.result.outputs[0].kind, "folder");

    const plain = setup({ format: "package", packageIncludeIdml: false, packageIncludePdf: false, pdfPreset: "", outputPath: path.join(os.tmpdir(), `pkg2-${Date.now()}`, "Poster Folder") });
    assert.equal(plain.result.ok, true, plain.result.error);
    assert.deepEqual(plain.calls.packaged[0].args.slice(7, 10), [false, false, ""]);
});

test("an existing output that InDesign didn't replace is reported as a failure", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "indesign-worker-"));
    const out = path.join(dir, "Poster.pdf");
    fs.writeFileSync(out, "old");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(out, old, old);
    const { result } = setup({ outputPath: out }, { exportWritesFile: false });
    assert.equal(result.ok, false);
    assert.match(result.error, /existing file was not replaced/);
});

test("preset listing hides temp presets; results with quotes, newlines and Hebrew are valid JSON", () => {
    const { result } = setup({ action: "listPresets" }, { presets: [...PRESETS, ['Client "A"\nקמפיין', {}]] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.presets, ["[High Quality Print]", "[PDF/X-4:2008]", 'Client "A"\nקמפיין']);
});

test("a missing job file is raised to InDesign (so the bridge reports it) instead of failing silently", () => {
    assert.throws(() => runWorkerScript({ jsxSource: JSX, jobFile: "", presets: PRESETS }), /No job file/);
});
