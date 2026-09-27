#targetengine "sizeSortedExport"
/*
    Size-Sorted Export for Adobe InDesign (CC 2019 and newer; ExtendScript / ES3)
    ==========================================================================
    A floating dashboard (ScriptUI palette) for the exporting machine. It exports every page of a
    document on its own, into a folder named after that page's size:

        <Root>/<Exports>/1080x1080/Poster_Page_01_1080x1080.jpg
        <Root>/<Exports>/A4/Poster_Page_02_A4.pdf

    Sources: the active document, every .indd file in the root folder (e.g. a Google Drive folder),
    or "watch": the folder is checked every few minutes and new or changed files are exported by
    themselves while InDesign is idle.

    HOW TO INSTALL
        Put this file in InDesign's Scripts Panel folder (Window > Utilities > Scripts, right-click
        "User" > Reveal in Explorer/Finder), then double-click it in the Scripts panel. Running it
        again brings the existing dashboard to the front instead of opening a second one.
        To open it at every InDesign start, put it in the "Startup Scripts" folder instead.

    WHY "#targetengine"
        A palette only stays open while the script engine that made it is alive. The named engine
        on line 1 keeps it alive after this file has run. (Without it the window flashes and closes.)

    WHERE TO CHANGE THE LOOK
        Everything visual is in Dashboard.prototype.build (search for "LAYOUT"). Sizes, spacing,
        labels and the order of the panels are all set there; the export logic doesn't depend on it.

    CODE MAP (each part is a small "class": a constructor plus prototype methods)
        Util            small ES3 helpers (ExtendScript has no trim, indexOf, JSON...)
        Settings        remembers the dashboard's choices between InDesign sessions
        Log             messages in the dashboard + a log file (never fails silently)
        SizeNamer       page size -> "1080x1080", "A4", "A4-landscape", "210x99mm"
        FileNamer       naming template -> "Poster_Page_01_A4.pdf" (safe for Windows and Mac)
        FileGuard       is a synced file ready? (not still downloading, readable)
        PdfExporter / JpegExporter / PngExporter
                        set that format's options for ONE page and export it
        BatchRunner     documents -> pages -> formats, with error handling at every level
        FolderWatcher   the "watch" mode (InDesign idle task)
        Dashboard       the window
*/

(function (global) {

    var APP_NAME = "Size-Sorted Export";
    var VERSION = "1.0.0";
    var NS = global.SizeSortedExport || (global.SizeSortedExport = {});

    // =====================================================================================
    // Util
    // =====================================================================================
    var Util = {
        trim: function (s) { return String(s).replace(/^\s+|\s+$/g, ""); },
        indexOf: function (list, value) {
            for (var i = 0; i < list.length; i++) { if (list[i] === value) { return i; } }
            return -1;
        },
        pad: function (n, width) {
            var s = String(n);
            while (s.length < width) { s = "0" + s; }
            return s;
        },
        // Rounds and drops trailing zeros: 210 -> "210", 99.06 -> "99.1".
        num: function (n, decimals) {
            var f = Math.pow(10, decimals || 0);
            return String(Math.round(n * f) / f);
        },
        // Characters Windows, macOS and Google Drive refuse in file names become "-".
        safeName: function (s) {
            var out = String(s).replace(/[\\\/:*?"<>|\x00-\x1F]+/g, "-");
            out = out.replace(/\s+/g, " ").replace(/^[\s.]+|[\s.]+$/g, "");
            return out || "untitled";
        },
        baseName: function (fileName) {
            return String(fileName).replace(/\.[^.]*$/, "");
        },
        now: function () {
            var d = new Date();
            return Util.pad(d.getHours(), 2) + ":" + Util.pad(d.getMinutes(), 2) + ":" + Util.pad(d.getSeconds(), 2);
        },
        errorText: function (e) {
            if (!e) { return "unknown error"; }
            var msg = e.message || String(e);
            return e.line ? msg + " (line " + e.line + ")" : msg;
        }
    };

    // =====================================================================================
    // Settings: key=value lines in the user's InDesign script data folder.
    // =====================================================================================
    function Settings(file) {
        this.file = file;
        this.values = {
            rootPath: "",
            outputFolder: "_Exports",
            source: "folder",             // "active" | "folder"
            watch: "false",                // watching resumes by itself when the dashboard opens
            watchMinutes: "2",
            pdf: "true",
            jpeg: "true",
            png: "false",
            pdfPreset: "[High Quality Print]",
            resolution: "72",
            jpegQuality: "MAXIMUM",
            pngTransparent: "false",
            template: "{doc}_Page_{page}_{size}",
            paperNames: "true",
            sizeUnits: "px",               // "px" | "mm" for sizes that aren't a paper size
            overwrite: "true",
            settleSeconds: "3"
        };
    }
    Settings.prototype.get = function (key) { return this.values[key]; };
    Settings.prototype.bool = function (key) { return this.values[key] === "true"; };
    Settings.prototype.set = function (key, value) { this.values[key] = String(value); };
    Settings.prototype.load = function () {
        if (!this.file || !this.file.exists) { return; }
        this.file.encoding = "UTF-8";
        if (!this.file.open("r")) { return; }
        var lines = this.file.read().split(/\r?\n/);
        this.file.close();
        for (var i = 0; i < lines.length; i++) {
            var at = lines[i].indexOf("=");
            if (at > 0) {
                var key = lines[i].substring(0, at);
                if (this.values.hasOwnProperty(key)) { this.values[key] = lines[i].substring(at + 1); }
            }
        }
    };
    Settings.prototype.save = function () {
        if (!this.file) { return; }
        try {
            if (!this.file.parent.exists) { this.file.parent.create(); }
            this.file.encoding = "UTF-8";
            if (!this.file.open("w")) { return; }
            for (var k in this.values) {
                if (this.values.hasOwnProperty(k)) { this.file.writeln(k + "=" + String(this.values[k]).replace(/[\r\n]+/g, " ")); }
            }
            this.file.close();
        } catch (e) { /* settings are a convenience; the export doesn't depend on them */ }
    };

    // =====================================================================================
    // Log: every message goes to the dashboard (if open) and to a log file.
    // =====================================================================================
    function Log(file) {
        this.file = file;
        this.listeners = [];
        this.counts = { error: 0, warning: 0 };
        this.errors = [];        // recent error lines, for the phone alert
    }
    Log.prototype.onMessage = function (fn) { this.listeners.push(fn); };
    Log.prototype.write = function (level, text) {
        var line = Util.now() + "  " + (level === "error" ? "ERROR  " : level === "warning" ? "WARNING  " : "") + text;
        if (this.counts.hasOwnProperty(level)) { this.counts[level]++; }
        if (level === "error") { this.errors.push(text); if (this.errors.length > 50) { this.errors.shift(); } }
        for (var i = 0; i < this.listeners.length; i++) {
            try { this.listeners[i](level, line); } catch (e) { /* a closed window must not stop the export */ }
        }
        if (!this.file) { return; }
        try {
            if (!this.file.parent.exists) { this.file.parent.create(); }
            this.file.encoding = "UTF-8";
            if (this.file.open("a")) {
                this.file.writeln(new Date().toDateString() + " " + line);
                this.file.close();
            }
        } catch (e2) { /* nowhere left to report it */ }
    };
    Log.prototype.info = function (t) { this.write("info", t); };
    Log.prototype.warn = function (t) { this.write("warning", t); };
    Log.prototype.error = function (t) { this.write("error", t); };

    // =====================================================================================
    // PhoneAlert: problems go to the owner's phone through the InDesign export notifier
    // (tools/indesign-export-notify), if it's installed on this computer: same channel, same
    // sender with retries. Only problems are sent: the notifier already announces finished exports.
    // =====================================================================================
    function PhoneAlert(dir) {
        this.dir = dir || new Folder(Folder.userData + "/InDesignExportNotify");
    }
    PhoneAlert.prototype.settings = function () {
        var f = new File(this.dir.fsName + "/settings.txt");
        var sender = new File(this.dir.fsName + "/app/send-notification.ps1");
        if (!f.exists || !sender.exists) { return null; }
        f.encoding = "UTF-8";
        if (!f.open("r")) { return null; }
        var lines = f.read().split(/\r?\n/), out = {};
        f.close();
        for (var i = 0; i < lines.length; i++) {
            var at = lines[i].indexOf("=");
            if (at > 0) { out[lines[i].substring(0, at)] = Util.trim(lines[i].substring(at + 1)); }
        }
        return out.topic ? out : null;
    };
    PhoneAlert.prototype.available = function () { return !!this.settings(); };
    // Returns true when the message was handed to the sender (which retries for ~15 minutes).
    PhoneAlert.prototype.send = function (title, body) {
        var s = this.settings();
        if (!s) { return false; }
        var outbox = new Folder(this.dir.fsName + "/outbox");
        if (!outbox.exists) { outbox.create(); }
        var msg = new File(outbox.fsName + "/" + new Date().getTime() + "-size-export.msg");
        msg.encoding = "UTF-8";
        msg.lineFeed = "Unix";
        if (!msg.open("w")) { return false; }
        msg.write("server=" + (s.server || "https://ntfy.sh") + "\ntopic=" + s.topic + "\ntoken=" + (s.token || "") +
            "\ntitle=" + String(title).replace(/[^\x20-\x7E]/g, "") + "\ntags=warning\npriority=high\n---\n" + body);
        msg.close();
        var sender = new File(this.dir.fsName + "/app/send-notification.ps1");
        var args = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + sender.fsName + '" -MessageFile "' + msg.fsName + '"';
        try {
            app.doScript('CreateObject("WScript.Shell").Run "powershell.exe ' + args.replace(/"/g, '""') + '", 0, False', ScriptLanguage.VISUAL_BASIC);
        } catch (e) {
            // No VBScript on this Windows: a launcher file (may flash a window briefly).
            var cmd = new File(Folder.temp + "/size-export-send.cmd");
            cmd.open("w");
            cmd.write('@start "" /min powershell.exe ' + args + "\r\n");
            cmd.close();
            cmd.execute();
        }
        return true;
    };
    PhoneAlert.computer = function () {
        try { return $.getenv("COMPUTERNAME") || "the exporting machine"; } catch (e) { return "the exporting machine"; }
    };

    // =====================================================================================
    // SizeNamer: turns a page's width and height (in points) into a folder name.
    // =====================================================================================
    // Paper sizes in millimetres (portrait). A page within 0.5 mm of one of these gets its name.
    var PAPER = [
        ["A0", 841, 1189], ["A1", 594, 841], ["A2", 420, 594], ["A3", 297, 420], ["A4", 210, 297],
        ["A5", 148, 210], ["A6", 105, 148], ["DL", 99, 210],
        ["Letter", 215.9, 279.4], ["Legal", 215.9, 355.6], ["Tabloid", 279.4, 431.8]
    ];
    var MM_PER_PT = 25.4 / 72;

    function SizeNamer(options) {
        this.paperNames = !options || options.paperNames !== false;
        this.units = (options && options.units) || "px";
        this.tolerance = 0.5;
    }
    SizeNamer.prototype.name = function (widthPt, heightPt) {
        var wMm = widthPt * MM_PER_PT, hMm = heightPt * MM_PER_PT;
        if (this.paperNames) {
            for (var i = 0; i < PAPER.length; i++) {
                var p = PAPER[i];
                if (Math.abs(wMm - p[1]) <= this.tolerance && Math.abs(hMm - p[2]) <= this.tolerance) { return p[0]; }
                if (Math.abs(wMm - p[2]) <= this.tolerance && Math.abs(hMm - p[1]) <= this.tolerance) { return p[0] + "-landscape"; }
            }
        }
        if (this.units === "mm") { return Util.num(wMm, 1) + "x" + Util.num(hMm, 1) + "mm"; }
        // InDesign's pixel unit is the point (72 per inch), so a 1080 px social post is 1080 pt.
        return Math.round(widthPt) + "x" + Math.round(heightPt);
    };
    // page.bounds is [top, left, bottom, right] in the script's measurement unit (set to points).
    SizeNamer.prototype.pageSize = function (page) {
        var b = page.bounds;
        return { width: b[3] - b[1], height: b[2] - b[0] };
    };

    // =====================================================================================
    // FileNamer: the naming template. Tokens: {doc} {page} {pagename} {size} {format}
    // =====================================================================================
    function FileNamer(template) {
        this.template = Util.trim(template || "") || "{doc}_Page_{page}_{size}";
    }
    FileNamer.prototype.hasDocToken = function () { return this.template.indexOf("{doc}") >= 0; };
    FileNamer.prototype.build = function (tokens, extension) {
        var out = this.template;
        for (var k in tokens) {
            if (tokens.hasOwnProperty(k)) { out = out.split("{" + k + "}").join(String(tokens[k])); }
        }
        return Util.safeName(out) + "." + extension;
    };

    // =====================================================================================
    // FileGuard: is a (synced) file ready to open?
    // Google Drive writes a file in pieces; opening it half-way fails or, worse, opens an old copy.
    // =====================================================================================
    function FileGuard(options) {
        this.settleMs = (options && options.settleMs !== undefined) ? options.settleMs : 3000;
        this.sleep = (options && options.sleep) || function (ms) { $.sleep(ms); };
    }
    // Files that are never documents to export: lock files, temp files, hidden files.
    FileGuard.prototype.isCandidate = function (file) {
        var name = File.decode(file.name);
        if (!/\.indd$/i.test(name)) { return false; }
        return !/^[~.]/.test(name);
    };
    // { ok: true } or { ok: false, reason: "..." }. waitForSettle: false when the caller already
    // saw the same size and date on an earlier check (watch mode).
    FileGuard.prototype.check = function (file, waitForSettle) {
        if (!file.exists) { return { ok: false, reason: "the file is gone (moved, renamed or deleted)" }; }
        var size1 = file.length, date1 = String(file.modified);
        if (size1 <= 0) { return { ok: false, reason: "the file is empty: it's probably still syncing" }; }
        if (waitForSettle !== false && this.settleMs > 0) {
            this.sleep(this.settleMs);
            if (!file.exists || file.length !== size1 || String(file.modified) !== date1) {
                return { ok: false, reason: "the file is still changing: it's probably still syncing" };
            }
        }
        // A file another program is writing can't be opened for reading on Windows.
        if (!file.open("r")) { return { ok: false, reason: "the file is locked by another program (still syncing?)" }; }
        file.close();
        return { ok: true };
    };
    // InDesign leaves "~Name~xyz.idlk" next to a document that is open somewhere. Google Drive
    // syncs those too, so it means a designer has it open: fine to export, but worth a note.
    FileGuard.prototype.openElsewhere = function (file) {
        try {
            var stem = Util.baseName(File.decode(file.name)).substring(0, 5);
            var locks = file.parent.getFiles("~*.idlk");
            for (var i = 0; i < locks.length; i++) {
                if (File.decode(locks[i].name).indexOf("~" + stem) === 0) { return true; }
            }
        } catch (e) { /* only a note */ }
        return false;
    };

    // =====================================================================================
    // Exporters. Each one sets its own format's options for ONE page right before exporting it,
    // so formats can alternate freely inside the page loop. The app-wide export options are
    // put back afterwards, so the operator's own File > Export settings are left as they were.
    // =====================================================================================
    function remember(prefs, keys) {
        var saved = {};
        for (var i = 0; i < keys.length; i++) {
            try { saved[keys[i]] = prefs[keys[i]]; } catch (e) { /* not in this version */ }
        }
        return saved;
    }
    function restore(prefs, saved) {
        for (var k in saved) {
            if (saved.hasOwnProperty(k)) { try { prefs[k] = saved[k]; } catch (e) { /* read-only here */ } }
        }
    }
    // Page range strings for every page of a document, read once per document (asking InDesign
    // page by page is slow). A page's own name ("5", "iv", "A-3") is what InDesign expects;
    // the absolute "+N" is used only when two pages share a name (e.g. two sections).
    function pageRanges(doc) {
        var names = doc.pages.everyItem().name, count = {}, out = [];
        if (typeof names === "string" || typeof names === "number") { names = [names]; }   // a 1-page document
        for (var i = 0; i < names.length; i++) { count["_" + names[i]] = (count["_" + names[i]] || 0) + 1; }
        for (var j = 0; j < names.length; j++) { out.push(count["_" + names[j]] === 1 ? String(names[j]) : "+" + (j + 1)); }
        return out;
    }
    function setPref(prefs, key, value) {
        try { prefs[key] = value; } catch (e) { /* option not available in this InDesign version */ }
    }

    // ---- PDF ---------------------------------------------------------------------------
    // Built-in presets are locked, so the chosen preset is copied once per batch into a temporary
    // preset with "spreads" switched off (otherwise one page exports as its whole spread).
    function PdfExporter(presetName) {
        this.id = "pdf";
        this.label = "PDF";
        this.extension = "pdf";
        this.presetName = presetName;
        this.temp = null;
        this.saved = null;
    }
    var PRESET_SKIP = { name: 1, id: 1, index: 1, parent: 1, isValid: 1, properties: 1, events: 1, eventListeners: 1, label: 1 };
    PdfExporter.prototype.prepare = function () {
        var source = app.pdfExportPresets.itemByName(this.presetName);
        if (!source.isValid) {
            throw new Error("The PDF preset \"" + this.presetName + "\" isn't installed on this computer. Installed: " +
                app.pdfExportPresets.everyItem().name.join(", "));
        }
        this.temp = app.pdfExportPresets.add({ name: "__sizeSortedExport_" + new Date().getTime() });
        var props = source.properties;
        // Two passes: some options can only be set after others (e.g. PDF/X standard first).
        for (var pass = 0; pass < 2; pass++) {
            for (var k in props) {
                if (!props.hasOwnProperty(k) || PRESET_SKIP[k]) { continue; }
                try { this.temp[k] = props[k]; } catch (e) { /* read-only or depends on another option */ }
            }
        }
        setPref(this.temp, "exportReaderSpreads", false);
        this.saved = remember(app.pdfExportPreferences, ["pageRange"]);
    };
    PdfExporter.prototype.exportPage = function (doc, page, file, range) {
        app.pdfExportPreferences.pageRange = range;
        doc.exportFile(ExportFormat.PDF_TYPE, file, false, this.temp);
    };
    PdfExporter.prototype.cleanup = function () {
        if (this.saved) { restore(app.pdfExportPreferences, this.saved); this.saved = null; }
        if (this.temp) {
            try { if (this.temp.isValid) { this.temp.remove(); } } catch (e) { /* removed with the next batch */ }
            this.temp = null;
        }
        // Temporary presets left behind by a crash or a forced quit.
        try {
            var names = app.pdfExportPresets.everyItem().name;
            for (var i = 0; i < names.length; i++) {
                if (names[i].indexOf("__sizeSortedExport_") === 0) { app.pdfExportPresets.itemByName(names[i]).remove(); }
            }
        } catch (e2) { /* harmless leftovers */ }
    };

    // ---- JPEG --------------------------------------------------------------------------
    var JPEG_KEYS = ["jpegExportRange", "pageString", "exportingSpread", "exportResolution", "jpegQuality",
        "jpegColorSpace", "antiAlias", "useDocumentBleeds", "embedColorProfile", "simulateOverprint"];
    function JpegExporter(resolution, quality) {
        this.id = "jpeg";
        this.label = "JPEG";
        this.extension = "jpg";
        this.resolution = resolution;
        this.quality = quality || "MAXIMUM";
        this.saved = null;
    }
    JpegExporter.prototype.prepare = function () {
        this.saved = remember(app.jpegExportPreferences, JPEG_KEYS);
    };
    JpegExporter.prototype.exportPage = function (doc, page, file, range) {
        var p = app.jpegExportPreferences;
        setPref(p, "jpegExportRange", ExportRangeOrAllPages.EXPORT_RANGE);
        setPref(p, "pageString", range);
        setPref(p, "exportingSpread", false);
        setPref(p, "exportResolution", this.resolution);
        setPref(p, "jpegQuality", JPEGOptionsQuality[this.quality]);
        setPref(p, "jpegColorSpace", JpegColorSpaceEnum.RGB);
        setPref(p, "antiAlias", true);
        setPref(p, "useDocumentBleeds", false);
        setPref(p, "embedColorProfile", true);
        setPref(p, "simulateOverprint", false);
        doc.exportFile(ExportFormat.JPG, file, false);
    };
    JpegExporter.prototype.cleanup = function () {
        if (this.saved) { restore(app.jpegExportPreferences, this.saved); this.saved = null; }
    };

    // ---- PNG ---------------------------------------------------------------------------
    var PNG_KEYS = ["pngExportRange", "pageString", "exportingSpread", "exportResolution", "pngQuality",
        "pngColorSpace", "antiAlias", "useDocumentBleeds", "transparentBackground", "simulateOverprint"];
    function PngExporter(resolution, transparent) {
        this.id = "png";
        this.label = "PNG";
        this.extension = "png";
        this.resolution = resolution;
        this.transparent = !!transparent;
        this.saved = null;
    }
    PngExporter.prototype.prepare = function () {
        this.saved = remember(app.pngExportPreferences, PNG_KEYS);
    };
    PngExporter.prototype.exportPage = function (doc, page, file, range) {
        var p = app.pngExportPreferences;
        setPref(p, "pngExportRange", PNGExportRangeEnum.EXPORT_RANGE);
        setPref(p, "pageString", range);
        setPref(p, "exportingSpread", false);
        setPref(p, "exportResolution", this.resolution);
        setPref(p, "pngQuality", PNGQualityEnum.MAXIMUM);
        setPref(p, "pngColorSpace", PNGColorSpaceEnum.RGB);
        setPref(p, "antiAlias", true);
        setPref(p, "useDocumentBleeds", false);
        setPref(p, "transparentBackground", this.transparent);
        setPref(p, "simulateOverprint", false);
        doc.exportFile(ExportFormat.PNG_FORMAT, file, false);
    };
    PngExporter.prototype.cleanup = function () {
        if (this.saved) { restore(app.pngExportPreferences, this.saved); this.saved = null; }
    };

    // =====================================================================================
    // BatchRunner: documents -> pages -> formats. A problem with one page, format or document is
    // logged and the batch carries on; nothing is left changed in InDesign afterwards.
    // =====================================================================================
    function BatchRunner(log, options) {
        this.log = log;
        this.guard = (options && options.guard) || new FileGuard();
        this.onProgress = (options && options.onProgress) || function () {};
        this.busy = false;
    }

    // job: { outputRoot: Folder, exporters: [...], sizeNamer, fileNamer, overwrite,
    //        documents: [ { file: File } | { doc: Document } ], waitForSettle }
    // Returns { exported, failed, skipped, done: [File...] (documents that were exported) }
    BatchRunner.prototype.run = function (job) {
        if (this.busy) { throw new Error("An export is already running."); }
        this.busy = true;
        var result = { exported: 0, failed: 0, skipped: 0, done: [] };
        var savedLevel = app.scriptPreferences.userInteractionLevel;
        var savedUnit = null;
        var prepared = [];
        try {
            // No dialogs (missing fonts, links, "convert document"...) may block an unattended PC.
            app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
            try { savedUnit = app.scriptPreferences.measurementUnit; app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS; } catch (eu) { savedUnit = null; }
            if (!job.outputRoot.exists && !job.outputRoot.create()) {
                throw new Error("Can't create the output folder " + job.outputRoot.fsName);
            }
            for (var x = 0; x < job.exporters.length; x++) {
                job.exporters[x].prepare();
                prepared.push(job.exporters[x]);
            }
            this.writtenThisRun = {};
            for (var d = 0; d < job.documents.length; d++) {
                this.onProgress(d, job.documents.length, "");
                // "done" = opened and exported (even if some pages failed: those are logged, and
                // retrying them every few minutes wouldn't help). Not ready / not opened = tried again.
                var attempted = this.runDocument(job, job.documents[d], result);
                if (attempted && job.documents[d].file) { result.done.push(job.documents[d].file); }
            }
            this.onProgress(job.documents.length, job.documents.length, "");
        } finally {
            for (var c = 0; c < prepared.length; c++) {
                try { prepared[c].cleanup(); } catch (ec) { this.log.warn("Couldn't tidy up after " + prepared[c].label + ": " + Util.errorText(ec)); }
            }
            if (savedUnit !== null) { try { app.scriptPreferences.measurementUnit = savedUnit; } catch (eu2) { /* ignore */ } }
            app.scriptPreferences.userInteractionLevel = savedLevel;
            this.busy = false;
        }
        return result;
    };

    // Returns true when the document was opened and its pages were exported (problems with single
    // pages are logged), false when it wasn't ready or couldn't be opened.
    BatchRunner.prototype.runDocument = function (job, item, result) {
        var doc = item.doc || null, openedHere = false, label;
        if (!doc) {
            label = File.decode(item.file.name);
            var check = this.guard.check(item.file, job.waitForSettle);
            if (!check.ok) {
                this.log.warn("Skipped " + label + ": " + check.reason + ". It's tried again next time.");
                result.skipped++;
                return false;
            }
            doc = this.findOpen(item.file);
            if (!doc) {
                try {
                    doc = app.open(item.file, false);        // false = no window: faster, nothing on screen
                    openedHere = true;
                } catch (eo) {
                    this.log.error("Couldn't open " + label + ": " + Util.errorText(eo) + " (still syncing, damaged, or from a newer InDesign?)");
                    result.failed++;
                    return false;
                }
            }
            if (this.guard.openElsewhere(item.file)) { this.log.info(label + " is open on another computer: exporting the last synced version."); }
        }
        label = doc.name;
        try {
            this.noteMissingLinks(doc);
            var docName = Util.safeName(Util.baseName(doc.name));
            var total = doc.pages.length;
            var digits = Math.max(2, String(total).length);
            var ranges = pageRanges(doc);
            this.log.info("Exporting " + label + " (" + total + " page" + (total === 1 ? "" : "s") + ")");
            for (var i = 0; i < total; i++) {
                var page = doc.pages[i];
                var size;
                try {
                    var dims = job.sizeNamer.pageSize(page);
                    size = job.sizeNamer.name(dims.width, dims.height);
                } catch (es) {
                    this.log.error(label + " page " + (i + 1) + ": couldn't measure the page: " + Util.errorText(es));
                    result.failed += job.exporters.length;
                    continue;
                }
                var folder = new Folder(job.outputRoot.fsName + "/" + Util.safeName(size));
                if (!folder.exists && !folder.create()) {
                    this.log.error("Can't create the folder " + folder.fsName + " (is the drive full or read-only?)");
                    result.failed += job.exporters.length;
                    continue;
                }
                for (var f = 0; f < job.exporters.length; f++) {
                    var ex = job.exporters[f];
                    var tokens = { doc: docName, page: Util.pad(i + 1, digits), pagename: page.name, size: size, format: ex.label };
                    var file = this.target(folder, job.fileNamer.build(tokens, ex.extension), job.overwrite);
                    this.onProgress(-1, 0, label + " - page " + (i + 1) + "/" + total + " - " + ex.label);
                    try {
                        ex.exportPage(doc, page, file, ranges[i]);
                        if (!file.exists || file.length === 0) { throw new Error("InDesign reported no error, but no file was written"); }
                        this.writtenThisRun[file.fsName] = true;
                        result.exported++;
                    } catch (ee) {
                        this.log.error(label + " page " + (i + 1) + " (" + size + ") " + ex.label + ": " + Util.errorText(ee));
                        result.failed++;
                    }
                }
            }
        } catch (ed) {
            this.log.error(label + ": " + Util.errorText(ed));
            result.failed++;
        } finally {
            if (openedHere) {
                try { doc.close(SaveOptions.NO); } catch (ec) { this.log.warn("Couldn't close " + label + ": " + Util.errorText(ec)); }
            }
        }
        return true;
    };

    // The same file already open in InDesign (e.g. by the operator): use it, and leave it open.
    BatchRunner.prototype.findOpen = function (file) {
        for (var i = 0; i < app.documents.length; i++) {
            var d = app.documents[i];
            try { if (d.fullName.fsName === file.fsName) { return d; } } catch (e) { /* unsaved document */ }
        }
        return null;
    };

    BatchRunner.prototype.noteMissingLinks = function (doc) {
        try {
            var missing = [];
            for (var i = 0; i < doc.links.length; i++) {
                var s = doc.links[i].status;
                if (s === LinkStatus.LINK_MISSING || s === LinkStatus.LINK_INACCESSIBLE) { missing.push(doc.links[i].name); }
            }
            if (missing.length) {
                this.log.warn(doc.name + ": " + missing.length + " missing link(s), exported with low-resolution previews: " +
                    missing.slice(0, 5).join(", ") + (missing.length > 5 ? "..." : "") + ". Has Google Drive finished syncing the Links folder?");
            }
        } catch (e) { /* only a warning */ }
    };

    // Where to write. With "overwrite" off, or when this batch already wrote that name (two
    // documents with the same page names), "Name (2).jpg" is used instead of replacing it.
    BatchRunner.prototype.target = function (folder, fileName, overwrite) {
        var file = new File(folder.fsName + "/" + fileName);
        var clash = this.writtenThisRun[file.fsName] || (!overwrite && file.exists);
        if (!clash) { return file; }
        var stem = Util.baseName(fileName), ext = fileName.substring(stem.length);
        for (var n = 2; n < 1000; n++) {
            var alt = new File(folder.fsName + "/" + stem + " (" + n + ")" + ext);
            if (!this.writtenThisRun[alt.fsName] && (overwrite || !alt.exists)) { return alt; }
        }
        return file;
    };

    // All candidate documents in a folder and its subfolders, skipping the output folder.
    function findDocuments(root, outputRoot, guard, depth) {
        var found = [];
        if (depth === undefined) { depth = 0; }
        if (depth > 6 || !root.exists) { return found; }
        var items = root.getFiles();
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it instanceof Folder) {
                var n = File.decode(it.name);
                if (it.fsName === outputRoot.fsName || /^[~.]/.test(n)) { continue; }
                found = found.concat(findDocuments(it, outputRoot, guard, depth + 1));
            } else if (guard.isCandidate(it)) {
                found.push(it);
            }
        }
        return found;
    }

    // =====================================================================================
    // FolderWatcher: every few minutes, while InDesign is idle, export documents that are new or
    // changed since they were last exported. A file must look the same on two checks in a row
    // before it's exported, so a file that is still syncing is left alone until it's complete.
    // =====================================================================================
    function FolderWatcher(stateFile, log) {
        this.stateFile = stateFile;
        this.log = log;
        this.exported = {};      // path -> "size|modified" of the version last exported
        this.seen = {};          // path -> "size|modified" at the previous check
        this.task = null;
        this.load();
    }
    FolderWatcher.stamp = function (file) { return file.length + "|" + String(file.modified); };
    FolderWatcher.prototype.load = function () {
        if (!this.stateFile || !this.stateFile.exists) { return; }
        this.stateFile.encoding = "UTF-8";
        if (!this.stateFile.open("r")) { return; }
        var lines = this.stateFile.read().split(/\r?\n/);
        this.stateFile.close();
        for (var i = 0; i < lines.length; i++) {
            var at = lines[i].lastIndexOf("\t");
            if (at > 0) { this.exported[lines[i].substring(0, at)] = lines[i].substring(at + 1); }
        }
    };
    FolderWatcher.prototype.save = function () {
        if (!this.stateFile) { return; }
        try {
            if (!this.stateFile.parent.exists) { this.stateFile.parent.create(); }
            this.stateFile.encoding = "UTF-8";
            if (!this.stateFile.open("w")) { return; }
            for (var k in this.exported) { if (this.exported.hasOwnProperty(k)) { this.stateFile.writeln(k + "\t" + this.exported[k]); } }
            this.stateFile.close();
        } catch (e) { this.log.warn("Couldn't save the list of exported files: " + Util.errorText(e)); }
    };
    // Which of these files are ready to export now: changed since the last export, and unchanged
    // since the previous check.
    FolderWatcher.prototype.due = function (files) {
        var due = [], seenNow = {};
        for (var i = 0; i < files.length; i++) {
            var f = files[i], stamp;
            try { stamp = FolderWatcher.stamp(f); } catch (e) { continue; }
            seenNow[f.fsName] = stamp;
            if (this.exported[f.fsName] === stamp) { continue; }
            if (this.seen[f.fsName] === stamp) { due.push(f); }
        }
        this.seen = seenNow;
        return due;
    };
    FolderWatcher.prototype.markExported = function (file) {
        try { this.exported[file.fsName] = FolderWatcher.stamp(file); } catch (e) { /* tried again next time */ }
    };
    FolderWatcher.prototype.start = function (minutes, onTick) {
        this.stop();
        var ms = Math.max(1, minutes) * 60000;
        this.task = app.idleTasks.add({ name: "sizeSortedExportWatch", sleep: ms });
        this.task.addEventListener(IdleEvent.ON_IDLE, function () {
            try { onTick(); } catch (e) { NS.log.error("Watch check failed: " + Util.errorText(e)); }
        });
    };
    FolderWatcher.prototype.stop = function () {
        try {
            var old = app.idleTasks.itemByName("sizeSortedExportWatch");
            if (old.isValid) { old.remove(); }
        } catch (e) { /* none */ }
        this.task = null;
    };
    FolderWatcher.prototype.running = function () { return !!this.task; };

    // =====================================================================================
    // Dashboard: the floating window.
    // =====================================================================================
    function Dashboard(settings, log, runner, watcher, alert) {
        this.alert = alert || null;
        this.rootDown = false;
        this.settings = settings;
        this.log = log;
        this.runner = runner;
        this.watcher = watcher;
        this.win = null;
    }

    Dashboard.prototype.build = function () {
        var self = this, s = this.settings;

        // ---------------------------------------------------------------- LAYOUT
        // "palette" = floating, non-modal: InDesign stays usable while it's open.
        // Change preferredSize / spacing / margins below to adjust the look.
        var w = new Window("palette", APP_NAME + "  " + VERSION, undefined, { resizeable: true, closeButton: true });
        w.orientation = "column";
        w.alignChildren = ["fill", "top"];
        w.spacing = 10;
        w.margins = 14;
        var LABEL_W = 110;           // width of the labels on the left of each row
        var FIELD_W = 260;           // width of text fields and dropdowns

        function row(parent, labelText) {
            var g = parent.add("group");
            g.orientation = "row";
            g.alignChildren = ["left", "center"];
            if (labelText !== null) { g.add("statictext", undefined, labelText).preferredSize.width = LABEL_W; }
            return g;
        }

        // ---- Panel 1: folders
        var pFolder = w.add("panel", undefined, "Folders");
        pFolder.alignChildren = ["fill", "top"];
        pFolder.margins = [12, 16, 12, 10];
        var rRoot = row(pFolder, "Root folder:");
        this.rootText = rRoot.add("statictext", undefined, s.get("rootPath") || "(not chosen yet)", { truncate: "middle" });
        this.rootText.preferredSize.width = FIELD_W;
        var bRoot = rRoot.add("button", undefined, "Choose...");
        var rOut = row(pFolder, "Export into:");
        this.outText = rOut.add("edittext", undefined, s.get("outputFolder"));
        this.outText.preferredSize.width = 120;
        rOut.add("statictext", undefined, "(a folder inside the root folder)");

        // ---- Panel 2: what to export
        var pSource = w.add("panel", undefined, "Documents");
        pSource.alignChildren = ["fill", "top"];
        pSource.margins = [12, 16, 12, 10];
        var rSrc = row(pSource, "Export:");
        this.srcActive = rSrc.add("radiobutton", undefined, "The active document");
        this.srcFolder = rSrc.add("radiobutton", undefined, "Every InDesign file in the root folder");
        this.srcActive.value = s.get("source") === "active";
        this.srcFolder.value = !this.srcActive.value;
        var rWatch = row(pSource, "");
        this.watchBox = rWatch.add("checkbox", undefined, "Watch the root folder: export new and changed files every");
        this.watchMin = rWatch.add("dropdownlist", undefined, ["1", "2", "5", "10", "30"]);
        this.selectText(this.watchMin, s.get("watchMinutes"), 1);
        rWatch.add("statictext", undefined, "min");

        // ---- Panel 3: formats and quality
        var pFmt = w.add("panel", undefined, "Formats");
        pFmt.alignChildren = ["fill", "top"];
        pFmt.margins = [12, 16, 12, 10];
        var rFmt = row(pFmt, "Export as:");
        this.pdfBox = rFmt.add("checkbox", undefined, "PDF");
        this.jpegBox = rFmt.add("checkbox", undefined, "JPEG");
        this.pngBox = rFmt.add("checkbox", undefined, "PNG");
        this.pdfBox.value = s.bool("pdf");
        this.jpegBox.value = s.bool("jpeg");
        this.pngBox.value = s.bool("png");
        var rPreset = row(pFmt, "PDF preset:");
        this.presetList = rPreset.add("dropdownlist", undefined, []);
        this.presetList.preferredSize.width = FIELD_W;
        var bPresets = rPreset.add("button", undefined, "Refresh");
        var rRes = row(pFmt, "Image resolution:");
        this.resList = rRes.add("dropdownlist", undefined, ["72", "96", "150", "300", "Custom"]);
        this.resCustom = rRes.add("edittext", undefined, s.get("resolution"));
        this.resCustom.characters = 5;
        rRes.add("statictext", undefined, "ppi   (72 keeps pixel sizes: a 1080 px page -> 1080 px)");
        var rJq = row(pFmt, "JPEG quality:");
        this.jpegQ = rJq.add("dropdownlist", undefined, ["MAXIMUM", "HIGH", "MEDIUM", "LOW"]);
        this.selectText(this.jpegQ, s.get("jpegQuality"), 0);
        this.pngTransparent = rJq.add("checkbox", undefined, "PNG: transparent background");
        this.pngTransparent.value = s.bool("pngTransparent");

        // ---- Panel 4: naming
        var pName = w.add("panel", undefined, "Folder and file names");
        pName.alignChildren = ["fill", "top"];
        pName.margins = [12, 16, 12, 10];
        var rT = row(pName, "File name:");
        this.templateText = rT.add("edittext", undefined, s.get("template"));
        this.templateText.preferredSize.width = FIELD_W;
        rT.add("statictext", undefined, "{doc} {page} {pagename} {size} {format}");
        var rSize = row(pName, "Size folders:");
        this.paperBox = rSize.add("checkbox", undefined, "Use paper names (A4, Letter...)");
        this.paperBox.value = s.bool("paperNames");
        rSize.add("statictext", undefined, "other sizes in");
        this.unitsList = rSize.add("dropdownlist", undefined, ["pixels (1080x1080)", "millimetres (210x99mm)"]);
        this.unitsList.selection = s.get("sizeUnits") === "mm" ? 1 : 0;
        var rOver = row(pName, "");
        this.overwriteBox = rOver.add("checkbox", undefined, "Replace earlier exports of the same page (otherwise \"Name (2)\")");
        this.overwriteBox.value = s.bool("overwrite");
        this.preview = pName.add("statictext", undefined, "", { truncate: "end" });

        // ---- Panel 5: status and buttons
        var pRun = w.add("panel", undefined, "Status");
        pRun.alignChildren = ["fill", "top"];
        pRun.margins = [12, 16, 12, 10];
        this.status = pRun.add("statictext", undefined, "Ready.", { truncate: "end" });
        this.progress = pRun.add("progressbar", undefined, 0, 100);
        this.progress.preferredSize.height = 8;
        this.logList = pRun.add("listbox", undefined, [], { multiselect: false });
        this.logList.preferredSize = [LABEL_W + FIELD_W + 180, 170];   // log size: width, height
        var rBtn = pRun.add("group");
        rBtn.alignment = ["fill", "top"];
        this.runBtn = rBtn.add("button", undefined, "Execute Batch Export", { name: "ok" });
        this.runBtn.preferredSize.height = 30;
        var bOpen = rBtn.add("button", undefined, "Open export folder");
        var bLogFile = rBtn.add("button", undefined, "Open log file");
        var bClear = rBtn.add("button", undefined, "Clear");
        // ---------------------------------------------------------------- end of LAYOUT

        // Behaviour
        bRoot.onClick = function () {
            var f = Folder.selectDialog("Choose the root folder (e.g. the Google Drive folder with the InDesign files)");
            if (f) { s.set("rootPath", f.fsName); self.rootText.text = f.fsName; self.updatePreview(); }
        };
        bPresets.onClick = function () { self.fillPresets(); };
        this.resList.onChange = function () { self.resCustom.enabled = self.resList.selection && self.resList.selection.text === "Custom"; };
        var res = s.get("resolution");
        this.selectText(this.resList, res, 4);
        this.resCustom.enabled = this.resList.selection.text === "Custom";
        this.templateText.onChanging = this.paperBox.onClick = this.unitsList.onChange = function () { self.updatePreview(); };
        this.pdfBox.onClick = this.jpegBox.onClick = this.pngBox.onClick = function () { self.updatePreview(); };
        this.watchBox.onClick = function () { self.toggleWatch(); };
        this.runBtn.onClick = function () { self.runNow(); };
        bOpen.onClick = function () {
            var out = self.outputRoot();
            if (out && out.exists) { out.execute(); } else { self.say("The export folder doesn't exist yet: run an export first."); }
        };
        bLogFile.onClick = function () { if (self.log.file && self.log.file.exists) { self.log.file.execute(); } };
        bClear.onClick = function () { self.logList.removeAll(); };
        w.onResizing = w.onResize = function () { this.layout.resize(); };
        w.onClose = function () {
            self.readSettings();
            self.settings.save();
            if (self.watcher.running()) { self.watcher.stop(); self.log.info("Watching paused (dashboard closed). It carries on when the dashboard opens again."); }
            return true;
        };
        this.log.onMessage(function (level, line) { self.addLogLine(level, line); });

        this.win = w;
        this.fillPresets();
        this.updatePreview();
        return w;
    };

    Dashboard.prototype.selectText = function (list, text, fallbackIndex) {
        for (var i = 0; i < list.items.length; i++) { if (list.items[i].text === text) { list.selection = i; return; } }
        list.selection = fallbackIndex;
    };

    Dashboard.prototype.fillPresets = function () {
        var names = [];
        try { names = app.pdfExportPresets.everyItem().name; } catch (e) { names = []; }
        var want = this.presetList.selection ? this.presetList.selection.text : this.settings.get("pdfPreset");
        this.presetList.removeAll();
        for (var i = 0; i < names.length; i++) {
            if (names[i].indexOf("__sizeSortedExport_") !== 0) { this.presetList.add("item", names[i]); }
        }
        this.selectText(this.presetList, want, 0);
    };

    Dashboard.prototype.addLogLine = function (level, line) {
        if (!this.win) { return; }
        var item = this.logList.add("item", (level === "error" ? "X  " : level === "warning" ? "!  " : "    ") + line);
        while (this.logList.items.length > 500) { this.logList.remove(0); }
        try { this.logList.revealItem(item); } catch (e) { /* older ScriptUI */ }
        if (level !== "info") { this.status.text = line; }
    };

    Dashboard.prototype.say = function (text) {
        this.status.text = text;
        try { this.win.update(); } catch (e) { /* not shown yet */ }
    };

    Dashboard.prototype.resolution = function () {
        var text = this.resList.selection.text === "Custom" ? this.resCustom.text : this.resList.selection.text;
        var n = Number(Util.trim(text));
        return (n >= 1 && n <= 2400) ? Math.round(n) : null;
    };

    Dashboard.prototype.readSettings = function () {
        var s = this.settings;
        s.set("outputFolder", Util.trim(this.outText.text) || "_Exports");
        s.set("source", this.srcActive.value ? "active" : "folder");
        s.set("watchMinutes", this.watchMin.selection.text);
        s.set("pdf", this.pdfBox.value);
        s.set("jpeg", this.jpegBox.value);
        s.set("png", this.pngBox.value);
        if (this.presetList.selection) { s.set("pdfPreset", this.presetList.selection.text); }
        s.set("resolution", this.resList.selection.text === "Custom" ? Util.trim(this.resCustom.text) : this.resList.selection.text);
        s.set("jpegQuality", this.jpegQ.selection.text);
        s.set("pngTransparent", this.pngTransparent.value);
        s.set("template", Util.trim(this.templateText.text) || "{doc}_Page_{page}_{size}");
        s.set("paperNames", this.paperBox.value);
        s.set("sizeUnits", this.unitsList.selection.index === 1 ? "mm" : "px");
        s.set("overwrite", this.overwriteBox.value);
    };

    Dashboard.prototype.updatePreview = function () {
        var namer = new FileNamer(this.templateText.text);
        var sizes = new SizeNamer({ paperNames: this.paperBox.value, units: this.unitsList.selection && this.unitsList.selection.index === 1 ? "mm" : "px" });
        var ext = this.jpegBox.value ? "jpg" : this.pngBox.value ? "png" : "pdf";
        var size = sizes.name(1080, 1080);
        var example = namer.build({ doc: "Poster", page: "01", pagename: "1", size: size, format: ext.toUpperCase() }, ext);
        this.preview.text = "Example: " + (Util.trim(this.outText.text) || "_Exports") + "/" + size + "/" + example +
            (namer.hasDocToken() ? "" : "   (tip: add {doc}, or pages of different documents get \"(2)\" names)");
    };

    Dashboard.prototype.outputRoot = function () {
        var root = this.settings.get("rootPath");
        if (!root) { return null; }
        return new Folder(root + "/" + Util.safeName(Util.trim(this.outText.text) || "_Exports"));
    };

    // Everything needed for a batch, or null (with the reason shown) if something is missing.
    Dashboard.prototype.makeJob = function (documents) {
        this.readSettings();
        var s = this.settings;
        var root = s.get("rootPath") ? new Folder(s.get("rootPath")) : null;
        if (!root || !root.exists) { this.say("Choose the root folder first (Folders > Choose...)."); return null; }
        var resolution = this.resolution();
        var exporters = [];
        if (this.pdfBox.value) {
            if (!this.presetList.selection) { this.say("Choose a PDF preset (or click Refresh)."); return null; }
            exporters.push(new PdfExporter(this.presetList.selection.text));
        }
        if ((this.jpegBox.value || this.pngBox.value) && !resolution) { this.say("The image resolution must be a number from 1 to 2400."); return null; }
        if (this.jpegBox.value) { exporters.push(new JpegExporter(resolution, s.get("jpegQuality"))); }
        if (this.pngBox.value) { exporters.push(new PngExporter(resolution, s.bool("pngTransparent"))); }
        if (!exporters.length) { this.say("Tick at least one format: PDF, JPEG or PNG."); return null; }
        s.save();
        return {
            outputRoot: this.outputRoot(),
            exporters: exporters,
            sizeNamer: new SizeNamer({ paperNames: s.bool("paperNames"), units: s.get("sizeUnits") }),
            fileNamer: new FileNamer(s.get("template")),
            overwrite: s.bool("overwrite"),
            documents: documents,
            waitForSettle: true
        };
    };

    Dashboard.prototype.runNow = function () {
        if (this.runner.busy) { this.say("An export is already running."); return; }
        this.readSettings();
        var docs = [];
        if (this.settings.get("source") === "active") {
            if (!app.documents.length) { this.say("Open a document first, or choose \"Every InDesign file in the root folder\"."); return; }
            docs.push({ doc: app.activeDocument });
        } else {
            var root = this.settings.get("rootPath") ? new Folder(this.settings.get("rootPath")) : null;
            if (!root || !root.exists) { this.say("Choose the root folder first (Folders > Choose...)."); return; }
            var files = findDocuments(root, this.outputRoot(), this.runner.guard);
            if (!files.length) { this.say("No InDesign files found in " + root.fsName); return; }
            for (var i = 0; i < files.length; i++) { docs.push({ file: files[i] }); }
        }
        var job = this.makeJob(docs);
        if (job) { this.execute(job, null); }
    };

    Dashboard.prototype.execute = function (job, afterDone) {
        var self = this;
        this.runBtn.enabled = false;
        this.progress.value = 0;
        this.runner.onProgress = function (i, n, text) {
            if (i >= 0 && n > 0) { self.progress.value = Math.round(100 * i / n); }
            if (text) { self.status.text = text; }
            try { self.win.update(); } catch (e) { /* keep going */ }
        };
        var before = { e: this.log.counts.error, w: this.log.counts.warning, lines: this.log.errors.length };
        var r = null;
        try {
            r = this.runner.run(job);
            if (afterDone) { afterDone(r); }
        } catch (e) {
            this.log.error("The export stopped: " + Util.errorText(e));
        } finally {
            this.runBtn.enabled = true;
        }
        var newErrors = this.log.counts.error - before.e;
        if (newErrors > 0) { this.phone("Size-sorted export needs a look", newErrors + " problem(s) in the last export:\n" +
            this.log.errors.slice(Math.max(0, this.log.errors.length - Math.min(newErrors, 8))).join("\n") +
            (newErrors > 8 ? "\n..." : "") + "\nDetails: the dashboard's log on " + PhoneAlert.computer() + "."); }
        if (r) {
            var errors = newErrors, warnings = this.log.counts.warning - before.w;
            this.log.info("Finished: " + r.exported + " file(s) exported" + (r.failed ? ", " + r.failed + " failed" : "") +
                (r.skipped ? ", " + r.skipped + " document(s) skipped (not ready yet)" : "") + ".");
            this.say(errors ? "Finished with " + errors + " problem(s): see the red X lines below."
                : warnings ? "Finished with " + warnings + " warning(s)." : "Finished: " + r.exported + " file(s) exported.");
        }
    };

    Dashboard.prototype.phone = function (title, body) {
        if (!this.alert) { return; }
        try {
            if (this.alert.send(title, body)) { this.log.info("Phone alert sent: " + title); }
        } catch (e) { this.log.warn("Couldn't send the phone alert: " + Util.errorText(e)); }
    };

    // At start-up: say whether problems reach the phone, and carry on watching if it was on.
    Dashboard.prototype.start = function () {
        if (this.alert && this.alert.available()) { this.log.info("Problems are also sent to your phone (export notifier channel)."); }
        else { this.log.info("Phone alerts are off: the InDesign export notifier isn't installed on this computer."); }
        if (this.settings.bool("watch")) {
            this.watchBox.value = true;
            this.toggleWatch();
        }
    };

    Dashboard.prototype.toggleWatch = function () {
        var self = this;
        this.settings.set("watch", this.watchBox.value);
        this.settings.save();
        if (!this.watchBox.value) {
            this.watcher.stop();
            this.log.info("Watching stopped.");
            return;
        }
        this.readSettings();
        var root = this.settings.get("rootPath") ? new Folder(this.settings.get("rootPath")) : null;
        if (!root || !root.exists) { this.watchBox.value = false; this.say("Choose the root folder first."); return; }
        var minutes = Number(this.settings.get("watchMinutes")) || 2;
        this.watcher.start(minutes, function () { self.watchTick(); });
        this.log.info("Watching " + root.fsName + " every " + minutes + " min. New or changed files are exported once they've finished syncing.");
        this.watchTick();
    };

    Dashboard.prototype.watchTick = function () {
        if (this.runner.busy) { return; }
        var root = new Folder(this.settings.get("rootPath"));
        if (!root.exists) {
            this.log.error("The root folder can't be reached: " + root.fsName + " (is Google Drive running?)");
            if (!this.rootDown) {          // once, not every few minutes
                this.rootDown = true;
                this.phone("Size-sorted export can't reach its folder", "Watching " + root.fsName + " on " + PhoneAlert.computer() +
                    ", but the folder can't be opened. Is Google Drive running and signed in? Exports continue by themselves once it's back.");
            }
            return;
        }
        if (this.rootDown) { this.rootDown = false; this.log.info("The root folder can be reached again."); }
        var due = this.watcher.due(findDocuments(root, this.outputRoot(), this.runner.guard));
        if (!due.length) { this.say("Watching. Last check " + Util.now() + ": nothing new."); return; }
        var docs = [];
        for (var i = 0; i < due.length; i++) { docs.push({ file: due[i] }); }
        var job = this.makeJob(docs);
        if (!job) { return; }
        job.waitForSettle = false;       // already unchanged since the previous check
        var watcher = this.watcher;
        this.execute(job, function (r) {
            for (var j = 0; j < r.done.length; j++) { watcher.markExported(r.done[j]); }
            watcher.save();
        });
    };

    // =====================================================================================
    // Start-up: one dashboard per InDesign session.
    // =====================================================================================
    NS.Util = Util;
    NS.Settings = Settings;
    NS.Log = Log;
    NS.SizeNamer = SizeNamer;
    NS.FileNamer = FileNamer;
    NS.FileGuard = FileGuard;
    NS.PdfExporter = PdfExporter;
    NS.JpegExporter = JpegExporter;
    NS.PngExporter = PngExporter;
    NS.BatchRunner = BatchRunner;
    NS.FolderWatcher = FolderWatcher;
    NS.findDocuments = findDocuments;
    NS.PhoneAlert = PhoneAlert;
    NS.Dashboard = Dashboard;

    if (global.__SIZE_SORTED_EXPORT_TEST__) { return; }       // tests load the classes only

    if (NS.dashboard && NS.dashboard.win) {
        try { NS.dashboard.win.show(); return; } catch (e) { NS.dashboard = null; }
    }
    var dataDir = new Folder(Folder.userData + "/SizeSortedExport");
    if (!dataDir.exists) { dataDir.create(); }
    var settings = new Settings(new File(dataDir + "/settings.txt"));
    settings.load();
    NS.log = new Log(new File(dataDir + "/export-log.txt"));
    var runner = new BatchRunner(NS.log);
    var watcher = new FolderWatcher(new File(dataDir + "/exported-files.txt"), NS.log);
    watcher.stop();      // a watch task left from an earlier dashboard in this session
    NS.dashboard = new Dashboard(settings, NS.log, runner, watcher, new PhoneAlert());
    var win = NS.dashboard.build();
    win.onShow = function () { NS.log.info(APP_NAME + " " + VERSION + " ready. Log file: " + NS.log.file.fsName); };
    win.show();
    NS.dashboard.start();

})($.global);
