// test_userscript.js — execute the actual userscript code in a page-like vm sandbox
// and validate its crypto (decodeConfig/pageSeeds/A9p/b8g) against fixtures + real HAR data.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const US = path.resolve(__dirname, '..', 'bookwalker-downloader-v3.user.js');
const code = fs.readFileSync(US, 'utf8');

// ---- minimal browser stubs ----
function mkEl(tag) {
  const el = {
    style: {},
    classList: { add(){}, remove(){}, contains(){return false;} },
    dataset: {},
    setAttribute(){}, getAttribute(){ return null; },
    appendChild(){ return el; }, removeChild(){}, insertBefore(){}, addEventListener(){}, removeEventListener(){},
    append(){},
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    after(){}, before(){},
    get firstChild(){ return null; },
    get lastChild(){ return null; },
    set innerHTML(v){}, get innerHTML(){ return ''; },
    set textContent(v){}, get textContent(){ return ''; },
    set id(v){}, get id(){ return ''; },
    set src(v){}, get src(){ return ''; },
    set href(v){}, get href(){ return ''; },
    set download(v){}, get download(){ return ''; },
    set disabled(v){}, get disabled(){ return false; },
    set title(v){}, get title(){ return ''; },
    set onclick(v){}, get onclick(){ return null; },
    set onclose(v){}, get onclose(){ return null; },
    set width(v){}, set height(v){},
    getContext(){ return { drawImage(){}, fillRect(){} }; },
    toBlob(cb){ cb(new (require('buffer').Blob)(['x'])); },
  };
  return el;
}

const sandbox = {
  console,
  setTimeout: (fn) => 0,
  clearTimeout(){},
  setInterval: () => 0,
  clearInterval(){},
  performance: { now: () => Date.now() },
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  location: { search: '', href: 'https://viewer.bookwalker.jp/03/30/viewer.html?cid=test' },
  document: {
    cookie: 'u1=0c9f022c-21bd-4e41-8536-2e9ad67ddc58',
    readyState: 'complete',
    addEventListener(){},
    createElement: (t) => mkEl(t),
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    documentElement: mkEl('html'),
    body: mkEl('body'),
    head: mkEl('head'),
  },
  localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  XMLHttpRequest: function(){},
  Image: function(){},
  fetch: () => Promise.reject(new Error('fetch stub')),
  createImageBitmap: () => Promise.reject(new Error('bmp stub')),
  navigator: {},
  history: {},
  screen: {},
  devicePixelRatio: 1,
};
sandbox.XMLHttpRequest.prototype = { open(){}, send(){}, addEventListener(){}, setRequestHeader(){}, abort(){}, getResponseHeader(){ return null; } };
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.addEventListener = function(){};
sandbox.globalThis = sandbox;
sandbox.top = sandbox;
sandbox.parent = sandbox;
sandbox.frames = sandbox;
// JSZip stub
sandbox.JSZip = function(){ this.file=function(){}; this.generateAsync=()=>Promise.resolve(new Blob()); };
sandbox.Blob = Blob;

vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: 'userscript.user.js' });
} catch (e) {
  console.error('USERScript BOOT ERROR:', e.message);
  process.exit(1);
}

const bw = sandbox.window.__bwdd;
if (!bw) { console.error('__bwdd not exposed'); process.exit(1); }
console.log('userscript internals exposed OK');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// 1) decodeConfig on bookworm fixture 001
const raw1 = fs.readFileSync(path.resolve(__dirname, 'bookworm/src/__fixtures__/configuration_pack-001-encoded.json'), 'utf8');
let c1;
try { c1 = bw.decodeConfig(raw1); } catch (e) { c1 = null; console.log('  decode fixture001 threw:', e.message); }
check('decodeConfig fixture-001 parses', !!c1 && typeof c1 === 'object' && c1['OEBPS/text/p_0108.xhtml'] !== undefined);
if (c1) check('fixture-001 page meta', c1['OEBPS/text/p_0108.xhtml'].FileLinkInfo.PageLinkInfoList[0].Page.BlockWidth === 32);

// 2) decodeConfig on REAL config from HAR
const realRaw = fs.readFileSync(path.resolve(__dirname, 'live/configuration_pack.json'), 'utf8');
let real;
try { real = bw.decodeConfig(realRaw); } catch (e) { real = null; console.log('  decode REAL threw:', e.message); }
check('decodeConfig REAL parses', !!real);
if (real) {
  const contents = real['configuration']['contents'];
  check('REAL contents count 204', contents && contents.length === 204, contents && contents.length);
  check('REAL first page p-cover', contents && contents[0].file === 'OEBPS/text/p-cover.xhtml');
  const p0 = real['OEBPS/text/p-0000.xhtml'];
  check('REAL p-0000 NS', p0 && p0.FileLinkInfo.PageLinkInfoList[0].Page.NS === 3668519577);
}

// 3) pageSeeds on real p-0000 -> must equal python (442, 1028557846, 1113689316, 3394876767)
if (real) {
  const k = bw.state.keys;
  const s = bw.pageSeeds('OEBPS/text/p-0000.xhtml', real['OEBPS/text/p-0000.xhtml'], k[0], k[1], k[2]);
  check('pageSeeds p-0000', s.B0A === 442 && s.B0J === 1028557846 && s.B0K === 1113689316 && s.B0n === 3394876767,
    JSON.stringify({B0A:s.B0A,B0J:s.B0J,B0K:s.B0K,B0n:s.B0n}));
}

// 4) A9p fixture
const fx = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'bookworm/src/exported/__fixtures__/A9p-001.json'), 'utf8'));
const tiles = bw.A9p(fx.input[0], fx.input[1], fx.input[2]);
let mism = 0;
for (let i = 0; i < fx.output.length; i++) if (JSON.stringify(tiles[i]) !== JSON.stringify(fx.output[i])) mism++;
check('A9p fixture 2052 tiles 0 mism', tiles.length === 2052 && mism === 0, `tiles=${tiles.length} mism=${mism}`);

// 5) b8g filename tokens vs real HAR
if (real) {
  const k = bw.state.keys;
  const truth = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'live/token_truth.json'), 'utf8'));
  let ok = 0;
  for (const [p, tok] of Object.entries(truth)) {
    const got = bw.b8g('OEBPS/text/' + p + '.xhtml', k[0], k[1], k[2]).split('/').pop().replace('.jpeg', '');
    if (got === tok) ok++;
  }
  check('b8g tokens 25/25', ok === Object.keys(truth).length, `${ok}/${Object.keys(truth).length}`);
}

console.log(failures === 0 ? '\nALL USERSCRIPT CHECKS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 2);
