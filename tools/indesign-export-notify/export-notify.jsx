//@targetengine "exportNotify"
/*
 * InDesign startup script: sends a push notification (via ntfy) when an export finishes.
 *
 * Install (Windows): copy this file to
 *   %APPDATA%\Adobe\InDesign\<Version>\<locale>\Scripts\startup scripts\
 * (create the "startup scripts" folder if missing) and restart InDesign.
 *
 * Works for normal and background (Background Tasks panel) exports: it waits until
 * InDesign reports no running background tasks and the output file exists.
 * Exports that finish close together are grouped into one notification.
 */

var CONFIG = {
    server: "http://127.0.0.1:2586",           // self-hosted ntfy on this PC (server/SETUP.md)
    topic: "exports",
    token: "CHANGE-ME",                        // tk_... token from SETUP.md step 5
    pollSeconds: 5,                            // how often to check background exports
    timeoutHours: 8,                           // give up waiting after this long
    label: ""                                  // name shown in the message; blank = computer name
};

var pending = [];
var lastExportAt = 0;
var IDLE_NAME = "exportNotifyWait";
var LISTENER_NAME = "exportNotify";

function computerName() {
    if (CONFIG.label) return CONFIG.label;
    return $.getenv("COMPUTERNAME") || $.getenv("HOSTNAME") || "InDesign PC";
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

function onAfterExport(ev) {
    var docName = "";
    try { docName = ev.parent.name; } catch (e) {}
    pending.push({ file: ev.fullName, format: String(ev.format), doc: docName, start: new Date().getTime() });
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

    var ok = [], missing = [];
    for (var i = 0; i < pending.length; i++) {
        var p = pending[i];
        var name = p.file ? decodeURI(p.file.name) : "(unknown file)";
        if (p.file && p.file.exists) ok.push(name); else missing.push(name);
    }
    var mins = Math.round((now - pending[0].start) / 60000);
    pending = [];
    stopWaiting();

    var lines = [];
    if (ok.length) lines.push("Done (" + ok.length + "): " + ok.join(", "));
    if (missing.length) lines.push("Not found - cancelled or failed? (" + missing.length + "): " + missing.join(", "));
    if (timedOut) lines.push("Stopped waiting after " + CONFIG.timeoutHours + "h.");
    lines.push("On " + computerName() + (mins ? ", waited ~" + mins + " min after export started." : "."));

    var problem = missing.length > 0 || timedOut;
    send(problem ? "InDesign export needs a look" : "InDesign export finished",
         lines.join("\n"),
         problem ? "warning" : "white_check_mark",
         problem ? "high" : "default");
}

// Sends via curl (built into Windows 10 1803+ and macOS). Body goes through a UTF-8
// temp file so non-English file names survive; header values are kept ASCII.
function send(title, body, tags, priority) {
    try {
        var f = new File(Folder.temp + "/indesign-export-notify.txt");
        f.encoding = "UTF-8";
        f.lineFeed = "Unix";
        f.open("w"); f.write(body); f.close();

        var url = CONFIG.server.replace(/\/+$/, "") + "/" + CONFIG.topic;
        var args = ['-s', '-m', '20',
                    '-H', 'Title: ' + title,
                    '-H', 'Tags: ' + tags,
                    '-H', 'Priority: ' + priority];
        if (CONFIG.token) args.push('-H', 'Authorization: Bearer ' + CONFIG.token);
        args.push('--data-binary', '@' + f.fsName, url);

        if (File.fs === "Windows") {
            var cmd = 'curl.exe';
            for (var i = 0; i < args.length; i++) cmd += ' ""' + args[i].replace(/["%]/g, '') + '""';
            app.doScript('CreateObject("WScript.Shell").Run "' + cmd + '", 0, False',
                         ScriptLanguage.VISUAL_BASIC);
        } else {
            var sh = 'curl';
            for (var j = 0; j < args.length; j++) sh += " '" + args[j].replace(/'/g, '') + "'";
            app.doScript('do shell script "' + sh.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + ' > /dev/null 2>&1 &"',
                         ScriptLanguage.APPLESCRIPT_LANGUAGE);
        }
    } catch (e) {
        $.writeln("exportNotify: could not send notification: " + e);
    }
}

// Register once; reloading the script replaces the old listener instead of doubling up.
(function () {
    for (var i = app.eventListeners.length - 1; i >= 0; i--) {
        if (app.eventListeners[i].name === LISTENER_NAME) app.eventListeners[i].remove();
    }
    var l = app.addEventListener("afterExport", onAfterExport);
    l.name = LISTENER_NAME;
})();
