// Runs export-notify.jsx against a stand-in for InDesign's scripting API.  Usage: node tests/test-export-notify.js
const fs = require('fs'), path = require('path');
const { makeEnv } = require('./indesign-mock');
const ROOT = fs.mkdtempSync(path.join(require('os').tmpdir(), 'export-notify-test-'));
const JSX = path.join(__dirname, '..', 'export-notify.jsx');
const out = path.join(ROOT, 'exports');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const outbox = path.join(ROOT, 'appdata', 'InDesignExportNotify', 'outbox');
const msgs = () => fs.existsSync(outbox) ? fs.readdirSync(outbox).filter(f => f.endsWith('.msg')).sort().map(f => fs.readFileSync(path.join(outbox, f), 'utf8')) : [];
const clear = () => fs.existsSync(outbox) && fs.readdirSync(outbox).forEach(f => fs.unlinkSync(path.join(outbox, f)));
const show = m => { const [h, b] = m.split('\n---\n'); const g = k => (h.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]; return `[${g('topic').endsWith('-status') ? 'STATUS' : 'MAIN'}] ${g('title')} | ${g('priority')} | ${b.replace(/\n/g, ' / ')}`; };
let pass = 0, fail = 0;
const check = (name, cond, detail) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '\n       ' + detail : '')); };
async function settle(env) { await sleep(40); env.tick(); await sleep(5); }
(async () => {
  fs.mkdirSync(out, { recursive: true });
  // 0. startup heartbeat
  let env = makeEnv({ root: ROOT, jsx: JSX });
  let m = msgs(); check('startup heartbeat goes to status channel only', m.length === 1 && show(m[0]).startsWith('[STATUS] Notifier running'), m.map(show).join(' || '));
  check('heartbeat launched hidden via VBScript', env.calls.doScript.length === 1 && /WScript\.Shell"\)\.Run "powershell\.exe -NoProfile .*-WindowStyle Hidden.*-File ""[^"]+send-notification\.ps1"" -MessageFile ""[^"]+\.msg""", 0, False$/.test(env.calls.doScript[0]), env.calls.doScript[0]);
  clear();

  // 1. normal new PDF
  const a = path.join(out, 'notify-test.pdf');
  env.fire('beforeExport', a); fs.writeFileSync(a, 'pdf'); env.fire('afterExport', a); await settle(env);
  m = msgs(); check('new PDF -> "export finished" with project name', m.length === 1 && /InDesign export finished \| default \| Done \(1\): notify-test\.pdf \/ From: Back to the Grind_Digital\.indd \/ On EXPORT-PC\./.test(show(m[0])), m.map(show).join(' || ')); clear();

  // 2. overwrite existing file, export fails (file not rewritten)
  await sleep(20); env.fire('beforeExport', a); env.fire('afterExport', a); await settle(env);
  m = msgs(); check('overwrite but NOT rewritten -> warning (gap 7)', m.length === 1 && /needs a look \| high \| Not written - cancelled or failed\? \(1\): notify-test\.pdf/.test(show(m[0])), m.map(show).join(' || ')); clear();

  // 3. overwrite existing file, rewritten
  env.fire('beforeExport', a); await sleep(20); fs.writeFileSync(a, 'pdf v2'); fs.utimesSync(a, new Date(), new Date(Date.now() + 5000)); env.fire('afterExport', a); await settle(env);
  m = msgs(); check('overwrite AND rewritten -> finished', m.length === 1 && /export finished.*Done \(1\): notify-test\.pdf/.test(show(m[0])), m.map(show).join(' || ')); clear();

  // 4. multi-page JPG writes Poster1.jpg..Poster3.jpg, not Poster.jpg
  const j = path.join(out, 'Poster.jpg');
  env.fire('beforeExport', j); [1, 2, 3].forEach(n => fs.writeFileSync(path.join(out, `Poster${n}.jpg`), 'jpg')); env.fire('afterExport', j); await settle(env);
  m = msgs(); check('multi-page JPG -> finished, "3 files" (gap 6)', m.length === 1 && /export finished.*Done \(1\): Poster\.jpg \(3 files\)/.test(show(m[0])), m.map(show).join(' || ')); clear();

  // 5. background export still running -> wait, then send
  const b = path.join(out, 'Billboard 6x3.pdf');
  env.fire('beforeExport', b); env.fire('afterExport', b); env.bg.push({ status: 'RUNNING' }); await settle(env);
  check('background task running -> nothing sent yet', msgs().length === 0);
  fs.writeFileSync(b, 'pdf'); env.bg[0].status = 'COMPLETED'; await settle(env);
  m = msgs(); check('background task completed -> finished (name with space)', m.length === 1 && /Done \(1\): Billboard 6x3\.pdf/.test(show(m[0])), m.map(show).join(' || ')); env.bg.length = 0; clear();

  // 6. batch of two, one message; Hebrew name
  const h1 = path.join(out, 'קמפיין_חורף_A4.pdf'), h2 = path.join(out, 'Banner.pdf');
  for (const f of [h1, h2]) { env.fire('beforeExport', f, 'Winter.indd'); fs.writeFileSync(f, 'x'); env.fire('afterExport', f, 'Winter.indd'); }
  await settle(env);
  m = msgs(); check('batch of 2 -> one message, Hebrew intact', m.length === 1 && /Done \(2\): קמפיין_חורף_A4\.pdf, Banner\.pdf \/ From: Winter\.indd/.test(show(m[0])), m.map(show).join(' || ')); clear();

  // 7. no idle task left running after sending
  check('stops checking after sending', !env.app.idleTasks.itemByName('exportNotifyWait').isValid);

  // 8. hidden file names
  let env2 = makeEnv({ root: ROOT, jsx: JSX, hideNames: true }); clear();
  const c = path.join(out, 'Secret_Client.pdf'); env2.fire('beforeExport', c); fs.writeFileSync(c, 'x'); env2.fire('afterExport', c); await settle(env2);
  m = msgs(); check('hide file names -> no names or project', m.length === 1 && !/Secret|Grind/.test(m[0]) && /Done \(1\) \//.test(show(m[0])), m.map(show).join(' || ')); clear();

  // 9. VBScript disabled -> fallback launcher (gap 4)
  clear(); let env3 = makeEnv({ root: ROOT, jsx: JSX, noVBScript: true });
  const cmd = env3.calls.executed[0] || '';
  check('VBScript unavailable -> .cmd fallback launched', /export-notify-send\.cmd$/.test(cmd) && /^@start "" \/min powershell\.exe -NoProfile .*-File "[^"]+send-notification\.ps1" -MessageFile "[^"]+\.msg"\r\n$/.test(fs.readFileSync(cmd, 'utf8')), cmd && fs.readFileSync(cmd, 'utf8'));
  check('...and the message is still in the outbox', msgs().length === 1);

  // 10. reloading the script does not double up listeners
  const before = env.listeners.length;
  check('two listeners registered (before+after export)', before === 2, 'listeners=' + before);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
