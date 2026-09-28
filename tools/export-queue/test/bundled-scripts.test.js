// The InDesign script that Install.cmd puts into InDesign must be the latest version from
// tools/indesign-size-export (its source and tests live there).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const here = path.join(import.meta.dirname, "..", "indesign-scripts", "SizeSortedExport.jsx");
const source = path.join(import.meta.dirname, "..", "..", "indesign-size-export", "SizeSortedExport.jsx");

test("indesign-scripts/SizeSortedExport.jsx is the same as tools/indesign-size-export/SizeSortedExport.jsx", { skip: !fs.existsSync(source) && "source not in this checkout" }, () => {
    assert.equal(fs.readFileSync(here, "utf8"), fs.readFileSync(source, "utf8"),
        "copy the new version: cp ../indesign-size-export/SizeSortedExport.jsx indesign-scripts/");
});
