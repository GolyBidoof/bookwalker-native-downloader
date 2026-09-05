// test_worker_src.js — verify buildWorkerSource() output compiles and descrambles correctly
// in a simulated worker environment (this catches serialization/statics bugs).
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const US = path.resolve(__dirname, '..', 'bookwalker-downloader-v3.user.js');
const code = fs.readFileSync(US, 'utf8');

function mkEl(tag) {
  return {
    style: {}, classList: { add(){}, remove(){}, contains(){return false;} },
    setAttribute(){}, getAttribute(){ return null; }, appendChild(){}, removeChild(){},
    insertBefore(){}, addEventListener(){}, removeEventListener(){}, append(){},
    set textContent(v){}, get textContent(){ return ''; }, set id(v){}, get id(){ return ''; },
    set src(v){}, get src(){ return ''; }, set href(v){}, get href(){ return ''; }, set download(v){}, get download(){ return ''; },
    set disabled(v){}, get disabled(){ return false; }, set onclick(v){}, get onclick(){ return null; },
    set width(v){}, set height(v){}, getContext(){ return { drawImage(){}, fillRect(){}, getImageData(){ return {data:new Uint8ClampedArray(4)}; }, putImageData(){} }; },
    toBlob(cb){ cb(new Blob(['x'])); },
  };
}
const sandbox = {
  console, setTimeout: (fn)=>0, clearTimeout(){}, setInterval: ()=>0, clearInterval(){},
  performance: { now: () => Date.now() }, URLSearchParams, TextEncoder, TextDecoder,
  location: { search: '', href: 'https://viewer.bookwalker.jp/03/30/viewer.html?cid=test' },
  document: { cookie: 'u1=x', readyState: 'complete', addEventListener(){}, createElement: t=>mkEl(t), documentElement: mkEl('html'), body: mkEl('body') },
  localStorage: { getItem: ()=>null, setItem(){}, removeItem(){} }, XMLHttpRequest: function(){},
  Image: function(){}, fetch: ()=>Promise.reject(new Error('fetch stub')),
  createImageBitmap: ()=>Promise.reject(new Error('bmp stub')), navigator: {}, history: {}, screen: {}, devicePixelRatio: 1,
  JSZip: function(){ this.file=function(){}; this.generateAsync=()=>Promise.resolve(new Blob()); },
  Blob, Worker: function(){ throw new Error('no worker in node'); },
};
sandbox.XMLHttpRequest.prototype = { open(){}, send(){}, addEventListener(){}, setRequestHeader(){}, abort(){}, getResponseHeader(){return null;} };
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox; sandbox.top = sandbox; sandbox.parent = sandbox; sandbox.frames = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'userscript.user.js' });
const bw = sandbox.window.__bwdd;
if (!bw || typeof bw.buildWorkerSource !== 'function') { console.error('no __bwdd/buildWorkerSource'); process.exit(1); }

const workerSrc = bw.buildWorkerSource();
console.log('worker source length:', workerSrc.length);

// simulate a worker global scope
const wctx = {};
const post = [];
wctx.self = wctx;
wctx.postMessage = (...a) => post.push(a);
wctx.fetch = async (u) => { throw new Error('fetch ' + u); };
wctx.createImageBitmap = async () => { throw new Error('bmp'); };
wctx.OffscreenCanvas = function(w, h) { this.width = w; this.height = h; };
wctx.ImageData = class {};
wctx.URLSearchParams = URLSearchParams;
wctx.console = console;
wctx.Math = Math; wctx.JSON = JSON;
wctx.Uint8ClampedArray = Uint8ClampedArray;
wctx.setTimeout = setTimeout;
vm.createContext(wctx);
try {
  vm.runInContext(workerSrc, wctx, { filename: 'worker.js' });
  console.log('worker source executes OK');
} catch (e) {
  console.error('WORKER SOURCE FAILED TO EXECUTE:', e.message);
  process.exit(1);
}

// verify A9p works inside the worker scope
const fx = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'bookworm/src/exported/__fixtures__/A9p-001.json'), 'utf8'));
const res = vm.runInContext('A9p(' + JSON.stringify(fx.input[0]) + ', ' + fx.input[1] + ', ' + fx.input[2] + ')', wctx);
let mism = 0;
for (let i = 0; i < fx.output.length; i++) if (JSON.stringify(res[i]) !== JSON.stringify(fx.output[i])) mism++;
console.log('worker A9p fixture: tiles', res.length, 'mismatches', mism, mism === 0 && res.length === 2052 ? 'PASS' : 'FAIL');
// ---- regression check: workerMain() must have run and set self.onmessage ----
const hasOnMsg = typeof wctx.onmessage === 'function';
console.log('worker onmessage set:', hasOnMsg ? 'YES' : 'NO (bug: workerMain not invoked!)');
if (!hasOnMsg) process.exit(3);
// round-trip: post a message; fetch stub throws -> expect {id, error}
const replies = [];
const postOrig = wctx.postMessage;
wctx.postMessage = (m) => replies.push(m);
(async () => {
  try {
    await wctx.onmessage({ data: { id: 42, relPath: 'x', seeds: {}, auth: { Policy: 'p', Signature: 's', 'Key-Pair-Id': 'k' }, baseUrl: 'https://bw.example/', q: 0.9, timeoutMs: 1000 } });
  } catch (e) {}
  await new Promise(r => setTimeout(r, 30));
  const r0 = replies[0];
  console.log('round-trip response:', r0 ? JSON.stringify(r0).slice(0,120) : '(none)');
  if (!r0 || r0.id !== 42 || !r0.error) { console.log('round-trip FAIL'); process.exit(4); }
  console.log('round-trip PASS');
  process.exit(0);
})();



