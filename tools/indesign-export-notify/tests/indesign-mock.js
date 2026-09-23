// Minimal stand-in for InDesign's ExtendScript objects (app, File, Folder...), backed by the real file system.
const fs = require('fs'), path = require('path'), vm = require('vm');
function makeEnv(opts = {}) {
  const ROOT = opts.root;
  const calls = { doScript: [], executed: [] };
  class Folder {
    constructor(p) { this._p = String(p); }
    get exists() { return fs.existsSync(this._p) && fs.statSync(this._p).isDirectory(); }
    get fsName() { return this._p; }
    create() { fs.mkdirSync(this._p, { recursive: true }); return true; }
    getFiles(mask) {
      if (!this.exists) return [];
      const re = new RegExp('^' + mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
      return fs.readdirSync(this._p).filter(n => re.test(n)).map(n => {
        const full = path.join(this._p, n); return fs.statSync(full).isDirectory() ? new Folder(full) : new File(full); });
    }
  }
  Folder.userData = path.join(ROOT, 'appdata'); Folder.temp = path.join(ROOT, 'temp');
  class File {
    constructor(p) { this._p = String(p); this._buf = ''; }
    get exists() { return fs.existsSync(this._p); }
    get name() { return encodeURI(path.basename(this._p)); }
    get fsName() { return this._p; }
    get parent() { return new Folder(path.dirname(this._p)); }
    get modified() { return fs.statSync(this._p).mtime; }
    open() { this._buf = ''; return true; } write(s) { this._buf += s; } close() { fs.mkdirSync(path.dirname(this._p), { recursive: true }); fs.writeFileSync(this._p, this._buf); }
    execute() { calls.executed.push(this._p); return true; }
  }
  File.fs = 'Windows';
  const listeners = [], idle = {};
  const bg = [];
  const app = {
    version: '21.0.1', backgroundTasks: bg,
    eventListeners: Object.assign(listeners, {}),
    addEventListener(type, fn) { const l = { type, fn, name: '', remove() { listeners.splice(listeners.indexOf(l), 1); } }; listeners.push(l); return l; },
    idleTasks: {
      itemByName(n) { return idle[n] || { isValid: false }; },
      add(p) { const t = { name: p.name, sleep: p.sleep, isValid: true, fns: [], addEventListener(e, fn) { this.fns.push(fn); }, remove() { this.isValid = false; delete idle[p.name]; } }; idle[p.name] = t; return t; }
    },
    doScript(src, lang) { calls.doScript.push(src); if (opts.noVBScript) throw new Error('VBScript is not available'); }
  };
  const ctx = { app, File, Folder, decodeURI, encodeURI, Math, Date, String,
    $: { getenv: k => (k === 'COMPUTERNAME' ? 'EXPORT-PC' : ''), writeln: s => calls.log = s },
    TaskState: { COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED', RUNNING: 'RUNNING', QUEUED: 'QUEUED' },
    IdleEvent: { ON_IDLE: 'onIdle' }, ScriptLanguage: { VISUAL_BASIC: 'vb' } };
  vm.createContext(ctx);
  let src = fs.readFileSync(opts.jsx, 'utf8').replace('pollSeconds: 5', 'pollSeconds: 0.01');
  if (opts.hideNames) src = src.replace('showFileNames: true', 'showFileNames: false');
  vm.runInContext(src, ctx);
  const fire = (type, file, doc = 'Back to the Grind_Digital.indd') =>
    listeners.filter(l => l.type === type).forEach(l => l.fn({ fullName: new File(file), parent: { name: doc } }));
  const tick = () => Object.values(idle).forEach(t => t.fns.forEach(f => f()));
  return { app, fire, tick, calls, bg, listeners };
}
module.exports = { makeEnv };
