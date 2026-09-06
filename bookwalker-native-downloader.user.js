// ==UserScript==
// @name         BookWalker Native Downloader
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Download the book open in the BookWalker viewer as a ZIP, or run its pages through the local mokuro-bridge app for Japanese OCR and optional upload. Fetches CDN page files directly and reassembles them offline.
// @author       GolyBidoof
// @match        https://viewer.bookwalker.jp/*
// @match        https://viewer-trial.bookwalker.jp/*
// @match        https://viewer-ptrial.bookwalker.jp/*
// @match        https://viewer-subscription.bookwalker.jp/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=bookwalker.jp
// @grant        GM_xmlhttpRequest
// @connect      learnnatively.com
// @connect      manga-kotoba.com
// @run-at       document-end
// @license      MIT
//
// CREDITS
//   - BookWalker viewer protocol reverse-engineered and validated against
//     live HAR captures + the bookworm offline client (github.com/aaa4xu/bookworm).
//   - Reading stats from LearnNatively (learnnatively.com, by Brandon) and
//     manga-kotoba (manga-kotoba.com, by ChristopherFritz); they own that
//     data and its styling.
//   - OCR via mokuro: a performant fork of kha-white/mokuro
//     (github.com/GolyBidoof/mokuro), run through the companion
//     mokuro-bridge app (github.com/GolyBidoof/mokuro-bridge);
//     upload backend is the bridge's own.
//   - Built with DeepSeek V4 Flash (deepseek.com), the coding model that
//     reverse-engineered and ported the crypto/descramble logic with the author.
//
// NOTE ON PERMISSIONS:
//   On first install Tampermonkey asks for cross-origin access to
//   learnnatively.com (and manga-kotoba.com). That permission powers the
//   reading-stat cards. If you decline it, the script still works fully for
//   downloading/Mokuro — the LearnNatively card is then fetched through a public
//   CORS proxy instead, or hidden if the proxy is unreachable.
// ==/UserScript==
(function () {
    'use strict';

    // App identity
    const BWDD_VERSION = '1.0.0';
    const BWDD_AUTHOR = 'GolyBidoof';
    // Where the panel's GitHub button points.
    const BWDD_REPO_URL = 'https://github.com/GolyBidoof/bookwalker-native-downloader';

    // =====================================================================
    // 1. Capture the viewer's own network responses (browser data reuse)
    // =====================================================================
    const SERVER = 'https://viewer.bookwalker.jp';
    const state = {
        cid: (new URLSearchParams(location.search)).get('cid') || '',
        fileBases: {},
        auth: null,        // {hti, cfg, bid, uuid, pfCd, Policy, Signature, Key-Pair-Id}
        baseUrl: null,     // e.g. https://bw-bv-epubs.bookwalker.jp/3_product/<cid>/1/<pid>/
        cti: null,         // title
        configBody: null,  // encrypted configuration_pack.json text
        configFromUrl: null
    };

    // Shared protocol/presentation constants — single source of truth for
    // values that used to be inlined at every call site.
    const AUTH_PARAM_KEYS = ['hti', 'cfg', 'bid', 'uuid', 'pfCd', 'Policy', 'Signature', 'Key-Pair-Id'];
    const JPEG_QUALITY = 0.92;                // JPEG re-encode quality for output pages
    const EST_BYTES_PER_PAGE = 350 * 1024;    // rough per-page size used for size estimates
    // Debug-only: internals on window.* are exposed only when the viewer URL
    // carries ?bwddDebug=1 (used while validating against HAR captures), so
    // page scripts can't reach mutable script state by default.
    const BWDD_DEBUG = (() => {
        try { return new URLSearchParams(location.search).has('bwddDebug'); } catch (e) { return false; }
    })();

    function findInNFBR(win) {
        const out = { auth: null, baseUrl: null, config: null, cti: null };
        if (!win || !win.NFBR) return out;
        const seen = new Set();
        let budget = 200000;
        function isPlain(o) { return o && typeof o === 'object' && !Array.isArray(o) && !(o instanceof Date) && !(o instanceof RegExp); }
        function skipVal(v) {
            if (v instanceof ArrayBuffer) return true;
            if (ArrayBuffer.isView && ArrayBuffer.isView(v)) return true;
            if (typeof Node !== 'undefined' && v instanceof Node) return true;
            return false;
        }
        function looksLikeAuth(o) {
            return o && typeof o === 'object' && typeof o.Policy === 'string' &&
                typeof o.Signature === 'string' && typeof o['Key-Pair-Id'] === 'string';
        }
        function looksLikeAuthInfo(o) {
            return o && typeof o === 'object' && o.auth_info && looksLikeAuth(o.auth_info);
        }
        function looksLikeConfig(o) {
            return o && typeof o === 'object' && o.configuration && o.configuration.contents &&
                Array.isArray(o.configuration.contents) && o.configuration.contents.length > 0;
        }
        function walk(o, depth) {
            if (!isPlain(o) || depth > 9 || seen.has(o) || budget <= 0) return;
            seen.add(o);
            budget--;
            if (!out.baseUrl && typeof o.url === 'string' && o.url.indexOf('bw-bv-epubs') !== -1 && looksLikeAuthInfo(o)) {
                out.baseUrl = o.url.replace(/\/$/, '') + '/';
                out.auth = o.auth_info;
                if (typeof o.cti === 'string') out.cti = o.cti;
            }
            if (!out.auth && looksLikeAuth(o)) out.auth = o;
            if (!out.config && looksLikeConfig(o)) out.config = o;
            if (out.auth && out.baseUrl && out.config) return;
            for (const k of Object.keys(o)) {
                if (budget <= 0) return;
                const v = o[k];
                if (skipVal(v)) continue;
                if (isPlain(v)) walk(v, depth + 1);
            }
        }
        try {
            walk(win.NFBR, 0);
            try {
                const frames = win.document ? win.document.querySelectorAll('iframe') : [];
                for (const f of frames) {
                    try {
                        const fw = f.contentWindow;
                        if (fw) {
                            const r = findInNFBR(fw);
                            if (r.auth) { out.auth = r.auth; out.baseUrl = r.baseUrl; out.config = r.config; out.cti = r.cti; }
                            if (out.auth && out.baseUrl) break;
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        } catch (e) { console.warn('[bwdd] findInNFBR:', e && e.message); }
        return out;
    }

    async function ensureJSZip() {
        const t0 = Date.now();
        while (!window.JSZip) {
            if (Date.now() - t0 > 15000) break;
            await new Promise(r => setTimeout(r, 200));
        }
        if (window.JSZip) return window.JSZip;
        for (const url of [
            'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
            'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
        ]) {
            try {
                const ok = await new Promise((res) => {
                    const s = document.createElement('script');
                    s.src = url;
                    s.onload = () => res(true);
                    s.onerror = () => res(false);
                    document.head.appendChild(s);
                });
                if (ok && window.JSZip) return window.JSZip;
            } catch (e) {}
        }
        throw new Error('JSZip library could not be loaded from any CDN.');
    }

    // -----------------------------------------------------------------
    // Page cache (IndexedDB)
    // -----------------------------------------------------------------
    let pageDB = null;
    function openPageDB() {
        return new Promise((resolve, reject) => {
            if (pageDB) return resolve(pageDB);
            try {
                const req = indexedDB.open('bwdd-pages-v2', 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages');
                };
                req.onsuccess = () => { pageDB = req.result; resolve(pageDB); };
                req.onerror = () => reject(req.error);
            } catch (e) { reject(e); }
        });
    }
    // Cache entries are {blob, ts} so we can enforce a TTL (entries older than
    // PAGE_CACHE_TTL_MS are purged) and a size cap — the IndexedDB cache must
    // never grow unboundedly and eat the browser's memory/disk.
    const PAGE_CACHE_TTL_MS = 20 * 60 * 1000;   // 20 minutes
    const PAGE_CACHE_MAX_ENTRIES = 4000;        // safety cap (~3 GB at 700 KB/page)
    async function cachePage(cid, index, blob) {
        try {
            const db = await openPageDB();
            const key = cid + ':' + index;
            await new Promise((res, rej) => {
                const tx = db.transaction('pages', 'readwrite');
                tx.objectStore('pages').put({ blob, ts: Date.now() }, key);
                tx.oncomplete = () => res(true);
                tx.onerror = () => rej(tx.error);
            });
            // opportunistic housekeeping: cap size + drop expired entries
            prunePageCache();
            return true;
        } catch (e) { return false; }
    }
    async function getCachedPage(cid, index) {
        try {
            const db = await openPageDB();
            const v = await new Promise((res) => {
                const tx = db.transaction('pages', 'readonly');
                const rq = tx.objectStore('pages').get(cid + ':' + index);
                rq.onsuccess = () => res(rq.result || null);
                rq.onerror = () => res(null);
            });
            if (v && v.blob) return v.blob;
            return null;
        } catch (e) { return null; }
    }
    async function prunePageCache() {
        try {
            const db = await openPageDB();
            const now = Date.now();
            await new Promise((res) => {
                const tx = db.transaction('pages', 'readwrite');
                const st = tx.objectStore('pages');
                const req = st.openCursor();
                let count = 0;
                let oldestKey = null, oldestTs = Infinity;
                req.onsuccess = () => {
                    const cur = req.result;
                    if (!cur) { res(true); return; }
                    count++;
                    const val = cur.value;
                    if (val && val.ts && (now - val.ts) > PAGE_CACHE_TTL_MS) {
                        cur.delete();
                    } else if (val && val.ts && val.ts < oldestTs) {
                        oldestTs = val.ts; oldestKey = cur.key;
                    }
                    cur.continue();
                };
                tx.oncomplete = () => res(true);
                req.onerror = () => res(true);
            });
            // hard cap: if still too many entries, drop oldest until under the cap
            await new Promise((res) => {
                const tx = db.transaction('pages', 'readwrite');
                const st = tx.objectStore('pages');
                const countReq = st.count();
                countReq.onsuccess = () => {
                    const n = countReq.result;
                    if (n <= PAGE_CACHE_MAX_ENTRIES) { res(true); return; }
                    const delReq = st.openCursor();
                    let toDelete = n - PAGE_CACHE_MAX_ENTRIES;
                    delReq.onsuccess = () => {
                        const cur = delReq.result;
                        if (!cur || toDelete <= 0) { res(true); return; }
                        cur.delete(); toDelete--;
                        cur.continue();
                    };
                    delReq.onerror = () => res(true);
                };
                countReq.onerror = () => res(true);
            });
        } catch (e) {}
    }
    async function clearPageCache() {
        try {
            const db = await openPageDB();
            await new Promise((res, rej) => {
                const tx = db.transaction('pages', 'readwrite');
                tx.objectStore('pages').clear();
                tx.oncomplete = () => res(true);
                tx.onerror = () => rej(tx.error);
            });
            console.log('[bwdd] Page cache cleared');
            return true;
        } catch (e) { return false; }
    }

    function apiOriginFromUrl(url) {
        try {
            const m = url.match(/^(https?:\/\/[^/]+)/);
            return m ? m[1] : null;
        } catch (e) { return null; }
    }
    function recordApiBase(url) {
        const o = apiOriginFromUrl(url);
        if (o) state.apiBase = o;
    }
    function apiBase() {
        if (state.apiBase) return state.apiBase;
        try { return window.location.origin; } catch (e) { return ''; }
    }

    // Single reader for captured API/config responses — used by both the
    // fetch and XHR hooks below so the two capture paths can never classify an
    // endpoint differently (they once duplicated this and drifted). Handles:
    //   /browserWebApi/c | /trial-page/c  → full auth reply (auth_info + url)
    //   /browserWebApi/pb                 → incremental auth_info (policy refresh)
    //   configuration_pack.json           → encrypted manifest text (best dir wins)
    function absorbApiResponse(url, text) {
        try {
            if (url.includes('/browserWebApi/c') || url.includes('/trial-page/c')) {
                recordApiBase(url);
                const d = JSON.parse(text);
                if (d.auth_info && d.url) { state.auth = d.auth_info; state.baseUrl = d.url; state.cti = d.cti || state.cti; }
                if (d.auth_info && !d.url) { state.auth = Object.assign({}, state.auth || {}, d.auth_info); }
            } else if (url.includes('/browserWebApi/pb')) {
                recordApiBase(url);
                const d = JSON.parse(text);
                if (d.auth_info) {
                    // pb rotates the CloudFront policy — a changed signature
                    // resets the request-count budget (fetch and XHR capture
                    // paths now behave identically here).
                    const before = authPolicySig();
                    state.auth = Object.assign({}, state.auth || {}, d.auth_info);
                    if (authPolicySig() !== before) resetAuthBudget();
                }
            } else if (url.includes('configuration_pack.json')) {
                const dir = (url.split('?')[0] || '').replace(/configuration_pack\.json$/, '');
                if (!state.configBody || !state.configFromUrl || configPrio(dir) < configPrio(state.configFromUrl)) {
                    state.configBody = text;
                    state.configFromUrl = dir;
                }
            }
        } catch (e) {}
    }

    // Hooks
    const origFetch = window.fetch;
    window.fetch = function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        const p = origFetch.apply(this, args);
        if (url.includes('/browserWebApi/c') || url.includes('/trial-page/c') ||
            url.includes('/browserWebApi/pb') || url.includes('configuration_pack.json')) {
            p.then(r => r.clone().text()).then(t => absorbApiResponse(url, t)).catch(() => {});
        }
        return p;
    };
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__bwUrl = u; return origOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
        try {
            this.addEventListener('load', () => {
                const u = this.__bwUrl || '';
                if (u.includes('/browserWebApi/c') || u.includes('/trial-page/c') ||
                    u.includes('/browserWebApi/pb') || u.includes('configuration_pack.json')) {
                    absorbApiResponse(u, this.responseText);
                }
            });
        } catch (e) {}
        return origSend.apply(this, arguments);
    };

    // =====================================================================
    // 2. Crypto: decrypt configuration_pack.json
    // =====================================================================
    //
    // The viewer's configuration_pack.json is a custom envelope:
    //   { "version":"1.0", "data":"<custom-base64 payload>" }
    // Decoding is a fixed pipeline: custom base64 (A8j) -> a byte-keyed
    // key schedule (A3b / B0p / A7L / A6I / A2F / B0L / tB0l, an RC4 variant)
    // -> UTF-8 JSON of the page manifest. The first 128 chars of the payload
    // are three 32-byte keys (key1/key2/key3) later used to derive per-page
    // descramble seeds (section 3) and image filename tokens (section 4).
    //
    // NOTE: identifiers like A8j, A3b, B0p, v4..v9 are the original names
    // from the minified viewer, preserved verbatim because this port is
    // validated byte-for-byte against live HAR data and the bookworm
    // fixtures (see work/). Renaming them would risk silent drift; the
    // pipeline below is annotated instead.
    // =====================================================================

    // Swap two entries of an array (used by the key-schedule shuffles).
    function arraySwap(arr, a, b) { const t = arr[a]; arr[a] = arr[b]; arr[b] = t; }

    // --- Custom base64 lookup tables (4 chars -> 3 bytes) ---
    // BookWalker's base64 alphabet is the standard A-Z a-z 0-9 + / set, but
    // the decode uses shifted bit masks per byte position (v5..v9).
    const ARR1 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('');
    const ARR2 = ARR1.map(c => c.charCodeAt(0));
    const v4 = [], v5 = [], v6 = [], v7 = [], v8 = [], v9 = [], vak = [];
    for (let i = 0; i < 64; i++) {
        const ch = ARR2[i];
        v4[ch] = i; v5[ch] = i << 2; v6[ch] = (i << 4) & 255;
        v7[ch] = (i << 6) & 255; v8[ch] = i >> 2; v9[ch] = i >> 4; vak[ch] = true;
    }
    const A8f = [v4, v5, v6, v7, v8, v9, vak];

    // Decode the custom base64 payload between dataOffset..dataEndOffset.
    // Returns [decodedBytes, decodedLength, key1, key2, key3] where the keys
    // are the first 128 chars split into three 32-byte registers.
    function A8j(content, dataOffset, dataEndOffset) {
        const arrayLength = 32, keyDataLength = 128;
        const payloadOffset = dataOffset + keyDataLength;
        const payloadLength = dataEndOffset - payloadOffset;
        if (payloadLength & 3) throw new Error('Invalid A8j payload length');
        const k1 = new Array(arrayLength), k2 = new Array(arrayLength), k3 = new Array(arrayLength);
        for (let i = dataOffset, active = k1, ai = 0; i < payloadOffset; ) {
            const a = content.charCodeAt(i++), b = content.charCodeAt(i++), c = content.charCodeAt(i++), d = content.charCodeAt(i++);
            if (!(A8f[6][a] && A8f[6][b] && A8f[6][c] && A8f[6][d])) throw new Error('Corrupted A8j characters');
            active[ai++] = A8f[1][a] | A8f[5][b];
            if (i === dataOffset + 88) { active = k3; ai = 0; }
            active[ai++] = A8f[2][b] | A8f[4][c];
            if (i === dataOffset + 44) { active = k2; ai = 0; }
            active[ai++] = A8f[3][c] | A8f[0][d];
        }
        if (payloadLength === 0) return [new Uint8Array(0), 0, k1, k2, k3];
        let resultLength = (payloadLength * 3) >> 2;
        if (content.charCodeAt(dataEndOffset - 2) === 61) resultLength -= 2;
        else if (content.charCodeAt(dataEndOffset - 1) === 61) resultLength -= 1;
        const result = new Uint8Array(resultLength);
        let off = payloadOffset, idx = 0;
        for (; off < dataEndOffset - 4; ) {
            const c1 = content.charCodeAt(off++), c2 = content.charCodeAt(off++), c3 = content.charCodeAt(off++), c4 = content.charCodeAt(off++);
            if (!(A8f[6][c1] && A8f[6][c2] && A8f[6][c3] && A8f[6][c4])) throw new Error('A8j char failure');
            result[idx++] = A8f[1][c1] | A8f[5][c2];
            result[idx++] = A8f[2][c2] | A8f[4][c3];
            result[idx++] = A8f[3][c3] | A8f[0][c4];
        }
        const u = content.charCodeAt(off++), v = content.charCodeAt(off++), w = content.charCodeAt(off++), x = content.charCodeAt(off++);
        if (!A8f[6][u] || !A8f[6][v]) throw new Error('A8j tail parsing error');
        result[idx++] = A8f[1][u] | A8f[5][v];
        if (A8f[6][w]) {
            result[idx++] = A8f[2][v] | A8f[4][w];
            if (A8f[6][x]) result[idx++] = A8f[3][w] | A8f[0][x];
            else if (x !== 61) throw new Error('A8j tail alignment error');
        } else if (w !== 61 || x !== 61) throw new Error('A8j tail padding error');
        return [result, resultLength, k1, k2, k3];
    }

    function a0F(input) {
        const result = new Array(256).fill(0).map((_, i) => i);
        const get = typeof input === 'string' ? input.charCodeAt.bind(input) : i => input[i];
        for (let c = 0, i = 0; i < 256; i++) {
            c = (c + result[i] + get(i % input.length)) % 256;
            arraySwap(result, i, c);
        }
        return result;
    }
    function a0g(key, b) {
        const result = [], g = a0F(b);
        for (let i = 0, c = 0, d = 0; i < key.length; i++) {
            c = (c + 1) % 256;
            d = (d + g[c]) % 256;
            arraySwap(g, c, d);
            result.push(key[i] ^ g[(g[c] + g[d]) % 256]);
        }
        return result;
    }
    const v_qmi = (p1, p2, p3) => a0F([...p1, ...p2, ...p3]);
    const v_smi = (content, p1, p2, p3) => a0g(content, [...p1, ...p2, ...p3]);

    function step(v7, v8, i, key, content) {
        v7 = (v7 + 1) % 256;
        v8 = (v8 + key[v7]) % 256;
        arraySwap(key, v7, v8);
        content[i] ^= key[(key[v7] + key[v8]) % 256];
        return [v7, v8];
    }
    function processContentStep(st, key, i) {
        const [content, clen, k1, k2, k3] = st;
        let v7 = 0, v8 = 0;
        for (; i >= 0; i -= 2) [v7, v8] = step(v7, v8, i, key, content);
        return [content, clen, k1, k2, k3];
    }

    function check1(n, m) { return (n & m) === m; }
    function process1(v0, v1, key) {
        for (let i = 0; i < 32; i++) { v0 = (v0 + key[i]) & 255; v1 ^= key[i]; }
        return [v0, v1];
    }
    function process2(y, u, g) {
        for (let v = y; u > y; u--, v--) arraySwap(g, u, v);
    }
    function A3b(of, st) {
        let [content, clen, k1, k2, k3] = st;
        let jki, kki, lki, mki, nki;
        switch (of) {
            case 3: jki = k1; kki = 32; lki = k2; mki = k3; nki = null; break;
            case 2: jki = k2; kki = 32; lki = k1; mki = k3; nki = null; break;
            case 1: jki = k3; kki = 32; lki = k1; mki = k2; nki = null; break;
            default: jki = content; kki = clen; lki = k1; mki = k2; nki = k3;
        }
        let [w0, x1] = process1(0, 0, lki);
        [w0, x1] = process1(w0, x1, mki);
        if (nki) [w0, x1] = process1(w0, x1, nki);
        const f2 = !check1(w0, 2), f4 = !check1(w0, 4), f8 = !check1(w0, 8);
        const s5 = x1 >>> 5, s6 = 8 - s5;
        let p7 = 0;
        const gli = [];
        for (let pli, qli, rli, sli, tli, uli, wli, xli, zli; p7 < kki; ) {
            for (
                pli = p7 + 32, qli = pli > kki,
                    qli ? ((pli = kki), (rli = pli - p7)) : (rli = 32),
                    wli = w0, xli = x1, tli = 0, uli = p7;
                tli < rli;
            ) {
                sli = jki[uli++];
                if (f2) sli = ((sli & 85) << 1) | ((sli >>> 1) & 85);
                if (f4) sli = ((sli & 51) << 2) | ((sli >>> 2) & 51);
                if (f8) sli = ((sli & 15) << 4) | ((sli >>> 4) & 15);
                gli[tli++] = sli;
                wli = (wli + sli) & 255;
                xli ^= sli;
            }
            for (let j = 0; j < rli; j++) {
                for (let i = 1; i <= 6; i++) {
                    const a = Math.pow(2, i);
                    if (!check1(j, a - 1)) break;
                    if (!check1(wli, a)) process2(j - Math.pow(2, i - 1), j, gli);
                }
            }
            zli = xli >>> 3;
            qli ? (zli %= rli) : (zli &= 31);
            if (s5 === 0) {
                for (let i = p7, j = rli - zli; i < pli; ) {
                    if (j === rli) j = 0;
                    jki[i++] = gli[j++];
                }
            } else {
                for (let i = p7, j = rli - zli - 1; i < pli; ) {
                    sli = gli[j] << s6;
                    if (++j === rli) j = 0;
                    sli |= gli[j] >>> s5;
                    jki[i++] = sli & 255;
                }
            }
            p7 = pli;
        }
        return [content, clen, k1, k2, k3];
    }

    function B0p(fk, st) {
        const [content, clen, k1, k2, k3] = st;
        const key = v_qmi(k2, fk, k3);
        for (let off = 0, omi = 0; off < clen; omi %= 256) content[off++] ^= key[omi++];
        return [content, clen, k1, k2, k3];
    }
    function A7L(fk, st) {
        const [content, clen, k1, k2, k3] = st;
        const i = (clen | 1) - 2;
        const key = v_qmi(fk, k1, k2);
        return processContentStep([content, clen, k1, k2, k3], key, i);
    }
    function A6I(fk, st) {
        const [content, clen, k1, k2, k3] = st;
        const i = (clen - 1) & -2;
        const key = v_qmi(k3, fk, k1);
        return processContentStep([content, clen, k1, k2, k3], key, i);
    }
    function A2F(st) {
        const [content, clen, k1, k2, k3] = st;
        const dmi = Math.min(32, clen);
        let a, b;
        for (let i = 0; i < dmi; i++) {
            const x = content[i] ^ k1[i] ^ k2[i] ^ k3[i];
            switch (x & 12) { case 0: a = k1[i]; break; case 4: a = k2[i]; break; case 8: a = k3[i]; break; case 12: a = content[i]; }
            switch (x & 3) {
                case 0: b = k1[i]; k1[i] = a; break;
                case 1: b = k2[i]; k2[i] = a; break;
                case 2: b = k3[i]; k3[i] = a; break;
                case 3: b = content[i]; content[i] = a;
            }
            switch (x & 12) { case 0: k1[i] = b; break; case 4: k2[i] = b; break; case 8: k3[i] = b; break; case 12: content[i] = b; }
            switch (x & 192) { case 0: a = k1[i]; break; case 64: a = k2[i]; break; case 128: a = k3[i]; break; case 192: a = content[i]; }
            switch (x & 48) {
                case 0: b = k1[i]; k1[i] = a; break;
                case 16: b = k2[i]; k2[i] = a; break;
                case 32: b = k3[i]; k3[i] = a; break;
                case 48: b = content[i]; content[i] = a;
            }
            switch (x & 192) { case 0: k1[i] = b; break; case 64: k2[i] = b; break; case 128: k3[i] = b; break; case 192: content[i] = b; }
        }
        return [content, clen, k1, k2, k3];
    }
    function B0L(fk, st) {
        let [content, clen, k1, k2, k3] = st;
        k3 = v_smi(k3, k2, k1, fk);
        k2 = v_smi(k2, k1, fk, k3);
        k1 = v_smi(k1, fk, k3, k2);
        return [content, clen, k1, k2, k3];
    }
    function tB0l(fk, st) {
        const [content, clen, k1, k2, k3] = st;
        const key = v_qmi(k3, k2, fk);
        let v7 = 0, v8 = 0;
        for (let i = 0; i < clen; i++) [v7, v8] = step(v7, v8, i, key, content);
        return [content, clen, k1, k2, k3];
    }
    function processFilename(filename) { return Array.from(new TextEncoder().encode(filename)); }
    function A6e(st) {
        const [content, clen] = st;
        return [new TextDecoder('utf-8').decode(content.slice(0, clen))];
    }
    function decodeConfig(content) {
        const DATA_STR = '"data":"';
        const dataOffset = content.indexOf(DATA_STR) + DATA_STR.length;
        const dataEndOffset = content.indexOf('"', dataOffset);
        if (dataEndOffset - dataOffset < 128) throw new Error('Configuration pack format invalid or truncated.');
        const fk = processFilename('configuration_pack.json');
        let st = A8j(content, dataOffset, dataEndOffset);
        st = A3b(0, st); st = B0p(fk, st); st = A7L(fk, st); st = A6I(fk, st); st = A2F(st);
        st = B0L(fk, st); st = A3b(1, st); st = A3b(2, st); st = A3b(3, st); st = tB0l(fk, st);
        const [jsonStr] = A6e(st);
        return JSON.parse(jsonStr);
    }

    // =====================================================================
    // 3. Tile shuffle & descramble arithmetic (A9p)
    // =====================================================================
    const B2Y_TRIPLES = JSON.parse('[[1,3,10],[1,5,16],[1,5,19],[1,9,29],[1,11,6],[1,11,16],[1,19,3],[1,21,20],[1,27,27],[2,5,15],[2,5,21],[2,7,7],[2,7,9],[2,7,25],[2,9,15],[2,15,17],[2,15,25],[2,21,9],[3,1,14],[3,3,26],[3,3,28],[3,3,29],[3,5,20],[3,5,22],[3,5,25],[3,7,29],[3,13,7],[3,23,25],[3,25,24],[3,27,11],[4,3,17],[4,3,27],[4,5,15],[5,3,21],[5,7,22],[5,9,7],[5,9,28],[5,9,31],[5,13,6],[5,15,17],[5,17,13],[5,21,12],[5,27,8],[5,27,21],[5,27,25],[5,27,28],[6,1,11],[6,3,17],[6,17,9],[6,21,7],[6,21,13],[7,1,9],[7,1,18],[7,1,25],[7,13,25],[7,17,21],[7,25,12],[7,25,20],[8,7,23],[8,9,23],[9,5,14],[9,5,25],[9,11,19],[9,21,16],[10,9,21],[10,9,25],[11,7,12],[11,7,16],[11,17,13],[11,21,13],[12,9,23],[13,3,17],[13,3,27],[13,5,19],[13,17,15],[14,1,15],[14,13,15],[15,1,29],[17,15,20],[17,15,23],[17,15,26]]');
    const XSHIFT = [
        (p1, p2, p3, p4) => { p1 ^= p1 << p2; p1 ^= p1 >>> p3; p1 ^= p1 << p4; return p1; },
        (p1, p2, p3, p4) => { p1 ^= p1 << p4; p1 ^= p1 >>> p3; p1 ^= p1 << p2; return p1; },
        (p1, p2, p3, p4) => { p1 ^= p1 >>> p2; p1 ^= p1 << p3; p1 ^= p1 >>> p4; return p1; },
        (p1, p2, p3, p4) => { p1 ^= p1 >>> p4; p1 ^= p1 << p3; p1 ^= p1 >>> p2; return p1; },
        (p1, p2, p3, p4) => { p1 ^= p1 << p2; p1 ^= p1 << p4; p1 ^= p1 >>> p3; return p1; },
        (p1, p2, p3, p4) => { p1 ^= p1 >>> p2; p1 ^= p1 >>> p4; p1 ^= p1 << p3; return p1; },
    ];
    const B2Y_SEED = 2463534242;
    class B2y {
        constructor() {
            this.vk = 0; this.j = B2Y_SEED;
            this.l = B2Y_TRIPLES[74][this.vk++];
            this.m = B2Y_TRIPLES[74][this.vk++];
            this.n = B2Y_TRIPLES[74][this.vk++];
            this.f = XSHIFT[0];
        }
        b9es(E, L) {
            this.j = B2Y_SEED;
            const p = B2Y_TRIPLES[E];
            this.l = p[0]; this.m = p[1]; this.n = p[2]; this.f = XSHIFT[L];
        }
        B0o(p1) { const r = p1 >>> 0; this.j = r || B2Y_SEED; }
        b4K(p1) {
            if (p1 <= 1) return 0;
            const vv = 4294967295 - p1;
            let u = this.j, t, s;
            do {
                u = this.f(u, this.l, this.m, this.n) >>> 0;
                t = u - 1;
                s = t % p1;
            } while (vv < t - s);
            this.j = u;
            return s;
        }
    }
    B2y.b6o = B2Y_TRIPLES.length;
    B2y.b6b = XSHIFT.length;
    B2y.b4v = B2y.b6o * B2y.b6b;

    function v_mqg(fn, total) {
        const o = [];
        for (let i = 0; i < total; i++) { const n = fn(i + 1); o[i] = o[n]; o[n] = i; }
        return o;
    }
    function v_6qg(fn, v) { return v < 4 ? fn(v + 1) : fn(v - 1) + 1; }
    function v_7qg(fn, ye, ee) { if (ee <= 0) return 0; const r = fn(ee); return r < ye ? r : r + 1; }
    function v_9qg(fn, p2, p3, p4, p5, p6, p7) {
        for (let a, b, c, d = p6, e = p7, f = p4, g = p5, h = 0, i = 0, j = -1; d + e > 0; ) {
            const k = 0, l = j;
            a = fn(d + e);
            if (a < d) {
                if (a < f) {
                    for (b = i; b > k && !(h >= p2[b + l]); b--);
                    for (c = i + e; c < p7 && !(h >= p2[c]); c++);
                    p3[h] = fn(c - b) + b;
                    h++; f--;
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
                    i++; g--;
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
        for (let v = 0; v < p1; v++) for (let w = 0; w < p2; w++) {
            const z = p3[v + w * p1], x = z % p1, y = (z - x) / p1;
            const r = v < p11[w] ? v : v + q1;
            const s = w < p10[v] ? w : w + q2;
            const t = x < p7[y] ? x : x + q1;
            const u = y < p6[x] ? y : y + q2;
            result.push(u * q3 + r);
            result.push(t * q4 + s);
        }
        result.push(p9 * q3 + p12);
        result.push(p8 * q4 + p13);
        for (let v = 0; v < p1; v++) {
            const x = p4[v], r = v < p12 ? v : v + q1, t = x < p8 ? x : x + q1;
            result.push(p6[x] * q3 + r);
            result.push(t * q4 + p10[v]);
        }
        for (let w = 0; w < p2; w++) {
            const y = p5[w], s = w < p13 ? w : w + q2, u = y < p9 ? y : y + q2;
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
        let q1 = wog ^ xog ^ yog, q2 = vog ^ yog, q3 = p1 ^ p2, q4 = p1 ^ p3, q5 = p1 ^ p4;
        q1 >>>= 16;
        const r6 = q1 % zp, r7 = ((q1 - r6) / zp) % zo;
        const b4k = tog.b4K.bind(tog);
        tog.b9es(r7, r6);
        tog.B0o(uog);
        const r9 = b4k(65536) | (b4k(65536) << 16);
        const apg = b4k(512);
        const bpg = wog >>> 16, cpg = xog >>> 16;
        q2 = (q2 >>> 16) ^ apg;
        q3 = (q3 ^ r9) >>> 0;
        q4 = (q4 ^ r9) >>> 0;
        q5 = (q5 ^ r9) >>> 0;
        const dpg = q2 % zp, epg = ((q2 - dpg) / zp) % zo;
        tog.b9es(epg, dpg);
        tog.B0o(q3);
        const fpg = v_mqg(b4k, bpg * cpg);
        tog.B0o(q4);
        const gpg = v_6qg(b4k, bpg), hpg = v_6qg(b4k, cpg);
        const ipg = v_7qg(b4k, gpg, bpg), jpg = v_7qg(b4k, hpg, cpg);
        tog.B0o(q5);
        const kpg = [], lpg = [];
        v_9qg(b4k, kpg, lpg, gpg, hpg, bpg, cpg);
        const mpg = v_mqg(b4k, bpg), npg = v_mqg(b4k, cpg);
        const opg = [], ppg = [];
        v_9qg(b4k, ppg, opg, ipg, jpg, bpg, cpg);
        return v_qpg(bpg, cpg, fpg, mpg, npg, opg, ppg, ipg, jpg, lpg, kpg, gpg, hpg);
    }
    function A9p(page, width, height) {
        const bw = page.b8A, bh = page.b6V;
        const r = page.B0J, s = page.B0K, t = page.B0n, u = page.B0A;
        const vo = B2y.b6o, wo = B2y.b6b;
        const bx = Math.floor(width / bw), by = Math.floor(height / bh);
        const lbw = width % bw, lbh = height % bh;
        const d14 = (bx + 1) << 1, d24 = (by + 1) << 1;
        const lxvs = (bx + 1) * bw - lbw, lyvs = (by + 1) * bh - lbh;
        const b54 = new B2y();
        const b64 = u ^ bx ^ by;
        const b74 = b64 % wo, b84 = ((b64 - b74) / wo) % vo;
        const out = [];
        b54.b9es(b84, b74);
        b54.B0o(r ^ s ^ t);
        const b94 = b54.b4K(65536) + b54.b4K(65536) * 65536 + b54.b4K(512) * 4294967296;
        const a4j = bx * 4294967296 + r, b4j = by * 4294967296 + s, c4j = u * 4294967296 + t;
        const d4j = a3f(b94, a4j, b4j, c4j);
        const e4j = (index, total, sbw, sbh) => {
            if (sbw !== 0 && sbh !== 0) for (; index < total; ) {
                const f = d4j[index++], g = d4j[index++];
                const h = f % d14, i = g % d24;
                const j = (g - i) / d24, k = (f - h) / d14;
                out.push({
                    srcX: h * bw - (h > bx ? lxvs : 0),
                    srcY: i * bh - (i > by ? lyvs : 0),
                    destX: j * bw - (j > bx ? lxvs : 0),
                    destY: k * bh - (k > by ? lyvs : 0),
                    width: sbw, height: sbh,
                });
            }
        };
        let x = 0, y = bx * by * 2;
        e4j(x, y, bw, bh);
        x = y; y += 2;
        e4j(x, y, lbw, lbh);
        x = y; y += bx * 2;
        e4j(x, y, bw, lbh);
        x = y; y += by * 2;
        e4j(x, y, lbw, bh);
        return out;
    }
    function pageSeedsNo(pageId, pageConfig, k1, k2, k3, no) {
        const list = pageConfig.FileLinkInfo.PageLinkInfoList;
        const Page = (list[no] && list[no].Page) || list[0].Page;
        const NS = Page.NS, PS = Page.PS, RS = Page.RS, No = Page.No;
        let v0 = 47;
        for (let i = 0; i < pageId.length; i++) v0 += pageId.charCodeAt(i);
        const fn = No.toString(10);
        for (let i = 0; i < fn.length; i++) v0 += fn.charCodeAt(i);
        v0 += k1.reduce((a, b) => a + b, 0) + k2.reduce((a, b) => a + b, 0) + k3.reduce((a, b) => a + b, 0);
        let v9 = v0 & 255;
        v9 |= v9 << 8;
        v9 |= v9 << 16;
        function xorHash(key) {
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
        const noDescramble = NS === null || NS === undefined || PS === null || PS === undefined || RS === null || RS === undefined;
        return {
            B0A: v0 % B2y.b4v,
            B0J: (v9 ^ xorHash(k1) ^ (NS || 0)) >>> 0,
            B0K: (v9 ^ xorHash(k2) ^ (PS || 0)) >>> 0,
            B0n: (v9 ^ xorHash(k3) ^ (RS || 0)) >>> 0,
            b8A: Page.BlockWidth,
            b6V: Page.BlockHeight,
            Size: Page.Size,
            noDescramble,
        };
    }

    // =====================================================================
    // 4. Page image filename token
    // =====================================================================
    function v_jdf(filename) {
        const n = parseInt(filename, 10);
        if (!isNaN(n) && n >= 0 && n <= 1152921504606847000) {
            const h = n.toString(16);
            return h.length.toString(16) + h;
        }
        return '0' + filename;
    }
    function v_hdf(k1, k2, k3) {
        const out = [];
        out.length = Math.max(k1.length, k2.length, k3.length);
        for (let i = 0; i < out.length; i++) out[i] = 0;
        for (let i = 0; i < k1.length; i++) out[i] ^= k1[i];
        for (let i = 0; i < k2.length; i++) out[i] ^= k2[i];
        for (let i = 0; i < k3.length; i++) out[i] ^= k3[i];
        return out;
    }
    const vval = (value) => (value < 10 ? 48 : 87) + value;
    function v_ndf(b9w, pageId, fileName) {
        const parentFolder = pageId + '/';
        const pathLength = parentFolder.length + fileName.length;
        const v_bef = (1 + pathLength) << 1;
        const cef = new Array(v_bef);
        cef[0] = 0; cef[1] = 59;
        const def = String.prototype.charCodeAt.bind(parentFolder + fileName);
        for (let p = 2, o = 0; o < pathLength; o++) {
            const s = def(o);
            cef[p++] = s >>> 8;
            cef[p++] = s % 256;
        }
        let fef = 3;
        for (let eef = (fileName.length << 1) + v_bef + v_bef; eef < 256; fef++) eef += v_bef;
        let jef = 1670739, kef = 1282576, lef = 2237221;
        for (let i = (1 + parentFolder.length) << 1, j = 0, k = 0; k < fef; k++, i = 0) {
            for (; i < v_bef; ) {
                lef ^= cef[i++] ^ b9w[j++];
                const ief = 435 * lef;
                const hef = 435 * kef + ((lef & 7) << 18) + (ief >>> 22);
                const gef = 435 * jef + ((kef & 3) << 19) + ((lef & 4194296) >>> 3) + (hef >>> 21);
                lef = ief & 4194303;
                kef = hef & 2097151;
                jef = gef & 2097151;
                j >= b9w.length && (j = 0);
            }
        }
        const mef = new Array(16);
        const pval = (idx, value) => { mef[idx] = vval(value >>> 4); mef[idx + 1] = vval(value & 15); };
        pval(0, (jef >>> 13) ^ b9w[0]);
        pval(2, ((jef >>> 5) & 255) ^ b9w[1]);
        pval(4, (((jef & 31) << 3) | (kef >>> 18)) ^ b9w[2]);
        pval(6, ((kef >>> 10) & 255) ^ b9w[3]);
        pval(8, ((kef >>> 2) & 255) ^ b9w[4]);
        pval(10, (((kef & 3) << 6) | (lef >>> 16)) ^ b9w[5]);
        pval(12, ((lef >>> 8) & 255) ^ b9w[6]);
        pval(14, (lef & 255) ^ b9w[7]);
        return String.fromCharCode(...mef);
    }
    function b8gNo(pageId, k1, k2, k3, no) {
        const fname = String(no == null ? 0 : no);
        return pageId + '/' + v_jdf(fname) + v_ndf(v_hdf(k1, k2, k3), pageId, fname) + '.jpeg';
    }

    // =====================================================================
    // 5. Auth helpers
    // =====================================================================
    function getU1() {
        const m = document.cookie.match(/(?:^|;\s*)u1=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : '';
    }
    function getBID() {
        try { const v = localStorage.getItem('NFBR.Global/BrowserId'); if (v) return v; } catch (e) {}
        if (state.auth && state.auth.bid) return state.auth.bid;
        return Date.now() + '' + Math.floor(Math.random() * 1e8) + 'NFBR';
    }
    function authQuery(auth) {
        const p = new URLSearchParams();
        for (const k of AUTH_PARAM_KEYS) {
            if (auth[k] !== undefined && auth[k] !== null) p.set(k, auth[k]);
        }
        return p.toString();
    }

    // =====================================================================
    // 6. Worker Pool & Descramble Engine
    // =====================================================================
    function buildWorkerSource() {
        const deps = [
            'const MASK32 = 0xFFFFFFFF;',
            'const AUTH_PARAM_KEYS = ' + JSON.stringify(AUTH_PARAM_KEYS) + ';',
            'const B2Y_TRIPLES = ' + JSON.stringify(B2Y_TRIPLES) + ';',
            'const XSHIFT = [' + XSHIFT.map(f => f.toString()).join(',') + '];',
            'const B2Y_SEED = 2463534242;',
            B2y.toString(),
            'B2y.b6o = ' + B2y.b6o + ';',
            'B2y.b6b = ' + B2y.b6b + ';',
            'B2y.b4v = ' + B2y.b4v + ';',
            v_mqg.toString(),
            v_6qg.toString(),
            v_7qg.toString(),
            v_9qg.toString(),
            v_qpg.toString(),
            a3f.toString(),
            A9p.toString(),
            workerMain.toString(),
            'workerMain();',
        ];
        return deps.join('\n');
    }

    function workerMain() {
        self.onmessage = async (ev) => {
            const { id, relPath, seeds, auth, baseUrl, q, timeoutMs, blob: inputBlob } = ev.data;
            try {
                let blob = inputBlob;
                if (!blob) {
                    const qs = new URLSearchParams();
                    for (const k of AUTH_PARAM_KEYS) {
                        if (auth[k] !== undefined && auth[k] !== null) qs.set(k, auth[k]);
                    }
                    const url = baseUrl + relPath + '?' + qs.toString();
                    let res = null, lastErr = null;
                    for (let attempt = 0; attempt < 3; attempt++) {
                        const ctrl = new AbortController();
                        const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
                        try {
                            res = await fetch(url, { credentials: 'omit', signal: ctrl.signal });
                        } catch (e) {
                            lastErr = e;
                            res = null;
                        } finally {
                            clearTimeout(timer);
                        }
                        if (res && (res.ok || res.status === 403)) break;
                        await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
                    }
                    if (res && res.status === 403) { self.postMessage({ id, error: 'auth-expired' }); return; }
                    if (!res) throw lastErr || new Error('fetch failed after retries');
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    blob = await res.blob();
                }
                const bmp = await createImageBitmap(blob);
                const W = bmp.width, H = bmp.height;
                const canvas = new OffscreenCanvas(W, H);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(bmp, 0, 0);
                if (bmp.close) bmp.close();
                if (!seeds.noDescramble) {
                    const src = ctx.getImageData(0, 0, W, H).data;
                    const out = new Uint8ClampedArray(src.length);
                    const tiles = A9p(seeds, W, H);
                    const stride = W * 4;
                    for (const t of tiles) {
                        const sx = t.destX, sy = t.destY, dx = t.srcX, dy = t.srcY;
                        const tw = t.width, th = t.height;
                        const srcRow = sy * stride + sx * 4;
                        const dstRow = dy * stride + dx * 4;
                        const len = tw * 4;
                        for (let r = 0; r < th; r++) {
                            out.set(src.subarray(srcRow + r * stride, srcRow + r * stride + len), dstRow + r * stride);
                        }
                    }
                    ctx.putImageData(new ImageData(out, W, H), 0, 0);
                }
                let outCanvas = canvas;
                const S = seeds.Size;
                if (S && S.Width && S.Height && (W !== S.Width || H !== S.Height)) {
                    outCanvas = new OffscreenCanvas(S.Width, S.Height);
                    outCanvas.getContext('2d').drawImage(canvas, 0, 0);
                }
                let outBlob;
                if (typeof outCanvas.convertToBlob === 'function') {
                    outBlob = await outCanvas.convertToBlob({ type: 'image/jpeg', quality: q });
                } else {
                    outBlob = await new Promise((res2, rej) => outCanvas.toBlob(b => b ? res2(b) : rej(new Error('toBlob')), 'image/jpeg', q));
                }
                self.postMessage({ id, blob: outBlob });
            } catch (e) {
                const msg = String((e && e.message) || e);
                self.postMessage({ id, error: /abor/i.test(msg) ? 'timeout' : msg });
            }
        };
    }

    function makePool(size, workerSrc, onDone, jobTimeoutMs) {
        const queue = [];
        const workers = [];
        const timers = new Map();

        function spawn() {
            const w = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
            w.busy = false;
            w.jobId = null;
            w.onmessage = (ev) => {
                const id = ev.data && ev.data.id;
                const t = timers.get(id); if (t) { clearTimeout(t); timers.delete(id); }
                w.busy = false; w.jobId = null;
                onDone(ev.data);
                pump();
            };
            w.onerror = () => {
                const id = w.jobId;
                const t = timers.get(id); if (t) { clearTimeout(t); timers.delete(id); }
                w.busy = false; w.jobId = null;
                const idx = workers.indexOf(w);
                if (idx !== -1) workers[idx] = spawn();
                try { w.terminate(); } catch (e2) {}
                onDone({ id, error: 'worker crash' });
                pump();
            };
            return w;
        }
        for (let i = 0; i < size; i++) workers.push(spawn());

        function pump() {
            for (const w of workers) {
                if (w.busy) continue;
                const job = queue.shift();
                if (!job) return;
                w.busy = true;
                w.jobId = job.id;
                const timer = setTimeout(() => {
                    timers.delete(job.id);
                    w.busy = false; w.jobId = null;
                    const idx = workers.indexOf(w);
                    if (idx !== -1) workers[idx] = spawn();
                    try { w.terminate(); } catch (e2) {}
                    onDone({ id: job.id, error: 'timeout' });
                    pump();
                }, jobTimeoutMs);
                timers.set(job.id, timer);
                try {
                    w.postMessage({ id: job.id, relPath: job.relPath, seeds: job.seeds, auth: job.auth, baseUrl: job.baseUrl, q: job.q, timeoutMs: jobTimeoutMs });
                } catch (e) {
                    clearTimeout(timer); timers.delete(job.id);
                    w.busy = false; w.jobId = null;
                    onDone({ id: job.id, error: 'post failed' });
                }
            }
        }
        return {
            submit(job) { queue.push(job); pump(); },
            terminate() { for (const w of workers) { try { w.terminate(); } catch (e) {} } for (const t of timers.values()) clearTimeout(t); timers.clear(); },
        };
    }

    function detectWorkers() {
        try {
            if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return false;
            const src = buildWorkerSource();
            const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
            w.terminate();
            return true;
        } catch (e) { return false; }
    }

    async function fetchWithTimeout(url, opts, ms) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ms);
        try {
            return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
        } finally {
            clearTimeout(timer);
        }
    }

    async function decodeBlobMain(blob, seeds, q) {
        const bmp = await createImageBitmap(blob);
        const W = bmp.width, H = bmp.height;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        if (bmp.close) bmp.close();
        const src = ctx.getImageData(0, 0, W, H).data;
        const out = new Uint8ClampedArray(src.length);
        const tiles = A9p(seeds, W, H);
        const stride = W * 4;
        for (const t of tiles) {
            const sx = t.destX, sy = t.destY, dx = t.srcX, dy = t.srcY;
            const tw = t.width, th = t.height;
            const srcRow = sy * stride + sx * 4;
            const dstRow = dy * stride + dx * 4;
            const len = tw * 4;
            for (let r = 0; r < th; r++) {
                out.set(src.subarray(srcRow + r * stride, srcRow + r * stride + len), dstRow + r * stride);
            }
        }
        ctx.putImageData(new ImageData(out, W, H), 0, 0);
        let outCanvas = canvas;
        const S = seeds.Size;
        if (S && (canvas.width !== S.Width || canvas.height !== S.Height)) {
            outCanvas = document.createElement('canvas');
            outCanvas.width = S.Width;
            outCanvas.height = S.Height;
            outCanvas.getContext('2d').drawImage(canvas, 0, 0);
        }
        return await new Promise((res2, rej) =>
            outCanvas.toBlob(b => b ? res2(b) : rej(new Error('toBlob')), 'image/jpeg', q));
    }

    let rateLimitCooldownUntil = 0;
    let consecutiveBlocks = 0;
    function corsLikeError(e, status) {
        if (status === 429 || status === 503) return true;
        if (status === 403) return true;
        const msg = String((e && e.message) || e);
        return /Failed to fetch|NetworkError|load failed|ERR_|TypeError/i.test(msg);
    }
    async function sleepMs(ms) { await new Promise(r => setTimeout(r, ms)); }
    async function waitOutCooldown() {
        while (rateLimitCooldownUntil > Date.now()) {
            const wait = Math.min(rateLimitCooldownUntil - Date.now(), 10000);
            await sleepMs(wait);
        }
    }
    function tripBreaker() {
        const now = Date.now();
        if (rateLimitCooldownUntil > now) return breakerRemainingMs();
        consecutiveBlocks = Math.min(consecutiveBlocks + 1, 3);
        const cooldownMs = [8000, 16000, 30000][consecutiveBlocks - 1] || 30000;
        rateLimitCooldownUntil = now + cooldownMs;
        console.warn(`[bwdd] CDN protection active: cooling down for ${cooldownMs / 1000}s`);
        return cooldownMs;
    }
    function breakerOpen() { return rateLimitCooldownUntil > Date.now(); }
    function breakerRemainingMs() { return Math.max(0, rateLimitCooldownUntil - Date.now()); }

    let reqsSinceAuth = 0;
    const REQS_PER_POLICY_HARD = 180;
    const REQS_PER_POLICY_RENEW = 100;
    function authRequestBudgetExhausted() { return reqsSinceAuth >= REQS_PER_POLICY_RENEW; }
    function resetAuthBudget() { reqsSinceAuth = 0; }

    function cdnUrl(relPath, fileKey) {
        const qs = new URLSearchParams();
        for (const k of AUTH_PARAM_KEYS) {
            if (state.auth[k] !== undefined && state.auth[k] !== null) qs.set(k, state.auth[k]);
        }
        let base = state.baseUrl;
        if (fileKey && state.fileBases && state.fileBases[fileKey]) {
            base = state.fileBases[fileKey];
        }
        return base + relPath + '?' + qs.toString();
    }
    function cdnBaseCandidates(fileKey, relPath) {
        const out = [];
        const add = (u) => { if (u && out.indexOf(u) === -1) out.push(u); };
        if (fileKey && state.fileBases && state.fileBases[fileKey]) add(state.fileBases[fileKey]);
        if (state.baseUrl) {
            const m = state.baseUrl.match(/^(.*?\/SVGA\/)(?:[^/]+\/)?$/);
            if (m) {
                // Pick the variant this rel actually lives in FIRST. Captures:
                // cover/front-matter/shared pages sit under SVGA/shared while
                // the body pages sit under SVGA/normal_default — a mismatched
                // first guess 403s and (in the old code) stalled the whole run
                // on breaker cooldowns. Guessing right means the first probe
                // usually 200s.
                const isShared = /(^|\/)shared\//.test(relPath || '');
                const variants = isShared ? ['shared', 'normal_default'] : ['normal_default', 'shared'];
                for (const v of variants) add(m[1] + v + '/');
            }
            add(state.baseUrl);
        }
        return out;
    }
    async function cdnFetchWithFallback(relPath, fileKey, timeoutMs) {
        const bases = cdnBaseCandidates(fileKey, relPath);
        let lastErr = null;
        for (let bi = 0; bi < bases.length; bi++) {
            try {
                const res = await cdnFetch(() => bases[bi] + relPath + '?' + authQuery(state.auth), timeoutMs || 45000);
                // Remember which base dir actually served this page family so
                // later pages skip the probe chain entirely (state.fileBases is
                // reset per run in resetRunState).
                if (fileKey && state.fileBases && !state.fileBases[fileKey]) state.fileBases[fileKey] = bases[bi];
                return res;
            } catch (e) {
                lastErr = e;
                // 403 with a still-valid policy = this base-dir guess does not
                // host the file (wrong SVGA variant). That is NOT a rate limit:
                // move to the next candidate immediately, no breaker, no auth
                // churn. (Genuinely expired policies are retried inside
                // cdnFetch, and prefetchOne rotates auth when every candidate
                // path-denies.)
                if (e && e.pathDenied) continue;
                if (breakerOpen()) {
                    await waitOutCooldown();
                    try { await refreshAuthBest(); } catch (e2) {}
                }
            }
        }
        throw lastErr || new Error('All variant endpoints failed for ' + relPath);
    }

    async function cdnFetch(urlBuilder, timeoutMs) {
        await waitOutCooldown();
        // Policy-clock renewal: every /browserWebApi/pb response mints a
        // CloudFront policy whose DateLessThan is ~60 s out (verified on all
        // live captures), and no capture shows a per-policy *request* quota on
        // valid paths. Refresh when the current policy is about to lapse OR the
        // legacy request-count budget trips; count alone was refreshing far too
        // eagerly during 128-wide bursts.
        if ((!authLooksFresh() || reqsSinceAuth >= REQS_PER_POLICY_RENEW) && authRefreshPromise === null) {
            try {
                const before = authPolicySig();
                await refreshAuthBest();
                if (authPolicySig() !== before) reqsSinceAuth = 0;
            } catch (e) {}
        }
        let lastStatus = 0;
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            let res = null, err = null;
            try {
                res = await fetchWithTimeout(urlBuilder(), { credentials: 'omit' }, timeoutMs || 45000);
            } catch (e) { err = e; }
            const status = res ? res.status : 0;
            reqsSinceAuth++;
            if (res && res.ok) {
                consecutiveBlocks = 0;
                return res;
            }
            lastStatus = status; lastErr = err;
            if (status === 403) {
                // A 403 while the policy still has runway is a PATH denial:
                // this base-dir guess does not host the file. Captures show the
                // same token 200s under .../SVGA/shared or .../SVGA/normal_default
                // while bare .../SVGA or .../shared guesses 403 forever, even
                // with the newest signature. Refreshing auth cannot fix a wrong
                // path and must NOT trip the global 8-30 s breaker: signal
                // pathDenied so the caller tries the next base dir instantly.
                // Only when the policy itself has lapsed do we rotate once and
                // retry before giving that verdict.
                if (!authLooksFresh() && attempt < 2) {
                    const before = authPolicySig();
                    try { await refreshAuthBest(); } catch (e2) {}
                    if (authPolicySig() !== before) { reqsSinceAuth = 0; continue; }
                }
                const e2 = new Error('CDN denied path (Status: 403)');
                e2.status = 403;
                e2.pathDenied = true;
                throw e2;
            }
            const blocked = corsLikeError(err, status);
            if (blocked) {
                if (attempt < 2) { await sleepMs(1200 * (attempt + 1)); continue; }
                tripBreaker();
                const e2 = new Error('CDN rate limiter reached (Status: ' + status + ')');
                e2.status = status;
                throw e2;
            }
            if (res) { const e2 = new Error('HTTP ' + status); e2.status = status; throw e2; }
            throw (err || new Error('CDN request failed'));
        }
        const e4 = new Error('Retries exhausted for CDN slice (Last status: ' + lastStatus + ')');
        e4.status = lastStatus;
        throw e4;
    }
    function effectiveBurst(base) {
        if (consecutiveBlocks === 0) return base;
        return Math.max(4, Math.floor(base / (consecutiveBlocks + 1)));
    }
    function authPolicySig() {
        try { return (state.auth && state.auth['Policy'] || '') + '|' + (state.auth && state.auth['Signature'] || ''); }
        catch (e) { return ''; }
    }

    async function fetchAndDescramble(relPath, seeds, q, timeoutMs) {
        const res = await cdnFetch(() => state.baseUrl + relPath + '?' + authQuery(state.auth), timeoutMs || 60000);
        if (!res.ok) throw new Error('HTTP error ' + res.status);
        const blob = await res.blob();
        return await decodeBlobMain(blob, seeds, q);
    }

    // =====================================================================
    // 7. Manga stats bridge (manga-kotoba + LearnNatively)
    // =====================================================================
    // Cross-origin fetch for the stats bridges.
    //  - manga-kotoba.com reflects any Origin, so plain fetch() works.
    //  - learnnatively.com sends NO CORS headers. GM_xmlhttpRequest bypasses
    //    that, but only if the user accepted the GM_xmlhttpRequest permission.
    //    If they didn't (or the manager doesn't expose it), fall back to a
    //    public CORS proxy so the LearnNatively card still works.
    const CORS_PROXIES = [
        'https://corsproxy.io/?url=',
        'https://api.allorigins.win/raw?url=',
    ];
    async function gmFetch(url, timeoutMs = 20000) {
        // 1) native GM_xmlhttpRequest (bypasses CORS) when granted
        if (typeof GM_xmlhttpRequest === 'function') {
            try {
                return await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET', url, timeout: timeoutMs,
                        onload: (r) => resolve({ status: r.status, text: r.responseText }),
                        onerror: (e) => reject(new Error('GM_xhr: ' + (e && e.error))),
                        ontimeout: () => reject(new Error('GM_xhr: Timeout')),
                    });
                });
            } catch (e) { /* fall through to proxies */ }
        }
        // 2) plain fetch (works for CORS-friendly hosts like manga-kotoba)
        try {
            const r = await fetch(url, { credentials: 'omit' });
            return { status: r.status, text: await r.text() };
        } catch (e) { /* fall through to proxies */ }
        // 3) public CORS proxies (LearnNatively without GM permission)
        for (const proxy of CORS_PROXIES) {
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), timeoutMs);
                const r = await fetch(proxy + encodeURIComponent(url), { signal: ctrl.signal });
                clearTimeout(timer);
                if (r.ok) return { status: r.status, text: await r.text() };
            } catch (e) { /* try next proxy */ }
        }
        throw new Error('fetch failed: ' + url.slice(0, 80));
    }
    function extractVolumeNumber(title) {
        const t = String(title || '');
        const full = t.match(/([0-9０-９]+|[０-９]+)/) || t.match(/([0-9]+)/);
        if (full) {
            const digits = full[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
            return parseInt(digits, 10);
        }
        const kanji = t.match(/[一二三四五六七八九十百]+[巻話]/);
        if (kanji) return kanjiNum(kanji[0]);
        return NaN;
    }
    function kanjiNum(s) {
        const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
        let n = 0, m = 0;
        for (const ch of s) {
            if (map[ch]) m = map[ch];
            else if (ch === '十') { n += (m || 1) * 10; m = 0; }
            else if (ch === '百') { n += (m || 1) * 100; m = 0; }
        }
        return n + m || 1;
    }
    function parseMangaKotobaTable(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const rows = doc.querySelectorAll('#series-volume-stats tbody tr, table#series-volume-stats tr');
        const out = [];
        for (const tr of rows) {
            const a = tr.querySelector('a[href*="/volume/"]');
            if (!a) continue;
            const cells = tr.querySelectorAll('td');
            if (cells.length < 7) continue;
            const num = (s) => parseInt((s || '').replace(/,/g, '').trim(), 10);
            const pct = (s) => parseFloat((s || '').replace('%', '').trim());
            out.push({
                title: a.textContent.trim(),
                href: a.getAttribute('href'),
                total: num(cells[2] ? cells[2].textContent : ''),
                unique: num(cells[3] ? cells[3].textContent : ''),
                usedOnce: num(cells[4] ? cells[4].textContent : ''),
                usedOncePct: pct(cells[5] ? cells[5].textContent : ''),
                newWords: num(cells[6] ? cells[6].textContent : ''),
                density: parseFloat((cells[7] ? cells[7].textContent : '').trim()),
            });
        }
        return out;
    }
    async function lookupMangaKotoba(seriesTitle, volumeNum) {
        try {
            let links = null;
            let search = '';
            let usedTitle = seriesTitle;
            for (const cand of searchTitleCandidates(seriesTitle)) {
                const q = encodeURIComponent(cand);
                const text = await (await fetch('https://manga-kotoba.com/search/series/?q=' + q)).text();
                const doc = new DOMParser().parseFromString(text, 'text/html');
                const l = [...doc.querySelectorAll('a[href*="/series/"]')];
                if (l.length) { links = l; search = text; usedTitle = cand; break; }
            }
            if (!links) return null;
            const norm = (x) => String(x || '').replace(/[\s　\u30fb・:：()（）]/g, '').toLowerCase();
            const target = norm(usedTitle);
            // manga-kotoba's /series/ results wrap an entire card in the anchor
            // (Japanese title, English title, author, label, genres…), so
            // anchor.textContent is far broader than the series name — the old
            // "whole-anchor substring" scoring made any spin-off listed before
            // the base series win, because its card merely *contains* the name
            // (e.g. 幸色のワンルーム　外伝　正壊の名探偵 beat 幸色のワンルーム).
            // Match against the card's own Japanese title when present, and
            // break substring ties toward the closest (shortest) title.
            const titleOf = (a) => {
                const h = a.querySelector('.japanese-title, .series-title, h3');
                if (h) { const x = (h.textContent || '').trim(); if (x) return x; }
                const line = String(a.textContent || '').split(/\n/).map(x => x.trim()).find(Boolean);
                return line || '';
            };
            let best = null, bestScore = 0, bestExtra = Infinity;
            for (const a of links) {
                const t = norm(titleOf(a));
                if (!t || !target) continue;
                let score = 0;
                if (t === target) score = 1000;
                else if (t.indexOf(target) !== -1) score = target.length;
                else if (target.indexOf(t) !== -1) score = t.length;
                if (!score) continue;
                const extra = t.length - target.length;
                if (score > bestScore || (score === bestScore && extra < bestExtra)) {
                    bestScore = score; bestExtra = extra; best = a;
                }
            }
            if (!best) return null;
            const slug = best.getAttribute('href');
            const page = await (await fetch('https://manga-kotoba.com' + slug)).text();
            const vols = parseMangaKotobaTable(page);
            if (!vols.length) return { seriesUrl: 'https://manga-kotoba.com' + slug, volume: null };
            let vol = null;
            for (const v of vols) {
                const n = extractVolumeNumber(v.title);
                if (n === volumeNum) { vol = v; break; }
            }
            if (!vol && vols.length === 1) vol = vols[0];
            return {
                seriesUrl: 'https://manga-kotoba.com' + slug,
                volume: vol ? { ...vol, url: 'https://manga-kotoba.com' + vol.href } : null,
                volumeCount: vols.length,
            };
        } catch (e) {
            console.warn('[bwdd] Manga-kotoba lookup error:', e && e.message);
            return null;
        }
    }
    function searchTitleCandidates(raw) {
        const t = String(raw || '').trim();
        const out = [t];
        const seen = new Set([t]);
        const push = (s) => { s = String(s || '').trim(); if (s && !seen.has(s)) { seen.add(s); out.push(s); } };
        let s = t.replace(/【[^】]*】/g, ' ').replace(/[\s　]+/g, ' ').trim();
        push(s);
        let cur = s;
        for (let i = 0; i < 6; i++) {
            const before = cur;
            cur = cur
                .replace(/[\s　]*(文庫版|新装版|完全版|愛蔵版|廉価版|普及版|電子版|特装版|限定版|豪華版|分冊版|合本版|オンデマンド版|デジタル版|単行本版|ノベルズ版|ペーパーバック版)[\s　]*$/u, '')
                .replace(/[\s　]*[(（]*(文庫|新装|完全|愛蔵|廉価|普及)[)）]*[\s　]*$/u, '')
                .replace(/[\s　]*第?[一二三四五六七八九十百0-9０-９]*[巻話版編]?[\s　]*$/u, '')
                .trim();
            push(cur);
            if (cur === before) break;
        }
        push(s.replace(/[\s　]*版$/u, '').trim());
        return out.filter(Boolean);
    }
    async function lnSearchBook(candidates) {
        for (const cand of candidates) {
            const q = encodeURIComponent(cand);
            const r = await gmFetch('https://learnnatively.com/api/ninja/search/books/?language=jpn&q=' + q);
            if (r.status !== 200) continue;
            try {
                const d = JSON.parse(r.text);
                const items = (d.results || []).map(x => x.item).filter(i => i && i.series_id);
                if (items.length) return { cand, items };
            } catch (e) {}
        }
        return null;
    }

    async function lookupLearnNatively(seriesTitle, volumeNum) {
        try {
            const cands = searchTitleCandidates(seriesTitle);
            const found = await lnSearchBook(cands);
            if (!found) return null;
            const items = found.items;
            const first = items[0];
            const sid = first.series_id.replace(/-/g, '').slice(0, 10);
            let volUrl = null, volTitle = null, level = null;
            let matchedNo = null;      // which volume the resolved link actually is
            let fallbackNearest = null; // nearest available volume when exact not found
            try {
                const shtml = (await gmFetch('https://learnnatively.com/series/' + sid + '/')).text;
                const sdoc = new DOMParser().parseFromString(shtml, 'text/html');
                const links = [...sdoc.querySelectorAll('a.title[href*="/book/"]')];
                for (const a of links) {
                    const parent = a.closest('.item, .subitems > div, li, div') || a;
                    const notice = parent.querySelector('.item-type-notice');
                    const numMatch = (notice ? notice.textContent : '') + ' ' + (a.getAttribute('title') || a.textContent);
                    // Book #N (series page) is authoritative; fall back to title patterns
                    const m = numMatch.match(/Book\s*#?\s*(\d+)/i) || numMatch.match(/第?\s*(\d+)\s*巻/) ||
                             numMatch.match(/(\d+)\s*$/) || numMatch.match(/[（(]?([0-9０-９]{1,3})[）)]/);
                    const an = m ? parseInt(m[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)), 10) : NaN;
                    if (an === volumeNum) {
                        volUrl = a.getAttribute('href');
                        volTitle = a.getAttribute('title') || a.textContent.trim();
                        matchedNo = an;
                        break;
                    }
                    if (!isNaN(an)) {
                        // remember the highest volume listed, and the nearest one
                        // at or below the current volume (for a graceful fallback)
                        if (!fallbackNearest || (an > fallbackNearest.an && an <= volumeNum) ||
                            (an <= volumeNum && (fallbackNearest.an > volumeNum || an > fallbackNearest.an))) {
                            fallbackNearest = { an, href: a.getAttribute('href'), title: a.getAttribute('title') || a.textContent.trim() };
                        }
                    }
                }
                if (!volUrl && links.length === 1) {
                    volUrl = links[0].getAttribute('href');
                    volTitle = links[0].getAttribute('title') || links[0].textContent.trim();
                    matchedNo = 1;
                }
                // exact volume not on LearnNatively: use the nearest available
                if (!volUrl && fallbackNearest) {
                    volUrl = fallbackNearest.href;
                    volTitle = fallbackNearest.title;
                    matchedNo = fallbackNearest.an;
                }
                const lvl = sdoc.querySelector('.key-tags .level, [class*="level"], [class*="Level"]');
                level = lvl ? lvl.textContent.trim() : null;
            } catch (e) {}
            const lvlFromRating = first.rating ? first.rating.lvl : null;
            const tmpFlag = first.rating ? !!(first.rating.temporary || first.rating.always_temporary) : false;
            const bookUrl = volUrl ? 'https://learnnatively.com' + volUrl : ('https://learnnatively.com' + first.url);
            // enrich from the search API (no extra fetch): avg rating, counts,
            // wanikani/book-club badges, alternative titles
            const rd = first.review_data || {};
            const badges = [];
            if (first.wanikani) badges.push('WK');
            if (first.book_club) badges.push('BC');
            // reading/finished counts still come from the book page
            const meta = await fetchLnBookMeta(bookUrl);
            // Label the card with the *resolved* book (volTitle/matchedNo from
            // the series page), not the raw first search hit: the search API
            // ranks by popularity, so for 幸色のワンルーム it returns
            // "幸色のワンルーム 1" (series_order 1) even when the resolved
            // book is volume 3 — which made the card read "… 1" while the
            // Book link correctly pointed at 幸色のワンルーム 3.
            return Object.assign({
                seriesUrl: 'https://learnnatively.com/series/' + sid + '/',
                bookUrl,
                title: volTitle || first.title,
                volume: matchedNo != null ? matchedNo
                    : (first.series_order != null ? first.series_order : null),
                level: lvlFromRating != null ? lvlFromRating : level,
                temporary: tmpFlag,
                avgRating: rd.avg_rating != null ? rd.avg_rating : null,
                ratings: rd.rating_count != null ? rd.rating_count : null,
                reviews: rd.review_count != null ? rd.review_count : null,
                badges,
                altTitles: first.alternative_titles || null,
            }, meta || {});
        } catch (e) {
            console.warn('[bwdd] LearnNatively lookup error:', e && e.message);
            return null;
        }
    }
    async function fetchLnBookMeta(bookUrl) {
        try {
            const r = await gmFetch(bookUrl);
            if (r.status !== 200) return null;
            const doc = new DOMParser().parseFromString(r.text, 'text/html');
            const out = {};
            const rs = doc.querySelector('.ratings-summary');
            if (rs) {
                const m = rs.textContent.replace(/\s+/g, ' ').match(/([\d,]+)\s*ratings?,?\s*([\d,]+)\s*reviews?/i);
                if (m) {
                    out.ratings = parseInt(m[1].replace(/,/g, ''), 10) || 0;
                    out.reviews = parseInt(m[2].replace(/,/g, ''), 10) || 0;
                }
            }
            const inc = doc.querySelector('.count.in-progress');
            const fin = doc.querySelector('.count.finished');
            const num = (s) => { const v = s && s.textContent.replace(/[^\d]/g, ''); return v ? parseInt(v, 10) : 0; };
            out.reading = num(inc);
            out.finished = num(fin);
            const badges = [...doc.querySelectorAll('.key-tags .wanikani')].map(b => b.textContent.trim()).filter(Boolean);
            if (badges.length) out.badges = badges;
            const alt = doc.querySelector('.alternative-titles .alt-titles');
            if (alt) out.altTitles = alt.textContent.trim();
            return out;
        } catch (e) { return null; }
    }
    // Fire both catalog lookups at once and render each card the moment its
    // own lookup resolves. The old fetchMangaStats awaited Manga-Kotoba first
    // and only then started LearnNatively (search API → series page → book
    // page), so nothing appeared until both chains finished — and the MK card
    // waited on LN's extra requests. Here each card shows as soon as it is
    // found; a slow or missing site only delays (or skips) its own card.
    // Both lookups swallow their failures and resolve to null, so a null
    // result simply renders nothing.
    function fetchAndRenderStats(statsEl, seriesTitle, volumeNum) {
        if (!statsEl || !seriesTitle) return;
        lookupMangaKotoba(seriesTitle, volumeNum)
            .then(mk => { if (mk) upsertCard(statsEl, 'manga-kotoba', () => renderMangaKotobaCard(mk)); })
            .catch(e => console.warn('[bwdd] Manga-kotoba lookup error:', e && e.message));
        lookupLearnNatively(seriesTitle, volumeNum)
            .then(ln => { if (ln) upsertCard(statsEl, 'natively', () => renderNativelyCard(ln)); })
            .catch(e => console.warn('[bwdd] LearnNatively lookup error:', e && e.message));
    }

    // Card helpers (terse but accessible: real links, labelled pills, dl rows)
    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    function cardLink(href, label, hint) {
        const a = el('a', 'bwdd-link', label + ' ↗');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.setAttribute('aria-label', hint ? `${label}, ${hint} (new tab)` : `${label} (new tab)`);
        return a;
    }
    function statRow(grid, label, value, tip) {
        const dt = el('dt', null, label);
        if (tip) dt.title = tip;
        grid.append(dt, el('dd', null, value == null ? '—' : String(value)));
    }
    function upsertCard(container, key, buildFn) {
        if (!container) return null;
        const old = container.querySelector('.bwdd-card[data-card="' + key + '"]');
        if (old) old.remove();
        // buildFn may legitimately return null when there is nothing to show
        // (e.g. a Manga-Kotoba card with no volume and no series link yet).
        const card = buildFn();
        if (!card) return null;
        card.dataset.card = key;
        const book = container.querySelector('.bwdd-card[data-card="book"]');
        if (key === 'book') {
            if (book) container.insertBefore(card, book);
            else if (container.firstChild) container.insertBefore(card, container.firstChild);
            else container.appendChild(card);
            return card;
        }
        const last = container.querySelector('.bwdd-card:last-child');
        if (last) last.after(card);
        else container.appendChild(card);
        return card;
    }
    function emptyCard(kicker) {
        const card = el('article', 'bwdd-card');
        card.appendChild(el('h3', null, kicker));
        return card;
    }
    // Single lookup: [pill bg, JLPT hint]. Darkened for ≥4.5:1 white-text contrast.
    function levelInfo(level) {
        const l = Number(level);
        if (isNaN(l)) return ['#5b21b6', ''];
        if (l <= 12) return ['#075985', 'N5'];
        if (l <= 19) return ['#9f1239', 'N4'];
        if (l <= 26) return ['#5b21b6', 'N3'];
        if (l <= 33) return ['#9a3412', 'N2'];
        if (l <= 40) return ['#166534', 'N1'];
        return ['#0e7490', 'N1+'];
    }
    // Lighten a #rrggbb color by mixing it toward white (amount 0..1).
    function lightenHex(hex, amount) {
        const n = parseInt(hex.slice(1), 16);
        const mix = (c) => Math.round(c + (255 - c) * amount);
        const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
        return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
    }
    function renderLevelPill(level, temporary) {
        const [bg, jlpt] = levelInfo(level);
        const b = el('span', 'bwdd-nlvl-pill', `Level ${level}${temporary ? '??' : ''}`);
        // Provisional/unknown level: pale tinted pill with the level color as text
        b.style.background = temporary ? lightenHex(bg, 0.55) : bg;
        b.style.color = temporary ? bg : '#fff';
        b.setAttribute('role', 'img');
        b.setAttribute('aria-label', temporary
            ? `Provisional Natively level ${level}${jlpt ? `, ${jlpt}` : ''}`
            : `Natively level ${level}${jlpt ? `, ${jlpt}` : ''}`);
        return b;
    }
    function renderNativelyCard(ln) {
        const card = emptyCard('LearnNatively');
        const meta = el('div', 'bwdd-ln-meta');
        if (ln.level != null) {
            const [, jlpt] = levelInfo(ln.level);
            meta.appendChild(renderLevelPill(ln.level, ln.temporary));
            if (jlpt) {
                const cap = el('span', 'bwdd-lvl-cap', jlpt);
                cap.setAttribute('aria-hidden', 'true');
                meta.appendChild(cap);
            }
        }
        for (const b of ln.badges || []) {
            const t = { WK: 'WaniKani vocab', BC: 'Book club' }[String(b).toUpperCase()] || '';
            const s = el('span', 'bwdd-lnbadge', String(b).toUpperCase());
            if (t) s.title = t;
            meta.appendChild(s);
        }
        const head = el('div', 'bwdd-ln-head');
        if (meta.childElementCount) head.appendChild(meta);
        if (ln.title) {
            // If the title already carries the volume number ("…」 1", "…（２）",
            // "…1巻"), don't repeat it as "· Vol. N".
            const titleHasVol = ln.volume != null && (() => {
                // normalize full-width digits so （２） and 2 both match
                const t = String(ln.title).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
                return new RegExp('(^|[^0-9])' + ln.volume + '([^0-9]|$)').test(t) ||
                       new RegExp('[（(]' + ln.volume + '[）)]').test(t);
            })();
            const sub = el('div', 'bwdd-card-sub bwdd-ln-title-row',
                ln.title + (ln.volume != null && !titleHasVol ? ` · Vol. ${ln.volume}` : ''));
            head.appendChild(sub);
        }
        if (head.childElementCount) card.appendChild(head);
        const bits = [];
        if (ln.avgRating != null) {
            // "★ 4.3 · 1,204 ratings" (the second number is ratings when present,
            // otherwise the review count — never leave it unlabeled).
            if (ln.ratings != null) {
                bits.push(`★ ${Number(ln.avgRating).toFixed(1)} · ${Number(ln.ratings).toLocaleString()} ratings`);
            } else if (ln.reviews != null) {
                bits.push(`★ ${Number(ln.avgRating).toFixed(1)} · ${Number(ln.reviews).toLocaleString()} reviews`);
            } else {
                bits.push(`★ ${Number(ln.avgRating).toFixed(1)}`);
            }
        }
        if (ln.reading || ln.finished) bits.push(`${ln.reading || 0} reading · ${ln.finished || 0} finished`);
        if (bits.length) {
            const social = el('div', 'bwdd-ln-social');
            for (const bit of bits) social.appendChild(el('span', null, bit));
            card.appendChild(social);
        }
        const links = el('div', 'bwdd-card-links');
        links.appendChild(cardLink(ln.bookUrl, 'Book', ln.title));
        if (ln.seriesUrl) links.appendChild(cardLink(ln.seriesUrl, 'Series', ln.title));
        card.appendChild(links);
        return card;
    }
    function renderMangaKotobaCard(mk) {
        const card = emptyCard('Manga-Kotoba');
        const v = mk && mk.volume;
        if (!v) {
            if (mk && mk.seriesUrl) {
                card.appendChild(el('p', 'bwdd-none', 'Volume pending — series cataloged.'));
                card.appendChild(cardLink(mk.seriesUrl, 'Series', 'Manga-Kotoba'));
                return card;
            }
            return null;
        }
        if (v.title) card.appendChild(el('div', 'bwdd-card-sub bwdd-mk-title', v.title));
        const grid = el('dl', 'bwdd-grid');
        const pct = String(v.usedOncePct ?? '').replace('%', '');
        const num = (x) => x != null ? Number(x).toLocaleString() : '—';
        statRow(grid, 'Total words', num(v.total), 'All words in this volume, counting repeats');
        statRow(grid, 'Unique words', num(v.unique), 'Distinct words used in this volume');
        statRow(grid, 'Used once', v.usedOnce != null ? `${num(v.usedOnce)}${pct ? ` (${pct}%)` : ''}` : '—', 'Words that appear exactly once in the volume — new-vocabulary fodder');
        statRow(grid, 'Density', v.density, 'Lexical density — share of distinct words in the text');
        card.appendChild(grid);
        const url = v.url || (mk.seriesUrl ? mk.seriesUrl + '/' : null);
        if (url) card.appendChild(cardLink(url, 'Breakdown', v.title));
        return card;
    }
    function renderStatsCards(statsEl, stats) {
        if (!stats) return;
        if (stats.mangaKotoba) upsertCard(statsEl, 'manga-kotoba', () => renderMangaKotobaCard(stats.mangaKotoba));
        if (stats.learnNatively) upsertCard(statsEl, 'natively', () => renderNativelyCard(stats.learnNatively));
    }
    function renderBookCard(statsEl, metaObj) {
        if (!statsEl) return;
        upsertCard(statsEl, 'book', () => {
            const card = emptyCard('Book Details');
            card.setAttribute('role', 'region');
            card.setAttribute('aria-label', 'Current book metadata');

            const titleEl = document.createElement('div');
            titleEl.className = 'bwdd-book-title';
            titleEl.textContent = metaObj.title || 'BookWalker Volume';
            card.appendChild(titleEl);

            const grid = document.createElement('div');
            grid.className = 'bwdd-spec-badges';

            function badge(label, value, tip) {
                const b = document.createElement('div');
                b.className = 'bwdd-spec-badge';
                if (tip) b.title = tip;
                const l = document.createElement('span');
                l.className = 'bwdd-spec-lbl';
                l.textContent = label;
                const v = document.createElement('span');
                v.className = 'bwdd-spec-val';
                v.textContent = value;
                b.append(l, v);
                return b;
            }

            if (metaObj.pages) grid.appendChild(badge('Pages', metaObj.pages, 'Number of page images in this book'));
            if (metaObj.resolution) grid.appendChild(badge('Page Size', metaObj.resolution, 'Resolution of the page images (width × height)'));
            if (metaObj.type) grid.appendChild(badge('Edition', metaObj.type, 'Whether this is a purchased edition or a sample / trial volume'));

            card.appendChild(grid);
            return card;
        });
    }

    // =====================================================================
    // 8. Mokuro bridge client
    // =====================================================================
    const MOKURO_BRIDGE_URL = 'http://127.0.0.1:62642';
    const MOKURO_BRIDGE_START_URL = 'bw-mokuro-bridge://start';
    // Shown (via the run's catch-all) when the bridge cannot be reached.
    const MOKURO_BRIDGE_OFFLINE_MSG =
        'The Mokuro Bridge app is not running.\n\n' +
        'Get and start mokuro-bridge (github.com/GolyBidoof/mokuro-bridge) — its ' +
        'README shows the start command for your OS (macOS/Linux: ./run.sh from ' +
        'its folder), then click “Save and run through Mokuro” again.';

    // Hysteresis so a single dropped /health probe (or a slow response during
    // a heavy upload) can't flip the UI to "offline" and hide the bars. The
    // dot/message only go grey after BRIDGE_FAIL_LIMIT consecutive failures.
    const BRIDGE_FAIL_LIMIT = 3;
    let bridgeConsecFail = 0;
    async function bridgeHealth() {
        try {
            const r = await fetchWithTimeout(MOKURO_BRIDGE_URL + '/health', { cache: 'no-store' }, 2000);
            const ok = r.ok;
            bridgeConsecFail = ok ? 0 : bridgeConsecFail + 1;
            return ok || bridgeConsecFail < BRIDGE_FAIL_LIMIT;
        } catch (e) {
            bridgeConsecFail++;
            return bridgeConsecFail < BRIDGE_FAIL_LIMIT;
        }
    }
    // Cached /health payload (upload backends, output dir, version…).
    let bridgeInfo = null;
    async function refreshBridgeInfo() {
        try {
            const r = await fetchWithTimeout(MOKURO_BRIDGE_URL + '/health', { cache: 'no-store' }, 3000);
            if (r.ok) { bridgeInfo = await r.json(); return bridgeInfo; }
        } catch (e) {}
        return null;
    }
    // --- Generic upload-method support (mokuro-bridge >= 0.3) ---
    // The bridge exposes GET /upload-methods -> { methods:[{id,name,configured,
    // default,creds_source,current_folder}], upload_method_default }. We pick
    // the first configured method (or 'local'), remembering which folder it
    // writes to. Falls back to /health mega_configured on older bridges.
    let uploadMethods = null;
    async function fetchUploadMethods() {
        try {
            const r = await fetchWithTimeout(MOKURO_BRIDGE_URL + '/upload-methods', { cache: 'no-store' }, 3000);
            if (r.ok) { uploadMethods = await r.json(); return uploadMethods; }
        } catch (e) {}
        return null;
    }
    // Resolve which upload method + destination folder to use for this run.
    // Returns { method, folder, label } where method is one of the bridge's
    // ids ('local','mega','drive',…).
    // The bridge's sticky default (upload_method_default, mirrored by the
    // per-method "default" flag) must be reported only when it is actually
    // usable: "local" is always configured, so picking the first *configured*
    // method would always say "saving locally". But an unconfigured default
    // (e.g. drive not set up yet) must not be advertised as the destination —
    // fall back to the first configured method (normally local).
    async function mokuroUploadPlan() {
        const methods = uploadMethods || await fetchUploadMethods();
        if (methods && Array.isArray(methods.methods)) {
            const list = methods.methods;
            const def = methods.upload_method_default || 'local';
            const byDefault = list.find(m => m.id === def);
            const usableDefault = byDefault && byDefault.configured ? byDefault : null;
            const firstConfigured = list.find(m => m.configured);
            const picked =
                usableDefault ||
                firstConfigured ||
                list.find(m => m.id === 'local') ||
                list[0];
            if (picked) return { method: picked.id, folder: picked.current_folder || null, label: picked.name || picked.id };
        }
        // older bridge: only /health
        const info = bridgeInfo || await refreshBridgeInfo();
        if (info && info.mega_configured) return { method: 'mega', folder: info.mega_library_root || null, label: 'MEGA' };
        return { method: 'local', folder: info && info.output_dir || null, label: 'Local' };
    }
    // Final decision for a run: prefer the user's pick in the panel, else the
    // bridge's configured default. Returns {method, folder, label, localDir}.
    async function resolveUploadChoice(ui) {
        const plan = await mokuroUploadPlan().catch(() => ({ method: null, folder: null, label: null }));
        let method = plan.method, folder = plan.folder;
        if (ui && ui.destSelect && ui.destSelect.value) {
            method = ui.destSelect.value;
            folder = null;
            if (method === 'local' && ui.localDirInput && ui.localDirInput.value.trim()) folder = ui.localDirInput.value.trim();
        }
        return { method, folder, label: plan.label || method, localDir: method === 'local' ? folder : null };
    }

    async function ensureBridgeRunning(timeoutMs = 15000) {
        if (await bridgeHealth()) return true;
        try {
            const a = document.createElement('a');
            a.href = MOKURO_BRIDGE_START_URL;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
        } catch (e) {}
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            await new Promise(r => setTimeout(r, 600));
            if (await bridgeHealth()) return true;
        }
        return false;
    }
    // Wait until the bridge reports idle (busy=false) before starting a new
    // capture. The bridge sets busy while OCR/upload is in progress and also
    // while ocr_queue_depth > 0, so this prevents starting a run that would
    // interleave with work already happening.
    async function waitForBridgeIdle(timeoutMs = 30000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const r = await fetchWithTimeout(MOKURO_BRIDGE_URL + '/health', { cache: 'no-store' }, 3000);
                if (r.ok) {
                    const h = await r.json();
                    if (!h.busy) return true;
                }
            } catch (e) {}
            await new Promise(res => setTimeout(res, 1000));
        }
        return false;   // still busy after the timeout — caller decides
    }

    async function mokuroStartSession(title) {
        const fd = new FormData();
        fd.append('title', title || 'manga');
        const res = await fetchWithTimeout(MOKURO_BRIDGE_URL + '/session/start', { method: 'POST', body: fd }, 15000);
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.detail || 'HTTP ' + res.status);
        return d;
    }
    async function mokuroStreamPage(sessionId, blob, filename, pageNum) {
        const fd = new FormData();
        fd.append('page', blob, filename);
        fd.append('filename', filename);
        fd.append('page_num', String(pageNum));
        const res = await fetchWithTimeout(MOKURO_BRIDGE_URL + '/session/' + sessionId + '/page', { method: 'POST', body: fd }, 60000);
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.detail || 'HTTP ' + res.status);
        return d;
    }
    // Early cover upload: push the first descrambled page to the destination
    // as <title>.webp immediately (the cover), before OCR finishes, so the
    // user sees upload activity start at once. {method, localDir} must match
    // the run's destination (the dropdown is locked during the run).
    async function mokuroUploadCover(sessionId, blob, opts = {}) {
        const fd = new FormData();
        fd.append('cover', blob, 'cover.jpg');
        if (opts.method) fd.append('upload_method', opts.method);
        if (opts.method === 'local' && opts.localDir) fd.append('local_dir', opts.localDir);
        const res = await fetchWithTimeout(MOKURO_BRIDGE_URL + '/session/' + sessionId + '/cover', { method: 'POST', body: fd }, 120000);
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((d && d.detail) || 'HTTP ' + res.status);
        return d;
    }
    async function mokuroStatus(sessionId) {
        try {
            const res = await fetchWithTimeout(MOKURO_BRIDGE_URL + '/session/' + sessionId + '/status', {}, 5000);
            if (!res.ok) return null;
            return await res.json();
        } catch (e) { return null; }
    }
    // Reads the bridge's finalize NDJSON stream.
    //   onStage(stage, msg)      — every frame
    //   onUpload(ev) — live upload progress; ev carries the per-file payload
    //     {file, percent, speed, currentBytes, totalBytes, method, remotePath}.
    //     The bridge streams per-file upload_progress frames (one file at a
    //     time, each with that file's own percent/bytes), so the caller must
    //     accumulate across files — use makeUploadBarUpdater() below.
    async function readNdjsonStream(res, onStage, onUpload) {
        if (!res.body) throw new Error('No streaming response body from bridge');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', finalResult = null;
        // Collect per-file storage URLs the bridge reports. Local forks attach
        // upload_file's third value as `url` on per-file upload frames and/or
        // inside done.uploads[]. Entries are deduped; attached to the returned
        // result as:   uploadUrls: [{file, url}]   storedUrl: first http(s).
        const uploadUrls = [];
        let storedUrl = null;
        function rememberUrl(msg) {
            const seen = new Set();
            const add = (file, url) => {
                const u = typeof url === 'string' ? url.trim() : '';
                if (!u) return;
                const f = typeof file === 'string' ? file : '';
                const key = f + '\u0000' + u;
                if (seen.has(key)) return;
                seen.add(key);
                if (uploadUrls.some(e => e.file === f && e.url === u)) return;
                uploadUrls.push({ file: f, url: u });
                // Prefer the .cbz (the volume archive itself) for the "Open
                // stored file" action; the cover .webp uploads first, so
                // without this preference the button would point at an image.
                if (/^https?:\/\//i.test(u)) {
                    if (!storedUrl || /\.cbz$/i.test(f)) storedUrl = u;
                }
            };
            if (typeof msg.url === 'string' && msg.url) add(msg.file, msg.url);
            const up = msg.upload || {};
            if (typeof up.url === 'string' && up.url) add(up.file || msg.file, up.url);
            if (Array.isArray(msg.uploads)) {
                for (const u of msg.uploads) add(u && u.file, u && u.url);
            }
        }
        // Force-flush any partially-buffered lines if nothing arrives for a
        // while. Without this, a slow upload's trailing NDJSON line (no
        // trailing newline yet) can sit in `buffer` until the next chunk,
        // making the bar look stuck even though the bridge is streaming.
        let lastLineAt = Date.now();
        const flushTimer = setInterval(() => {
            if (!buffer.trim() || Date.now() - lastLineAt < 4000) return;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) { processLine(line); }
            lastLineAt = Date.now();
        }, 2000);
        function processLine(line) {
            if (!line.trim()) return;
            let msg; try { msg = JSON.parse(line); } catch (e) { return; }
            if (onStage) onStage(msg.stage, msg);
            rememberUrl(msg);
            if ((msg.stage === 'upload_progress' || msg.stage === 'upload') && onUpload) {
                const up = msg.upload || {};
                const hasPayload = !!(up.file || msg.file || up.bytes || msg.bytes != null ||
                    up.current_bytes != null || msg.current_bytes != null ||
                    up.total_bytes != null || msg.total_bytes != null);
                if (hasPayload) {
                    onUpload({
                        file: up.file || msg.file || '',
                        percent: msg.percent != null ? msg.percent : (up.percent != null ? up.percent : null),
                        speed: msg.speed_human || up.speed_human || null,
                        currentBytes: msg.current_bytes != null ? msg.current_bytes :
                            (up.current_bytes != null ? up.current_bytes :
                                (up.bytes != null ? up.bytes : (msg.bytes != null ? msg.bytes : 0))),
                        totalBytes: msg.total_bytes != null ? msg.total_bytes :
                            (up.total_bytes != null ? up.total_bytes : 0),
                        method: msg.method || up.method || null,
                        remotePath: msg.remote_path || msg.mega_path || up.remote_path || up.mega_path || null,
                    });
                }
            }
            if (msg.stage === 'done') finalResult = msg;
            if (msg.stage === 'error') throw new Error(msg.message || 'Mokuro bridge pipeline error');
        }
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            lastLineAt = Date.now();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) { processLine(line); }
            // (the tail buffer is handled after the loop)
        }
        if (buffer.trim()) {
            const msg = JSON.parse(buffer);
            if (onStage) onStage(msg.stage, msg);
            rememberUrl(msg);
            if (msg.stage === 'done') finalResult = msg;
            if (msg.stage === 'error') throw new Error(msg.message || 'Mokuro bridge pipeline error');
        }
        clearInterval(flushTimer);
        if (!finalResult) throw new Error('Mokuro bridge closed stream without completing.');
        if (uploadUrls.length) finalResult.uploadUrls = uploadUrls;
        if (storedUrl) finalResult.storedUrl = storedUrl;
        return finalResult;
    }
    // Multi-file upload progress for the Store/Upload bar. Tracks a list of
    // files in upload order (seeded up front from the bridge's "upload" frame
    // `files:` list, then fed live per-file progress). The label reads
    //   "1/3 · 62% · 65.0 MB / 104.8 MB · 5.1 MiB/s"
    // i.e. file k of N · overall % · bytes · speed — no file name clutter.
    // The fill is the byte-weighted overall % (sum done / sum total), which
    // is monotonic because every file's total is known before it uploads.
    // The k/N and size totals are *kept after completion* — finishing never
    // blanks the bar; the stage handler may append "done" separately.
    function makeUploadBarUpdater(bar) {
        const order = [];              // file names in first-seen (upload) order
        const byName = new Map();      // name -> {cur, tot}
        const rec = (name) => {
            let r = byName.get(name);
            if (!r) { r = { cur: 0, tot: 0 }; byName.set(name, r); order.push(name); }
            return r;
        };
        let seeded = false;            // full plan announced by the bridge
        let done = 0;                  // files fully uploaded (tot>0 && cur>=tot)
        const feed = function onUploadFrame(ev) {
            if (!bar) return;
            bar.wrap.style.display = 'flex';
            const name = ev.file || '';
            if (name) {
                const r = rec(name);
                if (ev.totalBytes > 0) r.tot = Math.max(r.tot, ev.totalBytes);
                if (ev.currentBytes > 0) r.cur = Math.max(r.cur, ev.currentBytes);
            }
            let sumCur = 0, sumTot = 0;
            done = 0;
            for (const n of order) {
                const r = byName.get(n);
                sumCur += r.cur; sumTot += r.tot;
                if (r.tot > 0 && r.cur >= r.tot) done++;
            }
            let overall;
            if (sumTot > 0) overall = Math.min(100, (sumCur / sumTot) * 100);
            else if (ev.percent != null) overall = ev.percent;
            else overall = 0;
            let parts = [];
            if (seeded && order.length > 0) {
                // Always show k/N against the full plan: k = files fully done
                // (0 at the very start), never a premature "1/3" just because
                // one file was announced.
                parts.push(Math.min(done, order.length) + '/' + order.length);
            }
            parts.push(overall.toFixed(0) + '%');
            if (sumTot > 0) parts.push(fmtBytes(sumCur) + ' / ' + fmtBytes(sumTot));
            else if (ev.percent != null && ev.totalBytes > 0) parts.push(fmtBytes(ev.currentBytes || 0) + ' / ' + fmtBytes(ev.totalBytes));
            if (ev.speed && overall < 100) parts.push(ev.speed);
            setBar(bar, overall, parts.join(' · '));
        };
        // Pre-register the whole upload plan (the bridge announces it in the
        // initial "upload" frame): {file, total_bytes}[]. With a full
        // denominator up front the overall % is honest (no false 100% when a
        // single file finishes) and the k/N counter always counts against N.
        feed.seed = function seed(list) {
            if (!Array.isArray(list)) return;
            for (const it of list) {
                if (it && typeof it.file === 'string' && it.file) {
                    const r = rec(it.file);
                    if (it.total_bytes > 0) r.tot = Math.max(r.tot, it.total_bytes);
                }
            }
            if (list.length) seeded = true;
        };
        // True once any file has been registered (used to avoid clobbering
        // early-cover progress when the finalize phase reuses this feed).
        feed.hasAny = function hasAny() { return order.length > 0; };
        // Summary accessors: the final k/N and total size stay readable after
        // the run so the caller can keep them on the bar.
        feed.summary = function summary() {
            let sumCur = 0, sumTot = 0, d = 0;
            for (const n of order) {
                const r = byName.get(n);
                sumCur += r.cur; sumTot += r.tot;
                if (r.tot > 0 && r.cur >= r.tot) d++;
            }
            return { done: d, total: order.length, sumCur, sumTot };
        };
        return feed;
    }
    // Ask the bridge to finalize + store a volume.
    //   opts.method   — upload_method id ('local' | 'mega' | 'drive' | 'onedrive' | 'webdav').
    //                   null/omitted → let the bridge decide (env default).
    //   opts.localDir — when method is 'local', write output to this folder.
    //   opts.forceMega— legacy fallback: when the bridge rejects upload_method,
    //                   retry once with upload_to_mega=true (old bridges).
    // delete_after_upload=true cleans the bridge's working files on success.
    // Protocol: github.com/GolyBidoof/mokuro-bridge.
    async function mokuroFinalize(sessionId, opts = {}, onStage, onUpload) {
        const method = opts.method || null;
        const fd = new FormData();
        if (method) {
            fd.append('upload_method', method);
            if (method === 'local' && opts.localDir) fd.append('local_dir', opts.localDir);
        } else if (opts.forceMega) {
            fd.append('upload_to_mega', 'true');
        }
        fd.append('delete_after_upload', 'true');
        let res = await fetchWithTimeout(MOKURO_BRIDGE_URL + '/session/' + sessionId + '/finalize', { method: 'POST', body: fd }, 3600000);
        // Legacy fallback: if the new bridge rejects an unknown upload_method
        // (error frame), retry once with the old upload_to_mega flag.
        if (method && !res.ok) {
            const fd2 = new FormData();
            fd2.append('upload_to_mega', method === 'local' ? 'false' : 'true');
            fd2.append('delete_after_upload', 'true');
            res = await fetchWithTimeout(MOKURO_BRIDGE_URL + '/session/' + sessionId + '/finalize', { method: 'POST', body: fd2 }, 3600000);
        }
        return readNdjsonStream(res, onStage, onUpload);
    }
    // Where the post-OCR "Open Reader Mokuro" button points: the reader URL the
    // bridge reported when its done frame carries one, otherwise the reader home.
    function readerJumpUrl(result) {
        const u = result && result.reader_url;
        if (typeof u === 'string' && /^https?:\/\//i.test(u.trim())) return u.trim();
        return 'https://reader.mokuro.app/';
    }

    // =====================================================================
    // 9. UI & Accessibility Construction
    // =====================================================================
    function cleanTitle(t) {
        if (!t) return '';
        let s = String(t).replace(/^【[^】]*】\s*/g, '').trim();
        s = s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim();
        return s;
    }
    function splitSeriesVolume(t) {
        let s = String(t || '').trim();
        s = s.replace(/【[^】]*】/g, '').trim();
        let volNum = null;
        let m = s.match(/(.*?)第?\s*([0-9０-９]{1,3}|[一二三四五六七八九十百]+)\s*[巻話](.*)$/);
        if (m && m[1].trim()) {
            const d = m[2].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
            volNum = /[0-9]/.test(d) ? parseInt(d, 10) : kanjiNum(d);
            s = (m[1] + ' ' + m[3]).trim();
        } else {
            m = s.match(/^(.*?)[\s　]*[：（:　]?[\s　]*[（(]?([0-9０-９]{1,3})[）)]?\s*$/);
            if (m && m[1].trim()) {
                const d = m[2].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
                volNum = parseInt(d, 10);
                s = m[1].trim();
            }
        }
        let series = s.replace(/[：:]\s*$/, '').trim();
        series = series.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim();
        const volumeTitle = (series + ' ' + (volNum != null ? volNum : '')).trim();
        return { series, volNum, volumeTitle };
    }
    // ── Cross-platform (Windows / Linux / macOS) output naming ────────────
    // Everything the user ultimately saves to disk (ZIP inner folders, the
    // downloaded .zip name) must be legal on the *worst-case* target
    // filesystem — Windows. cleanTitle() above already drops the characters
    // Windows forbids in file names (\/:*?"<>| plus C0 controls); fsSafePath()
    // additionally covers the rules that only bite on Windows:
    //   • trailing dots/spaces — NTFS strips them silently, so what gets
    //     created is not what the user named (and a name that is only dots
    //     becomes '' or '.' and fails),
    //   • reserved device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9, CONIN$,
    //     CONOUT$) — creating the file/folder fails or it gets auto-renamed,
    //   • component length — NTFS caps a path component at 255 UTF-16 units;
    //     we cap at 190 code points so the whole extraction path stays well
    //     inside the legacy 260-char Windows limit too.
    // Linux/macOS tolerate all of this output unchanged.
    const BWDD_RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\..*)?$/i;
    function fsSafePath(name) {
        let s = cleanTitle(name);
        if (!s) return '';
        // Strip any trailing run of ASCII dots/spaces (Windows drops them
        // when creating the file/folder).
        s = s.replace(/[. ]+$/, '').trim();
        if (!s || s === '.' || s === '..') return '';
        if (BWDD_RESERVED_DEVICE.test(s)) s = '_' + s;   // CON → _CON
        const cps = Array.from(s);
        if (cps.length > 190) s = cps.slice(0, 190).join('').replace(/[. ]+$/, '');
        return s;
    }
    // ZIP inner layout: Series/Volume/page-NNNN.jpg (flat at the archive root
    // when no series can be derived — the same shape as before, hardened).
    function zipLayoutOf(sv, fallbackTitle) {
        const series = fsSafePath(sv && sv.series);
        const vol = fsSafePath(sv && sv.volumeTitle) || fsSafePath(fallbackTitle);
        if (!series) return '';
        return series + '/' + vol + '/';
    }
    // Downloaded archive name: <series>.zip, else <title>.zip, else book.zip.
    function zipBaseName(sv, fallbackTitle) {
        return fsSafePath(sv && sv.series) || fsSafePath(fallbackTitle) || 'book';
    }
    function fmtBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
    }
    // Outcome messages shared by the trial and full download/OCR pipelines,
    // so the two code paths can never drift apart in wording again.
    function msgZipSaved(n, size, secs) {
        return 'ZIP saved: ' + n + ' pages (' + size + ') in ' + secs + 's.';
    }
    function msgZipPartial(ok, total) {
        const missing = total - ok;
        return 'Saved ' + ok + ' of ' + total + ' pages — ' + missing +
            ' could not be fetched. Flip one page in the reader to renew credentials, then click Save as ZIP again — the missing pages resume automatically.';
    }
    function msgAllFailedZip() {
        return 'Every page failed to download — the session auth may have expired. Flip one page in the reader, then click Save as ZIP again.';
    }
    function msgOcrPartial(missing, total) {
        return missing + ' of ' + total + ' pages could not be fetched, so the volume may be incomplete. Flip one page in the reader, then run “Save and run through Mokuro” again.';
    }
    function msgStoredLocal(p) { return 'Stored locally to: ' + p; }
    function msgUploadedTo(label, p) { return 'Uploaded to ' + label + ' → ' + p; }

    // Best filesystem/destination path the bridge reported for a finished
    // volume (output_dir for local forks, staging/remote_path otherwise).
    function storedPathOf(result) {
        return (result && (result.output_dir || result.staging || result.remote_path)) || null;
    }
    // Short user-facing label for an upload-method id ('mega' → 'MEGA'…).
    function methodShortLabel(method) {
        const t = { mega: 'MEGA', drive: 'Google Drive', onedrive: 'OneDrive', webdav: 'WebDAV', local: 'Local' };
        return (t && t[method]) || method || '';
    }
    // The WebDAV base URL as reported by the bridge (/upload-methods extras or
    // /health upload_methods) — used to rebuild direct file URLs, since WebDAV
    // has no share-link concept to attach to upload frames.
    function webdavBaseUrl() {
        const lists = [];
        if (uploadMethods && Array.isArray(uploadMethods.methods)) lists.push(uploadMethods.methods);
        if (bridgeInfo && Array.isArray(bridgeInfo.upload_methods)) lists.push(bridgeInfo.upload_methods);
        for (const list of lists) {
            const w = list.find(m => m && m.id === 'webdav');
            const b = w && w.extra && w.extra.base_url;
            if (typeof b === 'string' && /^https?:\/\//i.test(b.trim())) return b.trim().replace(/\/+$/, '');
        }
        return '';
    }
    // Best openable per-file target for a finished OCR run:
    //   1. per-file http(s) links the bridge attached (uploadUrls / uploads[].url),
    //   2. else a rebuilt direct WebDAV URL (base + remote_path/<volume>.cbz).
    // .cbz (the image archive) is preferred over .mokuro / .webp. Returns
    // {file, url} or null when nothing can be opened from the browser.
    function storedOpenTarget(result) {
        if (!result) return null;
        const cands = [];
        const seen = new Set();
        const add = (file, url) => {
            const u = typeof url === 'string' ? url.trim() : '';
            if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
            seen.add(u);
            cands.push({ file: file || '', url: u });
        };
        for (const u of (result.uploadUrls || [])) add(u && u.file, u && u.url);
        if (Array.isArray(result.uploads)) for (const u of result.uploads) add(u && u.file, u && u.url);
        if (result.storedUrl) add('', result.storedUrl);
        if (cands.length) {
            const rank = (f) => {
                const e = String(f || '').toLowerCase();
                return e.endsWith('.cbz') ? 0 : e.endsWith('.mokuro') ? 1 : e.endsWith('.webp') ? 2 : 3;
            };
            cands.sort((a, b) => (rank(a.file) - rank(b.file)) || (a.file < b.file ? -1 : 1));
            return cands[0];
        }
        // WebDAV only: rebuild the direct file URL from base + remote folder.
        if (result.method === 'webdav') {
            const base = webdavBaseUrl();
            const folder = result.remote_path || (result.series ? 'mokuro-reader/' + result.series : '');
            const vol = String(result.title || '');
            if (base && folder && vol) {
                const enc = (s) => encodeURIComponent(s).replace(/%2F/gi, '/');
                const url = base + '/' + folder.split('/').map(enc).join('/') + '/' + enc(vol + '.cbz');
                return { file: vol + '.cbz', url };
            }
        }
        return null;
    }

    // ZIP Builder
    let __crcTable = null;
    function crc32Bytes(buf) {
        if (!__crcTable) {
            __crcTable = new Int32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                __crcTable[n] = c;
            }
        }
        const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        let c = -1;
        for (let i = 0; i < u.length; i++) c = (c >>> 8) ^ __crcTable[(c ^ u[i]) & 0xFF];
        return (c ^ -1) >>> 0;
    }
    function dosDateTime(d) {
        return {
            t: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
            dt: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
        };
    }
    function leU32(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
    function leU16(v) { return new Uint8Array([v & 255, (v >>> 8) & 255]); }
    function localHeader(nameB, crc, size, dos) {
        const h = new Uint8Array(30 + nameB.length);
        h.set(leU32(0x04034b50), 0);
        h.set(leU16(20), 4);
        h.set(leU16(0x0800), 6);
        h.set(leU16(0), 8);
        h.set(leU16(dos.t), 10);
        h.set(leU16(dos.dt), 12);
        h.set(leU32(crc), 14);
        h.set(leU32(size), 18);
        h.set(leU32(size), 22);
        h.set(leU16(nameB.length), 26);
        h.set(leU16(0), 28);
        h.set(nameB, 30);
        return h;
    }
    function centralEntry(nameB, crc, size, dos, offset) {
        const e = new Uint8Array(46 + nameB.length);
        e.set(leU32(0x02014b50), 0);
        e.set(leU16(20), 4);
        e.set(leU16(20), 6);
        e.set(leU16(0x0800), 8);
        e.set(leU16(0), 10);
        e.set(leU16(dos.t), 12);
        e.set(leU16(dos.dt), 14);
        e.set(leU32(crc), 16);
        e.set(leU32(size), 20);
        e.set(leU32(size), 24);
        e.set(leU16(nameB.length), 28);
        e.set(leU16(0), 30);
        e.set(leU16(0), 32);
        e.set(leU16(0), 34);
        e.set(leU16(0), 36);
        e.set(leU32(0), 38);
        e.set(leU32(offset), 42);
        e.set(nameB, 46);
        return e;
    }
    const enc = new TextEncoder();
    async function buildStoreZip(entries, onProgress) {
        const parts = [];
        const centralParts = [];
        let offset = 0;
        const base = new Date(Date.now() - entries.length * 2000);
        for (let i = 0; i < entries.length; i++) {
            const ent = entries[i];
            const dos = dosDateTime(new Date(base.getTime() + i * 2000));
            const nameB = enc.encode(ent.path);
            const ab = await ent.blob.arrayBuffer();
            const crc = crc32Bytes(ab);
            const size = ab.byteLength;
            parts.push(localHeader(nameB, crc, size, dos), ab);
            centralParts.push(centralEntry(nameB, crc, size, dos, offset));
            offset += 30 + nameB.length + size;
            if (onProgress) onProgress(i + 1, entries.length);
            if ((i & 15) === 15) await new Promise(r => setTimeout(r, 0));
        }
        const cd = new Blob(centralParts);
        const cdBytes = new Uint8Array(await cd.arrayBuffer());
        const cdSize = cdBytes.length;
        const eocd = new Uint8Array(22);
        eocd.set(leU32(0x06054b50), 0);
        eocd.set(leU16(0), 4); eocd.set(leU16(0), 6);
        eocd.set(leU16(entries.length), 8); eocd.set(leU16(entries.length), 10);
        eocd.set(leU32(cdSize), 12);
        eocd.set(leU32(offset), 16);
        eocd.set(leU16(0), 20);
        parts.push(cd, eocd);
        return new Blob(parts, { type: 'application/zip' });
    }

    // =====================================================================
    // 10. Stylesheet Injection
    // =====================================================================
    // 10a. Light/dark scheme detection (environment / browser / OS)
    // =====================================================================
    // Real detection of the current color scheme, not a styling guess: we
    // ask the platform through prefers-color-scheme — which reflects the OS
    // "dark mode" toggle, the browser's own theme, and any browser-level
    // per-site override — and make that decision the single authority:
    //   • <html data-bwdd-theme="dark|light"> mirrors the detected scheme
    //     (available to CSS rules or to any other code);
    //   • bwddTheme.isDark() / .current / .onChange() give the script a live
    //     value of the environment's light/dark state;
    //   • the dark-palette <style> created in injectStyles() is enabled only
    //     while the environment actually reports dark (see attachStyle), so
    //     the theme follows the OS/browser in every environment instead of
    //     depending on the page honouring a media query.
    // A 'change' listener keeps everything in sync when the user flips the
    // OS/browser theme while the viewer is already open — no reload needed.
    const bwddTheme = (() => {
        let scheme = 'light';          // resolved value: 'dark' | 'light'
        let started = false;
        let styleEl = null;            // dark-palette <style> gated by detection
        const subscribers = [];

        function mql(pref) {
            try {
                if (typeof window.matchMedia !== 'function') return null;
                return window.matchMedia('(prefers-color-scheme: ' + pref + ')');
            } catch (e) { return null; }
        }
        function readScheme() {
            // 'dark' wins; an explicit 'light' wins over nothing; anything
            // else (unsupported browser, "no-preference") resolves to light,
            // matching the script's default styling.
            const dark = mql('dark');
            if (dark && dark.matches) return 'dark';
            const light = mql('light');
            if (light && light.matches) return 'light';
            return 'light';
        }
        function publish() {
            try {
                if (document.documentElement) document.documentElement.setAttribute('data-bwdd-theme', scheme);
            } catch (e) {}
            for (const fn of subscribers) { try { fn(scheme); } catch (e) {} }
        }
        function gateStyle() {
            // The dark-palette <style> is present in the document only while
            // the environment reports dark. Attaching/removing the element is
            // the most widely supported gate (no reliance on CSSOM .disabled
            // semantics) and costs nothing: light mode simply has no dark
            // stylesheet, dark mode gets one, appended after the base sheet.
            if (!styleEl) return;
            const host = (typeof document !== 'undefined' && (document.head || document.documentElement)) || null;
            if (!host) return;
            const connected = typeof styleEl.isConnected === 'boolean' ? styleEl.isConnected : !!styleEl.parentNode;
            const dark = scheme === 'dark';
            try {
                if (dark && !connected) host.appendChild(styleEl);
                else if (!dark && connected && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
            } catch (e) {}
        }
        function onMediaChange() {
            const next = readScheme();
            if (next === scheme) return;
            scheme = next;
            gateStyle();
            publish();
            try { console.info('[bwdd] light/dark scheme:', scheme); } catch (e) {}
        }
        return {
            start() {
                if (started) return scheme;
                started = true;
                scheme = readScheme();
                publish();
                const dark = mql('dark');
                const light = mql('light');
                const attach = (mq) => {
                    if (!mq) return;
                    const fn = () => onMediaChange();
                    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', fn);
                    else if (typeof mq.addListener === 'function') mq.addListener(fn);   // legacy Safari
                };
                attach(dark); attach(light);
                try { console.info('[bwdd] light/dark scheme:', scheme); } catch (e) {}
                return scheme;
            },
            get current() { return scheme; },
            isDark() { return scheme === 'dark'; },
            onChange(fn) {
                if (typeof fn === 'function') subscribers.push(fn);
                if (started) { try { fn(scheme); } catch (e) {} }
            },
            attachStyle(el) {
                styleEl = el;
                gateStyle();
            },
        };
    })();
    try { bwddTheme.start(); } catch (e) {}
    if (BWDD_DEBUG) { try { window.__bwddTheme = bwddTheme; } catch (e) {} }

    let __bwddCssInjected = false;
    function injectStyles() {
        if (__bwddCssInjected) return;
        __bwddCssInjected = true;

        const font = document.createElement('link');
        font.href = 'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap';
        font.rel = 'stylesheet';
        document.head.appendChild(font);

        const css = document.createElement('style');
        css.textContent = `
#bwdd-root {
  --bwdd-accent-fill: #1d4ed8;
  --bwdd-amber-fill: #fcd9a8;
  --bwdd-bg: #ffffff;
  --bwdd-bg-ctrl: #f1f5f9;
  --bwdd-bg-ctrl-hover: #e2e8f0;
  --bwdd-bg-hover: #f1f5f9;
  --bwdd-bg-sunken: #f8fafc;
  --bwdd-border: #e2e8f0;
  --bwdd-border-soft: #f1f5f9;
  --bwdd-border-strong: #cbd5e1;
  --bwdd-code-bg: #f8fafc;
  --bwdd-danger: #b91c1c;
  --bwdd-danger-bg: #fef2f2;
  --bwdd-danger-border: #fecaca;
  --bwdd-glow-offline: 0 0 6px rgba(220, 38, 38, 0.45);
  --bwdd-glow-online: 0 0 6px rgba(21, 128, 61, 0.4);
  --bwdd-icon: #64748b;
  --bwdd-link: #1d4ed8;
  --bwdd-link-hover: #1e40af;
  --bwdd-link-hover-bg: rgba(29, 78, 216, 0.06);
  --bwdd-offline: #dc2626;
  --bwdd-root-fg: #0f172a;
  --bwdd-success: #15803d;
  --bwdd-success-dot: #15803d;
  --bwdd-text: #1e293b;
  --bwdd-text-ctrl: #334155;
  --bwdd-text-faint: #64748b;
  --bwdd-text-fainter: #94a3b8;
  --bwdd-text-muted: #475569;
  --bwdd-text-soft: #334155;
  --bwdd-text-strong: #0f172a;
  --bwdd-title: #1e293b;
  --bwdd-warn-bg: #fffbeb;
  --bwdd-warn-border: #fde68a;
  --bwdd-warn-code-bg: #fef9c3;
  --bwdd-warn-text: #92400e;
  --bwdd-busy: #d97706;   /* amber — bridge busy (OCR/upload) */
  --bwdd-glow-busy: 0 0 6px rgba(217, 119, 6, 0.45);
  --bwdd-white: #ffffff;

  position: fixed;
  top: 16px;
  right: 24px;   /* room to grow leftward when the stats column mounts */
  z-index: 2147483647;
  width: 400px;   /* single-column default; widens to 640px once the stats column mounts */
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 32px);
  min-height: 0;
  background: var(--bwdd-bg);
  color: var(--bwdd-root-fg);
  border-radius: 14px;
  border: 1px solid var(--bwdd-border);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.04);
  font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 12px;
  line-height: 1.4;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
  transition: height 0.2s ease, opacity 0.15s ease, width 0.25s ease, transform 0.25s ease;
}
#bwdd-root * { box-sizing: border-box; }
#bwdd-root.collapsed { height: auto !important; max-height: none !important; }
#bwdd-root.collapsed .bwdd-body { display: none; }
#bwdd-root.bwdd-stats-visible { width: 640px; }   /* two-column width, once there is a stats column to show */
@media (prefers-reduced-motion: reduce) {
  #bwdd-root, #bwdd-root *, .bwdd-btn, .bwdd-bar-fill { transition: none !important; }
}

/* Header with Drag Handle */
.bwdd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 10px 10px 12px;
  background: var(--bwdd-bg);
  border-bottom: 1px solid var(--bwdd-border-soft);
  cursor: grab;
  touch-action: none;
}
.bwdd-head:active { cursor: grabbing; }
.bwdd-title-group { display: flex; flex-direction: column; min-width: 0; }
.bwdd-title {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--bwdd-title);
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 1.2;
}
.bwdd-title .bwdd-icon { font-size: 14px; }
.bwdd-title-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.bwdd-subtitle {
  font-size: 11px;
  color: var(--bwdd-text-muted);
  font-weight: 500;
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 0 1 auto;   /* natural width — the GitHub link sits right after the text */
  min-width: 0;
}
.bwdd-gh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 17px;
  height: 17px;
  border-radius: 5px;
  color: var(--bwdd-text-muted);
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}
.bwdd-gh svg { width: 12px; height: 12px; fill: currentColor; display: block; }
.bwdd-gh:hover { color: var(--bwdd-link); background: var(--bwdd-link-hover-bg); }
.bwdd-gh:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
.bwdd-head-controls { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.bwdd-ctrl-btn {
  background: transparent;
  border: none;
  color: var(--bwdd-text-muted);
  font-size: 15px;
  line-height: 1;
  min-width: 32px;
  min-height: 32px;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.bwdd-ctrl-btn:hover { background: var(--bwdd-bg-hover); color: var(--bwdd-text-strong); }
.bwdd-ctrl-btn:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 2px; }
.bwdd-ctrl-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Scrollable Body */
.bwdd-body {
  padding: 10px 12px 12px;
  overflow: hidden;
  display: flex;
  flex-direction: row;
  gap: 10px;
  background: var(--bwdd-bg);
  user-select: text;
  flex: 1 1 auto;
  min-height: 0;
}
.bwdd-col { min-height: 0; }   /* allow the scrollable columns to shrink when the panel is resized vertically */
.bwdd-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.bwdd-col-stats {
  flex: 0 0 250px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.bwdd-col-main {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* Hairline between the controls column and the reading-stats column. It is
   appended together with the stats column, so it only exists once stats do. */
.bwdd-col-sep {
  flex: 0 0 auto;
  align-self: stretch;
  width: 1px;
  margin: 2px 0;
  background: var(--bwdd-border);
}
@media (max-width: 660px) {
  .bwdd-body { flex-direction: column; overflow-y: auto; }
  .bwdd-col-sep { display: none; }
  .bwdd-col-stats, .bwdd-col-main { flex: none; width: 100%; overflow: visible; }
}

/* Bridge Health Indicator */
.bwdd-bridge-pill {
  font-size: 11px;
  color: var(--bwdd-text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px;
  min-height: 24px;
}
.bwdd-indicator-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bwdd-text-fainter);
  display: inline-block;
  flex-shrink: 0;
}
.bwdd-indicator-dot.online { background: var(--bwdd-success-dot); box-shadow: var(--bwdd-glow-online); }

/* "What is the Mokuro Bridge?" help dot + toggleable infobox */
.bwdd-info-dot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--bwdd-border-strong);
  background: var(--bwdd-bg-sunken);
  color: var(--bwdd-icon);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  padding: 0;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.bwdd-info-dot:hover,
.bwdd-info-dot:focus-visible,
.bwdd-info-dot[aria-expanded="true"] {
  background: var(--bwdd-accent-fill);
  border-color: var(--bwdd-accent-fill);
  color: var(--bwdd-white);
}
.bwdd-info-dot:focus-visible { outline: 2px solid rgba(29, 78, 216, 0.4); outline-offset: 1px; }
/* "mokuro missing" alert (below the bridge row) + mokuro detail line in the info box */
.bwdd-mokuro-alert {
  margin: 2px 0 6px;
  padding: 7px 9px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--bwdd-danger);
  background: var(--bwdd-danger-bg);
  border: 1px solid var(--bwdd-danger-border);
  border-radius: 8px;
}
.bwdd-mokuro-alert:empty { display: none; }
.bwdd-indicator-dot.offline {
  background: var(--bwdd-offline);
  box-shadow: var(--bwdd-glow-offline);
}
.bwdd-indicator-dot.busy {
  background: var(--bwdd-busy);
  box-shadow: var(--bwdd-glow-busy);
}
.bwdd-bridge-info-mokuro {
  display: block;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--bwdd-success);
}
.bwdd-bridge-info-mokuro.missing { color: var(--bwdd-danger); }
.bwdd-bridge-info {
  margin: 2px 0 6px;
  padding: 9px 11px 10px;
  background: var(--bwdd-bg-sunken);
  border: 1px solid var(--bwdd-border);
  border-radius: 10px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--bwdd-text-soft);
}
.bwdd-bridge-info[hidden] { display: none; }
.bwdd-bridge-info-title {
  display: block;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--bwdd-text-muted);
  margin-bottom: 7px;
}
.bwdd-bridge-info-section { display: block; }
.bwdd-bridge-info-subhead {
  display: block;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--bwdd-text-muted);
  margin-bottom: 2px;
}
.bwdd-bridge-info-divider {
  border: none;
  border-top: 1px solid var(--bwdd-border);
  margin: 7px 0;
}
.bwdd-bridge-info-body { display: block; }
.bwdd-bridge-info-link {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--bwdd-link);
  text-decoration: none;
  font-weight: 600;
  font-size: 11px;
  line-height: 1.5;
  border: 1px solid currentColor;
  border-radius: 6px;
  padding: 4px 8px;
  min-height: 24px;
  white-space: nowrap;
}
.bwdd-bridge-info-link:hover { text-decoration: underline; background: var(--bwdd-link-hover-bg); }
.bwdd-bridge-info-link:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 2px; }

/* Progress Bars */
.bwdd-bars {
  display: none;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: var(--bwdd-bg-sunken);
  border: 1px solid var(--bwdd-border);
  border-radius: 10px;
}
.bwdd-bar-row { display: none; flex-direction: column; gap: 3px; }
.bwdd-bar-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--bwdd-text-muted);
}
.bwdd-bar-rate { font-variant-numeric: tabular-nums; color: var(--bwdd-text-strong); }
.bwdd-bar-track {
  position: relative;
  height: 6px;
  background: var(--bwdd-border);
  border-radius: 999px;
  overflow: hidden;
}
.bwdd-bar-fill,
.bwdd-bar-fill-bg {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  width: 0%;
  border-radius: 999px;
  transition: width 0.2s ease;
}
.bwdd-bar-fill { z-index: 2; }
.bwdd-bar-fill-bg {
  z-index: 1;
  background: var(--bwdd-amber-fill);   /* faint amber — pages received, not yet OCR'd */
}
.bwdd-bar-legend {
  font-size: 10px;
  line-height: 1.4;
  color: var(--bwdd-text-faint);
  margin-top: 1px;
}

/* Cards & Badges — compact, LearnNatively / Manga-Kotoba inspired */
.bwdd-cards { display: flex; flex-direction: column; gap: 8px; }
.bwdd-cards:empty { display: none; }
.bwdd-card {
  border: 1px solid var(--bwdd-border);
  background: var(--bwdd-bg);
  border-radius: 10px;
  padding: 8px 10px;
}
.bwdd-card h3 {
  margin: 0 0 5px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--bwdd-text-muted);
  line-height: 1.3;
}
.bwdd-card[data-card="book"] {
  background: var(--bwdd-bg-sunken);
  border-color: var(--bwdd-border-strong);
}
.bwdd-book-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--bwdd-text-strong);
  margin-bottom: 5px;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.bwdd-spec-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.bwdd-spec-badges:empty { display: none; }
.bwdd-spec-badge {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-size: 11px;
  background: var(--bwdd-bg);
  border: 1px solid var(--bwdd-border);
  border-radius: 6px;
  padding: 1px 6px;
  line-height: 1.5;
}
.bwdd-spec-lbl { color: var(--bwdd-text-muted); font-weight: 500; }
.bwdd-spec-val { color: var(--bwdd-text-strong); font-weight: 600; font-variant-numeric: tabular-nums; }

.bwdd-card-sub { font-size: 11px; font-weight: 600; color: var(--bwdd-text); margin-bottom: 4px; line-height: 1.35; }
.bwdd-lvl-cap { font-size: 10px; color: var(--bwdd-text-muted); font-weight: 500; }

/* Compact stat rows (shared LN + MK) */
.bwdd-grid {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 1px 10px;
  font-size: 11px;
  margin: 2px 0 4px;
}
.bwdd-grid dt { color: var(--bwdd-text-muted); font-weight: 500; line-height: 1.6; }
.bwdd-grid dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--bwdd-title); line-height: 1.6; }

.bwdd-card-links { display: flex; gap: 6px; margin-top: 6px; font-size: 11px; }
.bwdd-link {
  color: var(--bwdd-link);
  text-decoration: none;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid currentColor;
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  line-height: 1.5;
  min-height: 24px;
}
.bwdd-card-links .bwdd-link { flex: 1; text-align: center; }
.bwdd-link:hover { text-decoration: underline; background: var(--bwdd-link-hover-bg); }
.bwdd-link:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 2px; }

.bwdd-nlvl-pill {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border-radius: 6px;
  padding: 2px 9px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  line-height: 1.5;
  min-height: 22px;
}
/* LearnNatively card: warm cream body, brown text, teal links */
.bwdd-card[data-card="natively"] {
  background: #faf6ee;
  border-color: #e8ddc9;
  color: #3f3227;
  box-shadow: none;
}
.bwdd-card[data-card="natively"] h3 { color: #8a6d3b; }
.bwdd-card[data-card="natively"] .bwdd-card-sub { color: #3f3227; }
.bwdd-card[data-card="natively"] .bwdd-lvl-cap { color: #6f5f4d; }
.bwdd-card[data-card="natively"] .bwdd-link { color: #0f766e; border-color: #0f766e; }
.bwdd-card[data-card="natively"] .bwdd-link:hover { background: rgba(15, 118, 110, 0.08); }
.bwdd-card[data-card="natively"] .bwdd-link:focus-visible { outline-color: #0f766e; }
.bwdd-ln-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.bwdd-ln-title-row {
  display: block;
  flex: 1 1 160px;
  min-width: 0;
  margin-bottom: 0;
  line-height: 1.45;
}
.bwdd-ln-meta {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0;
  flex: 0 0 auto;
}
.bwdd-ln-social {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 3px 16px;
  border-top: 1px solid #e8ddc9;
  padding-top: 6px;
  margin: 6px 0 0;
  line-height: 1.7;
  font-size: 11px;
  color: #6f5f4d;
  text-align: left;
}
/* Manga-Kotoba card: plain white body, sage text, hairline ledger rows */
.bwdd-card[data-card="manga-kotoba"] {
  background: #ffffff;
  border-color: #dfe3d2;
  color: #243b2a;
  box-shadow: none;
}
.bwdd-card[data-card="manga-kotoba"] h3 { color: #6b5d2e; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid { margin-bottom: 2px; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dt,
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dd {
  padding: 1px 0;
  border-bottom: 1px solid #edf0e3;
}
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dt { color: #5b6650; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dd { color: #243b2a; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link { color: #3f6212; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link:hover { background: rgba(63, 98, 18, 0.07); }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link:focus-visible { outline-color: #3f6212; }
.bwdd-mk-title {
  display: block;
  text-align: center;
  margin-bottom: 2px;
}
.bwdd-lnbadge {
  display: inline-block;
  border: 1px solid var(--bwdd-border-strong);
  border-radius: 5px;
  color: var(--bwdd-text-muted);
  font-size: 10px;
  font-weight: 700;
  padding: 0 5px;
  line-height: 1.6;
}
.bwdd-none { font-size: 11px; color: var(--bwdd-text-muted); margin: 0 0 6px; line-height: 1.5; text-align: center; }

/* Action Buttons */
.bwdd-actions { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }

/* Upload destination picker */
.bwdd-dest {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 6px;
  padding: 8px 10px;
  background: var(--bwdd-bg-sunken);
  border: 1px solid var(--bwdd-border);
  border-radius: 10px;
}
.bwdd-dest-label { font-size: 11px; font-weight: 600; color: var(--bwdd-text-muted); }
.bwdd-dest-select, .bwdd-dest-input {
  font: 12px inherit;
  padding: 5px 7px;
  border: 1px solid var(--bwdd-border-strong);
  border-radius: 6px;
  background: var(--bwdd-bg);
  color: var(--bwdd-root-fg);
  width: 100%;
}
.bwdd-dest-select:focus-visible, .bwdd-dest-input:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
.bwdd-dest-localdir { display: flex; flex-direction: column; gap: 3px; }
.bwdd-dest-hint { font-size: 11px; color: var(--bwdd-warn-text); background: var(--bwdd-warn-bg); border: 1px solid var(--bwdd-warn-border); border-radius: 6px; padding: 5px 7px; line-height: 1.4; }
.bwdd-dest-hint code { font-family: ui-monospace, monospace; font-size: 10px; background: var(--bwdd-warn-code-bg); border-radius: 3px; padding: 0 3px; }
.bwdd-btn-fill {
  flex: 0 0 auto;
  font: 600 11px inherit;
  padding: 5px 8px;
  border: 1px solid var(--bwdd-border-strong);
  border-radius: 6px;
  background: var(--bwdd-bg-ctrl);
  color: var(--bwdd-text-ctrl);
  cursor: pointer;
  white-space: nowrap;
}
.bwdd-btn-fill:hover { background: var(--bwdd-bg-ctrl-hover); }
.bwdd-btn-fill:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
.bwdd-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 8px 12px;
  min-height: 44px;
  border: none;
  border-radius: 10px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--bwdd-white);
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s;
}
.bwdd-btn-sub {
  font-size: 11px;
  font-weight: 400;
  opacity: 0.9;
  margin-top: 1px;
}
.bwdd-btn > span { text-align: center; width: 100%; }
.bwdd-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}
.bwdd-btn:active:not(:disabled) { transform: translateY(0); }
.bwdd-btn:focus-visible { outline: 2px solid var(--bwdd-root-fg); outline-offset: 2px; }
.bwdd-btn:disabled { opacity: 0.6; cursor: not-allowed; }
@media (forced-colors: active) {
  .bwdd-btn, .bwdd-nlvl-pill { forced-color-adjust: none; }
}

.bwdd-btn.zip {
  background: linear-gradient(135deg, #15803d 0%, #166534 100%);
  box-shadow: 0 4px 12px rgba(22, 101, 52, 0.25);
}
.bwdd-btn.zip:hover:not(:disabled) {
  box-shadow: 0 6px 16px rgba(22, 101, 52, 0.35);
}
.bwdd-btn.ocr {
  background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);
}
.bwdd-btn.ocr:hover:not(:disabled) {
  box-shadow: 0 6px 16px rgba(37, 99, 235, 0.35);
}

/* Destination section dimmed while a run holds the lock */
.bwdd-dest-locked { opacity: 0.7; }

/* "Open Reader Mokuro" + open-file/copy — one quiet row, only after a
   successful OCR run. Both are secondary actions, so they share a calm
   outline-button look instead of loud filled gradients. */
.bwdd-reader-row {
  display: none;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 6px;
  margin-top: 6px;
}
.bwdd-reader-row > .bwdd-ghost-btn {
  min-width: 0;
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 10px;
  min-height: 30px;
  border: 1px solid var(--bwdd-border-strong);
  border-radius: 8px;
  background: var(--bwdd-bg);
  color: var(--bwdd-text-muted);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.bwdd-reader-row > .bwdd-ghost-btn:hover {
  background: var(--bwdd-bg-sunken);
  color: var(--bwdd-link);
  border-color: var(--bwdd-link);
}
.bwdd-reader-row > .bwdd-ghost-btn:focus-visible {
  outline: 2px solid var(--bwdd-link);
  outline-offset: 1px;
}

.bwdd-hint-box {
  font-size: 11px;
  color: var(--bwdd-text-muted);
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.45;
}
.bwdd-hint-box:empty { display: none; }
/* Collapsible raw-error block inside the status area (see setRunDetails) */
.bwdd-hint-box details { margin-top: 6px; }
.bwdd-hint-box summary {
  cursor: pointer;
  color: var(--bwdd-link);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.bwdd-hint-box summary:hover { color: var(--bwdd-link-hover); }
.bwdd-hint-box pre {
  margin: 6px 0 0;
  padding: 6px 8px;
  background: var(--bwdd-code-bg);
  border: 1px solid var(--bwdd-border);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--bwdd-text-muted);
  max-height: 140px;
  overflow: auto;
}
/* Panel flapped away to the right — an edge tab stays to bring it back */
#bwdd-root.bwdd-flapped { pointer-events: none; }
.bwdd-edge-tab {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2147483647;
  display: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 76px;
  padding: 0;
  border: none;
  border-radius: 10px 0 0 10px;
  background: #1d4ed8;
  color: #ffffff;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  box-shadow: -3px 0 10px rgba(15, 23, 42, 0.18);
  transition: background 0.15s;
}
.bwdd-edge-tab:hover { background: #2563eb; }
.bwdd-edge-tab:focus-visible { outline: 2px solid #1d4ed8; outline-offset: -2px; }
/* Header drag grip + corner resize handle */
.bwdd-drag-grip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: stretch;
  width: 16px;
  color: var(--bwdd-text-fainter);
  font-size: 11px;
  line-height: 1;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.bwdd-drag-grip:active { cursor: grabbing; }
.bwdd-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 22px;
  height: 22px;
  z-index: 6;
  cursor: nwse-resize;   /* corner: resize both width and height */
  touch-action: none;
  user-select: none;
}
.bwdd-resize::after {
  content: '';
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 9px;
  height: 9px;
  border-right: 2px solid var(--bwdd-text-fainter);
  border-bottom: 2px solid var(--bwdd-text-fainter);
  border-bottom-right-radius: 3px;
  opacity: 0.65;
  transition: opacity 0.15s;
}
.bwdd-resize:hover::after,
.bwdd-resize:active::after { opacity: 1; }
#bwdd-root.collapsed .bwdd-resize,
#bwdd-root.bwdd-flapped .bwdd-resize { display: none; }

`;
        (document.head || document.documentElement).appendChild(css);

        // Dark palette (only active while bwddTheme detects dark — section
        // 10a). This is a deliberate per-rule remap, not a blanket inversion:
        // the script's own chrome and surfaces are re-themed with the dark
        // palette chosen for contrast (slate-900 surfaces, slate-200/300/400
        // text tiers). The LearnNatively and Manga-Kotoba stat cards get
        // brand-matched dark variants further down (warm espresso / sage ink),
        // so every surface in the panel reads correctly in dark mode. The
        // only elements deliberately left alone are the Natively difficulty
        // level rectangles (.bwdd-nlvl-pill): they carry their own semantic
        // colors inline and already look right on dark. The rules have no
        // @media wrapper on purpose: the stylesheet element is
        // attached/removed by bwddTheme.attachStyle() below, so the
        // environment detection (OS/browser) is the one gate.
        const darkCss = document.createElement('style');
        darkCss.textContent = `
#bwdd-root {
  --bwdd-accent-fill: #3b82f6;
  --bwdd-amber-fill: rgba(245, 158, 11, 0.22);
  --bwdd-bg: #0f172a;
  --bwdd-bg-ctrl: #334155;
  --bwdd-bg-ctrl-hover: #475569;
  --bwdd-bg-hover: #1e293b;
  --bwdd-bg-sunken: #1e293b;
  --bwdd-border: #334155;
  --bwdd-border-soft: #1e293b;
  --bwdd-border-strong: #475569;
  --bwdd-code-bg: #0f172a;
  --bwdd-danger: #f87171;
  --bwdd-danger-bg: rgba(127, 29, 29, 0.28);
  --bwdd-danger-border: #7f1d1d;
  --bwdd-glow-offline: 0 0 6px rgba(248, 113, 113, 0.4);
  --bwdd-glow-online: 0 0 6px rgba(34, 197, 94, 0.45);
  --bwdd-icon: #cbd5e1;
  --bwdd-link: #60a5fa;
  --bwdd-link-hover: #93c5fd;
  --bwdd-link-hover-bg: rgba(96, 165, 250, 0.12);
  --bwdd-offline: #f87171;
  --bwdd-root-fg: #e2e8f0;
  --bwdd-success: #4ade80;
  --bwdd-success-dot: #22c55e;
  --bwdd-text: #e2e8f0;
  --bwdd-text-ctrl: #e2e8f0;
  --bwdd-text-faint: #94a3b8;
  --bwdd-text-fainter: #64748b;
  --bwdd-text-muted: #94a3b8;
  --bwdd-text-soft: #cbd5e1;
  --bwdd-text-strong: #f1f5f9;
  --bwdd-title: #f1f5f9;
  --bwdd-warn-bg: rgba(251, 191, 36, 0.12);
  --bwdd-warn-border: rgba(251, 191, 36, 0.35);
  --bwdd-warn-code-bg: rgba(251, 191, 36, 0.25);
  --bwdd-warn-text: #fcd34d;
  --bwdd-busy: #f59e0b;
  --bwdd-glow-busy: 0 0 6px rgba(245, 158, 11, 0.5);
  --bwdd-white: #ffffff;
  background: var(--bwdd-bg);
  color: var(--bwdd-root-fg);
  border-color: var(--bwdd-border);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.35);
  color-scheme: dark;
}

/* LearnNatively card, dark variant: warm espresso surfaces with cream text.
   The difficulty level rectangles (.bwdd-nlvl-pill) are deliberately NOT
   restyled here — their semantic colors are set inline by JS and already
   read correctly on the dark card. */
.bwdd-card[data-card="natively"] {
  background: #201a12;
  border-color: #463a27;
  color: #e9dcbf;
  box-shadow: none;
}
.bwdd-card[data-card="natively"] h3 { color: #cfa95f; }
.bwdd-card[data-card="natively"] .bwdd-card-sub { color: #f0e6d2; }
.bwdd-card[data-card="natively"] .bwdd-lvl-cap { color: #bfa97f; }
.bwdd-card[data-card="natively"] .bwdd-lnbadge {
  border-color: #574832;
  background: #2a2319;
  color: #d5c5a6;
}
.bwdd-card[data-card="natively"] .bwdd-link { color: #2dd4bf; border-color: #2dd4bf; }
.bwdd-card[data-card="natively"] .bwdd-link:hover { background: rgba(45, 212, 191, 0.12); }
.bwdd-card[data-card="natively"] .bwdd-link:focus-visible { outline-color: #2dd4bf; }
.bwdd-card[data-card="natively"] .bwdd-ln-social {
  border-top-color: #4a3d2a;
  color: #c8b896;
}


/* Manga-Kotoba card, dark variant: deep sage ink with sage/cream text. */
.bwdd-card[data-card="manga-kotoba"] {
  background: #131a14;
  border-color: #2e3f33;
  color: #d9e4da;
  box-shadow: none;
}
.bwdd-card[data-card="manga-kotoba"] h3 { color: #cfbf7a; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-card-sub { color: #e6efe7; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dt,
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dd {
  border-bottom-color: #283a2f;
}
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dt { color: #9db3a1; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dd { color: #e2ebe3; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link { color: #84cc16; border-color: #84cc16; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link:hover { background: rgba(132, 204, 22, 0.14); }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link:focus-visible { outline-color: #84cc16; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-none { color: #a9bcab; }
.bwdd-dest-select:focus-visible, .bwdd-dest-input:focus-visible,
.bwdd-btn-fill:focus-visible { outline-color: #60a5fa; }
.bwdd-hint-box summary { color: #60a5fa; }
.bwdd-hint-box summary:hover { color: #93c5fd; }
.bwdd-hint-box pre { background: #0f172a; border-color: #334155; color: #94a3b8; }
/* Edge restore tab (dark) */
.bwdd-edge-tab { background: #3b82f6; color: #ffffff; box-shadow: -3px 0 10px rgba(0, 0, 0, 0.4); }
.bwdd-edge-tab:hover { background: #60a5fa; }
.bwdd-edge-tab:focus-visible { outline-color: #60a5fa; }
/* Quiet reader/stored row (dark) — colors come from --bwdd-* tokens */
.bwdd-reader-row > .bwdd-ghost-btn { background: var(--bwdd-bg); color: var(--bwdd-text-muted); border-color: var(--bwdd-border-strong); }
.bwdd-reader-row > .bwdd-ghost-btn:hover { background: var(--bwdd-bg-sunken); color: var(--bwdd-link); border-color: var(--bwdd-link); }

`;
        (document.head || document.documentElement).appendChild(darkCss);
        bwddTheme.attachStyle(darkCss);   // removed from the DOM unless dark is detected
    }

    // Remembered panel placement/collapse, restored on the next open.
    const PANEL_POS_KEY = 'bwdd-panel-pos';
    const PANEL_COLLAPSED_KEY = 'bwdd-panel-collapsed';
    const PANEL_WIDTH_KEY = 'bwdd-panel-width';   // manual resize, if any
    const PANEL_HEIGHT_KEY = 'bwdd-panel-height';   // manual vertical resize, if any
    const PANEL_WIDTH_SINGLE = 400;
    const PANEL_WIDTH_TWOCOL = 640;

    function buildUI() {
        injectStyles();
        const root = document.createElement('section');
        root.id = 'bwdd-root';
        // A labelled region, not a modal dialog: the panel never traps focus
        // or blocks the viewer behind it, and Esc collapses rather than closes.
        root.setAttribute('role', 'region');
        root.setAttribute('aria-labelledby', 'bwdd-panel-title');

        // Header
        const head = document.createElement('div');
        head.className = 'bwdd-head';
        head.setAttribute('title', 'Drag to reposition');

        const titleGroup = document.createElement('div');
        titleGroup.className = 'bwdd-title-group';

        const title = document.createElement('h2');
        title.id = 'bwdd-panel-title';
        title.className = 'bwdd-title';
        title.innerHTML = '<span class="bwdd-icon" aria-hidden="true">📖</span> BookWalker Native Downloader';

        // Version tag row: "vX.Y.Z by <author>" with a GitHub link right next
        // to it (the repo this script will live in).
        const titleSub = document.createElement('div');
        titleSub.className = 'bwdd-title-sub';

        const sub = document.createElement('div');
        sub.className = 'bwdd-subtitle';
        sub.textContent = `v${BWDD_VERSION} by ${BWDD_AUTHOR}`;

        const ghLink = document.createElement('a');
        ghLink.className = 'bwdd-gh';
        ghLink.href = BWDD_REPO_URL;
        ghLink.target = '_blank';
        ghLink.rel = 'noopener noreferrer';
        ghLink.setAttribute('aria-label', 'Open the GitHub repository in a new tab');
        ghLink.title = 'GitHub repository: ' + BWDD_REPO_URL;
        ghLink.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
        titleSub.append(sub, ghLink);
        titleGroup.append(title, titleSub);

        const ctrlGroup = document.createElement('div');
        ctrlGroup.className = 'bwdd-head-controls';

        const minBtn = document.createElement('button');
        minBtn.type = 'button';
        minBtn.className = 'bwdd-ctrl-btn';
        minBtn.setAttribute('aria-label', 'Minimize panel');
        minBtn.setAttribute('aria-expanded', 'true');
        minBtn.setAttribute('aria-controls', 'bwdd-body');
        minBtn.textContent = '–';
        minBtn.setAttribute('title', 'Minimize panel (Esc)');
        function setCollapsed(isCol) {
            root.classList.toggle('collapsed', isCol);
            minBtn.textContent = isCol ? '+' : '–';
            minBtn.setAttribute('aria-label', isCol ? 'Expand panel' : 'Minimize panel');
            minBtn.setAttribute('aria-expanded', String(!isCol));
            try { localStorage.setItem(PANEL_COLLAPSED_KEY, isCol ? '1' : '0'); } catch (e) {}
        }
        minBtn.onclick = () => setCollapsed(!root.classList.contains('collapsed'));

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'bwdd-ctrl-btn';
        closeBtn.setAttribute('aria-label', 'Close downloader panel');
        closeBtn.setAttribute('title', 'Close panel');
        closeBtn.textContent = '×';
        // Close tears the panel down completely: it stops the periodic
        // bridge-health poll and removes the window-level listener + observer,
        // so nothing keeps hitting 127.0.0.1:62642 or mutating detached DOM
        // after the user closes the panel. (The edge-tab "flap" is the
        // non-destructive way to tuck the panel away and bring it back.)
        closeBtn.onclick = () => {
            try { if (bridgeTimer) { clearTimeout(bridgeTimer); bridgeTimer = null; } } catch (e) {}
            try { window.removeEventListener('keydown', onPanelKeydown); } catch (e) {}
            try { statsObs.disconnect(); } catch (e) {}
            try { root.remove(); } catch (e) {}
            try { if (edgeTab) edgeTab.remove(); } catch (e) {}
        };

        // "Flap" control: slides the whole panel off the right edge of the
        // screen (a small tab on the right edge brings it back).
        const flapBtn = document.createElement('button');
        flapBtn.type = 'button';
        flapBtn.className = 'bwdd-ctrl-btn';
        flapBtn.setAttribute('aria-label', 'Hide the panel to the right edge');
        flapBtn.setAttribute('aria-expanded', 'true');
        flapBtn.setAttribute('title', 'Slide the panel away to the right edge of the screen');
        flapBtn.textContent = '»';

        ctrlGroup.append(flapBtn, minBtn, closeBtn);

        // Visible drag grip at the left of the header (the whole header also
        // drags — this just makes the affordance obvious).
        const dragGrip = document.createElement('span');
        dragGrip.className = 'bwdd-drag-grip';
        dragGrip.setAttribute('aria-hidden', 'true');
        dragGrip.textContent = '\u283F';   // braille dots: grab handle look
        head.append(dragGrip, titleGroup, ctrlGroup);

        // Body
        const body = document.createElement('div');
        body.className = 'bwdd-body';
        body.id = 'bwdd-body';

        // Bridge Health Banner
        const bridgeRow = document.createElement('div');
        bridgeRow.className = 'bwdd-bridge-pill';
        const dot = document.createElement('span');
        dot.className = 'bwdd-indicator-dot';
        dot.setAttribute('aria-hidden', 'true');
        const bridgeText = document.createElement('span');
        bridgeText.textContent = 'Looking for the Mokuro Bridge helper…';
        bridgeRow.title = 'mokuro-bridge: a small local app (github.com/GolyBidoof/mokuro-bridge) that runs mokuro OCR on the downloaded pages and can upload the results.';
        bridgeRow.append(dot, bridgeText);

        // Red alert shown below the bridge row when the bridge runs but mokuro
        // itself is not installed — the OCR button is unusable in that state.
        const mokuroAlert = document.createElement('div');
        mokuroAlert.className = 'bwdd-mokuro-alert';
        mokuroAlert.style.display = 'none';
        mokuroAlert.setAttribute('role', 'alert');

        // “?” info dot next to the connection-status dot. Pressing it shows a
        // small infobox right under the bridge status row explaining what the
        // local mokuro-bridge app is used for, with a real, clickable link to
        // the GitHub repo; pressing “?” again hides it.
        const infoDot = document.createElement('button');
        infoDot.type = 'button';
        infoDot.className = 'bwdd-info-dot';
        infoDot.setAttribute('aria-label', 'What is the Mokuro Bridge used for?');
        infoDot.setAttribute('aria-expanded', 'false');
        infoDot.textContent = '?';
        bridgeRow.insertBefore(infoDot, bridgeText);

        const bridgeInfo = document.createElement('div');
        bridgeInfo.className = 'bwdd-bridge-info';
        bridgeInfo.hidden = true;
        const infoTitle = document.createElement('span');
        infoTitle.className = 'bwdd-bridge-info-title';
        infoTitle.textContent = 'What is the Mokuro Bridge?';

        // Section 1 — the mokuro OCR engine installed on this machine
        // (version + custom-fork marker), or a red note when it's missing.
        // Updated from /health on each status tick.
        const mokuroSection = document.createElement('div');
        mokuroSection.className = 'bwdd-bridge-info-section';
        const mokuroSectionHeading = document.createElement('span');
        mokuroSectionHeading.className = 'bwdd-bridge-info-subhead';
        mokuroSectionHeading.textContent = 'Mokuro engine';
        const infoMokuro = document.createElement('span');
        infoMokuro.className = 'bwdd-bridge-info-mokuro';
        mokuroSection.append(mokuroSectionHeading, infoMokuro);

        // Section divider
        const divider1 = document.createElement('hr');
        divider1.className = 'bwdd-bridge-info-divider';

        // Section 2 — what the bridge does
        const aboutSection = document.createElement('div');
        aboutSection.className = 'bwdd-bridge-info-section';
        const aboutSectionHeading = document.createElement('span');
        aboutSectionHeading.className = 'bwdd-bridge-info-subhead';
        aboutSectionHeading.textContent = 'What it does';
        const infoBody = document.createElement('span');
        infoBody.className = 'bwdd-bridge-info-body';
        infoBody.textContent = 'A small companion app that runs locally on your computer. ' +
            'Choosing “Save and run through Mokuro” sends the downloaded pages to it, where ' +
            'mokuro runs Japanese OCR on them; the finished volume is then saved or ' +
            'uploaded wherever you pick. Plain “Save as ZIP” downloads don\'t use it.';
        aboutSection.append(aboutSectionHeading, infoBody);

        // Section divider
        const divider2 = document.createElement('hr');
        divider2.className = 'bwdd-bridge-info-divider';

        // Download link (points at the same GitHub repo)
        const infoLink = document.createElement('a');
        infoLink.className = 'bwdd-bridge-info-link';
        infoLink.href = 'https://github.com/GolyBidoof/mokuro-bridge';
        infoLink.target = '_blank';
        infoLink.rel = 'noopener noreferrer';
        infoLink.textContent = 'Download mokuro-bridge ↗';
        bridgeInfo.append(infoTitle, mokuroSection, divider1, aboutSection, divider2, infoLink);
        infoDot.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = bridgeInfo.hidden;
            bridgeInfo.hidden = !open;
            infoDot.setAttribute('aria-expanded', String(open));
        });

        // Human-readable busy reason from the bridge's /health fields.
        function busyReason(info) {
            if (!info) return '';
            const stage = info.busy_stage;
            if (info.busy) {
                if (stage === 'uploading') return 'Uploading…';
                if (stage === 'ocr') return info.busy_detail || 'OCR running…';
                return info.busy_detail || 'Busy…';
            }
            return '';
        }
        async function updateBridgeDot() {
            if (!root.isConnected) return;   // panel closed — skip the tick entirely
            const ok = await bridgeHealth();
            let mokuroMissing = false;
            let mokuroDetailText = '';
            let bridgeBusy = false;
            let bridgeBusyStage = '';
            let bridgeBusyDetail = '';
            // The bridge answers /health even when mokuro isn't installed
            // (mokuro_installed:false) — that still means the bridge process is
            // up, so it's an "online but unusable for OCR" state, not offline.
            if (ok) {
                const info = await refreshBridgeInfo().catch(() => null);
                mokuroMissing = !!(info && info.mokuro_installed === false);
                bridgeBusy = !!(info && info.busy);
                bridgeBusyStage = (info && info.busy_stage) || '';
                bridgeBusyDetail = (info && info.busy_detail) || '';
                if (info && info.mokuro_installed === true) {
                    mokuroDetailText = info.mokuro_version
                        ? 'Mokuro v' + info.mokuro_version + (info.mokuro_custom_fork ? ' (custom fork)' : '') + ' is installed on this machine.'
                        : 'Mokuro is installed on this machine.';
                    infoMokuro.classList.remove('missing');
                } else if (mokuroMissing) {
                    mokuroDetailText = 'Mokuro is not installed on this machine — OCR cannot run.';
                    infoMokuro.classList.add('missing');
                } else {
                    mokuroDetailText = '';
                    infoMokuro.classList.remove('missing');
                }
            } else {
                mokuroDetailText = 'Bridge not reachable — start it to check the installed mokuro.';
                infoMokuro.classList.remove('missing');
            }
            infoMokuro.textContent = mokuroDetailText;
            bridgeOnline = ok && !mokuroMissing;
            if (ok && mokuroMissing) {
                // Bridge up but no OCR engine: block OCR, show a red alert.
                dot.className = 'bwdd-indicator-dot offline';
                mokuroAlert.style.display = 'block';
                mokuroAlert.textContent = 'Mokuro is not installed on this machine. ' +
                    'OCR cannot run until you install it — e.g. run “pip install mokuro” (or point ' +
                    'the bridge at your mokuro checkout) in the mokuro-bridge folder, then restart the bridge.';
            } else if (ok && bridgeBusy) {
                // Bridge is working (OCR/upload) — amber dot + reason.
                dot.className = 'bwdd-indicator-dot busy';
                mokuroAlert.style.display = 'none';
            } else {
                dot.className = ok ? 'bwdd-indicator-dot online' : 'bwdd-indicator-dot';
                mokuroAlert.style.display = 'none';
            }
            if (ok && !mokuroMissing) {
                destWrap.style.display = 'flex';
                // Refresh the destination list only while idle: mid-run the
                // dropdown must keep exactly the pick the run started with
                // (the run reads it again at finalize time).
                if (!runBusy) { try { populateDestMethods(); } catch (e) {} }
                if (bridgeBusy) {
                    // While the bridge is busy, say what it's doing instead of
                    // re-asserting "online" (the dot is already amber).
                    bridgeText.textContent = 'Mokuro Bridge busy — ' + (busyReason({ busy: true, busy_stage: bridgeBusyStage, busy_detail: bridgeBusyDetail }) || 'working');
                    bridgeRow.title = 'mokuro-bridge: ' + (bridgeBusyDetail ? bridgeBusyDetail + ' · ' : '') + 'github.com/GolyBidoof/mokuro-bridge';
                } else {
                    // Idle — describe the destination from the panel's own pick
                    // (the same dropdown the user sees), so the status line can
                    // never contradict what is about to be used at finalize.
                    try {
                        const hasOptions = !!(destSelect.options && destSelect.options.length);
                        const method = hasOptions ? (destSelect.value || 'local') : 'local';
                        let desc, folder = null;
                        if (method === 'local') {
                            folder = localDirInput.value.trim() || (bridgeInfo && bridgeInfo.output_dir) || null;
                            desc = 'saving locally';
                        } else {
                            const opt = destSelect.selectedOptions && destSelect.selectedOptions[0];
                            const text = opt ? String(opt.textContent) : '';
                            const name = opt ? text.split(' — ')[0].trim() : method;
                            const m = text.match(/—\s*(.+)$/);
                            folder = m ? m[1].trim() : null;
                            desc = 'uploading via ' + (name || method);
                        }
                        bridgeText.textContent = 'Mokuro Bridge + Mokuro online — ' + desc;
                        bridgeRow.title = 'mokuro-bridge: ' + (folder ? 'writes to ' + folder + ' · ' : '') + 'github.com/GolyBidoof/mokuro-bridge';
                    } catch (e) {
                        bridgeText.textContent = 'Mokuro Bridge + Mokuro online';
                    }
                }
            } else {
                destWrap.style.display = 'none';
                bridgeText.textContent = ok
                    ? 'Mokuro Bridge is online but mokuro is missing — install it to enable OCR'
                    : 'Mokuro Bridge is not found on port 62642 — start it to enable OCR';
            }
            // OCR button + destination pickers derive from the run lock, so
            // this periodic tick can never re-enable them mid-run.
            setRunLock(runBusy);
            // Poll fast (1 s) while the bridge is busy — whether from our own
            // run or background work it reports via /health — so the UI
            // notices the moment it goes idle; otherwise settle to 10 s.
            bridgePollFast = !!(bridgeBusy || runBusy);
            scheduleBridgePoll();
        }

        let bridgeTimer = null;
        let bridgePollFast = false;
        function scheduleBridgePoll() {
            if (bridgeTimer) { clearTimeout(bridgeTimer); bridgeTimer = null; }
            bridgeTimer = setTimeout(updateBridgeDot, bridgePollFast ? 1000 : 10000);
        }
        updateBridgeDot();

        const statsEl = document.createElement('div');
        statsEl.className = 'bwdd-cards';

        // Run status area: live region so screen readers announce new
        // outcome/warning messages the moment they land here.
        const details = document.createElement('div');
        details.className = 'bwdd-hint-box';
        details.setAttribute('aria-live', 'polite');

        // Progress Bars
        function mkBar(label, gradient, a11yLabel) {
            const row = document.createElement('div');
            row.className = 'bwdd-bar-row';
            const meta = document.createElement('div');
            meta.className = 'bwdd-bar-meta';
            const name = document.createElement('span');
            name.textContent = label;
            const rate = document.createElement('span');
            rate.className = 'bwdd-bar-rate';
            rate.textContent = '—';
            meta.append(name, rate);

            const track = document.createElement('div');
            track.className = 'bwdd-bar-track';
            // faint background segment (used by the Mokuro bar to show "received
            // but not yet OCR'd"); stays 0-width for the other bars
            const fillBg = document.createElement('div');
            fillBg.className = 'bwdd-bar-fill-bg';
            fillBg.style.width = '0%';
            track.appendChild(fillBg);
            const fill = document.createElement('div');
            fill.className = 'bwdd-bar-fill';
            fill.style.background = gradient;
            fill.setAttribute('role', 'progressbar');
            fill.setAttribute('aria-label', a11yLabel);
            fill.setAttribute('aria-valuemin', '0');
            fill.setAttribute('aria-valuemax', '100');
            fill.setAttribute('aria-valuenow', '0');
            track.appendChild(fill);

            row.append(meta, track);
            return { wrap: row, fill, fillBg, labRate: rate, labName: name };
        }

        const barDownload = mkBar('1. Network Fetch', 'linear-gradient(90deg, #10b981, #059669)', 'Download Progress');
        const barDescramble = mkBar('2. Tile Descramble', 'linear-gradient(90deg, #3b82f6, #1d4ed8)', 'Descramble Progress');
        const barMokuro = mkBar('3. Mokuro Bridge', 'linear-gradient(90deg, #f59e0b, #d97706)', 'OCR Pipeline Progress');
        const barUpload = mkBar('4. Upload', 'linear-gradient(90deg, #8b5cf6, #6d28d9)', 'Upload Progress');
        // What each bar counts (hover/AT hint; the Mokuro rate reads done/received/total,
        // and the faint amber underlay is pages the bridge received but hasn't OCR'd yet).
        barDownload.wrap.title = 'Pages fetched from BookWalker\u2019s CDN';
        barDescramble.wrap.title = 'Pages reassembled from their scrambled tiles';
        barMokuro.wrap.title = 'Pages OCR\u2019d / pages received by the bridge / total pages \u2014 faint amber = received but not yet OCR\u2019d';
        barUpload.wrap.title = 'Finished volume being stored or uploaded by the mokuro-bridge';

        const barWrap = document.createElement('div');
        barWrap.className = 'bwdd-bars';
        barWrap.setAttribute('role', 'region');
        barWrap.setAttribute('aria-label', 'Task Progress');
        barWrap.append(barDownload.wrap, barDescramble.wrap, barMokuro.wrap, barUpload.wrap);

        // Actions
        const btnRow = document.createElement('div');
        btnRow.className = 'bwdd-actions';

        const btnZip = document.createElement('button');
        btnZip.type = 'button';
        btnZip.className = 'bwdd-btn zip';
        btnZip.innerHTML = '<span>Save as ZIP</span><span class="bwdd-btn-sub">Pages bundled, ready to read offline</span>';

        const btnOcr = document.createElement('button');
        btnOcr.type = 'button';
        btnOcr.className = 'bwdd-btn ocr';
        btnOcr.innerHTML = '<span>Save and run through Mokuro</span><span class="bwdd-btn-sub">Run pages through the local Mokuro Bridge, then optionally upload</span>';
        // tooltip explaining what mokuro-bridge is, with a link to the project
        const btnOcrTip = 'Mokuro = Japanese OCR (mokuro). Runs through the local mokuro-bridge app — see https://github.com/GolyBidoof/mokuro-bridge';
        btnOcr.title = btnOcrTip;

        btnRow.append(btnZip, btnOcr);

        // --- Upload destination picker (OCR mode) ---
        // Lets the user choose where mokuro-bridge stores the finished volume,
        // per request: any configured remote method, or 'local' + a directory.
        const destWrap = document.createElement('div');
        destWrap.className = 'bwdd-dest';
        destWrap.style.display = 'none';   // shown only while the bridge is running
        const destLabel = document.createElement('label');
        destLabel.className = 'bwdd-dest-label';
        destLabel.textContent = 'Mokuro output destination';
        destLabel.setAttribute('for', 'bwdd-upload-method');
        const destSelect = document.createElement('select');
        destSelect.id = 'bwdd-upload-method';
        destSelect.className = 'bwdd-dest-select';
        destSelect.setAttribute('aria-label', 'Mokuro upload method');
        // populated from /upload-methods when the bridge is online
        const localDirRow = document.createElement('div');
        localDirRow.className = 'bwdd-dest-localdir';
        localDirRow.style.display = 'none';
        const localDirLabel = document.createElement('label');
        localDirLabel.className = 'bwdd-dest-label';
        localDirLabel.textContent = 'Output folder (on this computer)';
        localDirLabel.setAttribute('for', 'bwdd-local-dir');
        const localDirInput = document.createElement('input');
        localDirInput.id = 'bwdd-local-dir';
        localDirInput.type = 'text';
        localDirInput.className = 'bwdd-dest-input';
        localDirInput.placeholder = 'absolute path on this computer — e.g. C:\\Users\\you\\manga or /home/you/manga';
        localDirInput.title = 'Where mokuro-bridge should write the finished volume. This is a path on the machine running the bridge (your computer).';
        // Browser note: a web page cannot read your filesystem path via a
        // folder picker (showDirectoryPicker yields an opaque handle). The
        // bridge runs locally, so we fill the path from ITS configured
        // output_dir instead, and let you edit it freely.
        const localDirFill = document.createElement('button');
        localDirFill.type = 'button';
        localDirFill.className = 'bwdd-btn-fill';
        localDirFill.textContent = 'Use bridge default';
        localDirFill.addEventListener('click', async () => {
            const info = bridgeInfo || await refreshBridgeInfo();
            if (info && info.output_dir) localDirInput.value = info.output_dir;
        });
        const localDirWrap = document.createElement('div');
        localDirWrap.style.cssText = 'display:flex;gap:6px;align-items:center;';
        localDirWrap.append(localDirInput, localDirFill);
        localDirRow.append(localDirLabel, localDirWrap);
        const destHint = document.createElement('div');
        destHint.className = 'bwdd-dest-hint';
        destHint.style.display = 'none';
        destWrap.append(destLabel, destSelect, localDirRow, destHint);

        // populate from the bridge's /upload-methods list
        // Which method the user actually picked. This is kept separate from
        // destSelect.value because populateDestMethods() rebuilds the dropdown
        // on every 10s bridge-health tick — a refresh that cannot represent
        // the current pick right now must not forget it and silently fall back
        // to the default ('local') forever.
        let userMethod = null;
        // A value is "usable" only when it maps to a configured, enabled option
        // — an unconfigured provider is selectable (to read its setup hint) but
        // must never be restored/seeded as the effective destination.
        const hasUsableOption = (v) => v != null && [...destSelect.options]
            .some(o => o.value === v && !o.disabled && !(o.dataset && o.dataset.unconfigured));

        async function populateDestMethods() {
            const methods = await fetchUploadMethods().catch(() => null);
            // A run may have started while this fetch was in flight — never
            // repopulate (and thereby change) the pick a running OCR session is
            // going to finalize with.
            if (runBusy) return;
            const prevValue = destSelect.value;   // keep the user's visible pick
            destSelect.textContent = '';
            let def = 'local';
            if (methods && Array.isArray(methods.methods) && methods.methods.length) {
                def = methods.upload_method_default || 'local';
                for (const m of methods.methods) {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    if (m.id === 'local') {
                        opt.textContent = 'Local folder' + (m.current_folder ? ' — ' + m.current_folder : '');
                    } else if (m.configured) {
                        opt.textContent = m.name + (m.current_folder ? ' — ' + m.current_folder : '');
                    } else {
                        // Unconfigured: still selectable so the user can ask
                        // about it — choosing it shows the setup hint below and
                        // disables the OCR button until the provider is set up.
                        opt.textContent = m.name + ' — needs setup';
                        opt.dataset.unconfigured = '1';
                        opt.title = 'Not set up yet — enable it once in the mokuro-bridge terminal (from its folder): python server.py --setup-upload ' + (m.id || '');
                    }
                    destSelect.appendChild(opt);
                }
            } else {
                // fallback: local + mega options only
                for (const [id, name] of [['local', 'Local (default output)'], ['mega', 'MEGA']]) {
                    const opt = document.createElement('option');
                    opt.value = id; opt.textContent = name;
                    destSelect.appendChild(opt);
                }
            }
            // Seed the remembered method from localStorage on the very first
            // population (no selection yet); later rebuilds preserve the user's
            // visible pick instead.
            if (!userMethod && !prevValue) {
                try {
                    const saved = localStorage.getItem('bwdd-upload-method');
                    if (saved && hasUsableOption(saved)) userMethod = saved;
                } catch (e) {}
            }
            // Pick the value to show after the rebuild:
            //   1. whatever the user currently has selected, if it still exists
            //      (configured or not — a "needs setup" pick must survive a
            //      tick so its hint keeps showing and OCR stays blocked),
            //   2. else the remembered usable method (seeded from localStorage
            //      on first open, retained so it comes back once the bridge
            //      lists it again — a stale default never overrides it),
            //   3. else the bridge's usable default, else 'local'.
            let picked = null;
            if (prevValue) {
                const stillThere = [...destSelect.options].some(o => o.value === prevValue);
                if (stillThere) picked = prevValue;
            }
            if (picked == null && userMethod && hasUsableOption(userMethod)) picked = userMethod;
            if (picked == null && hasUsableOption(def)) picked = def;
            if (picked == null) picked = 'local';
            destSelect.value = picked;
            onDestChange();
        }

        function rememberMethod(v) {
            userMethod = v;
            try { localStorage.setItem('bwdd-upload-method', v); } catch (e) {}
        }

        function onDestChange() {
            const v = destSelect.value || 'local';
            const showLocal = v === 'local';
            localDirRow.style.display = showLocal ? 'flex' : 'none';
            if (showLocal) {
                if (!localDirInput.value) {
                    const planDefault = bridgeInfo && bridgeInfo.output_dir || '';
                    if (planDefault) localDirInput.placeholder = 'default: ' + planDefault;
                }
            }
            updateDestHint();
            refreshOcrButton();
        }
        // Whether the destination currently chosen in the dropdown is one the
        // bridge hasn't been set up for yet.
        function selectedNeedsSetup() {
            const o = destSelect.selectedOptions && destSelect.selectedOptions[0];
            return !!(o && o.dataset && o.dataset.unconfigured);
        }
        // OCR button availability = not busy ∧ bridge online ∧ destination is
        // actually usable. While a not-yet-configured destination is selected
        // the button is disabled so a run can't start toward a dead end.
        function refreshOcrButton() {
            const blockedBySetup = selectedNeedsSetup();
            btnOcr.disabled = runBusy || !bridgeOnline || blockedBySetup;
            btnOcr.setAttribute('aria-disabled', String(btnOcr.disabled));
            btnOcr.title = blockedBySetup
                ? 'This destination is not set up yet — run the command below once, then it will be usable here.'
                : ((runBusy || bridgeOnline) ? btnOcrTip : 'Start the Mokuro Bridge to enable OCR');
        }
        // The setup hint is tied to the selection: it appears only when the
        // destination actually chosen isn't configured yet (and the OCR button
        // is disabled until it is). A configured pick — or a fully configured
        // bridge — shows no hint at all. Once the provider is set up, the next
        // health tick lists it as configured and the hint disappears.
        function updateDestHint() {
            const selOpt = destSelect.selectedOptions && destSelect.selectedOptions[0];
            if (!selOpt || !selOpt.dataset || !selOpt.dataset.unconfigured) {
                destHint.style.display = 'none';
                return;
            }
            destHint.style.display = 'block';
            destHint.textContent = '';
            destHint.appendChild(document.createTextNode('This destination needs one-time setup in the bridge terminal: '));
            const code = document.createElement('code');
            code.textContent = 'python server.py --setup-upload ' + (selOpt.value || '');
            destHint.appendChild(code);
            destHint.appendChild(document.createTextNode('  (from the mokuro-bridge folder)'));
        }
        destSelect.addEventListener('change', () => { rememberMethod(destSelect.value); onDestChange(); });
        localDirInput.addEventListener('change', () => { try { localStorage.setItem('bwdd-local-dir', localDirInput.value); } catch (e) {} });
        try { const saved = localStorage.getItem('bwdd-local-dir'); if (saved) localDirInput.value = saved; } catch (e) {}
        populateDestMethods();
        if (BWDD_DEBUG) { try { window.__bwddUI = Object.assign(window.__bwddUI || {}, { populateDestMethods, onDestChange }); } catch (e) {} }

        // --- Run-state lock --------------------------------------------------
        // While a run is in progress the action buttons and the whole
        // destination section are disabled: a second download cannot start
        // concurrently and the destination (which an OCR run re-reads at
        // finalize time) cannot be changed under it.
        let bridgeOnline = false;   // last known bridge /health result
        let runBusy = false;        // a download/OCR run is in progress

        function setRunLock(busy) {
            runBusy = busy;
            btnZip.disabled = busy;
            btnZip.setAttribute('aria-disabled', String(busy));
            // OCR availability folds in the destination-setup state too — see
            // refreshOcrButton (kept in sync on every selection change).
            refreshOcrButton();
            const destLocked = busy || !bridgeOnline;
            destSelect.disabled = destLocked;
            localDirInput.disabled = destLocked;
            localDirFill.disabled = destLocked;
            destWrap.classList.toggle('bwdd-dest-locked', busy);
            if (busy) {
                destWrap.setAttribute('aria-busy', 'true');
                destWrap.title = 'Locked while a download or OCR run is in progress';
            } else {
                destWrap.removeAttribute('aria-busy');
                destWrap.title = '';
            }
            // Closing or flapping the panel mid-run would orphan the pipeline
            // (auth timers, OCR polls, the finalize stream) that keeps posting
            // into a detached DOM — hold both header buttons until it finishes.
            closeBtn.disabled = busy;
            flapBtn.disabled = busy;
            if (busy) {
                closeBtn.title = 'Closes after the run finishes';
                flapBtn.title = 'Available after the run finishes';
            } else {
                closeBtn.title = 'Close panel';
                flapBtn.title = 'Slide the panel away to the right edge of the screen';
            }
        }

        // Post-run actions — "Open Reader Mokuro" + "Open stored file / Copy
        // path" — one quiet row of secondary (ghost) buttons that appears only
        // after a successful OCR run, side by side on a single line. Each
        // button spans the whole row on its own when the other has nothing to
        // offer (the row is grid auto-fit).
        const postRunRow = document.createElement('div');
        postRunRow.className = 'bwdd-reader-row';
        postRunRow.style.display = 'none';
        const btnReader = document.createElement('button');
        btnReader.type = 'button';
        btnReader.className = 'bwdd-ghost-btn';
        btnReader.textContent = 'Open Reader Mokuro';
        btnReader.setAttribute('aria-label', 'Open Reader Mokuro in a new tab');
        const btnStored = document.createElement('button');
        btnStored.type = 'button';
        btnStored.className = 'bwdd-ghost-btn';
        btnStored.setAttribute('aria-label', 'Open stored file');
        postRunRow.append(btnReader, btnStored);
        let readerReady = false;
        let storedReady = false;
        function syncPostRunRow() {
            btnReader.style.display = readerReady ? '' : 'none';
            btnStored.style.display = storedReady ? '' : 'none';
            postRunRow.style.display = (readerReady || storedReady) ? 'grid' : 'none';
        }
        function showReaderButton(result) {
            btnReader.onclick = () => {
                const a = document.createElement('a');
                a.href = readerJumpUrl(result);
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                a.remove();
            };
            readerReady = true;
            syncPostRunRow();
        }
        function hideReaderButton() {
            btnReader.onclick = null;
            readerReady = false;
            syncPostRunRow();
        }
        function showStoredButton(result) {
            const target = storedOpenTarget(result);
            if (target) {
                const isCbz = /\.cbz$/i.test(target.file || '');
                btnStored.textContent = isCbz ? 'Open stored file (.cbz)' : 'Open stored file';
                btnStored.setAttribute('aria-label', isCbz
                    ? 'Open the stored .cbz file in a new tab'
                    : 'Open the stored file in a new tab');
                btnStored.title = target.url;
                btnStored.onclick = () => {
                    const a = document.createElement('a');
                    a.href = target.url;
                    a.target = '_blank';
                    a.rel = 'noopener noreferrer';
                    a.style.display = 'none';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                };
            } else {
                const method = result && result.method;
                const isLocal = !method || method === 'local';
                const copyText = isLocal
                    ? (result && (result.output_dir || result.staging))
                    : (result && (result.remote_path || result.mega_path || result.staging));
                const mainLabel = isLocal ? 'Copy local folder path' : 'Copy destination path';
                const a11yLabel = mainLabel + ' to the clipboard';
                btnStored.textContent = mainLabel;
                btnStored.setAttribute('aria-label', a11yLabel);
                btnStored.title = copyText || '';
                btnStored.onclick = () => {
                    const text = copyText || 'about:blank';
                    try { navigator.clipboard.writeText(text); } catch (e) {}
                    btnStored.textContent = 'Path copied ✓';
                    btnStored.setAttribute('aria-label', 'Path copied to the clipboard');
                    setTimeout(() => {
                        btnStored.textContent = mainLabel;
                        btnStored.setAttribute('aria-label', a11yLabel);
                    }, 1500);
                };
            }
            storedReady = true;
            syncPostRunRow();
        }
        function hideStoredButton() {
            btnStored.onclick = null;
            storedReady = false;
            syncPostRunRow();
        }

        // Two-column layout: download & bridge controls on the left (always
        // present), reading stats on the right. The stats column is mounted
        // only once the first card (book details / LearnNatively /
        // Manga-Kotoba) lands in statsEl — until then the panel is a single
        // controls column, never an empty second one.
        const colMain = document.createElement('div');
        colMain.className = 'bwdd-col bwdd-col-main';
        colMain.append(bridgeRow, bridgeInfo, mokuroAlert, destWrap, btnRow, barWrap, details, postRunRow);

        const colStats = document.createElement('div');
        colStats.className = 'bwdd-col bwdd-col-stats';
        colStats.append(statsEl);

        // Hairline separator between the columns, appended with the stats col.
        const colSep = document.createElement('div');
        colSep.className = 'bwdd-col-sep';

        // Mount the stats column (+ separator) and widen the panel to its
        // two-column size the moment the first card lands.
        function mountStatsColumn() {
            const manual = parseFloat(root.style.width);
            const manualWide = isFinite(manual) && manual >= 620;
            body.append(colSep, colStats);
            root.classList.add('bwdd-stats-visible');
            // A manual width only sticks once it is wide enough for the two
            // columns; otherwise fall back to the auto two-column width.
            if (!manualWide) root.style.width = '';
        }
        let statsMounted = false;
        const statsObs = new MutationObserver(() => {
            if (statsMounted || !statsEl.childElementCount) return;
            statsMounted = true;
            statsObs.disconnect();
            mountStatsColumn();
        });
        statsObs.observe(statsEl, { childList: true });
        if (statsEl.childElementCount) { statsMounted = true; mountStatsColumn(); }   // safety net

        body.append(colMain);
        root.append(head, body);
        document.documentElement.appendChild(root);
        // The bridge dot is first updated above (buildUI), but that call runs
        // before root is connected and bails at the `!root.isConnected` guard —
        // so refresh it now that the panel is actually in the document, instead
        // of waiting for the first 10 s interval tick.
        try { updateBridgeDot(); } catch (e) {}

        // "Flap": slide the whole panel off the right edge of the screen. A
        // small tab stays docked on the right edge to bring it back.
        const edgeTab = document.createElement('button');
        edgeTab.type = 'button';
        edgeTab.className = 'bwdd-edge-tab';
        edgeTab.setAttribute('aria-label', 'Show the BookWalker Native Downloader panel');
        edgeTab.title = 'Show the BookWalker Native Downloader panel';
        edgeTab.textContent = '\u00AB';   // fancy "<<" — pull the panel back in from the right
        edgeTab.style.display = 'none';
        document.documentElement.appendChild(edgeTab);

        function flapOut() {
            if (edgeTab.style.display === 'flex') return;   // already away
            const r = root.getBoundingClientRect();
            // Push the panel fully past the right edge of the viewport. Its
            // left/top position is untouched, so clearing the transform below
            // returns it exactly where it was.
            const shift = Math.max(24, Math.ceil(window.innerWidth - r.left) + 4);
            root.style.transform = 'translateX(' + shift + 'px)';
            root.classList.add('bwdd-flapped');
            root.setAttribute('aria-hidden', 'true');
            // inert takes every control out of the tab order / a11y tree, so a
            // keyboard user can't Tab into invisible controls (aria-hidden
            // alone does not do that).
            root.inert = true;
            // Anchor the restore tab to the panel's own vertical span so a
            // bottom-docked panel leaves its tab near the bottom edge instead
            // of floating at the middle of the screen.
            const tabH = 76;   // .bwdd-edge-tab height
            const vh = window.innerHeight || document.documentElement.clientHeight || 800;
            const tabTop = Math.max(0, Math.min(r.top + (r.height - tabH) / 2, vh - tabH - 8));
            edgeTab.style.top = tabTop + 'px';
            edgeTab.style.display = 'flex';
            flapBtn.setAttribute('aria-expanded', 'false');
            flapBtn.setAttribute('aria-label', 'Show the panel (from the right edge)');
            try { edgeTab.focus(); } catch (e) {}
        }
        function flapIn() {
            if (edgeTab.style.display !== 'flex') return;
            root.classList.remove('bwdd-flapped');
            root.style.transform = '';
            root.removeAttribute('aria-hidden');
            root.inert = false;   // restore tab order + focusability
            edgeTab.style.display = 'none';
            flapBtn.setAttribute('aria-expanded', 'true');
            flapBtn.setAttribute('aria-label', 'Hide the panel to the right edge');
            try { flapBtn.focus(); } catch (e) {}
        }
        edgeTab.addEventListener('click', () => flapIn());
        flapBtn.onclick = () => flapOut();

        // --- Manual resize (corner handle) + remembered width -------------
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'bwdd-resize';
        resizeHandle.setAttribute('aria-hidden', 'true');
        resizeHandle.setAttribute('title', 'Drag to resize the panel');
        root.appendChild(resizeHandle);

        let resizing = false;
        let resizeStartX = 0, resizeStartY = 0;
        let resizeStartW = 0, resizeStartH = 0;
        function resizeMinW() {
            return root.classList.contains('bwdd-stats-visible') ? 620 : 360;
        }
        function resizeMinH() { return 120; }
        function persistPanelSize() {
            try {
                const r = root.getBoundingClientRect();
                localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(r.width)));
                localStorage.setItem(PANEL_HEIGHT_KEY, String(Math.round(r.height)));
            } catch (e) {}
        }
        resizeHandle.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const r = root.getBoundingClientRect();
            // Anchor by the top-left so the bottom-right corner follows the
            // pointer while resizing (works for both docked and dragged states).
            root.style.left = r.left + 'px';
            root.style.top = r.top + 'px';
            root.style.right = 'auto';
            resizing = true;
            resizeStartX = e.clientX; resizeStartY = e.clientY;
            resizeStartW = r.width;   resizeStartH = r.height;
            try { resizeHandle.setPointerCapture(e.pointerId); } catch (err) {}
        });
        resizeHandle.addEventListener('pointermove', (e) => {
            if (!resizing) return;
            const vw = window.innerWidth || 1200;
            const vh = window.innerHeight || 800;
            const left = root.getBoundingClientRect().left;
            const top = root.getBoundingClientRect().top;
            const minW = resizeMinW();
            const maxW = Math.max(minW, Math.min(1200, vw - left - 12));
            const w = Math.max(minW, Math.min(maxW, resizeStartW + (e.clientX - resizeStartX)));
            root.style.width = Math.round(w) + 'px';
            // Vertical: the panel is top-anchored (top stays put), so growing
            // downward is what the user expects; clamp to the viewport too.
            const minH = resizeMinH();
            const maxH = Math.max(minH, Math.min(1000, vh - top - 12));
            const h = Math.max(minH, Math.min(maxH, resizeStartH + (e.clientY - resizeStartY)));
            root.style.height = Math.round(h) + 'px';
        });
        resizeHandle.addEventListener('pointerup', () => { resizing = false; persistPanelSize(); });
        resizeHandle.addEventListener('pointercancel', () => { resizing = false; });
        resizeHandle.addEventListener('lostpointercapture', () => { if (resizing) { resizing = false; persistPanelSize(); } });

        // Restore a previously saved manual size, if any.
        try {
            const savedW = parseInt(localStorage.getItem(PANEL_WIDTH_KEY) || '', 10);
            if (isFinite(savedW) && savedW > 0) root.style.width = Math.min(Math.max(savedW, 300), 1200) + 'px';
        } catch (e) {}
        try {
            const savedH = parseInt(localStorage.getItem(PANEL_HEIGHT_KEY) || '', 10);
            if (isFinite(savedH) && savedH > 0) root.style.height = Math.min(Math.max(savedH, 120), 1000) + 'px';
        } catch (e) {}

        // Restore the last panel position + collapsed state, if any.
        try {
            const savedPos = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || 'null');
            if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
                root.style.left = clampPanelX(savedPos.x) + 'px';
                root.style.top = clampPanelY(savedPos.y) + 'px';
                root.style.right = 'auto';
            }
        } catch (e) {}
        try { if (localStorage.getItem(PANEL_COLLAPSED_KEY) === '1') setCollapsed(true); } catch (e) {}

        // Draggable Functionality (pointer + keyboard; Esc collapses)
        let dragging = false;
        let dragPointerId = null;
        let pos = { x: 0, y: 0 };
        function clampPanelX(x) { return Math.max(0, Math.min(x, Math.max(0, (window.innerWidth || 1200) - 60))); }
        function clampPanelY(y) { return Math.max(0, Math.min(y, Math.max(0, (window.innerHeight || 800) - 70))); }
        function savePanelPos() {
            try {
                const r = root.getBoundingClientRect();
                localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ x: r.left, y: r.top }));
            } catch (e) {}
        }
        function applyDragPos(clientX, clientY) {
            root.style.left = clampPanelX(clientX - pos.x) + 'px';
            root.style.top = clampPanelY(clientY - pos.y) + 'px';
            root.style.right = 'auto';
        }
        // Pointer events cover mouse, touch and pen (with capture so the drag
        // keeps tracking even when the pointer leaves the header).
        head.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (e.target.closest('button')) return;
            dragging = true;
            dragPointerId = e.pointerId;
            pos.x = e.clientX - root.offsetLeft;
            pos.y = e.clientY - root.offsetTop;
            try { head.setPointerCapture(e.pointerId); } catch (err) {}
            e.preventDefault();
        });
        head.addEventListener('pointermove', (e) => {
            if (!dragging || dragPointerId !== e.pointerId) return;
            applyDragPos(e.clientX, e.clientY);
        });
        function stopDrag(e) {
            if (!dragging || (e && dragPointerId != null && e.pointerId !== dragPointerId)) return;
            dragging = false;
            dragPointerId = null;
            savePanelPos();
        }
        head.addEventListener('pointerup', stopDrag);
        head.addEventListener('pointercancel', stopDrag);
        head.addEventListener('lostpointercapture', () => {
            if (dragging) savePanelPos();
            dragging = false;
            dragPointerId = null;
        });
        // The panel deliberately does NOT capture arrow keys: the viewer uses
        // Left/Right to flip pages, so arrow handling must never be eaten or
        // preventDefault'ed while the panel (or its header) holds focus. The
        // panel is repositioned by dragging the header (mouse/touch/pen) and
        // resized with the corner grip instead.

        // Keyboard shortcut: Escape toggles collapse. Named so the close
        // button can remove it — a closed panel must not keep a window-level
        // listener alive for the life of the tab.
        function onPanelKeydown(e) {
            if (e.key !== 'Escape') return;
            // don't hijack Esc while the user is typing in a form control
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
            if (document.contains(root) && !e.defaultPrevented) {
                setCollapsed(!root.classList.contains('collapsed'));
            }
        }
        window.addEventListener('keydown', onPanelKeydown);

        return { root, details, statsEl, barWrap, barDownload, barDescramble, barMokuro, barUpload, btnZip, btnOcr, destSelect, localDirInput, destHint, populateDestMethods, setRunLock, showReaderButton, hideReaderButton, showStoredButton, hideStoredButton };
    }

    // Three-value Mokuro progress: done / received / total.
    // fillBg (faint) = pages received by the bridge; fill (solid) = pages
    // actually OCR'd. No flicker — every update sets all three consistently.
    function updateMokuroBar(bar, done, received, total) {
        if (!bar || !bar.fill) return;
        const t = total || 1;
        const r = Math.max(0, Math.min(received || 0, t));
        const d = Math.max(0, Math.min(done || 0, r));
        if (bar.fillBg) bar.fillBg.style.width = Math.round((r / t) * 100) + '%';
        bar.fill.style.width = Math.round((d / t) * 100) + '%';
        bar.fill.setAttribute('aria-valuenow', String(Math.round((d / t) * 100)));
        bar.fill.setAttribute('aria-valuetext', d + ' of ' + t + ' pages OCR\u2019d, ' + r + ' received by the bridge');
        bar.labRate.textContent = d + '/' + r + '/' + t;
    }

    function setBar(bar, pct, text) {
        if (!bar) return;
        const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
        bar.fill.style.width = p + '%';
        bar.fill.setAttribute('aria-valuenow', String(p));
        bar.fill.setAttribute('aria-valuetext', `${p}% complete`);
        if (text != null) bar.labRate.textContent = text;
    }
    // Build (but don't insert) the collapsible raw-error block; returns null
    // when there is nothing to show. Both setRunDetails and the success paths
    // use it so recovered/retried errors surface without dominating the copy.
    function makeTechDetails(rawLines, label) {
        const lines = (rawLines || []).filter(Boolean);
        const capped = lines.slice(0, 15);
        const overflow = lines.length - capped.length;
        if (!capped.length) return null;
        const det = document.createElement('details');
        const sum = document.createElement('summary');
        sum.textContent = (label || 'Technical details') + ' (' + capped.length + (overflow ? '+' : '') + ')';
        const pre = document.createElement('pre');
        pre.textContent = capped.join('\n') + (overflow > 0 ? '\n\u2026 and ' + overflow + ' more' : '');
        det.append(sum, pre);
        return det;
    }
    // Show a run outcome in the status area: a plain summary plus (when the
    // caller has raw per-page error lines) a collapsible "technical details"
    // block so the raw internals never dominate the message.
    function setRunDetails(el, summary, rawLines) {
        if (!el) return;
        el.textContent = '';
        el.appendChild(document.createTextNode(summary));
        const det = makeTechDetails(rawLines);
        if (det) el.appendChild(det);
    }
    // Append diagnostics to an already-set status line (used when a run fully
    // succeeded but some pages needed retries — nothing silently swallowed).
    function appendRunDetails(el, rawLines, label) {
        if (!el) return;
        const det = makeTechDetails(rawLines, label);
        if (det) el.appendChild(det);
    }
    function showBars(ui) {
        ui.barWrap.style.display = 'flex';
        ui.barDownload.wrap.style.display = 'flex';
        ui.barDescramble.wrap.style.display = 'flex';
        setBar(ui.barDownload, 0, '0%');
        setBar(ui.barDescramble, 0, '0%');
    }

    // =====================================================================
    // 11. Orchestration & Token Lifecycle
    // =====================================================================
    let authRefreshPromise = null;
    let pbCounter = 0;
    // Refresh the CloudFront auth policy, coalesced so concurrent callers share
    // one in-flight request. Two viewer endpoints mint a fresh auth_info;
    // refreshAuthBest() tries 'pb' first, then 'c':
    //   'pb' — POST a plausible reading-position bookmark to /browserWebApi/pb
    //          (the viewer's own token-renewal channel). This mirrors what the
    //          viewer sends while reading and therefore also moves your reading
    //          progress on BookWalker's side each time — the fake position
    //          cycles monotonically within the book to stay plausible.
    //   'c'  — GET /browserWebApi/c with the params the viewer sends when
    //          opening a book; a fresh reply replaces auth/baseUrl/cti.
    function refreshAuthOnce(mode) {
        if (!authRefreshPromise) {
            authRefreshPromise = (async () => {
                let d;
                if (mode === 'pb') {
                    const ts = new Date();
                    const pad = n => String(n).padStart(2, '0');
                    const dateStr = ts.getFullYear() + '-' + pad(ts.getMonth() + 1) + '-' + pad(ts.getDate()) +
                        'T' + pad(ts.getHours()) + ':' + pad(ts.getMinutes()) + ':' + pad(ts.getSeconds()) + '+0900';
                    pbCounter = (pbCounter || 0) + 1;
                    const pbPos = 'OEBPS/text/p-' + String((pbCounter % 900) + 1).padStart(4, '0') + '.xhtml';
                    const bookmark = JSON.stringify({
                        date: dateStr, position: pbPos,
                        position_later_page: '', pr: (pbCounter % 7), type: 'epub', finished: 0,
                        bookmark_suffix_max: 1, bookmarks: [],
                    });
                    const form = new URLSearchParams();
                    form.set('cid', state.cid);
                    form.set('u1', getU1());
                    form.set('BID', getBID());
                    form.set('timestamp', '');
                    form.set('bookmark', bookmark);
                    const res = await fetchWithTimeout(apiBase() + '/browserWebApi/pb', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                        body: form.toString(),
                    }, 20000);
                    d = await res.json();
                    if (d && d.auth_info) {
                        // pb merges over the current auth; only a changed
                        // policy/signature resets the request-count budget.
                        const before = authPolicySig();
                        state.auth = Object.assign({}, state.auth || {}, d.auth_info);
                        if (authPolicySig() !== before) resetAuthBudget();
                    }
                } else {
                    const cr = Math.floor(Math.random() * 1e18) + 1e18;
                    const u1 = getU1();
                    const url = apiBase() + '/browserWebApi/c?cid=' + encodeURIComponent(state.cid) +
                        '&u1=' + encodeURIComponent(u1) + '&BID=' + encodeURIComponent(getBID()) + '&cr=' + cr;
                    const res = await fetchWithTimeout(url, { credentials: 'include' }, 20000);
                    d = await res.json();
                    if (d.status === '200' && d.auth_info && d.url) {
                        state.auth = d.auth_info;
                        state.baseUrl = d.url;
                        state.cti = d.cti || state.cti;
                    }
                }
                return d;
            })();
            authRefreshPromise.finally(() => { authRefreshPromise = null; });
        }
        return authRefreshPromise;
    }
    const refreshAuthViaPb = () => refreshAuthOnce('pb');
    const refreshAuthViaC = () => refreshAuthOnce('c');

    async function refreshAuthBest() {
        const before = authPolicySig();
        try {
            const d = await refreshAuthViaPb();
            if (authPolicySig() !== before) return { method: 'pb', fresh: true, d };
        } catch (e) {}
        try {
            const d = await refreshAuthViaC();
            if (authPolicySig() !== before) return { method: 'c', fresh: true, d };
        } catch (e) {}
        return { method: 'none', fresh: false };
    }

    async function refreshAuthTrial() {
        const cr = Math.floor(Math.random() * 1e18) + 1e18;
        const bid = getBID();
        const url = apiBase() + '/trial-page/c?cid=' + encodeURIComponent(state.cid) + '&BID=' + encodeURIComponent(bid) + '&cr=' + cr;
        const res = await fetchWithTimeout(url, { credentials: 'include' }, 20000);
        const d = await res.json();
        if (d && d.auth_info) {
            const before = authPolicySig();
            state.auth = Object.assign({}, state.auth || {}, d.auth_info);
            if (d.url) state.baseUrl = d.url;
            if (d.cti) state.cti = d.cti;
            if (authPolicySig() !== before) resetAuthBudget();
            return d;
        }
        return d;
    }

    function authLooksFresh() {
        try {
            const p = state.auth && state.auth['Policy'];
            if (!p) return false;
            const json = JSON.parse(atob(p));
            const lt = json && json.Statement && json.Statement[0] && json.Statement[0].Condition &&
                json.Statement[0].Condition.DateLessThan && json.Statement[0].Condition.DateLessThan['AWS:EpochTime'];
            if (!lt) return true;
            return (lt * 1000) > Date.now() + 10000;
        } catch (e) { return true; }
    }

    function configPrio(dir) {
        if (dir.indexOf('normal_default') !== -1) return 0;
        if (dir.indexOf('large_default') !== -1) return 1;
        if (dir.indexOf('x-large_default') !== -1) return 2;
        if (dir.indexOf('small_default') !== -1) return 3;
        return 4;
    }

    function deriveAuthFromResources() {
        try {
            let entries = state.viewerEntries && state.viewerEntries.length
                ? state.viewerEntries.map(name => ({ name }))
                : (performance.getEntriesByType('resource') || []);
            const hosts = ['bw-bv-epubs.bookwalker.jp', 'viewer-epubs-trial.bookwalker.jp', 'viewer-epubs.bookwalker.jp'];
            let best = null;
            let bestConfig = null;
            for (const e of entries) {
                const u = e.name;
                if (!u) continue;
                const hostMatch = hosts.find(h => u.indexOf(h) !== -1);
                if (!hostMatch) continue;
                const qIdx = u.indexOf('?');
                if (qIdx === -1) continue;
                const params = new URLSearchParams(u.slice(qIdx + 1));
                const auth = {};
                for (const k of AUTH_PARAM_KEYS) {
                    const v = params.get(k);
                    if (v !== null && v !== undefined) auth[k] = v;
                }
                if (!auth['Policy'] || !auth['Signature']) continue;
                const path = u.split('?')[0];
                if (state.cid && path.indexOf(state.cid) === -1) continue;
                if (path.indexOf('configuration_pack.json') !== -1) {
                    const dir = path.replace(/configuration_pack\.json$/, '');
                    const prio = configPrio(dir);
                    if (!bestConfig || prio < bestConfig.prio) {
                        bestConfig = { baseUrl: dir, auth, prio };
                    }
                    continue;
                }
                const m = path.match(/^(https?:\/\/[^\/]+\/[^\/]+\/[^\/]+\/.*?)\/item\//);
                if (m) {
                    const dir = m[1] + '/';
                    const fm = path.match(/item\/xhtml\/(p-[^/]+)\.xhtml/);
                    if (fm) {
                        if (!state.fileBases) state.fileBases = {};
                        state.fileBases[fm[1] + '.xhtml'] = dir;
                    }
                    const prio = configPrio(dir);
                    const depth = (dir.match(/\//g) || []).length;
                    if (!best) {
                        best = { baseUrl: dir, auth, prio, depth };
                    } else if (depth > best.depth) {
                        best = { baseUrl: dir, auth, prio, depth };
                    } else if (depth === best.depth && prio < (best.prio === undefined ? 9 : best.prio)) {
                        best = { baseUrl: dir, auth, prio, depth };
                    }
                }
            }
            const chosen = best || bestConfig;
            if (chosen) {
                state.baseUrl = chosen.baseUrl;
                state.auth = chosen.auth;
                return true;
            }
        } catch (e) { console.warn('[bwdd] deriveAuthFromResources:', e && e.message); }
        return false;
    }

    async function ensureStateFresh() {
        snapshotViewerResources();
        const found = findInNFBR(window);
        if (found.auth && found.baseUrl) {
            if (!state.auth) state.auth = found.auth;
            if (!state.baseUrl) state.baseUrl = found.baseUrl;
            if (found.cti && !state.cti) state.cti = found.cti;
            if (found.config && !state.configBody) state.decodedConfig = found.config;
        }
        if ((!state.auth || !state.baseUrl) && deriveAuthFromResources()) {}
        if (!state.auth || !state.baseUrl) {
            for (let attempt = 0; attempt < 8 && (!state.auth || !state.baseUrl); attempt++) {
                await new Promise(r => setTimeout(r, 750));
                const f2 = findInNFBR(window);
                if (f2.auth && f2.baseUrl) {
                    state.auth = f2.auth;
                    state.baseUrl = f2.baseUrl;
                    if (f2.cti && !state.cti) state.cti = f2.cti;
                    if (f2.config && !state.decodedConfig) state.decodedConfig = f2.config;
                }
                if ((!state.auth || !state.baseUrl) && deriveAuthFromResources()) {}
            }
        }
        if (!state.auth || !state.baseUrl) {
            let d = null;
            try {
                if (location.hostname.indexOf('trial') !== -1 || (state.baseUrl && state.baseUrl.indexOf('epubs-trial') !== -1)) {
                    d = await refreshAuthTrial();
                }
            } catch (e) {}
            if (!state.auth || !state.baseUrl) {
                try { await refreshAuthViaPb(); } catch (e) {}
                if (!state.auth || !state.baseUrl) {
                    try { d = await refreshAuthViaC(); } catch (e) { d = null; }
                }
            }
            if (!state.auth || !state.baseUrl) {
                const st = d && d.status;
                let hint = 'Failed to capture session auth. Flip one page in the reader and try again.';
                if (st === '503') hint = 'BookWalker returned 503 (session busy/rate-limited). Wait a moment, then try again.';
                else if (st === '401') hint = 'Session cookie expired. Reopen this book from your BookWalker library.';
                throw new Error(hint);
            }
        }
        const bodyDirMatches = !state.configBody || !state.configFromUrl ||
            !state.baseUrl || state.configFromUrl.indexOf(state.baseUrl) === 0;
        if (state.decodedConfig && bodyDirMatches && !state.configBody) {
            try {
                const url = state.baseUrl + 'configuration_pack.json?' + authQuery(state.auth);
                const res = await fetchWithTimeout(url, { credentials: 'omit' }, 60000);
                if (res.ok) { state.configBody = await res.text(); state.configFromUrl = state.baseUrl; }
            } catch (e) { console.warn('[bwdd] Config fetch failed, falling back to memory copy', e && e.message); }
        } else if (!state.decodedConfig && (!state.configBody || !bodyDirMatches)) {
            const url = state.baseUrl + 'configuration_pack.json?' + authQuery(state.auth);
            const res = await fetchWithTimeout(url, { credentials: 'omit' }, 60000);
            if (!res.ok) throw new Error('Failed to download configuration manifest (HTTP ' + res.status + ')');
            state.configBody = await res.text();
            state.configFromUrl = state.baseUrl;
        }
    }

    // Upload the cover (<safe_title>.webp — the first page, no OCR needed)
    // the moment it's descrambled, so the destination folder + Upload bar show
    // activity before OCR finishes. Feeds the same per-run upload bar feed the
    // finalize phase uses (name matches the bridge's file_base.webp, so the
    // entry is marked done and finalize's plan just adds the .cbz/.mokuro).
    async function uploadCoverEarly(opts) {
        const { ui, barUpload, feed, mokuroSessionId, safeTitle, blob } = opts;
        if (!mokuroSessionId || !blob) return null;
        const plan = await resolveUploadChoice(ui).catch(() => ({ method: null, label: null, localDir: null }));
        const coverName = (safeTitle || 'volume') + '.webp';
        try {
            barUpload.labName.textContent = '4. ' + (plan.method === 'local' ? 'Store' : 'Upload');
            barUpload.wrap.style.display = 'flex';
            // Seed the 1-file plan up front so the bar reads "1/1 · 0%" from
            // the very first moment (no bare "0%" without a file count).
            if (feed.seed) feed.seed([{ file: coverName, total_bytes: blob.size }]);
            feed({ file: coverName, currentBytes: 0, totalBytes: blob.size, percent: 0 });
            const res = await mokuroUploadCover(mokuroSessionId, blob, { method: plan.method || null, localDir: plan.localDir });
            feed({ file: res && res.file ? res.file : coverName, currentBytes: res && res.size ? res.size : blob.size, totalBytes: res && res.size ? res.size : blob.size, percent: 100 });
            return res;
        } catch (e) {
            // A failed early cover must never break the download/OCR run.
            console.warn('[bwdd] Early cover upload skipped:', e && e.message || e);
            return null;
        }
    }

    // Finalize phase shared by the trial and full OCR pipelines (kept in one
    // place so the two paths can never drift apart again): ask the bridge to
    // finalize the session (store locally or upload), stream live byte/percent
    // progress into the Store/Upload bar via the NDJSON frames, and keep the
    // Mokuro bar polled until the stream closes. Returns { result, plan }.
    async function finalizeOcrSession(mokuroSessionId, ui, barUpload, barMokuro, total, sharedFeed) {
        const plan = await resolveUploadChoice(ui).catch(() => ({ method: null, label: null, localDir: null }));
        // The 4th stage only uploads when the destination is remote — for
        // local saves it stores to disk, so name the bar honestly. If the
        // early cover upload already started the bar on this feed, don't
        // clobber it — keep the visible progress and just seed the rest.
        barUpload.labName.textContent = '4. ' + (plan.method === 'local' ? 'Store' : 'Upload');
        const uploadFeed = sharedFeed || makeUploadBarUpdater(barUpload);
        if (!sharedFeed || !sharedFeed.hasAny || !sharedFeed.hasAny()) {
            barUpload.wrap.style.display = 'none';
            setBar(barUpload, 0, '0%');
        }
        const result = await new Promise((resolve, reject) => {
            const fp = mokuroFinalize(mokuroSessionId, { method: plan.method || null, localDir: plan.localDir }, (stage, msg) => {
                if (stage === 'upload_progress' || stage === 'upload') barUpload.wrap.style.display = 'flex';
                // The initial "upload" frame announces every file + size, so
                // pre-size the bar before the first byte arrives.
                if (stage === 'upload' && msg && Array.isArray(msg.files) && uploadFeed.seed) {
                    uploadFeed.seed(msg.files);
                }
                // Keep the file count + total size on the bar when done —
                // final label reads e.g. "3/3 · 100% · 145.0 MB / 145.0 MB".
                if (stage === 'done' && uploadFeed.summary) {
                    const s = uploadFeed.summary();
                    if (barUpload.wrap.style.display === 'flex' && s.total > 0) {
                        setBar(barUpload, 100, s.done + '/' + s.total + ' · 100% · ' + fmtBytes(s.sumTot) + ' / ' + fmtBytes(s.sumTot));
                    } else if (barUpload.wrap.style.display === 'flex') {
                        setBar(barUpload, 100, '100%');
                    }
                }
            }, uploadFeed);
            // Poll the bridge's OCR status ~2.5/s so the Mokuro bar keeps
            // moving while the NDJSON finalize stream is open; the bridge also
            // publishes live upload progress to the same /status endpoint
            // (bytes/percent/speed per in-flight file), which we feed into the
            // same accumulator — that keeps the bar moving even with older
            // bridges that buffer their NDJSON upload frames.
            const poll = setInterval(async () => {
                try {
                    const st = await mokuroStatus(mokuroSessionId);
                    if (!st) return;
                    updateMokuroBar(barMokuro, st.pages_ocr_done ?? 0, st.pages_received ?? 0, total);
                    const up = st.upload;
                    if (up && (up.active === true || (up.current_bytes || 0) > 0 || (up.percent || 0) > 0)) {
                        barUpload.wrap.style.display = 'flex';
                        uploadFeed({
                            file: up.file || '',
                            currentBytes: up.current_bytes || 0,
                            totalBytes: up.total_bytes || 0,
                            percent: up.percent,
                            speed: up.speed_human || null,
                        });
                    }
                } catch (e) {}
            }, 400);
            fp.then(r => { clearInterval(poll); resolve(r); },
                   e => { clearInterval(poll); reject(e); });
        });
        return { result, plan };
    }

    async function downloadTrialZip(ui, config, contents, title, sv, zipFolder, mode, details) {
        const { barDownload, barDescramble, barMokuro, barUpload, destSelect, localDirInput } = ui;
        const zip = mode === 'zip' ? { entries: [] } : null;
        const errors = [];
        const okIdx = new Set();
        let bytes = 0;
        const t1 = performance.now();

        const jobs = [];
        for (const item of contents) {
            const fid = item.file;
            const isShared = String(fid).indexOf('../shared/') === 0 || String(fid).indexOf('shared/') === 0;
            const base = String(fid).replace(/^(\.\.\/)?shared\//, '');
            const cfg = config[fid] || {};
            const fli = cfg.FileLinkInfo || {};
            const nPages = fli.PageCount || Math.max(1, (fli.PageLinkInfoList || []).length) || 1;
            for (let no = 0; no < nPages; no++) jobs.push({ fid, base, no, isShared });
        }
        const total = jobs.length;

        async function cropToSize(blob, S) {
            if (!S || !S.Width || !S.Height) return blob;
            try {
                const bmp = await createImageBitmap(blob);
                if (bmp.width === S.Width && bmp.height === S.Height) { if (bmp.close) bmp.close(); return blob; }
                const c = document.createElement('canvas');
                c.width = S.Width; c.height = S.Height;
                c.getContext('2d').drawImage(bmp, 0, 0);
                if (bmp.close) bmp.close();
                return await new Promise((res2, rej) => c.toBlob(b => b ? res2(b) : rej(new Error('toBlob')), 'image/jpeg', JPEG_QUALITY));
            } catch (e) { return blob; }
        }

        let mokuroSessionId = null;
        let ocrPoll = null;
        let runSafeTitle = '';
        if (mode === 'ocr') {
            barMokuro.wrap.style.display = 'flex';
            barMokuro.fill.style.width = '0%';
            barMokuro.labRate.textContent = '0/' + total;
            if (!(await ensureBridgeRunning(25000))) {
                throw new Error(MOKURO_BRIDGE_OFFLINE_MSG);
            }
            // Don't start a capture while the bridge is still working on a
            // previous run — wait until it reports idle.
            if (!(await waitForBridgeIdle(60000))) {
                throw new Error('The Mokuro Bridge is still busy with a previous OCR/upload — wait for it to finish, then try again.');
            }
            const sess = await mokuroStartSession(title || 'book');
            mokuroSessionId = sess.session_id;
            runSafeTitle = sess.safe_title || sess.title || '';
            ocrPoll = setInterval(async () => {
                const st = await mokuroStatus(mokuroSessionId);
                if (!st) return;
                const done = (st.pages_ocr_done ?? 0);
                const got = (st.pages_received ?? 0) || done;
                updateMokuroBar(barMokuro, done, got, total);
            }, 700);
        }

        let fetched = 0;
        let nextIdx = 0;
        // One upload-bar feed shared by the early cover upload and finalize so
        // the bar tracks the whole multi-file upload (cover = file 1/N).
        const trialUploadFeed = makeUploadBarUpdater(barUpload);
        const trialCoverState = { fired: false };
        async function worker() {
            while (true) {
                const i = nextIdx++;
                if (i >= total) return;
                const j = jobs[i];
                const pageIdx = i + 1;
                try {
                    const rel = j.base + '/' + j.no + '.jpeg';
                    let base = state.baseUrl;
                    const fKey = j.base.split('/').pop();
                    if (state.fileBases && state.fileBases[fKey]) {
                        base = state.fileBases[fKey];
                    } else {
                        const m = (state.baseUrl || '').match(/^(.*\/SVGA\/)(?:[^/]+\/)?$/);
                        if (m) base = m[1] + (j.isShared ? 'shared' : 'normal_default') + '/';
                    }
                    const res = await cdnFetch(() => base + rel + '?' + authQuery(state.auth), 45000);
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    let blob = await res.blob();
                    const cfg = config[j.fid] || {};
                    const pl = (cfg.FileLinkInfo && cfg.FileLinkInfo.PageLinkInfoList) || [];
                    const S = (pl[j.no] && pl[j.no].Page && pl[j.no].Page.Size) ||
                             (pl[0] && pl[0].Page && pl[0].Page.Size);
                    blob = await cropToSize(blob, S);
                    okIdx.add(pageIdx);
                    bytes += blob.size;
                    fetched++;
                    if (zip) zip.entries.push({ path: zipFolder + 'page-' + String(pageIdx).padStart(4, '0') + '.jpg', blob });
                    if (mode === 'ocr' && mokuroSessionId) {
                        // Cover = first page: push it to the destination right
                        // away (before OCR finishes) so the folder + upload bar
                        // show life immediately.
                        if (pageIdx === 1 && !trialCoverState.fired) {
                            trialCoverState.fired = true;
                            uploadCoverEarly({
                                ui, barUpload, feed: trialUploadFeed,
                                mokuroSessionId, safeTitle: runSafeTitle,
                                blob,
                            }).catch(() => {});
                        }
                        try { await mokuroStreamPage(mokuroSessionId, blob, 'page-' + String(pageIdx).padStart(4, '0') + '.jpg', pageIdx); }
                        catch (e) { errors.push('OCR page ' + pageIdx + ': ' + (e && e.message)); }
                    }
                    if (state.cid) cachePage(state.cid, pageIdx, blob);
                } catch (e) {
                    errors.push(j.fid + '#' + j.no + ': ' + String((e && e.message) || e));
                }
                const el = (performance.now() - t1) / 1000;
                // Download bar tracks bytes/pages fetched from the CDN;
                // Descramble bar tracks pages actually processed (written to the
                // zip / sent to OCR) — they diverge naturally instead of moving
                // identically.
                setBar(barDownload, (fetched / total) * 100, fetched + '/' + total);
                setBar(barDescramble, (okIdx.size / total) * 100, okIdx.size + '/' + total);
            }
        }
        const CONC = 8;
        const ws = [];
        for (let w = 0; w < CONC; w++) ws.push(worker());
        await Promise.all(ws);

        const secs = ((performance.now() - t1) / 1000).toFixed(1);
        if (okIdx.size === 0) {
            setRunDetails(details,
                msgAllFailedZip(),
                errors);
            return false;
        }
        if (mode === 'ocr' && mokuroSessionId) {
            if (ocrPoll) clearInterval(ocrPoll);
            const { result, plan } = await finalizeOcrSession(mokuroSessionId, ui, barUpload, barMokuro, total, trialUploadFeed);
            barMokuro.fill.style.width = '100%';
            barMokuro.labRate.textContent = okIdx.size + '/' + okIdx.size;
            // OCR run finished → offer the jump to read it on reader.mokuro.app
            const missingOcr = total - okIdx.size;
            if (missingOcr > 0) {
                setRunDetails(details,
                    msgOcrPartial(missingOcr, total),
                    errors);
            } else {
                // Full volume — confirm where it was stored/uploaded.
                if (plan && plan.method === 'local') {
                    const localPath = storedPathOf(result) || plan.localDir;
                    if (localPath) details.textContent = msgStoredLocal(localPath);
                } else if (plan && plan.method) {
                    const rp = result && (result.remote_path || result.mega_path);
                    if (rp) details.textContent = msgUploadedTo(methodShortLabel(plan.method), rp);
                }
                if (errors.length) appendRunDetails(details, errors, 'Issues during the run');
            }
            ui.showReaderButton(result);
            // …and a copy/open button for where the volume was stored
            ui.showStoredButton(result);
            return missingOcr === 0;
        }
        if (zip && okIdx.size > 0) {
            const zipEntries = zip.entries.slice();
            zipEntries.sort((a, b) => {
                const na = parseInt(a.path.match(/page-(\d+)/)?.[1] || '0', 10);
                const nb = parseInt(b.path.match(/page-(\d+)/)?.[1] || '0', 10);
                return na - nb;
            });
            const zipBlob = await buildStoreZip(zipEntries, (done) => {
                const pct = Math.round((done / total) * 100);
                barDownload.fill.style.width = pct + '%';
                barDownload.labRate.textContent = pct + '%';
            });
            const url = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = zipBaseName(sv, title) + '.zip';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
            const missing = total - okIdx.size;
            if (missing > 0) {
                setRunDetails(details, msgZipPartial(okIdx.size, total), errors);
            } else {
                details.textContent = msgZipSaved(zipEntries.length, fmtBytes(zipBlob.size), secs);
                if (errors.length) appendRunDetails(details, errors, 'Issues during the run');
            }
            // Return success only when nothing is missing: a partial run keeps
            // its page cache so the next run resumes the missing pages.
            return missing === 0;
        }
        return false;
    }

    function snapshotViewerResources() {
        try {
            const entries = performance.getEntriesByType('resource') || [];
            state.viewerEntries = entries.map(e => e.name).filter(u => u && (
                u.indexOf('bw-bv-epubs') !== -1 || u.indexOf('epubs-trial') !== -1
            ));
        } catch (e) { state.viewerEntries = []; }
    }
    function resetRunState() {
        // All captured state below is per-book. If this tab has moved to a
        // different cid since the last run (SPA-style navigation), the cached
        // config/keys belong to the previous book — reusing them would silently
        // download the wrong pages (every CDN path 403s with a confusing
        // "session auth expired" message). Detect that and reset the config too.
        const currentCid = (new URLSearchParams(location.search)).get('cid') || '';
        const cidChanged = currentCid !== state.cid;
        state.cid = currentCid;
        state.fileBases = {};
        state.auth = null;
        state.baseUrl = null;
        state.viewerEntries = [];
        if (cidChanged) {
            state.decodedConfig = null;
            state.configBody = null;
            state.configFromUrl = null;
            state.keys = null;
            state.plaintextConfig = false;
            state.cti = null;
        }
    }

    async function run(ui, mode) {
        const { details, statsEl, barWrap, barDownload, barDescramble, barMokuro, barUpload, destSelect, localDirInput, btnZip, btnOcr } = ui;
        let finishedOk = false;
        // Lock the action buttons + destination pickers for the whole run: no
        // second download can start concurrently (the 10 s bridge-health tick
        // must never re-enable anything mid-run) and the destination cannot
        // change under the run. Any previous run's reader/stored buttons are
        // cleared too — they return only on a fresh OCR success — and the
        // Upload bar + status text from the last run are reset.
        ui.setRunLock(true);
        ui.hideReaderButton();
        ui.hideStoredButton();
        barUpload.wrap.style.display = 'none';
        details.textContent = '';
        const t0 = performance.now();
        try {
            resetRunState();
            await ensureStateFresh();
            const config = state.decodedConfig || decodeConfig(state.configBody);
            const contents = config['configuration'] && config['configuration']['contents'];
            if (!contents || !contents.length) throw new Error('Configuration manifest contains no readable pages.');
            const keys = state.keys;
            let total = contents.length;

            if ((state.plaintextConfig || !keys) && (mode === 'zip' || mode === 'ocr')) {
                const titleT = cleanTitle(state.cti || document.title) || state.cid;
                const svT = splitSeriesVolume(state.cti || titleT);
                const zipFolderT = zipLayoutOf(svT, titleT);
                barWrap.style.display = 'flex';
                barDownload.wrap.style.display = 'flex';
                barDescramble.wrap.style.display = 'flex';
                barDownload.fill.style.width = '0%';
                barDescramble.fill.style.width = '0%';
                const firstCfgT = config[contents[0] && contents[0].file];
                const firstPageT = firstCfgT && firstCfgT.FileLinkInfo && firstCfgT.FileLinkInfo.PageLinkInfoList &&
                    firstCfgT.FileLinkInfo.PageLinkInfoList[0].Page;
                const WT = firstPageT && firstPageT.Size ? firstPageT.Size.Width : '?';
                const HT = firstPageT && firstPageT.Size ? firstPageT.Size.Height : '?';
                let expT = 0;
                for (const it of contents) {
                    const cf = config[it.file] || {};
                    const fli = cf.FileLinkInfo || {};
                    expT += fli.PageCount || Math.max(1, (fli.PageLinkInfoList || []).length) || 1;
                }
                renderBookCard(statsEl, {
                    title: titleT,
                    pages: expT,
                    resolution: `${WT} × ${HT}`,
                    type: 'Sample / Trial'
                });
                if (svT.series) fetchAndRenderStats(statsEl, svT.series, svT.volNum);
                const trialOk = await downloadTrialZip(ui, config, contents, titleT, svT, zipFolderT, mode, details);
                if (trialOk) finishedOk = true;
                return;
            }

            const firstCfg = config[contents[0].file];
            const firstPage = firstCfg && firstCfg.FileLinkInfo.PageLinkInfoList[0].Page;
            const W = firstPage && firstPage.Size ? firstPage.Size.Width : '?';
            const H = firstPage && firstPage.Size ? firstPage.Size.Height : '?';
            const title = cleanTitle(state.cti || document.title) || state.cid;
            const sv = splitSeriesVolume(state.cti || title);

            renderBookCard(statsEl, {
                title,
                pages: total,
                resolution: `${W} × ${H}`,
                type: 'Full Edition'
            });

            barWrap.style.display = 'flex';
            barDownload.wrap.style.display = 'flex';
            barDescramble.wrap.style.display = 'flex';
            barDownload.fill.style.width = '0%';
            barDescramble.fill.style.width = '0%';

            if (sv.series) fetchAndRenderStats(statsEl, sv.series, sv.volNum);

            const zip = mode === 'zip' ? { entries: [] } : null;
            const zipFolder = zipLayoutOf(sv, title);

            let mokuroSessionId = null;
            let ocrPoll = null;
            let runSafeTitle = '';
            // One upload-bar feed shared by the early cover upload and finalize
            // so the bar tracks the whole multi-file upload (cover = file 1/N).
            const runUploadFeed = makeUploadBarUpdater(barUpload);
            const runCoverState = { fired: false };
            if (mode === 'ocr') {
                barWrap.style.display = 'flex';
                barMokuro.wrap.style.display = 'flex';
                barMokuro.fill.style.width = '0%';
                barMokuro.labRate.textContent = '0/' + total;
                const bridgeOk = await ensureBridgeRunning(25000);
                if (!bridgeOk) {
                    throw new Error(MOKURO_BRIDGE_OFFLINE_MSG);
                }
                // Don't start a capture while the bridge is still working on a
                // previous run — wait until it reports idle.
                if (!(await waitForBridgeIdle(60000))) {
                    throw new Error('The Mokuro Bridge is still busy with a previous OCR/upload — wait for it to finish, then try again.');
                }
                const sess = await mokuroStartSession(title);
                mokuroSessionId = sess.session_id;
                runSafeTitle = sess.safe_title || sess.title || '';
                ocrPoll = setInterval(async () => {
                    const st = await mokuroStatus(mokuroSessionId);
                    if (!st) return;
                    const done = st.pages_ocr_done ?? 0;
                    const got = st.pages_received ?? 0;
                    // move the Mokuro bar as OCR progresses in the background
                    updateMokuroBar(barMokuro, done, got, total);
                }, 700);
            }

            const usePool = detectWorkers();
            const poolSize = usePool ? Math.min(Math.max(4, (navigator.hardwareConcurrency || 8) * 2), 24) : 0;
            const JOB_TIMEOUT = 60000;
            let pool = null;
            if (usePool) pool = makePool(poolSize, buildWorkerSource(), onDone, JOB_TIMEOUT);

            let authTimers = [];
            const startAuthTimers = () => {
                authTimers.push(setInterval(async () => {
                    try {
                        if (authRequestBudgetExhausted()) await refreshAuthBest();
                    } catch (e) {}
                }, 5000));
                authTimers.push(setInterval(async () => {
                    try { await refreshAuthBest(); } catch (e) {}
                }, 25000));
            };
            const stopAuthTimers = () => {
                for (const t of authTimers) clearInterval(t);
                authTimers = [];
            };
            startAuthTimers();

            let seq = 0;
            const pending = new Map();
            const okIdx = new Set();
            const failedIdx = new Set();
            let bytes = 0;
            let totalJobsSubmitted = 0;
            const errors = [];
            const ocrBuffer = new Map();
            let nextOcr = 1;

            async function sendOcrStreaming() {
                while (true) {
                    if (failedIdx.has(nextOcr)) { nextOcr++; continue; }
                    if (!ocrBuffer.has(nextOcr)) break;
                    const blob = ocrBuffer.get(nextOcr);
                    ocrBuffer.delete(nextOcr);
                    const fn = 'page-' + String(nextOcr).padStart(4, '0') + '.jpg';
                    try { await mokuroStreamPage(mokuroSessionId, blob, fn, nextOcr); }
                    catch (e) { errors.push('OCR send page ' + nextOcr + ': ' + e.message); }
                    nextOcr++;
                }
            }

            let fetchedCount = 0;
            let mokuroSent = 0;
            let mokuroDone = 0;
            function bumpFetched(n) { fetchedCount += n; try { refreshProgress(); } catch (e) {} }
            function refreshProgress() {
                const deCount = okIdx.size;
                const dlCount = Math.min(fetchedCount, total);
                setBar(barDownload, (dlCount / total) * 100, dlCount + '/' + total);
                setBar(barDescramble, (deCount / total) * 100, deCount + '/' + total);
                // NOTE: the Mokuro bar is owned by the dedicated bridge status
                // poll (updateMokuroBar, done/received/total) — never write it
                // from here or the two writers fight and the label flickers.
            }

            function settleJob(job, error, blob) {
                if (job.resolved) return;
                job.resolved = true;
                pending.delete(job.id);
                if (error) {
                    errors.push(job.fid + ': ' + error);
                    failedIdx.add(job.index);
                    okIdx.delete(job.index);
                } else {
                    okIdx.add(job.index);
                    failedIdx.delete(job.index);
                    bytes += blob.size;
                    if (zip) zip.entries.push({ path: zipFolder + 'page-' + String(job.index).padStart(4, '0') + '.jpg', blob });
                    if (state.cid) cachePage(state.cid, job.index, blob);
                    // Cover = first page: push it to the destination right
                    // away (before OCR finishes) so the folder + upload bar
                    // show life immediately.
                    if (mokuroSessionId && job.index === 1 && !runCoverState.fired) {
                        runCoverState.fired = true;
                        uploadCoverEarly({
                            ui, barUpload, feed: runUploadFeed,
                            mokuroSessionId, safeTitle: runSafeTitle,
                            blob,
                        }).catch(() => {});
                    }
                    if (mokuroSessionId) {
                        ocrBuffer.set(job.index, blob);
                        if (job.index === nextOcr) sendOcrStreaming();
                    }
                }
                if (job._resolve) job._resolve();
                refreshProgress();
            }

            function onDone(data) {
                const job = pending.get(data.id);
                if (!job) return;
                if (data.error === 'auth-expired' && !job.retried) {
                    job.retried = true;
                    pending.delete(job.id);
                    refreshAuthBest().then(() => {
                        const j2 = Object.assign({}, job, { id: ++seq, retried: true, auth: state.auth, baseUrl: state.baseUrl });
                        pending.set(j2.id, j2);
                        if (pool) pool.submit(j2);
                        else {
                            fetchAndDescramble(j2.relPath, j2.seeds, JPEG_QUALITY, JOB_TIMEOUT)
                                .then(blob => settleJob(j2, null, blob))
                                .catch(e => settleJob(j2, String((e && e.message) || e), null));
                        }
                    }).catch(() => settleJob(job, 'Session auth refresh failed', null));
                    return;
                }
                settleJob(job, data.error, data.blob);
            }

            async function runJobs(jobList) {
                if (!jobList.length) return;
                totalJobsSubmitted = jobList.length;
                let prefetchIdx = 0;
                const ready = [];
                // Prefetch window scaled to the worker pool: ~3x pool keeps the
                // download a modest lead over descramble (smooth bars, no 10x
                // runaway where fetch finishes long before decode).
                const PREFETCH_AHEAD = Math.max(16, Math.min(64, (poolSize || 8) * 3));
                const NETWORK_BURST = Math.min(PREFETCH_AHEAD, 128);
                const prefetchInFlight = new Set();
                const prefetchErrors = [];

                const wakeChannel = new MessageChannel();
                const wake = () => wakeChannel.port2.postMessage(0);
                let wakePromise = null;
                function waitForWake() {
                    if (!wakePromise) {
                        wakePromise = new Promise(res => {
                            wakeChannel.port1.onmessage = () => { wakePromise = null; res(); };
                        });
                    }
                    return wakePromise;
                }

                async function prefetchOne(j) {
                    try {
                        for (let attempt = 0; attempt < 3; attempt++) {
                            try {
                                const fKey = j.fid ? j.fid.split('/').pop() : null;
                                const res = await cdnFetchWithFallback(j.rel, fKey, 45000);
                                if (!res.ok) throw new Error('HTTP ' + res.status);
                                const blob = await res.blob();
                                ready.push({ job: j, blob });
                                bumpFetched(1);
                                wake();
                                return;
                            } catch (e) {
                                const status = e && e.status;
                                if (breakerOpen()) {
                                    const wait = Math.min(breakerRemainingMs(), 10000);
                                    await new Promise(r => setTimeout(r, Math.max(wait, 800)));
                                    continue;
                                }
                                if (status === 403 || status === 0) {
                                    try { await refreshAuthBest(); } catch (e2) {}
                                    if (attempt < 2) continue;
                                }
                                const msg = String((e && e.message) || e);
                                prefetchErrors.push({ fid: j.fid, msg });
                                ready.push({ job: j, blob: null, error: msg });
                                bumpFetched(1);
                                wake();
                                return;
                            }
                        }
                        prefetchErrors.push({ fid: j.fid, msg: 'Blocked after retries' });
                        ready.push({ job: j, blob: null, error: 'blocked' });
                        wake();
                    } finally {
                        prefetchInFlight.delete(j.index);
                        pumpPrefetch();
                    }
                }
                function pumpPrefetch() {
                    if (breakerOpen()) return;
                    const burst = effectiveBurst(NETWORK_BURST);
                    while (prefetchInFlight.size < burst && prefetchIdx < jobList.length) {
                        const j = jobList[prefetchIdx++];
                        prefetchInFlight.add(j.index);
                        (async () => { try { await prefetchOne(j); } catch (e) {} })();
                    }
                }
                pumpPrefetch();

                const promises = [];
                const totalJobs = jobList.length;
                let consumed = 0;

                async function consumeOne() {
                    while (consumed < totalJobs) {
                        let item = null;
                        while (!item) {
                            const idx = ready.findIndex(r => !r.dispatched);
                            if (idx !== -1) {
                                item = ready[idx];
                                ready[idx].dispatched = true;
                            } else if (prefetchInFlight.size === 0 && prefetchIdx >= jobList.length && ready.every(r => r.dispatched)) {
                                break;
                            } else if (breakerOpen()) {
                                const wait = Math.min(breakerRemainingMs(), 3000);
                                await new Promise(r => setTimeout(r, Math.max(wait, 500)));
                                pumpPrefetch();
                            } else {
                                await Promise.race([
                                    waitForWake(),
                                    new Promise(r => setTimeout(r, 250)),
                                ]);
                            }
                        }
                        if (!item) break;
                        consumed++;
                        const j = item.job;
                        const id = ++seq;
                        const job = { id, index: j.index, fid: j.fid, relPath: j.rel, seeds: j.seeds, auth: state.auth, baseUrl: state.baseUrl, q: JPEG_QUALITY, retried: false };
                        pending.set(id, job);
                        job._resolve = null;
                        const p = new Promise(res => { job._resolve = res; });
                        promises.push(p);
                        if (pool && item.blob) {
                            pool.submit({ ...job, blob: item.blob });
                        } else if (pool && !item.blob) {
                            pool.submit(job);
                        } else {
                            (async () => {
                                try {
                                    const blob = item.blob
                                        ? await decodeBlobMain(item.blob, job.seeds, JPEG_QUALITY)
                                        : await fetchAndDescramble(job.relPath, job.seeds, JPEG_QUALITY, JOB_TIMEOUT);
                                    settleJob(job, null, blob);
                                } catch (e) {
                                    settleJob(job, String((e && e.message) || e), null);
                                }
                            })();
                        }
                    }
                }
                await consumeOne();
                stopAuthTimers();

                const deadline = Date.now() + 20 * 60 * 1000;
                let lastCount = -1;
                let lastProgress = Date.now();
                while (true) {
                    const unsettled = [...pending.values()].filter(j => !j.resolved);
                    if (unsettled.length === 0) break;
                    if (Date.now() > deadline) {
                        for (const j of unsettled) settleJob(j, 'Pipeline overall timeout', null);
                        break;
                    }
                    const settledCount = totalJobsSubmitted - unsettled.length;
                    if (settledCount !== lastCount) { lastCount = settledCount; lastProgress = Date.now(); }
                    if (Date.now() - lastProgress > 120000) {
                        for (const j of unsettled) settleJob(j, 'Pipeline stall (' + unsettled.length + ' unfinished)', null);
                        break;
                    }
                    await new Promise(r => setTimeout(r, 300));
                }
                await Promise.all(promises);
            }

            const allJobs = [];
            const jobMap = new Map();
            let cachedCount = 0;
            let jobSeq = 0;
            const cacheKey = (i) => i + 1;
            for (let i = 0; i < total; i++) {
                const item = contents[i];
                const fid = item.file;
                const pageCfg = config[fid];
                if (!pageCfg) { errors.push(fid + ': Manifest section missing'); failedIdx.add(jobSeq + 1); continue; }
                const list = (pageCfg.FileLinkInfo && pageCfg.FileLinkInfo.PageLinkInfoList) || [];
                const nPages = Math.max(1, list.length);
                for (let no = 0; no < nPages; no++) {
                    jobSeq++;
                    const idx = jobSeq;
                    const cached = state.cid ? await getCachedPage(state.cid, cacheKey(idx)) : null;
                    if (cached) {
                        okIdx.add(idx);
                        bytes += cached.size;
                        if (zip) zip.entries.push({ path: zipFolder + 'page-' + String(idx).padStart(4, '0') + '.jpg', blob: cached });
                        if (mokuroSessionId) { ocrBuffer.set(idx, cached); if (idx === nextOcr) sendOcrStreaming(); }
                        cachedCount++;
                        continue;
                    }
                    const seeds = pageSeedsNo(fid, pageCfg, keys[0], keys[1], keys[2], no);
                    const rel = b8gNo(fid, keys[0], keys[1], keys[2], no);
                    allJobs.push({ index: idx, fid, rel, seeds, no });
                    jobMap.set(idx, { fid, no });
                }
            }

            const realTotal = jobSeq;
            if (realTotal !== total) {
                total = realTotal;
                renderBookCard(statsEl, {
                    title,
                    pages: total,
                    resolution: `${W} × ${H}`,
                    type: 'Full Edition'
                });
            }
            if (cachedCount) {
                // Cache hits are pages fetched in an earlier run — count them as
                // fetched so the Download bar starts at the same baseline as the
                // Descramble bar (okIdx above) instead of showing only the pages
                // newly fetched this run. barDownload = cached + freshly fetched.
                fetchedCount += cachedCount;
                refreshProgress();
            }

            await runJobs(allJobs);

            for (let round = 0; round < 4; round++) {
                const failedIndexes = [...failedIdx];
                if (!failedIndexes.length) break;
                await refreshAuthBest();
                if (breakerOpen()) {
                    const wait = Math.min(breakerRemainingMs(), 15000);
                    await new Promise(r => setTimeout(r, Math.max(wait, 2000)));
                }
                const beforeCount = failedIdx.size;
                const retryJobs = failedIndexes.map(ix => {
                    const jm = jobMap.get(ix);
                    if (!jm) return null;
                    const pageCfg = config[jm.fid];
                    return {
                        index: ix, fid: jm.fid, no: jm.no,
                        rel: b8gNo(jm.fid, keys[0], keys[1], keys[2], jm.no),
                        seeds: pageSeedsNo(jm.fid, pageCfg, keys[0], keys[1], keys[2], jm.no),
                    };
                }).filter(Boolean);
                await runJobs(retryJobs);
                if (failedIdx.size >= beforeCount && round >= 1) break;
            }
            if (pool) pool.terminate();

            if (mokuroSessionId) {
                for (let i = 1; i <= total; i++) {
                    if (failedIdx.has(i)) continue;
                    const blob = ocrBuffer.get(i);
                    if (!blob) continue;
                    ocrBuffer.delete(i);
                    const fn = 'page-' + String(i).padStart(4, '0') + '.jpg';
                    try { await mokuroStreamPage(mokuroSessionId, blob, fn, i); }
                    catch (e) { errors.push('Final OCR send page ' + i + ': ' + e.message); }
                }
                if (ocrPoll) clearInterval(ocrPoll);
                barMokuro.wrap.style.display = 'flex';
                const { result, plan } = await finalizeOcrSession(mokuroSessionId, ui, barUpload, barMokuro, total, runUploadFeed);
                const secs = ((performance.now() - t0) / 1000).toFixed(1);
                if (failedIdx.size === 0) finishedOk = true;
                barMokuro.fill.style.width = '100%';
                barMokuro.labRate.textContent = okIdx.size + '/' + okIdx.size;
                // OCR run finished → offer the jump to read it on reader.mokuro.app
                const missingOcr = total - okIdx.size;
                if (missingOcr > 0) {
                    setRunDetails(details,
                        msgOcrPartial(missingOcr, total),
                        errors);
                } else {
                    // Full volume — confirm where it was stored/uploaded.
                    if (plan && plan.method === 'local') {
                        const localPath = storedPathOf(result) || plan.localDir;
                        if (localPath) details.textContent = msgStoredLocal(localPath);
                    } else if (plan && plan.method) {
                        const rp = result && (result.remote_path || result.mega_path);
                        if (rp) details.textContent = msgUploadedTo(methodShortLabel(plan.method), rp);
                    }
                    if (errors.length) appendRunDetails(details, errors, 'Issues during the run');
                }
                ui.showReaderButton(result);
                // …and a copy/open button for where the volume was stored
                ui.showStoredButton(result);
                return;
            }

            if (!zip) return;
            if (okIdx.size === 0) {
                setRunDetails(details,
                    msgAllFailedZip(),
                    errors);
                return;
            }

            barDownload.wrap.style.display = 'flex';
            barDescramble.wrap.style.display = 'flex';
            barMokuro.wrap.style.display = 'none';
            barDownload.fill.style.width = '0%';
            barDownload.labRate.textContent = 'Storing';
            barDescramble.fill.style.width = '100%';
            barDescramble.labRate.textContent = '100%';

            const zipEntries = zip.entries.slice();
            zipEntries.sort((a, b) => {
                const na = parseInt(a.path.match(/page-(\d+)/)?.[1] || '0', 10);
                const nb = parseInt(b.path.match(/page-(\d+)/)?.[1] || '0', 10);
                return na - nb;
            });
            const totalEntries = zipEntries.length;
            const zipBlob = await buildStoreZip(zipEntries, (done) => {
                const pct = Math.round((done / totalEntries) * 100);
                barDownload.fill.style.width = pct + '%';
                barDownload.labRate.textContent = pct + '%';

            });

            const url = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = zipBaseName(sv, title) + '.zip';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);

            const secs = ((performance.now() - t0) / 1000).toFixed(1);
            if (errors.length === 0) finishedOk = true;
            const missing = total - okIdx.size;
            if (missing > 0) {
                setRunDetails(details, msgZipPartial(okIdx.size, total), errors);
            } else {
                details.textContent = msgZipSaved(totalEntries, fmtBytes(zipBlob.size), secs);
                if (errors.length) appendRunDetails(details, errors, 'Issues during the run');
            }
        } catch (e) {
            details.textContent = 'Error: ' + (e && e.message ? e.message : 'something went wrong — see the browser console for details.');
        } finally {
            // Re-derive the enabled state from the bridge health — if the
            // bridge dropped mid-run, the OCR button stays disabled afterwards.
            ui.setRunLock(false);
            // memory hygiene: a finished download must not keep gigabytes of
            // blobs or an ever-growing IndexedDB cache behind.
            if (finishedOk) clearPageCache();
            // Run-local blobs (zip entries, OCR buffers, the ready queue) are
            // function-scoped and become garbage once run() returns.
        }
    }

    function decodeConfigWithKeys(content) {
        const c = String(content || '');
        if (c.indexOf('"data":"') === -1) {
            try {
                const j = JSON.parse(c);
                if (j && j.configuration && j.configuration.contents) {
                    state.keys = null;
                    state.plaintextConfig = true;
                    return j;
                }
            } catch (e) {}
        }
        const DATA_STR = '"data":"';
        const dataOffset = c.indexOf(DATA_STR) + DATA_STR.length;
        const dataEndOffset = c.indexOf('"', dataOffset);
        const fk = processFilename('configuration_pack.json');
        let st = A8j(c, dataOffset, dataEndOffset);
        st = A3b(0, st); st = B0p(fk, st); st = A7L(fk, st); st = A6I(fk, st); st = A2F(st);
        st = B0L(fk, st); st = A3b(1, st); st = A3b(2, st); st = A3b(3, st); st = tB0l(fk, st);
        const [jsonStr] = A6e(st);
        state.keys = [st[2], st[3], st[4]];
        return JSON.parse(jsonStr);
    }
    decodeConfig = decodeConfigWithKeys;

    function buildBookPreview() {
        try {
            const rawTitle = state.cti || document.title || '';
            const title = cleanTitle(rawTitle) || state.cid || 'Unknown Book';
            if (!state.decodedConfig && !state.configBody) return null;
            const config = state.decodedConfig || decodeConfig(state.configBody);
            const contents = config && config['configuration'] && config['configuration']['contents'];
            if (!contents || !contents.length) return null;
            const isPlain = state.plaintextConfig || !state.keys;
            let pages = 0, W = '?', H = '?';
            for (const it of contents) {
                const cfg = config[it.file];
                if (!cfg || !cfg.FileLinkInfo) { pages++; continue; }
                const fli = cfg.FileLinkInfo;
                const pl = fli.PageLinkInfoList || [];
                const n = fli.PageCount || Math.max(1, pl.length);
                pages += n;
                if (W === '?' && pl.length) {
                    const p = pl[0].Page;
                    if (p && p.Size) { W = p.Size.Width; H = p.Size.Height; }
                }
            }
            return {
                title,
                pages,
                resolution: `${W} × ${H}`,
                type: isPlain ? 'Sample / Trial' : 'Full Edition'
            };
        } catch (e) { return null; }
    }

    // =====================================================================
    // 12. Initialization
    // =====================================================================
    function boot() {
        const ui = buildUI();
        ui.btnZip.onclick = () => run(ui, 'zip');
        ui.btnOcr.onclick = () => run(ui, 'ocr');

        // purge expired cached pages from previous sessions (memory hygiene)
        try { prunePageCache(); } catch (e) {}

        (async () => {
            let statsKicked = false;
            for (let i = 0; i < 40; i++) {
                await new Promise(r => setTimeout(r, 500));
                if (!statsKicked) {
                    // Start the catalog lookups as soon as the series name is
                    // known (state.cti) — not once the whole preview finishes
                    // decoding — and only once; each card renders on its own.
                    try {
                        const sv = splitSeriesVolume(state.cti || document.title || '');
                        if (sv.series) {
                            fetchAndRenderStats(ui.statsEl, sv.series, sv.volNum);
                            statsKicked = true;
                        }
                    } catch (e) {}
                }
                const preview = buildBookPreview();
                if (preview) {
                    renderBookCard(ui.statsEl, preview);
                    break;
                }
            }
        })();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    if (BWDD_DEBUG) {
        // pageSeedsNo/b8gNo (not the old pageSeeds/b8g wrappers) so debuggers can
        // probe any specific page number, not just page 0.
        try { window.__bwdd = { decodeConfig, pageSeedsNo, A9p, b8gNo, state, buildWorkerSource, fetchAndDescramble, cleanTitle, splitSeriesVolume, fsSafePath, zipLayoutOf, zipBaseName, crc32Bytes, buildStoreZip }; } catch (e) {}
        try { window.__bwddUI = { renderStatsCards, renderBookCard, renderNativelyCard, renderMangaKotobaCard, setBar, showBars }; } catch (e) {}
    }
})();