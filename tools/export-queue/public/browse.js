// "Browse…" dialog: lists the client drives as the export PC sees them (GET /api/browse), so
// designers can pick .indd files (or an output folder) without copying paths. Every path it
// returns came from the server, so it always resolves to exactly the file the export PC opens.
import { agoShort, formatBytes, plural } from "./util.js";

const RECENT_MAX = 6;

export function createBrowser({ api, local, el, now, announce, onFiles, onFolder }) {
    const dialog = document.getElementById("browseDialog");
    const title = document.getElementById("browseTitle");
    const crumbsEl = document.getElementById("browseCrumbs");
    const tools = document.getElementById("browseTools");
    const filter = document.getElementById("browseFilter");
    const body = document.getElementById("browseBody");
    const status = document.getElementById("browseStatus");
    const okBtn = document.getElementById("browseOk");
    const sortButtons = [...dialog.querySelectorAll("[data-sort]")];

    let mode = "files";             // "files" | "folder"
    let listing = null;             // current /api/browse?path= response, or null on the start screen
    let selected = new Map();       // path → { folder, folderLabel } (kept while moving between folders)
    let sort = local.get("browseSort", "name") === "newest" ? "newest" : "name";
    let request = 0;
    let controller = null;
    let filterTimer = null;
    let lastLoad = null;            // () => Promise, for "Try again"
    let listingQuery = "";          // the ?q= the current listing was fetched with

    const labelOf = (l) => (l?.crumbs?.length ? l.crumbs.map((c) => c.name).join(" › ") : l?.drive?.name || "");

    function recentFolders() {
        const list = local.get("recentFolders", []);
        return Array.isArray(list) ? list.filter((r) => r && typeof r.path === "string" && typeof r.label === "string") : [];
    }

    function rememberFolder(path, label) {
        const list = recentFolders().filter((r) => r.path !== path);
        list.unshift({ path, label });
        local.set("recentFolders", list.slice(0, RECENT_MAX));
    }

    // ------------------------------------------------------------ loading

    async function load(path, { q = "", focusList = true } = {}) {
        controller?.abort();
        controller = new AbortController();
        const mine = ++request;
        lastLoad = () => load(path, { q, focusList });
        if (!listing || listing.path !== path) showMessage(path ? "Opening the folder…" : "Loading the client drives…", { busy: true });
        body.setAttribute("aria-busy", "true");
        try {
            const query = path ? `?path=${encodeURIComponent(path)}${q ? `&q=${encodeURIComponent(q)}` : ""}` : "";
            const data = await api(`/browse${query}`, { signal: controller.signal });
            if (mine !== request) return;
            if (path) {
                listing = data;
                listingQuery = q;
                renderListing({ focusList });
            } else {
                listing = null;
                renderStart(data.roots || [], { focusList });
            }
        } catch (err) {
            if (err.name === "AbortError" || mine !== request) return;
            showMessage(err.message, { retry: true });
        } finally {
            if (mine === request) body.removeAttribute("aria-busy");
        }
    }

    function showMessage(text, { busy = false, retry = false } = {}) {
        const box = el("div", { class: `browse-message${busy ? " busy" : ""}` }, el("p", { text }));
        if (retry) {
            box.append(el("div", { class: "browse-message-actions" },
                el("button", { type: "button", class: "btn btn-small", text: "Try again", onclick: () => lastLoad?.() }),
                el("button", { type: "button", class: "btn btn-small btn-ghost", text: "Back to the client drives", onclick: () => goStart() })));
        }
        body.replaceChildren(box);
        if (retry) announce(text);
    }

    function goStart() {
        filter.value = "";
        listing = null;
        renderCrumbs(null);
        tools.hidden = true;
        updateFooter();
        load("");
    }

    // ------------------------------------------------------------ start screen

    function renderStart(roots, { focusList }) {
        renderCrumbs(null);
        tools.hidden = true;
        const parts = [];
        const recent = recentFolders();
        if (recent.length) {
            parts.push(el("h3", { class: "browse-section", text: "Recent folders" }),
                el("ul", { class: "browse-list" }, recent.map((r) => el("li", {},
                    el("button", { type: "button", class: "row folder-row", onclick: () => load(r.path) },
                        el("span", { class: "row-icon icon-folder", "aria-hidden": "true" }),
                        el("span", { class: "row-name", text: r.label }))))));
        }
        parts.push(el("h3", { class: "browse-section", text: "Client drives" }));
        if (!roots.length) {
            parts.push(el("p", { class: "hint", text: "The export PC has no client drives set up. Ask the owner to run the installer again after connecting the drives." }));
        } else {
            parts.push(el("ul", { class: "drive-grid" }, roots.map((root) => {
                const down = root.ok === false;
                return el("li", {}, el("button", {
                    type: "button", class: `drive${down ? " drive-down" : ""}`, onclick: () => load(root.path),
                    title: root.path,
                }, el("span", { class: "row-icon icon-drive", "aria-hidden": "true" }),
                el("span", { class: "drive-name", text: root.name }),
                down ? el("span", { class: "drive-note", text: "not reachable" }) : null));
            })));
        }
        body.replaceChildren(...parts);
        updateFooter();
        if (focusList) body.querySelector("button")?.focus();
    }

    // ------------------------------------------------------------ folder view

    function renderCrumbs(data) {
        const items = [el("li", {}, data
            ? el("button", { type: "button", class: "crumb", text: "Client drives", onclick: goStart })
            : el("span", { class: "crumb current", "aria-current": "location", text: "Client drives" }))];
        for (const [i, c] of (data?.crumbs || []).entries()) {
            const last = i === data.crumbs.length - 1;
            items.push(el("li", {}, last
                ? el("span", { class: "crumb current", "aria-current": "location", text: c.name })
                : el("button", { type: "button", class: "crumb", text: c.name, onclick: () => { filter.value = ""; load(c.path); } })));
        }
        crumbsEl.replaceChildren(...items);
    }

    function visibleEntries() {
        const needle = filter.value.trim().toLowerCase();
        const match = (e) => !needle || e.name.toLowerCase().includes(needle);
        const folders = (listing.folders || []).filter(match);
        let files = mode === "files" ? (listing.files || []).filter(match) : [];
        if (sort === "newest") files = [...files].sort((a, b) => (b.modified || 0) - (a.modified || 0));
        return { folders, files };
    }

    function renderListing({ focusList = false } = {}) {
        renderCrumbs(listing);
        tools.hidden = false;
        for (const b of sortButtons) {
            b.setAttribute("aria-pressed", String(b.dataset.sort === sort));
            b.disabled = mode !== "files";
        }
        const { folders, files } = visibleEntries();
        const folderLabel = labelOf(listing);
        const rows = [];
        for (const f of folders) {
            rows.push(el("li", {}, el("button", {
                type: "button", class: "row folder-row", onclick: () => { filter.value = ""; load(f.path); },
            }, el("span", { class: "row-icon icon-folder", "aria-hidden": "true" }), el("span", { class: "row-name", text: f.name }))));
        }
        for (const f of files) {
            const box = el("input", { type: "checkbox", checked: selected.has(f.path) });
            box.addEventListener("change", () => {
                if (box.checked) selected.set(f.path, { folder: listing.path, folderLabel });
                else selected.delete(f.path);
                updateFooter();
                syncSelectAll();
            });
            const meta = [f.modified ? `saved ${agoShort(f.modified, now())}` : "", formatBytes(f.bytes)].filter(Boolean).join(" · ");
            rows.push(el("li", {}, el("label", { class: "row file-row" }, box,
                el("span", { class: "row-icon icon-indd", "aria-hidden": "true" }),
                el("span", { class: "row-name", text: f.name }),
                el("span", { class: "row-meta", text: meta }))));
        }

        const parts = [];
        if (mode === "files" && files.length > 1) {
            const all = el("input", { type: "checkbox", id: "browseAll" });
            all.addEventListener("change", () => {
                for (const f of files) {
                    if (all.checked) selected.set(f.path, { folder: listing.path, folderLabel });
                    else selected.delete(f.path);
                }
                for (const box of body.querySelectorAll(".file-row input")) box.checked = all.checked;
                updateFooter();
            });
            parts.push(el("label", { class: "select-all check small" }, all, `Select all ${files.length} InDesign files here`));
        }
        if (rows.length) {
            parts.push(el("ul", { class: "browse-list" }, rows));
        } else {
            const needle = filter.value.trim();
            parts.push(el("p", { class: "browse-empty", text: needle
                ? `Nothing in this folder matches “${needle}”.`
                : mode === "files" ? "This folder has no subfolders or InDesign files." : "This folder has no subfolders. You can save here." }));
        }
        if (listing.truncated) {
            parts.push(el("p", { class: "hint", text: "This folder is very big, so only the first 1000 items are shown. Type part of the name in the filter box to find the rest." }));
        }
        body.replaceChildren(...parts);
        syncSelectAll();
        updateFooter();
        if (focusList) (body.querySelector(".row") || filter).focus();
    }

    function syncSelectAll() {
        const all = body.querySelector("#browseAll");
        if (!all) return;
        const boxes = [...body.querySelectorAll(".file-row input")];
        all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
        all.indeterminate = !all.checked && boxes.some((b) => b.checked);
    }

    function updateFooter() {
        if (mode === "files") {
            const n = selected.size;
            status.textContent = n ? `${n} selected` : "Tick the InDesign files you want.";
            okBtn.textContent = n ? `Add ${plural(n, "file")}` : "Add files";
            okBtn.disabled = n === 0;
        } else {
            status.textContent = listing ? `Save to: ${labelOf(listing)}` : "Open the folder the exports should go to.";
            okBtn.textContent = "Use this folder";
            okBtn.disabled = !listing;
        }
    }

    // ------------------------------------------------------------ events

    // Small folders are filtered here, instantly. A folder cut off at 1000 entries (or one the
    // server already filtered) is asked again with ?q=, so matches beyond the first 1000 show up.
    filter.addEventListener("input", () => {
        if (!listing) return;
        renderListing();
        clearTimeout(filterTimer);
        if (!listing.truncated && !listingQuery) return;
        const path = listing.path;
        filterTimer = setTimeout(() => {
            const q = filter.value.trim();
            if (listing?.path === path && q !== listingQuery) load(path, { q, focusList: false });
        }, 300);
    });

    for (const b of sortButtons) {
        b.addEventListener("click", () => {
            sort = b.dataset.sort;
            local.set("browseSort", sort);
            if (listing) renderListing();
        });
    }

    okBtn.addEventListener("click", () => {
        if (mode === "files") {
            if (!selected.size) return;
            const paths = [...selected.keys()];
            const folders = new Map([...selected.values()].map((v) => [v.folder, v.folderLabel]));
            for (const [path, label] of [...folders].reverse()) rememberFolder(path, label);
            dialog.close("ok");
            onFiles(paths);
        } else if (listing) {
            rememberFolder(listing.path, labelOf(listing));
            dialog.close("ok");
            onFolder(listing.path, labelOf(listing));
        }
    });

    document.getElementById("browseCancel").addEventListener("click", () => dialog.close("cancel"));
    document.getElementById("browseClose").addEventListener("click", () => dialog.close("cancel"));
    dialog.addEventListener("close", () => {
        controller?.abort();
        clearTimeout(filterTimer);
    });

    return {
        open(newMode, opener) {
            mode = newMode === "folder" ? "folder" : "files";
            selected = new Map();
            listing = null;
            filter.value = "";
            title.textContent = mode === "files" ? "Choose InDesign files" : "Choose where to save";
            tools.hidden = true;
            renderCrumbs(null);
            updateFooter();
            dialog.addEventListener("close", () => opener?.focus?.(), { once: true });
            dialog.showModal();
            load("");
        },
        get isOpen() {
            return dialog.open;
        },
    };
}
