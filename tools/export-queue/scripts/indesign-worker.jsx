/*
 * Export-queue actions inside Adobe InDesign. Run by run-indesign.ps1 through DoScript.
 *
 * Input:  a job file written by the Node server; its path is in app.scriptArgs "exportQueueJob".
 *         { action: "export" | "listPresets", resultPath, jobId, sourcePath, outputPath, format,
 *           pdfPreset, pageRange, useDocumentBleed, includeSlug, packageIncludeIdml,
 *           packageIncludePdf, failOnMissing, linkMappings: [{ from, to }] }
 * Output: a result file at job.resultPath:
 *         { ok, outputs: [{ path, bytes, kind }], warnings: [], error, indesignVersion, presets? }
 *
 * Dialogs are suppressed for the duration (missing fonts/links, profile mismatch...), so an
 * unattended export PC never waits for a click. The document is never saved.
 * ExtendScript is ES3: no JSON object, no Array map/indexOf.
 */
(function () {
    var TEMP_PRESET_PREFIX = "__export_queue_";
    var MAX_WARNINGS = 50;

    // ---------- JSON in and out (ES3 has no JSON object) ----------

    function quote(s) {
        var out = '"';
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i), code = s.charCodeAt(i);
            if (c === '"' || c === "\\") {
                out += "\\" + c;
            } else if (code < 0x20 || code === 0x2028 || code === 0x2029) {
                var hex = code.toString(16);
                out += "\\u" + "0000".substring(hex.length) + hex;
            } else {
                out += c;
            }
        }
        return out + '"';
    }

    function toJSON(v) {
        if (v === null || v === undefined) return "null";
        var t = typeof v;
        if (t === "number") return isFinite(v) ? String(v) : "null";
        if (t === "boolean") return v ? "true" : "false";
        if (t === "string") return quote(v);
        var parts = [], i;
        if (v instanceof Array) {
            for (i = 0; i < v.length; i++) parts.push(toJSON(v[i]));
            return "[" + parts.join(",") + "]";
        }
        for (var k in v) {
            if (v.hasOwnProperty(k)) parts.push(quote(k) + ":" + toJSON(v[k]));
        }
        return "{" + parts.join(",") + "}";
    }

    function readJob() {
        var jobPath = "";
        try {
            if (app.scriptArgs.isDefined("exportQueueJob")) jobPath = app.scriptArgs.getValue("exportQueueJob");
            app.scriptArgs.setValue("exportQueueJob", "");
        } catch (e) {}
        if (!jobPath) throw new Error("No job file was passed to the InDesign script.");
        var f = new File(jobPath);
        f.encoding = "UTF-8";
        if (!f.open("r")) throw new Error("Cannot open the job file " + jobPath);
        var text = f.read();
        f.close();
        // Written by the export server with JSON.stringify (a subset of ES3 literals).
        return eval("(" + text + ")");
    }

    function writeResult(path, result) {
        var f = new File(path);
        f.encoding = "UTF-8";
        f.lineFeed = "Unix";
        if (!f.open("w")) throw new Error("Cannot write the result file " + path);
        f.write(toJSON(result));
        f.close();
    }

    function describeError(e) {
        var msg = (e && e.message) ? e.message : String(e);
        if (e && e.number && !(e.message && e.message.indexOf("(error ") >= 0)) msg += " (InDesign error " + e.number + ")";
        return msg;
    }

    // ---------- helpers ----------

    function warn(result, message) {
        if (result.warnings.length < MAX_WARNINGS) result.warnings.push(message);
        else if (result.warnings.length === MAX_WARNINGS) result.warnings.push("... and more (list shortened)");
    }

    function presetNames() {
        var names = [], presets = app.pdfExportPresets;
        for (var i = 0; i < presets.length; i++) {
            var n = presets[i].name;
            if (n.indexOf(TEMP_PRESET_PREFIX) !== 0) names.push(n);
        }
        return names;
    }

    // Temp presets left behind if InDesign was killed mid-export.
    function removeLeftoverTempPresets() {
        var presets = app.pdfExportPresets;
        for (var i = presets.length - 1; i >= 0; i--) {
            try {
                if (presets[i].name.indexOf(TEMP_PRESET_PREFIX) === 0) presets[i].remove();
            } catch (e) {}
        }
    }

    function requirePreset(name) {
        var preset = app.pdfExportPresets.itemByName(name);
        if (!preset.isValid) {
            throw new Error('The PDF preset "' + name + '" is not installed on the export PC. Installed presets: ' + presetNames().join(", "));
        }
        return preset;
    }

    // Copies every writable setting of a preset. Two passes, because some settings are only
    // accepted after another one is set (e.g. PDF/X output intent after the standard).
    function copySettings(from, to) {
        var skip = { name: 1, id: 1, index: 1, parent: 1, isValid: 1, properties: 1, events: 1, eventListeners: 1 };
        var props = from.properties;
        for (var pass = 0; pass < 2; pass++) {
            for (var k in props) {
                if (!props.hasOwnProperty(k) || skip[k]) continue;
                try { to[k] = props[k]; } catch (e) { /* read-only or not applicable */ }
            }
        }
    }

    function setPageRange(prefs, range) {
        prefs.pageRange = (!range || range === "all") ? PageRange.ALL_PAGES : range;
    }

    function resetPageRanges() {
        try { app.pdfExportPreferences.pageRange = PageRange.ALL_PAGES; } catch (e) {}
        try { app.interactivePDFExportPreferences.pageRange = PageRange.ALL_PAGES; } catch (e) {}
    }

    // File.name is URI-encoded in ExtendScript ("Poster%20A1.indd").
    function fileLabel(f) {
        try { return decodeURI(f.name); } catch (e) { return String(f.name); }
    }

    // Opens the document from disk, never a copy that is already open on the export PC: that one
    // may be older than the file the designer saved since, or hold edits nobody saved.
    // InDesign returns the open document when asked to open a file that is open already, also
    // under another spelling of its path (M:\... vs \\server\share\...), so ids are compared.
    function openFresh(src) {
        var before = {}, i;
        for (i = 0; i < app.documents.length; i++) {
            try { before[app.documents[i].id] = true; } catch (e) {}
        }
        var doc = app.open(src, false);
        if (!before[doc.id]) return doc;
        if (doc.modified) {
            throw new Error(fileLabel(src) + " is open on the export PC with unsaved changes. Close it there, then run the export again.");
        }
        doc.close(SaveOptions.NO);        // nothing is lost: it had no unsaved changes
        return app.open(src, false);
    }

    // ---------- links placed on a Mac ----------

    function startsWithNoCase(s, prefix) {
        return s.length >= prefix.length && s.substring(0, prefix.length).toLowerCase() === prefix.toLowerCase();
    }

    // The folder names after `from`, or null if `linkPath` isn't under it. A Mac mounts a second
    // connection to the same share as "/Volumes/Share-1", so "-1" style suffixes match too.
    function restAfter(linkPath, from) {
        var s = linkPath, sepRe, style;
        if (/^smb:\/\//i.test(from)) {
            try { s = decodeURIComponent(s); } catch (e) {}
            style = "url";
        } else if (/^[A-Za-z]:$/.test(from)) {
            style = "windows";
        } else if (/:$/.test(from)) {
            style = "hfs";                     // old-style Mac path: "Share:folder:file.psd"
        } else {
            style = "posix";
        }
        if (style !== "hfs") { s = s.replace(/\\/g, "/"); from = from.replace(/\\/g, "/"); }
        if (!startsWithNoCase(s, style === "hfs" ? from.substring(0, from.length - 1) : from)) return null;
        var after = s.substring(style === "hfs" ? from.length - 1 : from.length);
        var suffix = /^-\d{1,3}(?=[:\/]|$)/.exec(after);
        if (suffix && (style === "hfs" || /^\/volumes\//i.test(from))) after = after.substring(suffix[0].length);
        sepRe = style === "hfs" ? /^:/ : /^\//;
        if (!sepRe.test(after)) return null;
        var parts = after.substring(1).split(style === "hfs" ? ":" : "/"), out = [];
        for (var i = 0; i < parts.length; i++) {
            if (parts[i] === "..") return null;
            if (parts[i] !== "") out.push(parts[i]);
        }
        return out.length ? { parts: out, mac: style !== "windows" && !/^\/\//.test(from) } : null;
    }

    // Missing links whose file is on a client drive under another name (e.g. placed on a Mac as
    // /Volumes/MG_Mega/...) are pointed at the export PC's copy. Only the unsaved copy in
    // InDesign's memory changes; the document is closed without saving.
    function relinkMovedLinks(doc, job, result) {
        var mappings = job.linkMappings || [], relinked = 0;
        if (!mappings.length) return 0;
        var links = doc.links;
        for (var i = 0; i < links.length; i++) {
            var link = links[i];
            try {
                if (link.status != LinkStatus.LINK_MISSING) continue;
                var linkPath = String(link.filePath);
                for (var m = 0; m < mappings.length; m++) {
                    var rest = restAfter(linkPath, String(mappings[m].from));
                    if (!rest) continue;
                    var to = String(mappings[m].to).replace(/[\\\/]+$/, "");
                    var sep = to.indexOf("\\") >= 0 ? "\\" : "/";
                    var file = new File(to + sep + rest.parts.join(sep));
                    if (!file.exists) continue;
                    link.relink(file);
                    try { if (link.status == LinkStatus.LINK_OUT_OF_DATE) link.update(); } catch (e) {}
                    warn(result, "Relinked " + link.name + (rest.mac ? " (placed on a Mac)" : " (placed from another computer)"));
                    relinked++;
                    break;
                }
            } catch (e) { /* leave it missing: reported by checkDocument */ }
        }
        return relinked;
    }

    // Warnings for missing/modified links and missing fonts. Returns how many are missing.
    function checkDocument(doc, result) {
        var missing = 0, i;
        var links = doc.links;
        for (i = 0; i < links.length; i++) {
            try {
                var s = links[i].status;
                if (s == LinkStatus.LINK_MISSING || s == LinkStatus.LINK_INACCESSIBLE) {
                    warn(result, "Missing link: " + links[i].name);
                    missing++;
                } else if (s == LinkStatus.LINK_OUT_OF_DATE) {
                    warn(result, "Modified link (exported as last placed): " + links[i].name);
                }
            } catch (e) {}
        }
        var fonts = doc.fonts;
        for (i = 0; i < fonts.length; i++) {
            try {
                var fs = fonts[i].status;
                if (fs == FontStatus.NOT_AVAILABLE || fs == FontStatus.SUBSTITUTED) {
                    warn(result, "Missing font: " + String(fonts[i].name).replace(/\t/g, " "));
                    missing++;
                }
            } catch (e) {}
        }
        return missing;
    }

    // ---------- export formats ----------

    function exportPrintPdf(doc, job, state) {
        var preset = requirePreset(job.pdfPreset);
        // Built-in presets are locked, so bleed/slug are applied to a temporary copy.
        state.tempPreset = app.pdfExportPresets.add({ name: TEMP_PRESET_PREFIX + new Date().getTime() });
        copySettings(preset, state.tempPreset);
        state.tempPreset.useDocumentBleedWithPDF = job.useDocumentBleed;
        if (!job.useDocumentBleed) {
            state.tempPreset.bleedTop = 0;
            state.tempPreset.bleedBottom = 0;
            state.tempPreset.bleedInside = 0;
            state.tempPreset.bleedOutside = 0;
        }
        state.tempPreset.includeSlugWithPDF = job.includeSlug;
        setPageRange(app.pdfExportPreferences, job.pageRange);
        doc.exportFile(ExportFormat.PDF_TYPE, new File(job.outputPath), false, state.tempPreset);
    }

    function exportInteractivePdf(doc, job) {
        setPageRange(app.interactivePDFExportPreferences, job.pageRange);
        doc.exportFile(ExportFormat.INTERACTIVE_PDF, new File(job.outputPath), false);
    }

    function packageDocument(doc, job) {
        var folder = new Folder(job.outputPath);
        if (!folder.exists && !folder.create()) throw new Error("Could not create the package folder " + job.outputPath);
        var pdfStyle = job.packageIncludePdf ? requirePreset(job.pdfPreset).name : "";
        var ok = doc.packageForPrint(
            folder,
            true,                        // copying fonts
            true,                        // copying linked graphics
            false,                       // copying color profiles
            true,                        // updating graphics links in the package
            false,                       // including fonts/links from hidden layers
            true,                        // ignore preflight errors (reported as warnings instead)
            true,                        // create instructions report
            !!job.packageIncludeIdml,
            !!job.packageIncludePdf,
            pdfStyle,
            false,                       // document hyphenation exceptions only
            "",                          // version comments
            false                        // force save
        );
        if (ok === false) {
            throw new Error("InDesign reported that packaging failed." + (job.relinked
                ? " " + job.relinked + " image(s) placed on a Mac had been relinked first, which InDesign may want saved; ask for the document to be relinked and saved, then package again."
                : ""));
        }
    }

    function requireFields(job, names) {
        for (var i = 0; i < names.length; i++) {
            var v = job[names[i]];
            if (typeof v !== "string" || v === "") throw new Error("The job is missing \"" + names[i] + "\" (sent by the export server).");
        }
    }

    function runExport(job, result) {
        requireFields(job, ["sourcePath", "outputPath", "format"]);
        if (job.format === "pdf-print" || job.packageIncludePdf) requireFields(job, ["pdfPreset"]);
        var src = new File(job.sourcePath);
        if (!src.exists) throw new Error("The source file doesn't exist: " + job.sourcePath);
        removeLeftoverTempPresets();

        var out = job.format === "package" ? new Folder(job.outputPath) : new File(job.outputPath);
        var modifiedBefore = (job.format !== "package" && out.exists) ? out.modified.getTime() : null;

        var doc = null, state = { tempPreset: null };
        try {
            doc = openFresh(src);
            job.relinked = relinkMovedLinks(doc, job, result);

            var missing = checkDocument(doc, result);
            if (job.failOnMissing && missing > 0) {
                throw new Error("The document has " + missing + " missing link(s)/font(s) (see warnings), so it was not exported.");
            }

            if (job.format === "pdf-print") exportPrintPdf(doc, job, state);
            else if (job.format === "pdf-interactive") exportInteractivePdf(doc, job);
            else if (job.format === "idml") doc.exportFile(ExportFormat.INDESIGN_MARKUP, new File(job.outputPath), false);
            else if (job.format === "package") packageDocument(doc, job);
            else throw new Error("Unknown output format: " + job.format);
        } finally {
            if (state.tempPreset) { try { state.tempPreset.remove(); } catch (e) {} }
            resetPageRanges();
            if (doc) {
                try { doc.close(SaveOptions.NO); } catch (e) { warn(result, "InDesign could not close the document: " + describeError(e)); }
            }
        }

        // Never report success unless the output really exists (and was rewritten).
        if (job.format === "package") {
            if (!out.exists || out.getFiles().length === 0) throw new Error("InDesign finished, but the package folder is missing or empty: " + job.outputPath);
            result.outputs.push({ path: out.fsName, bytes: 0, kind: "folder" });
        } else {
            out = new File(job.outputPath);
            if (!out.exists) throw new Error("InDesign finished, but no file was written to " + job.outputPath);
            if (modifiedBefore !== null && out.modified.getTime() === modifiedBefore) {
                throw new Error("InDesign finished, but the existing file was not replaced: " + job.outputPath);
            }
            result.outputs.push({ path: out.fsName, bytes: out.length, kind: "file" });
        }
    }

    // ---------- main ----------

    var job = readJob();   // a problem here is thrown to DoScript, so the bridge reports it
    var result = { ok: false, outputs: [], warnings: [], error: null, indesignVersion: String(app.version) };
    var savedInteraction = app.scriptPreferences.userInteractionLevel;
    try {
        app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
        if (job.action === "listPresets") {
            result.presets = presetNames();
        } else {
            runExport(job, result);
        }
        result.ok = true;
    } catch (e) {
        result.ok = false;
        result.error = describeError(e);
    } finally {
        try { app.scriptPreferences.userInteractionLevel = savedInteraction; } catch (e) {}
    }
    writeResult(job.resultPath, result);
})();
