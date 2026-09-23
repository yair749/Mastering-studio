//@targetengine "exportNotify"
/*
 * InDesign startup script: sends a notification (via ntfy) when an export finishes.
 * Installed, and kept installed across InDesign upgrades, by Install.cmd. Windows only.
 *
 * How it works:
 *  1. beforeExport: note which output files already exist, and when they last changed.
 *  2. afterExport: remember the export.
 *  3. While InDesign is idle, every few seconds: once no background export is running,
 *     check the output file(s) were really written, then send one message for the batch.
 *  4. send-notification.ps1 delivers it, retrying for ~15 minutes, and logs any failure.
 */

var CONFIG = {
    server: "https://ntfy.sh",                 // filled in by Install.cmd
    topic: "CHANGE-ME",                        // filled in by Install.cmd (a long random name)
    token: "",                                 // only needed for a private/self-hosted server
    showFileNames: true,                       // false = say "2 files" instead of listing names
    pollSeconds: 5,                            // how often to check background exports
    timeoutHours: 8,                           // give up waiting after this long
    label: ""                                  // name shown in the message; blank = computer name
};

var NOTIFIER_DIR = Folder.userData + "/InDesignExportNotify";   // %APPDATA%\InDesignExportNotify
var SENDER = NOTIFIER_DIR + "/app/send-notification.ps1";
var IDLE_NAME = "exportNotifyWait";
var LISTENER_NAME = "exportNotify";

var snapshots = {};     // output path -> {file path: last modified} just before the export
var pending = [];
var lastExportAt = 0;
var sendCount = 0;

function computerName() {
    if (CONFIG.label) return CONFIG.label;
    return $.getenv("COMPUTERNAME") || "InDesign PC";
}

function pathKey(file) {
    return String(file.fsName).toLowerCase();
}

// The file(s) an export writes. Multi-page JPG/PNG exports add page numbers to the
// name, so "Poster.jpg" can become "Poster1.jpg", "Poster2.jpg"...: match "Poster*.jpg".
function outputFiles(file) {
    var result = {};
    try {
        var name = decodeURI(file.name);
        var dot = name.lastIndexOf(".");
        var mask = dot > 0 ? name.substring(0, dot) + "*" + name.substring(dot) : name + "*";
        var found = file.parent.exists ? file.parent.getFiles(mask) : [];
        for (var i = 0; found && i < found.length; i++) {
            if (found[i] instanceof File) result[pathKey(found[i])] = found[i].modified.getTime();
        }
        if (file.exists) result[pathKey(file)] = file.modified.getTime();
    } catch (e) {}
    return result;
}

// How many output files are new or rewritten since the snapshot.
function writtenFiles(p) {
    if (!p.before) return p.file.exists ? 1 : 0;   // no snapshot: fall back to "file exists"
    var now = outputFiles(p.file), count = 0;
    for (var k in now) {
        if (now.hasOwnProperty(k) && (!p.before.hasOwnProperty(k) || p.before[k] !== now[k])) count++;
    }
    return count;
}

function backgroundBusy() {
    try {
        var tasks = app.backgroundTasks;
        for (var i = 0; i < tasks.length; i++) {
            var s = tasks[i].status;
            if (s !== TaskState.COMPLETED && s !== TaskState.CANCELLED) return true;
        }
    } catch (e) {}
    return false;
}

function onBeforeExport(ev) {
    try { snapshots[pathKey(ev.fullName)] = outputFiles(ev.fullName); } catch (e) {}
}

function onAfterExport(ev) {
    var docName = "", key = "";
    try { docName = ev.parent.name; } catch (e) {}
    try { key = pathKey(ev.fullName); } catch (e) {}
    pending.push({ file: ev.fullName, before: snapshots[key], doc: docName, start: new Date().getTime() });
    delete snapshots[key];
    lastExportAt = new Date().getTime();
    startWaiting();
}

function startWaiting() {
    var task = app.idleTasks.itemByName(IDLE_NAME);
    if (!task.isValid) {
        task = app.idleTasks.add({ name: IDLE_NAME, sleep: CONFIG.pollSeconds * 1000 });
        task.addEventListener(IdleEvent.ON_IDLE, onIdle);
    } else {
        task.sleep = CONFIG.pollSeconds * 1000;
    }
}

function stopWaiting() {
    var task = app.idleTasks.itemByName(IDLE_NAME);
    if (task.isValid) task.remove();
}

function onIdle() {
    if (!pending.length) { stopWaiting(); return; }
    var now = new Date().getTime();
    // Wait for a quiet period so batch exports produce one message, and for background exports to end.
    if (now - lastExportAt < CONFIG.pollSeconds * 2000) return;
    var timedOut = now - pending[0].start > CONFIG.timeoutHours * 3600000;
    if (backgroundBusy() && !timedOut) return;

    var ok = [], missing = [], docs = [], seenDoc = {};
    for (var i = 0; i < pending.length; i++) {
        var p = pending[i];
        var name = p.file ? decodeURI(p.file.name) : "(unknown file)";
        var n = p.file ? writtenFiles(p) : 0;
        if (n > 1) name += " (" + n + " files)";
        if (n > 0) ok.push(name); else missing.push(name);
        if (p.doc && !seenDoc[p.doc]) { seenDoc[p.doc] = true; docs.push(p.doc); }
    }
    var mins = Math.round((now - pending[0].start) / 60000);
    pending = [];
    stopWaiting();

    var lines = [];
    if (ok.length) lines.push("Done (" + ok.length + ")" + (CONFIG.showFileNames ? ": " + ok.join(", ") : ""));
    if (missing.length) lines.push("Not written - cancelled or failed? (" + missing.length + ")" + (CONFIG.showFileNames ? ": " + missing.join(", ") : ""));
    if (docs.length && CONFIG.showFileNames) lines.push("From: " + docs.join(", "));
    if (timedOut) lines.push("Stopped waiting after " + CONFIG.timeoutHours + "h.");
    lines.push("On " + computerName() + (mins ? ", waited ~" + mins + " min after export started." : "."));

    var problem = missing.length > 0 || timedOut;
    send(CONFIG.topic,
         problem ? "InDesign export needs a look" : "InDesign export finished",
         problem ? "warning" : "white_check_mark",
         problem ? "high" : "default",
         lines.join("\n"));
}

// Writes the message to the outbox and starts send-notification.ps1 hidden, which delivers
// it with retries. Header values (title/tags) are kept ASCII; the body is UTF-8.
function send(topic, title, tags, priority, body) {
    try {
        var outbox = new Folder(NOTIFIER_DIR + "/outbox");
        if (!outbox.exists) outbox.create();
        var f = new File(outbox.fsName + "/" + new Date().getTime() + "-" + (++sendCount) + ".msg");
        f.encoding = "UTF-8";
        f.lineFeed = "Unix";
        f.open("w");
        f.write("server=" + CONFIG.server + "\ntopic=" + topic + "\ntoken=" + CONFIG.token +
                "\ntitle=" + title + "\ntags=" + tags + "\npriority=" + priority + "\n---\n" + body);
        f.close();

        var args = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
                   new File(SENDER).fsName + '" -MessageFile "' + f.fsName + '"';
        try {
            app.doScript('CreateObject("WScript.Shell").Run "powershell.exe ' + args.replace(/"/g, '""') + '", 0, False',
                         ScriptLanguage.VISUAL_BASIC);
        } catch (e) {
            // VBScript is being phased out of Windows. Fallback: a launcher file (may flash a window briefly).
            var cmd = new File(Folder.temp + "/export-notify-send.cmd");
            cmd.open("w");
            cmd.write('@start "" /min powershell.exe ' + args + "\r\n");
            cmd.close();
            cmd.execute();
        }
    } catch (e) {
        $.writeln("exportNotify: could not send notification: " + e);
    }
}

// Register once; reloading the script replaces the old listeners instead of doubling up.
(function () {
    for (var i = app.eventListeners.length - 1; i >= 0; i--) {
        if (app.eventListeners[i].name === LISTENER_NAME) app.eventListeners[i].remove();
    }
    var before = app.addEventListener("beforeExport", onBeforeExport);
    before.name = LISTENER_NAME;
    var after = app.addEventListener("afterExport", onAfterExport);
    after.name = LISTENER_NAME;

    // Heartbeat to the status channel, so a silent notifier is noticeable.
    send(CONFIG.topic + "-status", "Notifier running", "green_circle", "min",
         "InDesign " + app.version + " started on " + computerName() + ". Watching for exports.");
})();
