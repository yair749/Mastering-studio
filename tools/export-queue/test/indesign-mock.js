// A stand-in for the parts of InDesign's scripting model that indesign-worker.jsx uses,
// backed by the real file system, so the script can be run and checked without InDesign.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

export function runWorkerScript({ jsxSource, jobFile, documents = [], presets, openDocs = [], exportWritesFile = true }) {
    const calls = { opened: [], exported: [], packaged: [], closed: [], removedPresets: [] };

    class Folder {
        constructor(p) { this._p = String(p); }
        get exists() { return fs.existsSync(this._p) && fs.statSync(this._p).isDirectory(); }
        get fsName() { return this._p; }
        create() { fs.mkdirSync(this._p, { recursive: true }); return true; }
        getFiles() { return this.exists ? fs.readdirSync(this._p).map((n) => new File(path.join(this._p, n))) : []; }
    }
    class File {
        constructor(p) { this._p = String(p); this._buf = ""; this._mode = null; }
        get exists() { return fs.existsSync(this._p) && fs.statSync(this._p).isFile(); }
        get fsName() { return this._p; }
        get name() { return encodeURI(path.basename(this._p)); }
        get modified() { return fs.statSync(this._p).mtime; }
        get length() { return fs.statSync(this._p).size; }
        open(mode) {
            this._mode = mode;
            if (mode === "r") { if (!this.exists) return false; this._buf = fs.readFileSync(this._p, "utf8"); }
            else this._buf = "";
            return true;
        }
        read() { return this._buf; }
        write(s) { this._buf += s; }
        close() { if (this._mode === "w") fs.writeFileSync(this._p, this._buf); this._mode = null; }
    }

    const ExportFormat = { PDF_TYPE: "PDF", INTERACTIVE_PDF: "INTERACTIVE_PDF", INDESIGN_MARKUP: "IDML" };
    const PageRange = { ALL_PAGES: "ALL_PAGES" };
    const SaveOptions = { NO: "NO" };
    const UserInteractionLevels = { NEVER_INTERACT: "NEVER", INTERACT_WITH_ALL: "ALL" };
    const LinkStatus = { NORMAL: "NORMAL", LINK_MISSING: "MISSING", LINK_INACCESSIBLE: "INACCESSIBLE", LINK_OUT_OF_DATE: "OUT_OF_DATE" };
    const FontStatus = { INSTALLED: "INSTALLED", NOT_AVAILABLE: "NOT_AVAILABLE", SUBSTITUTED: "SUBSTITUTED" };

    const app = {
        version: "21.0.1",
        scriptArgs: {
            _v: { exportQueueJob: jobFile },
            isDefined(k) { return this._v[k] !== undefined && this._v[k] !== ""; },
            getValue(k) { return this._v[k]; },
            setValue(k, v) { this._v[k] = v; },
        },
        scriptPreferences: { userInteractionLevel: UserInteractionLevels.INTERACT_WITH_ALL },
        pdfExportPreferences: { pageRange: PageRange.ALL_PAGES },
        interactivePDFExportPreferences: { pageRange: PageRange.ALL_PAGES },
    };

    // PDF presets: built-in ones are locked (like InDesign's [bracketed] presets).
    function makePreset(name, settings, locked) {
        const preset = { isValid: true, _locked: locked };
        const values = { ...settings };
        Object.defineProperty(preset, "name", { get: () => name, enumerable: true });
        Object.defineProperty(preset, "properties", {
            get: () => ({ name, id: 1, index: 0, isValid: true, parent: app, ...values, readOnlyThing: 1 }),
        });
        for (const key of ["useDocumentBleedWithPDF", "bleedTop", "bleedBottom", "bleedInside", "bleedOutside", "includeSlugWithPDF", "standardsCompliance", "pdfXProfile", "colorBitmapSampling", "readOnlyThing"]) {
            Object.defineProperty(preset, key, {
                get: () => values[key],
                set: (v) => {
                    if (locked) throw new Error(`Preset "${name}" is locked`);
                    if (key === "readOnlyThing") throw new Error("read-only property");
                    // Like InDesign: the PDF/X output intent is only accepted once a standard is set.
                    if (key === "pdfXProfile" && !values.standardsCompliance) throw new Error("set standardsCompliance first");
                    values[key] = v;
                },
                enumerable: true,
            });
        }
        preset.remove = () => {
            const i = list.indexOf(preset);
            if (i >= 0) list.splice(i, 1);
            preset.isValid = false;
            calls.removedPresets.push(name);
        };
        return preset;
    }
    const list = [];
    for (const [name, settings, locked = true] of presets) list.push(makePreset(name, settings, locked));
    const presetCollection = new Proxy(list, {
        get(target, prop) {
            if (prop === "itemByName") return (n) => target.find((p) => p.name === n) || { isValid: false };
            if (prop === "add") return ({ name }) => { const p = makePreset(name, {}, false); target.push(p); return p; };
            return target[prop];
        },
    });
    app.pdfExportPresets = presetCollection;

    function makeDoc(spec) {
        const doc = {
            isValid: true,
            modified: Boolean(spec.modified),
            fullName: new File(spec.path),
            links: spec.links || [],
            fonts: spec.fonts || [],
            exportFile(format, file, showing, preset) {
                calls.exported.push({
                    format, file: file.fsName, showing,
                    presetName: preset?.name,
                    presetSettings: preset ? { ...preset.properties } : null,
                    pdfPageRange: app.pdfExportPreferences.pageRange,
                    interactivePageRange: app.interactivePDFExportPreferences.pageRange,
                    interaction: app.scriptPreferences.userInteractionLevel,
                });
                if (exportWritesFile) fs.writeFileSync(file.fsName, `exported ${format}`);
            },
            packageForPrint(folder, ...args) {
                calls.packaged.push({ folder: folder.fsName, args });
                fs.writeFileSync(path.join(folder.fsName, "Instructions.txt"), "package");
                return true;
            },
            close(option) { calls.closed.push({ path: spec.path, option }); doc.isValid = false; },
        };
        return doc;
    }
    const docs = openDocs.map(makeDoc);
    app.documents = docs;
    app.open = (file, showingWindow) => {
        calls.opened.push({ path: file.fsName, showingWindow });
        const spec = documents.find((d) => d.path === file.fsName) || { path: file.fsName };
        return makeDoc(spec);
    };

    const context = vm.createContext({ app, File, Folder, ExportFormat, PageRange, SaveOptions, UserInteractionLevels, LinkStatus, FontStatus, isFinite, String, Error });
    vm.runInContext(jsxSource, context);
    return { calls, app, presets: list };
}
