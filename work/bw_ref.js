// Standalone JS reference: bookworm crypto copied verbatim (no TS imports)
'use strict';
const fs = require('fs');

function arraySwap(arr, a, b) { const t = arr[a]; arr[a] = arr[b]; arr[b] = t; }

// ---- A8f tables ----
const ARR1 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('');
const ARR2 = ARR1.map(c => c.charCodeAt(0));
const v_3kj = [], v_4kj = [], v_5kj = [], v_6kj = [], v_7kj = [], v_8kj = [], v_9kj = [], v_akj = [];
for (let index = 0; index < 64; index++) {
  const v_bkj = ARR2[index];
  v_3kj[index] = ARR1[index];
  v_4kj[v_bkj] = index;
  v_5kj[v_bkj] = index << 2;
  v_6kj[v_bkj] = (index << 4) & 255;
  v_7kj[v_bkj] = (index << 6) & 255;
  v_8kj[v_bkj] = index >> 2;
  v_9kj[v_bkj] = index >> 4;
  v_akj[v_bkj] = true;
}
const A8f = [v_4kj, v_5kj, v_6kj, v_7kj, v_8kj, v_9kj, v_akj];

// ---- A8j ----
function A8j(content, dataOffset, dataEndOffset) {
  const arrayLength = 32, keyDataLength = 128;
  const payloadOffset = dataOffset + keyDataLength, payloadLength = dataEndOffset - payloadOffset;
  if (payloadLength & 3) throw new Error();
  const v_4ii = new Array(arrayLength), v_5ii = new Array(arrayLength), v_6ii = new Array(arrayLength);
  for (let i = dataOffset, activeArray = v_4ii, activeArrayIndex = 0; i < payloadOffset; ) {
    const a = content.charCodeAt(i++), b = content.charCodeAt(i++), c = content.charCodeAt(i++), d = content.charCodeAt(i++);
    if (!(A8f[6][a] && A8f[6][b] && A8f[6][c] && A8f[6][d])) throw new Error();
    activeArray[activeArrayIndex++] = A8f[1][a] | A8f[5][b];
    if (i === dataOffset + 88) { activeArray = v_6ii; activeArrayIndex = 0; }
    activeArray[activeArrayIndex++] = A8f[2][b] | A8f[4][c];
    if (i === dataOffset + 44) { activeArray = v_5ii; activeArrayIndex = 0; }
    activeArray[activeArrayIndex++] = A8f[3][c] | A8f[0][d];
  }
  if (payloadLength === 0) return [new Uint8Array(0), 0, v_4ii, v_5ii, v_6ii];
  let resultLength = (payloadLength * 3) >> 2;
  if (content.charCodeAt(dataEndOffset - 2) === 61) resultLength -= 2;
  else if (content.charCodeAt(dataEndOffset - 1) === 61) resultLength -= 1;
  const result = new Uint8Array(resultLength);
  let chuckOffset = payloadOffset, index = 0;
  for (; chuckOffset < dataEndOffset - 4; ) {
    const c1 = content.charCodeAt(chuckOffset++), c2 = content.charCodeAt(chuckOffset++), c3 = content.charCodeAt(chuckOffset++), c4 = content.charCodeAt(chuckOffset++);
    if (!(A8f[6][c1] && A8f[6][c2] && A8f[6][c3] && A8f[6][c4])) throw new Error();
    result[index++] = A8f[1][c1] | A8f[5][c2];
    result[index++] = A8f[2][c2] | A8f[4][c3];
    result[index++] = A8f[3][c3] | A8f[0][c4];
  }
  const v_uii = content.charCodeAt(chuckOffset++), v_vii = content.charCodeAt(chuckOffset++), v_wii = content.charCodeAt(chuckOffset++), v_xii = content.charCodeAt(chuckOffset++);
  if (!A8f[6][v_uii] || !A8f[6][v_vii]) throw new Error();
  result[index++] = A8f[1][v_uii] | A8f[5][v_vii];
  if (A8f[6][v_wii]) {
    result[index++] = A8f[2][v_vii] | A8f[4][v_wii];
    if (A8f[6][v_xii]) { result[index++] = A8f[3][v_wii] | A8f[0][v_xii]; }
    else if (v_xii !== 61) throw new Error();
  } else if (v_wii !== 61 || v_xii !== 61) throw new Error();
  return [result, resultLength, v_4ii, v_5ii, v_6ii];
}

// ---- a0F / a0g / v_qmi / v_smi ----
function a0F(input) {
  const result = new Array(256).fill(0).map((_, index) => index);
  const getFromInput = typeof input === 'string' ? input.charCodeAt.bind(input) : index => input[index];
  for (let c = 0, i = 0; i < 256; i++) {
    const index = i % input.length;
    c = (c + result[i] + getFromInput(index)) % 256;
    arraySwap(result, i, c);
  }
  return result;
}
function a0g(key, b) {
  const result = []; const g = a0F(b);
  for (let i = 0, c = 0, d = 0; i < key.length; i++) {
    c = (c + 1) % 256; d = (d + g[c]) % 256; arraySwap(g, c, d);
    const e = (g[c] + g[d]) % 256;
    result.push(key[i] ^ g[e]);
  }
  return result;
}
const v_qmi = (p1, p2, p3) => a0F([...p1, ...p2, ...p3]);
const v_smi = (content, p1, p2, p3) => a0g(content, [...p1, ...p2, ...p3]);

// ---- processContentStep ----
function step(v_7ki, v_8ki, i, key, content) {
  v_7ki = (v_7ki + 1) % 256;
  v_8ki = (v_8ki + key[v_7ki]) % 256;
  arraySwap(key, v_7ki, v_8ki);
  content[i] ^= key[(key[v_7ki] + key[v_8ki]) % 256];
  return [v_7ki, v_8ki];
}
function processContentStep([content, contentLength, key1, key2, key3], key, i) {
  for (let v_7ki = 0, v_8ki = 0; i >= 0; i -= 2) { [v_7ki, v_8ki] = step(v_7ki, v_8ki, i, key, content); }
  return [content, contentLength, key1, key2, key3];
}

// ---- A3b ----
function check1(n, m) { return (n & m) === m; }
function process1(v_0li, v_1li, key) {
  for (let i = 0; i < 32; i++) { v_0li = (v_0li + key[i]) & 255; v_1li ^= key[i]; }
  return [v_0li, v_1li];
}
function process2(v_yli, v_uli, v_gli) {
  for (let v_vli = v_yli; v_uli > v_yli; v_uli--, v_vli--) { arraySwap(v_gli, v_uli, v_vli); }
}
function A3b(v_ofi, [content, contentLength, key1, key2, key3]) {
  let v_jki, v_kki, v_lki, v_mki, v_nki, v_oki;
  switch (v_ofi) {
    case 3: v_jki = key1; v_kki = 32; v_oki = 32; v_lki = key2; v_mki = key3; v_nki = null; break;
    case 2: v_jki = key2; v_kki = 32; v_oki = 32; v_lki = key1; v_mki = key3; v_nki = null; break;
    case 1: v_jki = key3; v_kki = 32; v_oki = 32; v_lki = key1; v_mki = key2; v_nki = null; break;
    case 0: v_jki = content; v_kki = contentLength; v_oki = 65536; v_lki = key1; v_mki = key2; v_nki = key3; break;
  }
  let [v_0li, v_1li] = process1(0, 0, v_lki);
  [v_0li, v_1li] = process1(v_0li, v_1li, v_mki);
  if (v_nki) [v_0li, v_1li] = process1(v_0li, v_1li, v_nki);
  const v_0liFlag2 = !check1(v_0li, 2), v_0liFlag4 = !check1(v_0li, 4), v_0liFlag8 = !check1(v_0li, 8),
    v_5li = v_1li >>> 5, v_6li = 8 - v_5li;
  let v_7li = 0;
  const v_gli = [];
  for (let v_pli, v_qli, v_rli, v_sli, v_tli, v_uli, v_wli, v_xli, v_zli; v_7li < v_kki; ) {
    for (
      v_pli = v_7li + 32, v_qli = v_pli > v_kki,
        v_qli ? ((v_pli = v_kki), (v_rli = v_pli - v_7li)) : (v_rli = 32),
        v_wli = v_0li, v_xli = v_1li, v_tli = 0, v_uli = v_7li;
      v_tli < v_rli;
    ) {
      v_sli = v_jki[v_uli++];
      if (v_0liFlag2) v_sli = ((v_sli & 85) << 1) | ((v_sli >>> 1) & 85);
      if (v_0liFlag4) v_sli = ((v_sli & 51) << 2) | ((v_sli >>> 2) & 51);
      if (v_0liFlag8) v_sli = ((v_sli & 15) << 4) | ((v_sli >>> 4) & 15);
      v_gli[v_tli++] = v_sli;
      v_wli = (v_wli + v_sli) & 255;
      v_xli ^= v_sli;
    }
    for (let j = 0; j < v_rli; j++) {
      for (let i = 1; i <= 6; i++) {
        const a = Math.pow(2, i);
        if (!check1(j, a - 1)) break;
        if (!check1(v_wli, a)) process2(j - Math.pow(2, i - 1), j, v_gli);
      }
    }
    v_zli = v_xli >>> 3;
    v_qli ? (v_zli %= v_rli) : (v_zli &= 31);
    if (v_5li === 0) {
      for (let i = v_7li, j = v_rli - v_zli; i < v_pli; ) {
        if (j === v_rli) j = 0;
        v_jki[i++] = v_gli[j++];
      }
    } else {
      for (let i = v_7li, j = v_rli - v_zli - 1; i < v_pli; ) {
        v_sli = v_gli[j] << v_6li;
        if (++j === v_rli) j = 0;
        v_sli |= v_gli[j] >>> v_5li;
        v_jki[i++] = v_sli & 255;
      }
    }
    v_7li = v_pli;
  }
  return [content, contentLength, key1, key2, key3];
}

// ---- B0p / A7L / A6I / A2F / B0L / tB0l ----
function B0p(filenameKey, [content, contentLength, key1, key2, key3]) {
  const key = v_qmi(key2, filenameKey, key3);
  for (let offset = 0, v_omi = 0; offset < contentLength; v_omi %= 256) { content[offset++] ^= key[v_omi++]; }
  return [content, contentLength, key1, key2, key3];
}
function A7L(filenameKey, [content, contentLength, key1, key2, key3]) {
  const i = (contentLength | 1) - 2;
  const key = v_qmi(filenameKey, key1, key2);
  return processContentStep([content, contentLength, key1, key2, key3], key, i);
}
function A6I(filenameKey, [content, contentLength, key1, key2, key3]) {
  const i = (contentLength - 1) & -2;
  const key = v_qmi(key3, filenameKey, key1);
  return processContentStep([content, contentLength, key1, key2, key3], key, i);
}
function A2F([content, contentLength, key1, key2, key3]) {
  const v_dmi = Math.min(32, contentLength);
  let v_6mi, v_7mi;
  for (let i = 0; i < v_dmi; i++) {
    const v_8mi = content[i] ^ key1[i] ^ key2[i] ^ key3[i];
    switch (v_8mi & 12) {
      case 0: v_6mi = key1[i]; break; case 4: v_6mi = key2[i]; break; case 8: v_6mi = key3[i]; break; case 12: v_6mi = content[i];
    }
    switch (v_8mi & 3) {
      case 0: v_7mi = key1[i]; key1[i] = v_6mi; break; case 1: v_7mi = key2[i]; key2[i] = v_6mi; break;
      case 2: v_7mi = key3[i]; key3[i] = v_6mi; break; case 3: v_7mi = content[i]; content[i] = v_6mi;
    }
    switch (v_8mi & 12) {
      case 0: key1[i] = v_7mi; break; case 4: key2[i] = v_7mi; break; case 8: key3[i] = v_7mi; break; case 12: content[i] = v_7mi;
    }
    switch (v_8mi & 192) {
      case 0: v_6mi = key1[i]; break; case 64: v_6mi = key2[i]; break; case 128: v_6mi = key3[i]; break; case 192: v_6mi = content[i];
    }
    switch (v_8mi & 48) {
      case 0: v_7mi = key1[i]; key1[i] = v_6mi; break; case 16: v_7mi = key2[i]; key2[i] = v_6mi; break;
      case 32: v_7mi = key3[i]; key3[i] = v_6mi; break; case 48: v_7mi = content[i]; content[i] = v_6mi;
    }
    switch (v_8mi & 192) {
      case 0: key1[i] = v_7mi; break; case 64: key2[i] = v_7mi; break; case 128: key3[i] = v_7mi; break; case 192: content[i] = v_7mi;
    }
  }
  return [content, contentLength, key1, key2, key3];
}
function B0L(filenameKey, [content, contentLength, key1, key2, key3]) {
  key3 = v_smi(key3, key2, key1, filenameKey);
  key2 = v_smi(key2, key1, filenameKey, key3);
  key1 = v_smi(key1, filenameKey, key3, key2);
  return [content, contentLength, key1, key2, key3];
}
function tB0l(filenameKey, [content, contentLength, key1, key2, key3]) {
  const key = v_qmi(key3, key2, filenameKey);
  for (let i = 0, v_7ki = 0, v_8ki = 0; i < contentLength; i++) { [v_7ki, v_8ki] = step(v_7ki, v_8ki, i, key, content); }
  return [content, contentLength, key1, key2, key3];
}

// ---- processFilename (UTF-8) ----
function processFilename(filename) { return Array.from(Buffer.from(filename, 'utf8')); }

// ---- A6e ----
function A6e([content, contentLength, key1, key2, key3]) {
  const decodedContent = [];
  for (let contentOffset = 0; contentOffset < contentLength; ) {
    const char = content[contentOffset++];
    if (char < 128) { decodedContent.push(char); continue; }
    const v_zgi = content[contentOffset];
    if (contentOffset >= contentLength || char < 194 || char > 244 || !isPassCheck1(v_zgi) ||
      (char === 224 && v_zgi < 160) || (char === 237 && v_zgi >= 160) || (char === 240 && v_zgi < 144) || (char === 244 && v_zgi >= 144)) {
      decodedContent.push(65533); continue;
    }
    contentOffset++;
    if (char < 224) { decodedContent.push((v_zgi & 63) | ((char & 31) << 6)); continue; }
    const v_0hi = content[contentOffset];
    if (contentOffset >= contentLength || !isPassCheck1(v_0hi)) { decodedContent.push(65533); continue; }
    contentOffset++;
    if (char < 240) { decodedContent.push((v_0hi & 63) | ((v_zgi & 63) << 6) | ((char & 15) << 12)); continue; }
    const v_1hi = content[contentOffset];
    if (contentOffset >= contentLength || !isPassCheck1(v_1hi)) { decodedContent.push(65533); continue; }
    contentOffset++;
    const v_2hi = ((v_0hi & 48) >> 4) | ((v_zgi & 63) << 2) | ((char & 7) << 8);
    const v_3hi = (v_1hi & 63) | ((v_0hi & 15) << 6);
    decodedContent.push(55232 + v_2hi); decodedContent.push(56320 + v_3hi);
  }
  return [decodedContent.map(v => String.fromCharCode(v)).join(''), key1, key2, key3];
}
function isPassCheck1(v_0hi) { return (v_0hi & 192) === 128; }

// ---- Config.decode ----
function decodeConfig(content, filename = 'configuration_pack.json') {
  const DATA_STR = '"data":"';
  const dataOffset = content.indexOf(DATA_STR) + DATA_STR.length;
  const dataEndOffset = content.indexOf('"', dataOffset);
  if (dataEndOffset - dataOffset < 128) throw new Error();
  const filenameKey = processFilename(filename);
  let state = A8j(content, dataOffset, dataEndOffset);
  const steps = [
    s => A3b(0, s), s => B0p(filenameKey, s), s => A7L(filenameKey, s), s => A6I(filenameKey, s),
    A2F, s => B0L(filenameKey, s), s => A3b(1, s), s => A3b(2, s), s => A3b(3, s), s => tB0l(filenameKey, s),
  ];
  for (const fn of steps) state = fn(state);
  return A6e(state);
}

const raw = fs.readFileSync('bookworm/src/__fixtures__/configuration_pack-001-encoded.json', 'utf8');
const [jsonStr] = decodeConfig(raw);
console.log('decoded head:', JSON.stringify(jsonStr.slice(0, 120)));
console.log('decoded len:', jsonStr.length);
try { const p = JSON.parse(jsonStr); console.log('JSON OK, type', Array.isArray(p) ? 'array len ' + p.length : 'object'); }
catch (e) { console.log('JSON FAIL', e.message); }
