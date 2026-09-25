// Validation of job submissions. Everything a designer sends is checked here; the result is
// the only shape the worker and the InDesign script ever see.

export const FORMATS = {
    "pdf-print": { label: "PDF (Print)", extension: ".pdf", usesPreset: true, usesPageRange: true, usesBleed: true },
    "pdf-interactive": { label: "PDF (Interactive)", extension: ".pdf", usesPreset: false, usesPageRange: true, usesBleed: false },
    "idml": { label: "IDML", extension: ".idml", usesPreset: false, usesPageRange: false, usesBleed: false },
    "package": { label: "Package", extension: "", usesPreset: false, usesPageRange: false, usesBleed: false },
};

export class ValidationError extends Error {
    constructor(errors, pathErrors) {
        const messages = Object.values(errors);
        super(messages.length === 1 ? messages[0] : "Please fix the highlighted fields.");
        this.errors = errors;           // { field: message }
        this.pathErrors = pathErrors;   // [{ index, input, message }] for a list of files, or undefined
    }
}

const PAGE_RANGE = /^[A-Za-z0-9+\-,.:\s]{1,200}$/;

function text(value, max) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") return null;
    const v = value.trim();
    return v.length > max ? null : v;
}

function bool(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "on") return true;
    if (value === "false" || value === "off") return false;
    return null;
}

export const MAX_FILES = 50;
export const MAX_FORMATS = Object.keys(FORMATS).length;

export function presetNotInstalled(name) {
    return `"${name}" isn't installed on the export PC. Choose one from the list.`;
}

// Checks everything in a submission except whether the files exist (that needs the disk, see
// api.js). Never throws for a designer's mistake: it returns every problem at once, so the
// form can show them all together.
//   { errors, submittedBy, sources: [{ index, input }], sourceField, formats, formatField,
//     paramsByFormat: { format: params }, pathErrors: [{ index, input, message }] }
// `installedPresets`: the export PC's preset list, if known (empty = don't check).
export function checkSubmission(body, { installedPresets = [] } = {}) {
    const errors = {};
    const pathErrors = [];
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return { errors: { form: "The request was not a job." }, pathErrors, sources: [], formats: [], paramsByFormat: {} };
    }

    // One path (v1 form, "sourcePath") or several ("sourcePaths", one per line in the form).
    const sourceField = body.sourcePaths !== undefined ? "sourcePaths" : "sourcePath";
    const sources = [];
    if (sourceField === "sourcePaths" && !Array.isArray(body.sourcePaths)) {
        errors.sourcePaths = "Send the file paths as a list.";
    } else {
        const list = sourceField === "sourcePaths" ? body.sourcePaths : [body.sourcePath];
        list.forEach((value, index) => {
            if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return;   // blank line
            if (typeof value !== "string") return pathErrors.push({ index, input: "", message: "Enter a path." });
            const input = text(value, 1024);
            if (input === null) pathErrors.push({ index, input: value.slice(0, 200), message: "That path is too long." });
            else sources.push({ index, input });
        });
        if (!sources.length && !pathErrors.length) errors[sourceField] = "Enter the path of the .indd file on the network drive.";
        else if (sources.length + pathErrors.length > MAX_FILES) errors[sourceField] = `You can add up to ${MAX_FILES} files at once.`;
    }

    const submittedBy = text(body.submittedBy, 80);
    if (!submittedBy) errors.submittedBy = "Enter your name so the team knows whose export this is.";

    const formatField = body.formats !== undefined ? "formats" : "format";
    const requested = formatField === "formats" ? body.formats : [body.format];
    let formats = [];
    if (!Array.isArray(requested) || requested.length === 0 || requested.length > MAX_FORMATS ||
        !requested.every((f) => typeof f === "string" && FORMATS[f])) {
        errors[formatField] = "Choose an output format.";
    } else if (new Set(requested).size !== requested.length) {
        errors[formatField] = "Each format can only be chosen once.";
    } else {
        formats = requested;
    }
    const specs = formats.map((f) => FORMATS[f]);

    const preset = text(body.pdfPreset, 200);
    if (preset === null) errors.pdfPreset = "The preset name is too long.";
    const includePdfInPackage = bool(body.packageIncludePdf, false);
    const needsPreset = specs.some((spec) => spec.usesPreset) || (formats.includes("package") && includePdfInPackage);
    if (needsPreset && preset !== null) {
        if (!preset) errors.pdfPreset = "Choose or type the Adobe PDF preset, e.g. [High Quality Print].";
        else if (installedPresets.length && !installedPresets.includes(preset)) errors.pdfPreset = presetNotInstalled(preset);
    }

    let pageRange = "all";
    if (specs.some((spec) => spec.usesPageRange)) {
        const range = text(body.pageRange, 200);
        if (range === null) errors.pageRange = "The page range is too long.";
        else if (range && !/^all$/i.test(range)) {
            if (!PAGE_RANGE.test(range)) errors.pageRange = "Use page numbers like 1-4, 7, 10-12 (or \"All\").";
            else pageRange = range.replace(/\s+/g, " ");
        }
    }

    const bleed = bool(body.useDocumentBleed, true);
    const slug = bool(body.includeSlug, false);
    if (specs.some((spec) => spec.usesBleed)) {
        if (bleed === null) errors.useDocumentBleed = "Invalid value.";
        if (slug === null) errors.includeSlug = "Invalid value.";
    }

    const idml = bool(body.packageIncludeIdml, true);
    if (formats.includes("package")) {
        if (idml === null) errors.packageIncludeIdml = "Invalid value.";
        if (includePdfInPackage === null) errors.packageIncludePdf = "Invalid value.";
    }

    const outputFolder = text(body.outputFolder, 1024);
    if (outputFolder === null) errors.outputFolder = "The output folder path is too long.";

    const overwrite = bool(body.overwrite, false);
    const failOnMissing = bool(body.failOnMissing, false);
    if (overwrite === null) errors.overwrite = "Invalid value.";
    if (failOnMissing === null) errors.failOnMissing = "Invalid value.";

    // Each job only carries the options its own format uses.
    const paramsByFormat = {};
    for (const format of formats) {
        const spec = FORMATS[format];
        const params = { format };
        if (spec.usesPreset || (format === "package" && includePdfInPackage)) params.pdfPreset = preset || "";
        if (spec.usesPageRange) params.pageRange = pageRange;
        if (spec.usesBleed) {
            params.useDocumentBleed = bleed;
            params.includeSlug = slug;
        }
        if (format === "package") {
            params.packageIncludeIdml = idml;
            params.packageIncludePdf = includePdfInPackage;
        }
        params.outputFolderInput = outputFolder || "";
        params.overwrite = overwrite;
        params.failOnMissing = failOnMissing;
        paramsByFormat[format] = params;
    }

    return { errors, pathErrors, submittedBy, sources, sourceField, formats, formatField, paramsByFormat, outputFolder: outputFolder || "" };
}

// Single-file, single-format form of checkSubmission that throws (kept for callers and tests
// that only deal with one job). Returns { sourceInput, submittedBy, format, params }.
export function validateSubmission(body, options) {
    const r = checkSubmission(body, options);
    const errors = { ...r.errors };
    if (r.pathErrors.length) errors[r.sourceField ?? "sourcePath"] = r.pathErrors[0].message;
    if (Object.keys(errors).length) throw new ValidationError(errors);
    const format = r.formats[0];
    return { sourceInput: r.sources[0].input, submittedBy: r.submittedBy, format, params: r.paramsByFormat[format] };
}
