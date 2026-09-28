// A stand-in for the parts of InDesign (and ScriptUI) that SizeSortedExport.jsx uses, backed by
// the real file system, so the script can run and be checked without InDesign.
//
// The script runs in its own JavaScript context with the ES5 additions removed (JSON,
// Array.prototype.indexOf/forEach/map, String.prototype.trim, Object.keys...), because
// ExtendScript doesn't have them: using one by mistake makes a test fail here instead of
// failing on the exporting machine.
//
// Pages: { name, width, height } in points (e.g. 1080 x 1080, or A4 = 595.28 x 841.89).
// Like InDesign, page.bounds is given in the script's measurement unit: points only when the
// script asked for points (otherwise millimetres), so a script that forgets to switch gets
// wrong sizes.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const MM = 25.4 / 72;

export function loadScript(source, { presets = ["[High Quality Print]", "[Press Quality]"], failExport = () => false } = {}) {
    const calls = { exports: [], opened: [], closed: [], presetsAdded: [], presetsRemoved: [], idleTasks: [], doScript: [] };
    const unreadable = new Set();          // paths File.open("r") refuses (locked by another program)

    class Folder {
        constructor(p) { this._p = String(p).replace(/[\\/]+$/, "") || "/"; }
        get exists() { return fs.existsSync(this._p) && fs.statSync(this._p).isDirectory(); }
        get fsName() { return path.resolve(this._p); }
        get name() { return encodeURI(path.basename(this._p)); }
        get parent() { return new Folder(path.dirname(this.fsName)); }
        create() { try { fs.mkdirSync(this._p, { recursive: true }); return true; } catch { return false; } }
        getFiles(mask) {
            if (!this.exists) return [];
            let names = fs.readdirSync(this._p);
            if (mask) {
                const re = new RegExp("^" + mask.replace(/[.+^$()|[\]{}]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
                names = names.filter((n) => re.test(n));
            }
            return names.map((n) => {
                const p = path.join(this._p, n);
                return fs.statSync(p).isDirectory() ? new Folder(p) : new File(p);
            });
        }
        execute() { return true; }
        toString() { return this.fsName; }
        static selectDialog() { return null; }
    }
    Folder.userData = "/tmp";
    Folder.temp = "/tmp";

    class File {
        constructor(p) { this._p = String(p); this._buf = ""; this._mode = null; this.encoding = "BINARY"; }
        get exists() { return fs.existsSync(this._p) && fs.statSync(this._p).isFile(); }
        get fsName() { return path.resolve(this._p); }
        get name() { return encodeURI(path.basename(this._p)); }
        get parent() { return new Folder(path.dirname(this.fsName)); }
        get length() { return this.exists ? fs.statSync(this._p).size : -1; }
        get modified() { return this.exists ? fs.statSync(this._p).mtime : null; }
        open(mode) {
            if (mode === "r" && (unreadable.has(this.fsName) || !this.exists)) return false;
            this._mode = mode;
            this._buf = mode === "r" ? fs.readFileSync(this._p, "utf8") : mode === "a" && this.exists ? fs.readFileSync(this._p, "utf8") : "";
            return true;
        }
        read() { return this._buf; }
        write(s) { this._buf += s; }
        writeln(s) { this._buf += s + "\n"; }
        close() { if (this._mode === "w" || this._mode === "a") fs.writeFileSync(this._p, this._buf); this._mode = null; return true; }
        execute() { return true; }
        toString() { return this.fsName; }
        static decode(s) { return decodeURI(s); }
    }

    const ExportFormat = { PDF_TYPE: "PDF", JPG: "JPG", PNG_FORMAT: "PNG" };
    const enums = {
        ExportFormat,
        ExportRangeOrAllPages: { EXPORT_RANGE: "EXPORT_RANGE", EXPORT_ALL: "EXPORT_ALL" },
        PNGExportRangeEnum: { EXPORT_RANGE: "EXPORT_RANGE", EXPORT_ALL: "EXPORT_ALL" },
        JPEGOptionsQuality: { MAXIMUM: "MAXIMUM", HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW" },
        JpegColorSpaceEnum: { RGB: "RGB", CMYK: "CMYK" },
        PNGQualityEnum: { MAXIMUM: "MAXIMUM" },
        PNGColorSpaceEnum: { RGB: "RGB" },
        MeasurementUnits: { POINTS: "POINTS", MILLIMETERS: "MILLIMETERS" },
        UserInteractionLevels: { NEVER_INTERACT: "NEVER", INTERACT_WITH_ALL: "ALL" },
        SaveOptions: { NO: "NO", YES: "YES" },
        LinkStatus: { NORMAL: "NORMAL", LINK_MISSING: "MISSING", LINK_INACCESSIBLE: "INACCESSIBLE" },
        IdleEvent: { ON_IDLE: "onIdle" },
        ScriptLanguage: { VISUAL_BASIC: "VB", JAVASCRIPT: "JS" },
    };

    // PDF presets: a collection like InDesign's. Built-in ones are "locked" (can't be changed).
    const presetList = presets.map((name) => ({ name, isValid: true, locked: true, exportReaderSpreads: true, colorBitmapSamplingDPI: 300, standardsCompliance: "NONE", remove() { throw new Error("locked"); } }));
    const pdfExportPresets = {
        itemByName(name) { return presetList.find((p) => p.name === name) || { isValid: false }; },
        everyItem() { return { name: presetList.map((p) => p.name) }; },
        add(props) {
            const p = { ...props, isValid: true, remove() { p.isValid = false; presetList.splice(presetList.indexOf(p), 1); calls.presetsRemoved.push(p.name); } };
            presetList.push(p);
            calls.presetsAdded.push(p.name);
            return p;
        },
    };
    for (const p of presetList) Object.defineProperty(p, "properties", { get() { return { name: p.name, exportReaderSpreads: p.exportReaderSpreads, colorBitmapSamplingDPI: p.colorBitmapSamplingDPI, standardsCompliance: p.standardsCompliance, id: 7 }; } });

    const original = {
        pdf: { pageRange: "ALL" },
        jpeg: { jpegExportRange: "EXPORT_ALL", pageString: "", exportingSpread: true, exportResolution: 300, jpegQuality: "HIGH", jpegColorSpace: "CMYK", antiAlias: false, useDocumentBleeds: true, embedColorProfile: false, simulateOverprint: true },
        png: { pngExportRange: "EXPORT_ALL", pageString: "", exportingSpread: true, exportResolution: 300, pngQuality: "HIGH", pngColorSpace: "RGB", antiAlias: false, useDocumentBleeds: true, transparentBackground: false, simulateOverprint: true },
    };
    const app = {
        version: "21.0",
        scriptPreferences: { userInteractionLevel: "ALL", measurementUnit: "MILLIMETERS" },
        pdfExportPreferences: { ...original.pdf },
        jpegExportPreferences: { ...original.jpeg },
        pngExportPreferences: { ...original.png },
        pdfExportPresets,
        documents: [],
        library: new Map(),                 // fsName -> document description (files InDesign can open)
        open(file, showingWindow) {
            const already = app.documents.find((d) => d.fullName.fsName === file.fsName);
            if (already) return already;
            const desc = app.library.get(file.fsName);
            if (!desc) throw new Error("Cannot open the file. It may be damaged or from a newer version.");
            calls.opened.push({ path: file.fsName, showingWindow });
            const d = makeDocument(file.fsName, desc);
            app.documents.push(d);
            return d;
        },
        doScript(code, language) { calls.doScript.push({ code, language }); },
        get activeDocument() { if (!app.documents.length) throw new Error("No documents are open."); return app.documents[0]; },
        idleTasks: {
            _tasks: [],
            add(props) {
                const t = { ...props, isValid: true, listeners: [], addEventListener(ev, fn) { t.listeners.push(fn); }, remove() { t.isValid = false; app.idleTasks._tasks.splice(app.idleTasks._tasks.indexOf(t), 1); } };
                app.idleTasks._tasks.push(t);
                calls.idleTasks.push(t);
                return t;
            },
            itemByName(n) { return app.idleTasks._tasks.find((t) => t.name === n) || { isValid: false }; },
        },
    };

    function makeDocument(fsName, desc) {
        const pages = desc.pages.map((p, i) => ({
            name: p.name ?? String(i + 1),
            documentOffset: i,
            get bounds() {
                const f = app.scriptPreferences.measurementUnit === "POINTS" ? 1 : MM;
                return [0, 0, p.height * f, p.width * f];
            },
        }));
        pages.everyItem = () => ({ name: pages.map((p) => p.name) });
        const doc = {
            name: path.basename(fsName),
            fullName: new File(fsName),
            pages,
            links: (desc.links || []).map((l) => ({ name: l.name, status: l.missing ? enums.LinkStatus.LINK_MISSING : enums.LinkStatus.NORMAL })),
            exportFile(format, file, showing, preset) {
                const prefs = format === "PDF" ? { ...app.pdfExportPreferences } : format === "JPG" ? { ...app.jpegExportPreferences } : { ...app.pngExportPreferences };
                const call = { doc: doc.name, format, path: file.fsName, prefs, preset: preset ? { name: preset.name, exportReaderSpreads: preset.exportReaderSpreads, colorBitmapSamplingDPI: preset.colorBitmapSamplingDPI } : null,
                    interaction: app.scriptPreferences.userInteractionLevel, showing };
                calls.exports.push(call);
                if (failExport(call)) throw new Error("The file is in use by another application.");
                fs.writeFileSync(file.fsName, `${format} of ${doc.name}`);
            },
            close(opt) { calls.closed.push({ doc: doc.name, opt }); app.documents.splice(app.documents.indexOf(doc), 1); },
        };
        return doc;
    }

    // ---- ScriptUI stand-in: enough to build the dashboard and click its buttons.
    class Control {
        constructor(type, text, props) {
            this.type = type; this.text = text ?? ""; this.properties = props || {}; this.children = [];
            this.preferredSize = { width: 0, height: 0 }; this.enabled = true; this.value = false;
            this.items = []; this._sel = null; this.layout = { resize() {} };
            if (Array.isArray(text)) { this.text = ""; for (const t of text) this.add("item", t); }
        }
        add(type, bounds, text, props) {
            if (type === "item") { const it = { text: String(bounds), index: this.items.length }; this.items.push(it); return it; }
            const c = new Control(type, text, props); this.children.push(c); return c;
        }
        get selection() { return this._sel; }
        set selection(v) { this._sel = v === null ? null : typeof v === "number" ? this.items[v] : v; }
        removeAll() { this.items = []; this._sel = null; }
        remove(i) { this.items.splice(i, 1); this.items.forEach((it, n) => { it.index = n; }); }
        revealItem() {}
        update() {}
        show() { this.shown = true; if (this.onShow) this.onShow(); }
        close() { if (this.onClose) this.onClose(); this.shown = false; }
        find(pred) { if (pred(this)) return this; for (const c of this.children) { const f = c.find(pred); if (f) return f; } return null; }
    }
    class Window extends Control { constructor(type, title, bounds, props) { super("window", title, props); this.windowType = type; } }

    const context = {
        app, File, Folder, Window, ...enums,
        $: { sleep: () => {}, global: null, getenv: (k) => (k === "COMPUTERNAME" ? "EXPORT-PC" : "") },
        __SIZE_SORTED_EXPORT_TEST__: true,
    };
    context.$.global = context;
    vm.createContext(context);
    // ExtendScript is ES3: take away what it doesn't have.
    vm.runInContext(`
        delete JSON; delete Object.keys; delete Array.isArray;
        ["indexOf","lastIndexOf","forEach","map","filter","reduce","some","every"].forEach(function (k) { delete Array.prototype[k]; });
        delete String.prototype.trim; delete Function.prototype.bind; delete Date.now;
    `, context);
    // Runs a script in this InDesign session, like double-clicking it in the Scripts panel.
    // (#targetengine keeps one engine per session, so a second run sees what the first one left.)
    const run = (src) => vm.runInContext(src.replace(/^#targetengine[^\n]*/, ""), context, { filename: "SizeSortedExport.jsx" });
    run(source);
    return { ns: context.SizeSortedExport, context, app, calls, original, unreadable, File, Folder, run };
}

export const A4 = { width: 210 / MM, height: 297 / MM };
