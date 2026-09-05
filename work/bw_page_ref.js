// bw_page_ref.js — BookWalker page-seeds + B2y PRNG + a3f shuffle + A9p tile script
// Ported 1:1 from aaa4xu/bookworm TS (B2y.ts, a3f.ts, A9p.ts, Page.ts) and validated
// against the A9p-001 fixture + the real decoded config.
'use strict';

// ---------- B2y ----------
const v_cgh = JSON.parse(
  '[[1,3,10],[1,5,16],[1,5,19],[1,9,29],[1,11,6],[1,11,16],[1,19,3],[1,21,20],[1,27,27],[2,5,15],[2,5,21],[2,7,7],[2,7,9],[2,7,25],[2,9,15],[2,15,17],[2,15,25],[2,21,9],[3,1,14],[3,3,26],[3,3,28],[3,3,29],[3,5,20],[3,5,22],[3,5,25],[3,7,29],[3,13,7],[3,23,25],[3,25,24],[3,27,11],[4,3,17],[4,3,27],[4,5,15],[5,3,21],[5,7,22],[5,9,7],[5,9,28],[5,9,31],[5,13,6],[5,15,17],[5,17,13],[5,21,12],[5,27,8],[5,27,21],[5,27,25],[5,27,28],[6,1,11],[6,3,17],[6,17,9],[6,21,7],[6,21,13],[7,1,9],[7,1,18],[7,1,25],[7,13,25],[7,17,21],[7,25,12],[7,25,20],[8,7,23],[8,9,23],[9,5,14],[9,5,25],[9,11,19],[9,21,16],[10,9,21],[10,9,25],[11,7,12],[11,7,16],[11,17,13],[11,21,13],[12,9,23],[13,3,17],[13,3,27],[13,5,19],[13,17,15],[14,1,15],[14,13,15],[15,1,29],[17,15,20],[17,15,23],[17,15,26]]');
const v_dgh = [
  (p1, p2, p3, p4) => { p1 ^= p1 << p2; p1 ^= p1 >>> p3; p1 ^= p1 << p4; return p1; },
  (p1, p2, p3, p4) => { p1 ^= p1 << p4; p1 ^= p1 >>> p3; p1 ^= p1 << p2; return p1; },
  (p1, p2, p3, p4) => { p1 ^= p1 >>> p2; p1 ^= p1 << p3; p1 ^= p1 >>> p4; return p1; },
  (p1, p2, p3, p4) => { p1 ^= p1 >>> p4; p1 ^= p1 << p3; p1 ^= p1 >>> p2; return p1; },
  (p1, p2, p3, p4) => { p1 ^= p1 << p2; p1 ^= p1 << p4; p1 ^= p1 >>> p3; return p1; },
  (p1, p2, p3, p4) => { p1 ^= p1 >>> p2; p1 ^= p1 >>> p4; p1 ^= p1 << p3; return p1; },
];
const v_ggh = 2463534242;

class B2y {
  constructor() {
    this.v_kgh = 0;
    this.v_jgh = v_ggh;
    this.v_lgh = v_cgh[74][this.v_kgh++];
    this.v_mgh = v_cgh[74][this.v_kgh++];
    this.v_ngh = v_cgh[74][this.v_kgh++];
    this.v_ogh = v_dgh[0];
  }
  b9es(E, L) {
    this.v_jgh = v_ggh;
    const p = v_cgh[E];
    this.v_lgh = p[0];
    this.v_mgh = p[1];
    this.v_ngh = p[2];
    this.v_ogh = v_dgh[L];
  }
  B0o(p1) {
    const r = p1 >>> 0;
    this.v_jgh = r || v_ggh;
  }
  b4K(p1) {
    if (p1 <= 1) return 0;
    const vv = 4294967295 - p1;
    let u = this.v_jgh, t, s;
    do {
      u = this.v_ogh(u, this.v_lgh, this.v_mgh, this.v_ngh) >>> 0;
      t = u - 1;
      s = t % p1;
    } while (vv < t - s);
    this.v_jgh = u;
    return s;
  }
}
B2y.b6o = v_cgh.length;   // 83
B2y.b6b = v_dgh.length;   // 6
B2y.b4v = B2y.b6o * B2y.b6b; // 498

// ---------- a3f ----------
function v_mqg(fn, total) {
  const o = [];
  for (let i = 0; i < total; i++) {
    const n = fn(i + 1);
    o[i] = o[n];
    o[n] = i;
  }
  return o;
}
function v_6qg(fn, v) { return v < 4 ? fn(v + 1) : fn(v - 1) + 1; }
function v_7qg(fn, ye, ee) {
  if (ee <= 0) return 0;
  const r = fn(ee);
  return r < ye ? r : r + 1;
}
function v_9qg(fn, p2, p3, p4, p5, p6, p7) {
  for (let a, b, c, d = p6, e = p7, f = p4, g = p5, h = 0, i = 0, j = -1; d + e > 0; ) {
    const k = 0, l = j;
    a = fn(d + e);
    if (a < d) {
      if (a < f) {
        for (b = i; b > k && !(h >= p2[b + l]); b--);
        for (c = i + e; c < p7 && !(h >= p2[c]); c++);
        p3[h] = fn(c - b) + b;
        h++;
        f--;
      } else {
        for (b = i; b > k && !(h + d <= p2[b + l]); b--);
        for (c = i + e; c < p7 && !(h + d <= p2[c]); c++);
        p3[h + d + l] = fn(c - b) + b;
      }
      d--;
    } else {
      if (a - d < g) {
        for (b = h; b > k && !(i >= p3[b + l]); b--);
        for (c = h + d; c < p6 && !(i >= p3[c]); c++);
        p2[i] = fn(c - b) + b;
        i++;
        g--;
      } else {
        for (b = h; b > k && !(i + e <= p3[b + l]); b--);
        for (c = h + d; c < p6 && !(i + e <= p3[c]); c++);
        p2[i + e + l] = fn(c - b) + b;
      }
      e--;
    }
  }
}
function v_qpg(p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13) {
  const result = [], q1 = p1 + 1, q2 = p2 + 1, q3 = q1 << 1, q4 = q2 << 1;
  for (let v = 0; v < p1; v++) {
    for (let w = 0; w < p2; w++) {
      const z = p3[v + w * p1];
      const x = z % p1;
      const y = (z - x) / p1;
      const r = v < p11[w] ? v : v + q1;
      const s = w < p10[v] ? w : w + q2;
      const t = x < p7[y] ? x : x + q1;
      const u = y < p6[x] ? y : y + q2;
      result.push(u * q3 + r);
      result.push(t * q4 + s);
    }
  }
  result.push(p9 * q3 + p12);
  result.push(p8 * q4 + p13);
  for (let v = 0; v < p1; v++) {
    const x = p4[v];
    const r = v < p12 ? v : v + q1;
    const t = x < p8 ? x : x + q1;
    result.push(p6[x] * q3 + r);
    result.push(t * q4 + p10[v]);
  }
  for (let w = 0; w < p2; w++) {
    const y = p5[w];
    const s = w < p13 ? w : w + q2;
    const u = y < p9 ? y : y + q2;
    result.push(u * q3 + p11[w]);
    result.push(p7[y] * q4 + s);
  }
  return result;
}
function a3f(p1, p2, p3, p4) {
  const tog = new B2y();
  const uog = p2 ^ p3 ^ p4;
  const vog = Math.floor(p1 / 65536);
  const wog = Math.floor(p2 / 65536);
  const xog = Math.floor(p3 / 65536);
  const yog = Math.floor(p4 / 65536);
  const zo = B2y.b6o, zp = B2y.b6b;
  let p1_ = wog ^ xog ^ yog;
  let p2_ = vog ^ yog;
  let p3_ = p1 ^ p2;
  let p4_ = p1 ^ p3;
  let p5_ = p1 ^ p4;
  p1_ >>>= 16;
  const p6_ = p1_ % zp;
  const p7_ = ((p1_ - p6_) / zp) % zo;
  const b4k = tog.b4K.bind(tog);
  tog.b9es(p7_, p6_);
  tog.B0o(uog);
  const p9_ = b4k(65536) | (b4k(65536) << 16);
  const apg = b4k(512);
  const bpg = wog >>> 16;
  const cpg = xog >>> 16;
  p2_ = (p2_ >>> 16) ^ apg;
  p3_ = (p3_ ^ p9_) >>> 0;
  p4_ = (p4_ ^ p9_) >>> 0;
  p5_ = (p5_ ^ p9_) >>> 0;
  const dpg = p2_ % zp;
  const epg = ((p2_ - dpg) / zp) % zo;
  tog.b9es(epg, dpg);
  tog.B0o(p3_);
  const fpg = v_mqg(b4k, bpg * cpg);
  tog.B0o(p4_);
  const gpg = v_6qg(b4k, bpg);
  const hpg = v_6qg(b4k, cpg);
  const ipg = v_7qg(b4k, gpg, bpg);
  const jpg = v_7qg(b4k, hpg, cpg);
  tog.B0o(p5_);
  const kpg = [], lpg = [];
  v_9qg(b4k, kpg, lpg, gpg, hpg, bpg, cpg);
  const mpg = v_mqg(b4k, bpg);
  const npg = v_mqg(b4k, cpg);
  const opg = [], ppg = [];
  v_9qg(b4k, ppg, opg, ipg, jpg, bpg, cpg);
  return v_qpg(bpg, cpg, fpg, mpg, npg, opg, ppg, ipg, jpg, lpg, kpg, gpg, hpg);
}

// ---------- A9p ----------
function A9p(page, width, height) {
  const blockWidth = page.b8A, blockHeight = page.b6V;
  const r = page.B0J, s = page.B0K, t = page.B0n, u = page.B0A;
  const vo = B2y.b6o, wo = B2y.b6b;
  const blocksX = Math.floor(width / blockWidth);
  const blocksY = Math.floor(height / blockHeight);
  const lastBW = width % blockWidth;
  const lastBH = height % blockHeight;
  const d14 = (blocksX + 1) << 1;
  const d24 = (blocksY + 1) << 1;
  const lastBXVS = (blocksX + 1) * blockWidth - lastBW;
  const lastBYVS = (blocksY + 1) * blockHeight - lastBH;
  const b54 = new B2y();
  const b64 = u ^ blocksX ^ blocksY;
  const b74 = b64 % wo;
  const b84 = ((b64 - b74) / wo) % vo;
  const out = [];
  b54.b9es(b84, b74);
  b54.B0o(r ^ s ^ t);
  const b94 = b54.b4K(65536) + b54.b4K(65536) * 65536 + b54.b4K(512) * 4294967296;
  const a4j = blocksX * 4294967296 + r;
  const b4j = blocksY * 4294967296 + s;
  const c4j = u * 4294967296 + t;
  const d4j = a3f(b94, a4j, b4j, c4j);
  const e4j = (index, total, sbw, sbh) => {
    if (sbw !== 0 && sbh !== 0) {
      for (; index < total; ) {
        const f = d4j[index++], g = d4j[index++];
        const h = f % d14, i = g % d24;
        const j = (g - i) / d24, k = (f - h) / d14;
        out.push({
          srcX: h * blockWidth - (h > blocksX ? lastBXVS : 0),
          srcY: i * blockHeight - (i > blocksY ? lastBYVS : 0),
          destX: j * blockWidth - (j > blocksX ? lastBXVS : 0),
          destY: k * blockHeight - (k > blocksY ? lastBYVS : 0),
          width: sbw,
          height: sbh,
        });
      }
    }
  };
  let x = 0, y = blocksX * blocksY * 2;
  e4j(x, y, blockWidth, blockHeight);
  x = y; y += 2;
  e4j(x, y, lastBW, lastBH);
  x = y; y += blocksX * 2;
  e4j(x, y, blockWidth, lastBH);
  x = y; y += blocksY * 2;
  e4j(x, y, lastBW, blockHeight);
  return out;
}

// ---------- Page seeds (Page.ts) ----------
function pageSeeds(pageId, pageConfig, key1, key2, key3) {
  const Page = pageConfig.FileLinkInfo.PageLinkInfoList[0].Page;
  const NS = Page.NS, PS = Page.PS, RS = Page.RS, No = Page.No;
  let v0if = 47;
  for (let i = 0; i < pageId.length; i++) v0if += pageId.charCodeAt(i);
  const fileName = No.toString(10);
  for (let i = 0; i < fileName.length; i++) v0if += fileName.charCodeAt(i);
  v0if += key1.reduce((a, b) => a + b, 0) + key2.reduce((a, b) => a + b, 0) + key3.reduce((a, b) => a + b, 0);
  let v9if = v0if & 255;
  v9if |= v9if << 8;
  v9if |= v9if << 16;
  function v_mhf(key) {
    let nhf = 0, ohf = key.length & -4;
    if (ohf > 32) ohf = 32;
    for (let phf = 0; phf < ohf; ) {
      nhf ^= key[phf++] << 24;
      nhf ^= key[phf++] << 16;
      nhf ^= key[phf++] << 8;
      nhf ^= key[phf++] << 0;
    }
    return nhf >>> 0;
  }
  return {
    B0A: v0if % B2y.b4v,
    B0J: (v9if ^ v_mhf(key1) ^ NS) >>> 0,
    B0K: (v9if ^ v_mhf(key2) ^ PS) >>> 0,
    B0n: (v9if ^ v_mhf(key3) ^ RS) >>> 0,
    b8A: Page.BlockWidth,
    b6V: Page.BlockHeight,
    Size: Page.Size,
  };
}

// ---------- validate ----------
const fs = require('fs');
const fx = JSON.parse(fs.readFileSync('bookworm/src/exported/__fixtures__/A9p-001.json', 'utf8'));
const page = fx.input[0], w = fx.input[1], h = fx.input[2];
const tiles = A9p(page, w, h);
const exp = fx.output;
let mism = 0;
for (let i = 0; i < exp.length; i++) {
  const a = tiles[i], b = exp[i];
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    mism++;
    if (mism <= 3) console.log('MISMATCH', i, a, b);
  }
}
console.log('A9p fixture: tiles', tiles.length, 'expected', exp.length, 'mismatches', mism);

// real config: decode keys via python helper then test seeds + tokens
const { execSync } = require('child_process');
const keys = JSON.parse(execSync('python3 -c "import sys,json; sys.path.insert(0,\'.\'); import bw_crypto as bc; raw=open(\'live/configuration_pack.json\',encoding=\'utf-8\').read(); p,k1,k2,k3=bc.decode_config(raw); print(json.dumps([k1,k2,k3]))"'));
const parsed = JSON.parse(execSync('python3 -c "import sys,json; sys.path.insert(0,\'.\'); import bw_crypto as bc; raw=open(\'live/configuration_pack.json\',encoding=\'utf-8\').read(); p,k1,k2,k3=bc.decode_config(raw); print(json.dumps(p))"'));
const [k1, k2, k3] = keys;
const s0 = pageSeeds('OEBPS/text/p-0000.xhtml', parsed['OEBPS/text/p-0000.xhtml'], k1, k2, k3);
console.log('p-0000 seeds JS:', s0.B0A, s0.B0J, s0.B0K, s0.B0n, 'tiles:', A9p(s0, 1070, 1600).length);
console.log('  (python gave 442 1028557846 1113689316 3394876767 / 1700 tiles)');
const s17 = pageSeeds('OEBPS/text/p-0017.xhtml', parsed['OEBPS/text/p-0017.xhtml'], k1, k2, k3);
console.log('p-0017 seeds JS:', s17.B0A, s17.B0J, s17.B0K, s17.B0n);
