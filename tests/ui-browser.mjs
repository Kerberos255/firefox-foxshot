import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const edgePaths = [process.env.FOXSHOT_BROWSER_EXECUTABLE,
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
].filter(Boolean);
const executable = edgePaths.find(p => fs.existsSync(p));
if (!executable) { console.error('Set FOXSHOT_BROWSER_EXECUTABLE to Edge/Chromium.'); process.exit(2); }
const types = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml' };
const server = http.createServer((req,res) => {
  const filename = new URL(req.url || '/', 'http://localhost').pathname.replace(/^\/+/, '');
  const file = path.resolve(root, filename);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.setHeader('content-type', (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8');
  res.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const site = 'http://127.0.0.1:' + server.address().port;
const profile = fs.mkdtempSync(path.join(os.tmpdir(),'foxshot-ui-test-'));
const child = spawn(executable, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=18000) {
  const start=Date.now(); while(Date.now()-start<timeout){try{const x=await fn();if(x)return x}catch{}await sleep(90)}
  throw Error('Timed out waiting for browser state');
}
let ws;
try {
  const port=await until(()=>{const f=path.join(profile,'DevToolsActivePort');return fs.existsSync(f)?Number(fs.readFileSync(f,'utf8').split('\n')[0]):null});
  const target=await until(async()=>{
    const r=await fetch('http://127.0.0.1:'+port+'/json/list');
    return (await r.json()).find(x=>x.type==='page'&&x.webSocketDebuggerUrl)
  });
  ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
  let id=0; const requests=new Map();
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const current=++id;requests.set(current,{resolve,reject});ws.send(JSON.stringify({id:current,method,params}))});
  ws.onmessage=e=>{
    const m=JSON.parse(e.data);
    if(m.id&&requests.has(m.id)){
      const {resolve,reject}=requests.get(m.id);requests.delete(m.id);m.error?reject(Error(m.error.message)):resolve(m.result||{});
    }
    if(m.method==='Runtime.bindingCalled'&&m.params?.name==='foxshotUiCapture'){
      const reqId=m.params.payload;
      void (async()=>{
        const shotData=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await cdp('Runtime.evaluate',{expression:`window.__deliverUiCapture(${JSON.stringify(reqId)},${JSON.stringify('data:image/png;base64,'+shotData.data)})`});
      })().catch(console.error);
    }
  };
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Runtime.addBinding',{name:'foxshotUiCapture'});
  const stub = `
    window.__calls = []; window.close = () => { window.__calls.push('close') }; window.__storage = {hideFloatingElements:true, uiTheme:'system'};
    window.__shortcut = 'Ctrl+Alt+S'; window.__resolveStart = null;
    window.browser = {
      i18n:{getMessage:id=>({settings:'Settings',pressShortcut:'Press shortcut',themeLabel:'Theme'})[id]||''},
      commands:{
        getAll:async()=>[{name:'capture-region',shortcut:window.__shortcut}],
        update:async({shortcut})=>{window.__shortcut=shortcut;window.__calls.push('shortcut:'+shortcut)},
        reset:async()=>{window.__shortcut='Alt+Shift+A'},
        openShortcutSettings:async()=>{window.__calls.push('shortcut-settings')}
      },
      runtime:{sendMessage:async({type,mode})=>{
        window.__calls.push(type+':'+(mode||''));
        if(type==='foxshot.startMode')return new Promise(resolve=>{window.__resolveStart=resolve});
        return {ok:true};
      },openOptionsPage:async()=>{window.__calls.push('options')}},
      storage:{local:{get:async defaults=>({...defaults,...window.__storage}),set:async data=>{Object.assign(window.__storage,data);window.__calls.push('store')}}}
    };
  `;
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:stub});
  const out=path.join(root,'dist','ui-preview');fs.mkdirSync(out,{recursive:true});
  async function evaluate(expression){
    const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result?.value;
  }
  async function load(pagePath,dark){
    await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:dark?'dark':'light'}]});
    await cdp('Emulation.setDeviceMetricsOverride',{width:pagePath.includes('popup')?350:950,height:pagePath.includes('popup')?420:780,deviceScaleFactor:1,mobile:false});
    await cdp('Page.navigate',{url:site+pagePath});
    await until(async()=>await evaluate("document.readyState==='complete' && Boolean(document.querySelector('#status'))"));
  }
  async function shot(label){const r=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,label+'.png'),Buffer.from(r.data,'base64'))}
  for(const dark of [false,true]){
    await load('/popup/popup.html',dark);
    await until(async()=>await evaluate("document.querySelector('.kbd-badge')?.textContent==='Ctrl+Alt+S' && !document.querySelector('.kbd-badge').hidden"));
    assert.equal(await evaluate("document.querySelectorAll('.kbd-key').length"),3);
    assert.equal(await evaluate("document.querySelectorAll('button[data-mode]').length"),3);
    assert.equal(await evaluate('getComputedStyle(document.body).overflowX'),'hidden');
    assert.equal(await evaluate(`(() => {
      const bodyRight = document.body.getBoundingClientRect().right;
      const primary = document.querySelector('.mode-card.is-primary').getBoundingClientRect();
      const tiles = Array.from(document.querySelectorAll('.mode-card.is-tile')).map(e => e.getBoundingClientRect());
      return primary.width > 250 && primary.right <= bodyRight
        && tiles.length === 2
        && tiles.every(t => t.width > 120 && t.right <= bodyRight)
        && Math.abs(tiles[0].top - tiles[1].top) <= 1
        && tiles[0].right < tiles[1].left;
    })()`),true);
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'),dark?'rgb(21, 22, 27)':'rgb(255, 255, 255)');
    await shot('popup-'+(dark?'dark':'light'));
    for(const mode of ['region','full','long']){
      await evaluate("document.querySelector('[data-mode=\\\""+mode+"\\\"]').click()");
      assert.equal(await evaluate("Array.from(document.querySelectorAll('button[data-mode]')).every(e=>e.disabled)"),true);
      assert.equal(await evaluate("window.__calls.filter(x=>x==='foxshot.startMode:"+mode+"').length"),1);
      await evaluate("window.__resolveStart({ok:false,error:'Synthetic error'})");
      await until(async()=>await evaluate("Array.from(document.querySelectorAll('button[data-mode]')).every(e=>!e.disabled)"));
      assert.equal(await evaluate("document.querySelector('#status').textContent"),'Synthetic error');
    }
    await evaluate("document.querySelector('#open-settings').click()");
    await until(async()=>await evaluate("window.__calls.includes('options')"));
    assert.equal(await evaluate("document.querySelector('#open-settings').getAttribute('aria-label')"),'Settings');
    console.log('PASS popup UI',dark?'dark':'light');

    await load('/options/options.html',dark);
    await until(async()=>await evaluate("document.querySelector('#hideFloatingElements').checked"));
    const bounds=await evaluate("Array.from(document.querySelectorAll('.card')).map(e=>{const r=e.getBoundingClientRect();return [r.width,r.left,r.right]})");
    assert.equal(bounds.length,3);
    assert.ok(bounds.every(([width,left,right])=>width>=280&&left>=0&&right<=950));
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'),dark?'rgb(15, 15, 19)':'rgb(248, 250, 252)');
    await shot('options-'+(dark?'dark':'light'));
    const opposite = dark ? 'light' : 'dark';
    await evaluate(`document.querySelector('[data-theme-value="${opposite}"]').click()`);
    await until(async()=>await evaluate(`window.__storage.uiTheme==='${opposite}'`));
    assert.equal(await evaluate('document.documentElement.dataset.theme'),opposite);
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'),opposite==='dark'?'rgb(15, 15, 19)':'rgb(248, 250, 252)');
    await evaluate("document.querySelector('[data-theme-value=\"system\"]').click()");
    await until(async()=>await evaluate("window.__storage.uiTheme==='system'"));
    assert.equal(await evaluate('document.documentElement.dataset.theme'),undefined);
    await evaluate("document.querySelector('#hideFloatingElements').click()");
    await until(async()=>await evaluate('window.__storage.hideFloatingElements===false'));
    await evaluate("document.querySelector('#shortcut').focus();document.querySelector('#shortcut').dispatchEvent(new KeyboardEvent('keydown',{key:'K',code:'KeyK',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}))");
    assert.equal(await evaluate("document.querySelector('#shortcut').value"),'Ctrl+Alt+K');
    await evaluate("document.querySelector('#save').click()");
    await until(async()=>await evaluate("window.__shortcut==='Ctrl+Alt+K'"));
    await evaluate("document.querySelector('#reset').click()");
    await until(async()=>await evaluate("window.__shortcut==='Alt+Shift+A'"));
    await evaluate("document.querySelector('#manage-shortcuts').click()");
    await until(async()=>await evaluate("window.__calls.includes('shortcut-settings')"));
    assert.equal(await evaluate("document.querySelector('.switch input').checked"),false);
    console.log('PASS options UI',dark?'dark':'light');
  }

  // Verify live capture.js toolbar, secondary attribute sub-bar, inline text editor,
  // theme overrides, and result preview header in both light and dark modes.
  const captureFixture = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; padding:32px; min-height:100vh; font:14px/1.6 system-ui,sans-serif;
      background:linear-gradient(135deg,#f8fafc,#e2e8f0); color:#0f172a; }
    .demo-card { max-width:560px; margin:20px auto; background:#fff; border-radius:16px;
      padding:24px 28px; box-shadow:0 12px 32px rgba(15,23,42,.08); border:1px solid rgba(15,23,42,.08); }
    .demo-card h1 { margin:0 0 8px; font-size:20px; }
    .demo-card p { margin:0 0 14px; color:#475569; }
    .tags { display:flex; gap:8px; }
    .tag { padding:4px 10px; border-radius:999px; font-size:12px; background:#fff7ed; color:#ea580c; border:1px solid #fed7aa; }
  </style></head><body>
    <div class="demo-card">
      <h1>FoxShot Capture Surface</h1>
      <p>Verify frosted floating toolbar, secondary attribute bar, inline text editor, and result preview across themes.</p>
      <div class="tags"><span class="tag">FoxShot Orange</span><span class="tag">Frosted Glass</span><span class="tag">Inline Text</span></div>
    </div>
    <script>
      window.__listeners = [];
      window.__copied = 0;
      window.__promptCalls = 0;
      window.__capSeq = 0;
      window.__capPending = {};
      window.__deliverUiCapture = (id, data) => { const fn = window.__capPending[id]; delete window.__capPending[id]; fn?.(data); };
      window.prompt = () => { window.__promptCalls++; return 'should-not-fire'; };
      window.browser.runtime.onMessage = { addListener: fn => window.__listeners.push(fn) };
      window.browser.runtime.sendMessage = async (msg) => {
        if (msg.type === 'foxshot.captureVisible') {
          const id = String(++window.__capSeq);
          return new Promise(resolve => { window.__capPending[id] = resolve; window.foxshotUiCapture(id); });
        }
        if (msg.type === 'foxshot.copyImage') { window.__copied++; return true; }
        return true;
      };
      window.__dispatch = async (msg) => { for (const fn of window.__listeners) await fn(msg); };
    </script>
    <script src="/content/capture.js"></script>
  </body></html>`;

  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/capture-fixture') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(captureFixture);
      return;
    }
    const filename = pathname.replace(/^\/+/, '');
    const file = path.resolve(root, filename);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.setHeader('content-type', (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8');
    res.end(fs.readFileSync(file));
  });

  const mouse = async (type, x, y, buttons) => cdp('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mousePressed' || type === 'mouseReleased' ? 'left' : 'none',
    buttons: buttons ? 1 : 0, clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0
  });

  for (const theme of ['light', 'dark']) {
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme === 'dark' ? 'light' : 'dark' }] });
    await cdp('Emulation.setDeviceMetricsOverride', { width: 960, height: 600, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: site + '/capture-fixture' });
    await until(async () => await evaluate('Boolean(window.__listeners && window.__listeners.length > 0)'));
    await evaluate(`window.__storage.uiTheme = '${theme}'`);
    await evaluate("window.__dispatch({type:'foxshot.start', mode:'region'})");
    await until(async () => await evaluate("document.querySelector('[data-foxshot-ui]')?.dataset?.theme === '" + theme + "'"));

    // Drag selection
    await mouse('mouseMoved', 210, 62, false);
    await mouse('mousePressed', 210, 62, true);
    await mouse('mouseMoved', 750, 265, true);
    await mouse('mouseReleased', 750, 265, false);
    await until(async () => await evaluate("Boolean(document.querySelector('[data-foxshot-ui]')?.shadowRoot?.querySelector('.toolbar'))"));

    // No native form inputs in toolbar
    assert.equal(await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelectorAll('.toolbar input, .toolbar select').length"), 0);
    // Secondary sub-bar starts hidden
    assert.equal(await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.toolbar-sub').hidden"), true);
    // Click arrow tool -> sub-bar opens
    await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('button[data-tool=\"arrow\"]').click()");
    assert.equal(await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.toolbar-sub').hidden"), false);
    assert.equal(await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelectorAll('.sub-swatch').length"), 7);
    // Draw an arrow inside selection so screenshot shows annotation + active sub-bar
    await mouse('mouseMoved', 530, 220, false);
    await mouse('mousePressed', 530, 220, true);
    await mouse('mouseMoved', 430, 145, true);
    await mouse('mouseReleased', 430, 145, false);
    await sleep(60);
    await shot('capture-region-' + theme);

    // Mosaic hides color swatches and renders real pixelated blocks live on .mosaic-layer
    await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('button[data-tool=\"mosaic\"]').click()");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.sub-colors')).display"), 'none');
    await sleep(180);
    // Paint a mosaic stroke across the dark heading
    await mouse('mouseMoved', 240, 88, false);
    await mouse('mousePressed', 240, 88, true);
    await mouse('mouseMoved', 450, 88, true);
    await mouse('mouseReleased', 450, 88, false);
    await until(async () => await evaluate(`(() => {
      const cv = document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.mosaic-layer');
      const d = cv.getContext('2d').getImageData(310, 88, 1, 1).data;
      return d[3] === 255;
    })()`));
    // Single-click dab on an orange tag also commits immediately
    await mouse('mouseMoved', 260, 192, false);
    await mouse('mousePressed', 260, 192, true);
    await mouse('mouseReleased', 260, 192, false);
    assert.equal(await evaluate(`(() => {
      const cv = document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.mosaic-layer');
      return cv.getContext('2d').getImageData(260, 192, 1, 1).data[3];
    })()`), 255);
    assert.equal(await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelectorAll('.draw-layer polyline').length"), 0);
    if (theme === 'light') await shot('capture-mosaic-live');
    // Undo removes the single-click dab and restores transparent pixel underneath
    await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelectorAll('.toolbar button.fx-icon')[6].click()");
    assert.equal(await evaluate(`(() => {
      const cv = document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.mosaic-layer');
      return cv.getContext('2d').getImageData(260, 192, 1, 1).data[3];
    })()`), 0);

    // Text tool uses inline text editor instead of window.prompt
    await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('button[data-tool=\"text\"]').click()");
    assert.equal(await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelectorAll('.sub-text-btn').length"), 3);
    await mouse('mouseMoved', 290, 190, false);
    await mouse('mousePressed', 290, 190, true);
    await mouse('mouseReleased', 290, 190, false);
    await until(async () => await evaluate("Boolean(document.querySelector('[data-foxshot-ui]')?.shadowRoot?.querySelector('.inline-text-editor'))"));
    assert.equal(await evaluate('window.__promptCalls'), 0);
    await evaluate(`(() => {
      const ed = document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.inline-text-editor');
      ed.value = 'FoxShot 标注';
      ed.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    // Changing swatch color updates live editor without closing it
    await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.sub-swatch[data-color=\"#f97316\"]').click()");
    assert.equal(await evaluate("Boolean(document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.inline-text-editor'))"), true);
    if (theme === 'light') await shot('capture-inline-text');
    // Enter commits text to SVG
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(async () => await evaluate("!document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.inline-text-editor')"));
    assert.equal(await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.draw-layer text')?.textContent"), 'FoxShot 标注');

    // Clicking active tool again closes sub-bar and returns to move mode
    await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('button[data-tool=\"text\"]').click()");
    assert.equal(await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.toolbar-sub').hidden"), true);

    // Enter when not editing text copies and closes region overlay
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(async () => await evaluate("window.__copied === 1 && !document.querySelector('[data-foxshot-ui]')"));

    // Verify full-page result preview header + dropped-down secondary attribute bar + live mosaic
    await evaluate("window.__dispatch({type:'foxshot.start', mode:'full'})");
    await until(async () => await evaluate("Boolean(document.querySelector('[data-foxshot-ui]')?.shadowRoot?.querySelector('.result-preview')?.complete)"));
    assert.equal(await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelectorAll('.result-head input, .result-head select').length"), 0);
    await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('button[data-result-tool=\"mosaic\"]').click()");
    const previewBox = await evaluate(`(() => {
      const r = document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.result-preview').getBoundingClientRect();
      return { x: Math.round(r.left + r.width * 0.4), y: Math.round(r.top + r.height * 0.2) };
    })()`);
    await mouse('mouseMoved', previewBox.x, previewBox.y, false);
    await mouse('mousePressed', previewBox.x, previewBox.y, true);
    await mouse('mouseReleased', previewBox.x, previewBox.y, false);
    assert.equal(await evaluate(`(() => {
      const cv = document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.result-mosaic');
      const d = cv.getContext('2d').getImageData(Math.round(cv.width * 0.4), Math.round(cv.height * 0.2), 1, 1).data;
      return d[3];
    })()`), 255);
    await evaluate("document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('button[data-result-tool=\"rect\"]').click()");
    await until(async () => await evaluate("!document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.toolbar-sub').hidden"));
    await sleep(60);
    await shot('capture-result-' + theme);

    // Verify long-capture floating toolbar (status, reselect, cancel, finish)
    await evaluate("window.__dispatch({type:'foxshot.start', mode:'long'})");
    await until(async () => await evaluate("Boolean(document.querySelector('[data-foxshot-ui]')?.shadowRoot?.querySelector('.stage'))"));
    await mouse('mouseMoved', 210, 62, false);
    await mouse('mousePressed', 210, 62, true);
    await mouse('mouseMoved', 750, 265, true);
    await mouse('mouseReleased', 750, 265, false);
    await until(async () => await evaluate("Boolean(document.querySelector('[data-foxshot-ui]')?.shadowRoot?.querySelector('.toolbar.long-bar'))"));
    assert.equal(await evaluate("Boolean(document.querySelector('[data-foxshot-ui]').shadowRoot.querySelector('.handle.s.long-grip'))"), true);
    assert.equal(await evaluate("Array.from(document.querySelector('[data-foxshot-ui]').shadowRoot.querySelectorAll('.toolbar.long-bar button')).some(b=>b.textContent==='完成')"), true);
    assert.equal(await evaluate("Array.from(document.querySelector('[data-foxshot-ui]').shadowRoot.querySelectorAll('.toolbar.long-bar button')).some(b=>b.textContent==='重选')"), true);
    await sleep(60);
    await shot('capture-long-' + theme);
    await evaluate("window.__dispatch({type:'foxshot.cancel'})");
    console.log('PASS capture overlay, long toolbar & result UI', theme);
  }
  console.log('FoxShot UI browser regression passed');
}finally{
  ws?.close();child.kill();server.close();await sleep(120);
  fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:150});
}
