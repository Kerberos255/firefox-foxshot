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
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&requests.has(m.id)){
    const {resolve,reject}=requests.get(m.id);requests.delete(m.id);m.error?reject(Error(m.error.message)):resolve(m.result||{});
  }};
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const current=++id;requests.set(current,{resolve,reject});ws.send(JSON.stringify({id:current,method,params}))});
  await cdp('Page.enable'); await cdp('Runtime.enable');
  const stub = `
    window.__calls = []; window.close = () => { window.__calls.push('close') }; window.__storage = {hideFloatingElements:true};
    window.__shortcut = 'Ctrl+Alt+S'; window.__resolveStart = null;
    window.browser = {
      i18n:{getMessage:id=>({settings:'Settings',pressShortcut:'Press shortcut'})[id]||''},
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
    assert.equal(await evaluate("document.querySelectorAll('button[data-mode]').length"),3);
    assert.equal(await evaluate('getComputedStyle(document.body).overflowX'),'hidden');
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.mode-card')).every(e=>{const b=e.getBoundingClientRect();return b.width>230&&b.right<=document.body.getBoundingClientRect().right})"),true);
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'),dark?'rgb(19, 19, 23)':'rgb(255, 255, 255)');
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
    assert.equal(bounds.length,2);
    assert.ok(bounds.every(([width,left,right])=>width>=280&&left>=0&&right<=950));
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'),dark?'rgb(15, 15, 19)':'rgb(248, 250, 252)');
    await shot('options-'+(dark?'dark':'light'));
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
  console.log('FoxShot UI browser regression passed');
}finally{
  ws?.close();child.kill();server.close();await sleep(120);
  fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:150});
}
