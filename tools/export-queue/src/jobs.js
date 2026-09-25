// Validation of job submissions. Everything a designer sends is checked here; the result is
// the only shape the worker and the InDesign script ever see.

export const FORMATS = {
    "pdf-print": { label: "PDF (Print)", extension: ".pdf", usesPreset: true, usesPageRange: true, usesBleed: true },
    "pdf-interactive": { label: "PDF (Interactive)", extension: ".pdf", usesPreset: false, usesPageRange: true, usesBleed: false },
    "idml": { label: "IDML", extension: ".idml", usesPreset: false, usesPageRange: false, usesBleed: false },
    "package": { label: "Package", extension: "", usesPreset: false, usesPageRange: false, usesBleed: false },
};

export class ValidationError extends Error {
    constructor(errors) {
        super("Please fix the highlighted fields.");
        this.errors = errors;           // { field: message }
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

// Returns { sourceInput, submittedBy, format, params } or throws ValidationError.
export function validateSubmission(body) {
    const errors = {};
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new ValidationError({ form: "The request was not a job." });
    }

    const sourceInput = text(body.sourcePath, 1024);
    if (!sourceInput) errors.sourcePath = "Enter the path of the .indd file on the network drive.";

    const submittedBy = text(body.submittedBy, 80);
    if (!submittedBy) errors.submittedBy = "Enter your name so the team knows whose export this is.";

    const format = typeof body.format === "string" ? body.format : "";
    const spec = FORMATS[format];
    if (!spec) errors.format = "Choose an output format.";

    const params = { format };

    const preset = text(body.pdfPreset, 200);
    if (preset === null) errors.pdfPreset = "The preset name is too long.";
    const includePdfInPackage = bool(body.packageIncludePdf, false);

    if (spec?.usesPreset || (format === "package" && includePdfInPackage)) {
        if (!preset) errors.pdfPreset = "Choose or type the Adobe PDF preset, e.g. [High Quality Print].";
        else params.pdfPreset = preset;
    }

    if (spec?.usesPageRange) {
        const range = text(body.pageRange, 200);
        if (range === null) errors.pageRange = "The page range is too long.";
        else if (!range || /^all$/i.test(range)) params.pageRange = "all";
        else if (!PAGE_RANGE.test(range)) errors.pageRange = "Use page numbers like 1-4, 7, 10-12 (or \"All\").";
        else params.pageRange = range.replace(/\s+/g, " ");
    }

    if (spec?.usesBleed) {
        const bleed = bool(body.useDocumentBleed, true);
        const slug = bool(body.includeSlug, false);
        if (bleed === null) errors.useDocumentBleed = "Invalid value.";
        if (slug === null) errors.includeSlug = "Invalid value.";
        params.useDocumentBleed = bleed;
        params.includeSlug = slug;
    }

    if (format === "package") {
        const idml = bool(body.packageIncludeIdml, true);
        if (idml === null) errors.packageIncludeIdml = "Invalid value.";
        if (includePdfInPackage === null) errors.packageIncludePdf = "Invalid value.";
        params.packageIncludeIdml = idml;
        params.packageIncludePdf = includePdfInPackage;
    }

    const outputFolder = text(body.outputFolder, 1024);
    if (outputFolder === null) errors.outputFolder = "The output folder path is too long.";
    params.outputFolderInput = outputFolder || "";

    const overwrite = bool(body.overwrite, false);
    const failOnMissing = bool(body.failOnMissing, false);
    if (overwrite === null) errors.overwrite = "Invalid value.";
    if (failOnMissing === null) errors.failOnMissing = "Invalid value.";
    params.overwrite = overwrite;
    params.failOnMissing = failOnMissing;

    if (Object.keys(errors).length) throw new ValidationError(errors);
    return { sourceInput, submittedBy, format, params };
}
