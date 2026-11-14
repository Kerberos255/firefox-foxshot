import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const handlers = new Map();
const calls = [];
const button = { dataset: { mode:"full" }, addEventListener: (event, fn) => handlers.set("click", fn) };
const status = { textContent: "" };
const badge = { textContent:"", hidden:true };
let resolveStart;
const startPromise = new Promise(resolve => { resolveStart = resolve; });
let closed = 0;
const win = {
  addEventListener: (event, fn) => handlers.set(event, fn),
  close: () => { closed++; }
};
const doc = {
  querySelector: (selector) => selector === ".kbd-badge" ? badge : null,
  querySelectorAll: (selector) => selector === "[data-i18n]" ? [] : selector === "button[data-mode]" ? [button] : [],
  getElementById: (id) => id === "status" ? status : { addEventListener:()=>{}, setAttribute:()=>{} }
};
const browser = {
  i18n: { getMessage: (key)=>key },
  commands: { getAll: async()=>[{name:"capture-region",shortcut:"Ctrl+Alt+S"}] },
  runtime: { sendMessage: async(message) => {
    calls.push(message.type);
    if(message.type === "foxshot.startMode") return startPromise;
    return {ok:true};
  } }
};
const ctx = vm.createContext({window:win,document:doc,browser,console});
vm.runInContext(fs.readFileSync(path.join(root,"popup/popup.js"),"utf8"),ctx);
await new Promise(setImmediate);
assert.equal(badge.textContent,"Ctrl+Alt+S");
assert.equal(badge.hidden,false);
const clickTask = handlers.get("click")();
assert.deepEqual(calls,["foxshot.startMode"]);
assert.equal(button.disabled,true);
const event = {key:"Escape",preventDefault(){this.prevented=true},stopImmediatePropagation(){this.stopped=true}};
handlers.get("keydown")(event);
assert.ok(event.prevented && event.stopped);
assert.deepEqual(calls,["foxshot.startMode","foxshot.cancelMode"]);
resolveStart({ok:true});
await clickTask;
await Promise.resolve();
assert.ok(closed>=1,"popup should eventually close after cancellation");
assert.equal(button.disabled,false);
console.log("Popup immediate Esc cancellation PASS");
