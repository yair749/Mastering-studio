import assert from "node:assert/strict";
import { test } from "node:test";
import { PathError, createPathResolver } from "../src/paths.js";

// Windows rules, as on the export PC (these tests don't touch the disk).
const win = createPathResolver({
    platform: "win32",
    allowedRoots: ["\\\\NAS\\Projects", "P:\\", "\\\\NAS\\Studio\\Shared"],
    pathMappings: [
        { from: "/Volumes/Projects", to: "\\\\NAS\\Projects" },
        { from: "/Volumes/Projects/Archive", to: "\\\\NAS\\Archive" },
        { from: "smb://nas/Projects", to: "\\\\NAS\\Projects" },
        { from: "Z:\\", to: "\\\\NAS\\Projects\\" },
    ],
});
const resolve = (input) => win.resolve(input, "sourcePath", { extension: ".indd" });
const rejects = (input, pattern) => assert.throws(() => resolve(input), (e) => e instanceof PathError && pattern.test(e.message));

test("UNC and drive paths inside the allowed roots are accepted", () => {
    assert.equal(resolve("\\\\NAS\\Projects\\Client\\Poster.indd"), "\\\\NAS\\Projects\\Client\\Poster.indd");
    assert.equal(resolve("P:\\Jobs\\Flyer.indd"), "P:\\Jobs\\Flyer.indd");
    assert.equal(resolve("\\\\nas\\projects\\Client\\Poster.indd"), "\\\\nas\\projects\\Client\\Poster.indd", "case-insensitive");
});

test("Mac, smb:// and other-drive-letter paths are mapped", () => {
    assert.equal(resolve("/Volumes/Projects/Client A/Poster.indd"), "\\\\NAS\\Projects\\Client A\\Poster.indd");
    assert.equal(resolve("smb://nas/Projects/Client%20A/Poster.indd"), "\\\\NAS\\Projects\\Client A\\Poster.indd");
    assert.equal(resolve("Z:\\Client\\Poster.indd"), "\\\\NAS\\Projects\\Client\\Poster.indd");
    assert.equal(resolve("/volumes/projects/Client/Poster.indd"), "\\\\NAS\\Projects\\Client\\Poster.indd", "case-insensitive mapping");
});

test("a second macOS mount of the same share (/Volumes/Share-1) is mapped too", () => {
    assert.equal(resolve("/Volumes/Projects-1/Client/Poster.indd"), "\\\\NAS\\Projects\\Client\\Poster.indd");
    assert.equal(resolve("/Volumes/Projects-12/Poster.indd"), "\\\\NAS\\Projects\\Poster.indd");
    rejects("/Volumes/Projects-Old/Poster.indd", /doesn't have a drive called “Projects-Old”/);        // a different share, not a re-mount
    rejects("/Volumes/Projects2/Poster.indd", /doesn't have a drive called “Projects2”/);
});

test("the longest matching mapping wins, then the root check applies", () => {
    rejects("/Volumes/Projects/Archive/Old.indd", /isn't on one of the client drives/);   // maps to \\NAS\Archive, not allowed
});

test("quoted 'Copy as path' values and file:// URLs are cleaned up", () => {
    assert.equal(resolve('"\\\\NAS\\Projects\\Client\\Poster.indd"'), "\\\\NAS\\Projects\\Client\\Poster.indd");
    assert.equal(resolve("file:///P:/Jobs/Some%20File.indd"), "P:\\Jobs\\Some File.indd");
});

test("paths outside the roots, relative paths and traversal are refused", () => {
    rejects("C:\\Windows\\System32\\evil.indd", /your own computer/);
    rejects("\\\\NAS\\Studio\\Shared\\..\\Private\\x.indd", /"\.\."/);
    rejects("/Volumes/Projects/../../Studio/Private/x.indd", /"\.\."/);
    rejects("\\\\NAS\\ProjectsEvil\\x.indd", /doesn't have a drive called “ProjectsEvil” on “NAS”/);
    rejects("Client\\Poster.indd", /isn't a full path/);
    rejects("/Users/dana/Desktop/Poster.indd", /your own computer/);
    rejects("Poster.indd", /only the file name/);
    rejects("G:\\Client\\Poster.indd", /Drive G: isn't one of the export PC's drives/);
});

test("wrong extension, bad characters and empty input are refused", () => {
    rejects("\\\\NAS\\Projects\\Client\\Poster.pdf", /\.indd/);
    rejects("\\\\NAS\\Projects\\Client\\Pos<ter.indd", /characters/);
    rejects("   ", /Enter a path/);
});
