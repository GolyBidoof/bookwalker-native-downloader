#!/usr/bin/env python3
"""
BookWalker Browser Viewer — standalone downloader (no browser needed).

Fetches page images straight from the CDN and descrambles them offline,
given only (a) a BookWalker member cookie jar and (b) the content id (cid).

Pipeline (validated end-to-end against live HAR + bookworm fixtures):
  1. GET /browserWebApi/03/getLoader  -> sets SESSION cookie
  2. GET /browserWebApi/c?cid&u1&BID&cr  -> {url: CDN base, auth_info: CloudFront signed params}
  3. GET <base>configuration_pack.json?<auth_info>  -> encrypted config
  4. decrypt config (custom base64 + key schedule + RC4-ish stages) -> per-page
     {No, NS, PS, RS, BlockWidth, BlockHeight, Size}
  5. per page: build image URL (LCG filename), GET <base><pageId>/<token>.jpeg?<auth_info>
  6. descramble: tile-move script from PRNG seeds -> PIL rect copies -> crop -> PNG

Auth notes:
  - /c returns auth_info valid ~60s (CloudFront Policy DateLessThan). Renew by
    POST /browserWebApi/pb (returns fresh auth_info) or re-call /c.
  - The CDN itself needs no cookies, only the signed query params.
  - BID is a persistent browser id (timestamp+8 random digits+NFBR); reuse one
    you already have (e.g. from localStorage "NFBR.Global/BrowserId") to stay
    consistent with the server, or generate a fresh one.

Usage:
  python3 bw_dl.py --cid <uuid> --cookie cookies.txt [--out dir] [--pages 1-204] [--workers 8] [--u1 <uuid>] [--bid <id>]
"""
import argparse
import concurrent.futures as cf
import http.cookiejar
import io
import json
import os
import random
import re
import sys
import time
import urllib.parse
import urllib.request

from PIL import Image
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bw_crypto import decode_config
from bw_page import page_seeds, A9p
from bw_filename import b8g

SERVER = "https://viewer.bookwalker.jp"
WEBAPI = SERVER + "/browserWebApi"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")


# --------------------------------------------------------------------------
# tiny HTTP helper (cookie jar + headers)
# --------------------------------------------------------------------------
class Client:
    def __init__(self, cookie_jar_path=None):
        self.jar = http.cookiejar.MozillaCookieJar(cookie_jar_path) if cookie_jar_path else http.cookiejar.CookieJar()
        if cookie_jar_path and os.path.exists(cookie_jar_path):
            try:
                self.jar.load(ignore_discard=True, ignore_expires=True)
            except Exception:
                pass
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def request(self, url, method="GET", data=None, headers=None, timeout=30, binary=False):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("User-Agent", UA)
        req.add_header("Referer", f"{SERVER}/03/30/viewer.html?cid={CID}&cty=1")
        req.add_header("Accept", "*/*")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        with self.opener.open(req, timeout=timeout) as resp:
            body = resp.read()
            if binary:
                return resp.status, body, dict(resp.headers)
            return resp.status, body.decode("utf-8", errors="replace"), dict(resp.headers)

    def save_jar(self, path):
        if hasattr(self.jar, "save"):
            self.jar.save(path, ignore_discard=True, ignore_expires=True)


def get_u1_from_jar(client):
    """u1 param comes from the u1 cookie; fall back to a supplied value."""
    for c in client.jar:
        if c.name == "u1":
            return c.value
    return None


# --------------------------------------------------------------------------
# protocol steps
# --------------------------------------------------------------------------
def bootstrap(client, cid, bid, u1):
    """getLoader (sets SESSION) then /c (content check). Returns (auth_info, base_url)."""
    client.request(f"{SERVER}/browserWebApi/03/getLoader", timeout=20)
    cr = random.randint(10 ** 18, 10 ** 19 - 1)
    if not u1:
        raise SystemExit("No u1 cookie found. Pass --u1 <uuid> or use a cookie jar with the u1 cookie.")
    url = f"{WEBAPI}/c?cid={cid}&u1={urllib.parse.quote(u1)}&BID={bid}&cr={cr}"
    _, body, _ = client.request(url, timeout=20)
    d = json.loads(body)
    if d.get("status") != "200":
        raise SystemExit(f"/c failed: {d}")
    return d["auth_info"], d["url"]


def fetch_config(client, base_url, auth):
    qs = urllib.parse.urlencode(auth)
    url = base_url.rstrip("/") + "/configuration_pack.json?" + qs
    _, body, _ = client.request(url, timeout=60)
    return body


def renew_auth(client, cid, auth, page_id, next_page_id, bid, u1):
    """POST /pb -> fresh auth_info (rolling auth, as the viewer does)."""
    ts = time.strftime("%Y-%m-%dT%H:%M:%S+0900")
    bookmark = json.dumps({
        "date": ts, "position": page_id, "position_later_page": next_page_id,
        "pr": 15, "type": "epub", "finished": 0, "bookmark_suffix_max": 1, "bookmarks": [],
    })
    form = urllib.parse.urlencode({
        "cid": cid, "u1": u1, "BID": bid,
        "timestamp": "", "bookmark": bookmark,
    }).encode()
    _, body, _ = client.request(f"{WEBAPI}/pb", method="POST", data=form,
                                headers={"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"},
                                timeout=20)
    d = json.loads(body)
    new_auth = d.get("auth_info") or {}
    return {**auth, **new_auth}


def download_image(client, base_url, rel_path, auth):
    """rel_path is the b8g output (already includes .jpeg)."""
    qs = urllib.parse.urlencode(auth)
    url = base_url.rstrip("/") + rel_path + "?" + qs
    status, body, _ = client.request(url, timeout=60, binary=True)
    if status != 200:
        raise RuntimeError(f"image {status} for {rel_path}")
    return body


# --------------------------------------------------------------------------
# descramble
# --------------------------------------------------------------------------
def descramble(jpeg_bytes, page, w, h):
    """jpeg_bytes -> unscrambled PIL Image (cropped to Size if present)."""
    enc = Image.open(io.BytesIO(jpeg_bytes)).convert("RGB")
    iw, ih = enc.size
    tiles = A9p(page, iw, ih)
    out = Image.new("RGB", (iw, ih), (255, 255, 255))
    for t in tiles:
        # decode: source rect is (destX,destY); place at (srcX,srcY)
        out.paste(enc.crop((t["destX"], t["destY"], t["destX"] + t["width"], t["destY"] + t["height"])),
                  (t["srcX"], t["srcY"]))
    size = page.get("Size")
    if size and (iw != size["Width"] or ih != size["Height"]):
        out = out.crop((0, 0, size["Width"], size["Height"]))
    return out


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def load_config_and_pages(cid, cookie_jar, bid, u1_override):
    client = Client(cookie_jar)
    u1 = u1_override or get_u1_from_jar(client)
    auth, base_url = bootstrap(client, cid, bid, u1)
    print("auth obtained; base:", base_url)
    cfg_raw = fetch_config(client, base_url, auth)
    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "live", "config_fresh.json"), "w").write(cfg_raw)
    parsed, k1, k2, k3 = decode_config(cfg_raw)
    contents = parsed["configuration"]["contents"]
    pages = []
    for item in contents:
        fid = item["file"]
        if fid not in parsed:
            continue
        seeds = page_seeds(fid, parsed[fid], k1, k2, k3)
        pages.append((item.get("index", len(pages) + 1), fid, seeds))
    pages.sort(key=lambda x: x[0])
    return client, auth, base_url, pages, parsed, (k1, k2, k3)


def main():
    global CID
    ap = argparse.ArgumentParser(description="BookWalker standalone downloader")
    ap.add_argument("--cid", required=True, help="content id (uuid)")
    ap.add_argument("--cookie", help="path to Netscape cookie jar (member cookies incl. u1)")
    ap.add_argument("--u1", help="u1 value (if not in cookie jar)")
    ap.add_argument("--bid", default=None, help="BrowserId; default: fresh timestamp+rand+NFBR")
    ap.add_argument("--out", default="pages", help="output dir")
    ap.add_argument("--pages", default=None, help="e.g. 1-204 or 1,3,5")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--only-config", action="store_true", help="fetch+decode config and stop")
    args = ap.parse_args()

    CID = args.cid
    bid = args.bid or (str(int(time.time() * 1000)) + str(random.randint(10 ** 7, 10 ** 8 - 1)) + "NFBR")
    print("BID:", bid)

    client, auth, base_url, pages, parsed, keys = load_config_and_pages(CID, args.cookie, bid, args.u1)
    print(f"config decoded: {len(pages)} pages")
    if args.only_config:
        return

    # page range filter
    if args.pages:
        sel = set()
        for part in args.pages.split(","):
            part = part.strip()
            if "-" in part:
                a, b = part.split("-")
                sel.update(range(int(a), int(b) + 1))
            else:
                sel.add(int(part))
        pages = [p for p in pages if p[0] in sel]
    print(f"downloading {len(pages)} pages to {args.out} ...")
    os.makedirs(args.out, exist_ok=True)

    # try to fetch one page to validate auth; then parallelize with periodic /pb refresh
    page_ids = [p[1] for p in pages]
    errors = []

    def fetch_one(item):
        idx, fid, seeds = item
        url_path = b8g(fid, *keys)
        try:
            jpg = download_image(client, base_url, url_path, auth)
            img = descramble(jpg, seeds, seeds["Size"]["Width"], seeds["Size"]["Height"])
            fn = os.path.join(args.out, f"page-{idx:04d}.png")
            img.save(fn, "PNG")
            return idx, True, None
        except Exception as e:
            return idx, False, str(e)

    # sequential first page (auth sanity) then parallel
    idx0, ok0, err0 = fetch_one(pages[0])
    if not ok0:
        print("first page failed:", err0)
        # try renewing auth via /pb
        auth = renew_auth(client, CID, auth, pages[0][1], pages[1][1] if len(pages) > 1 else pages[0][1], bid, args.u1 or "")
        idx0, ok0, err0 = fetch_one(pages[0])
        print("after /pb refresh:", "OK" if ok0 else err0)
    if ok0:
        print(f"page {idx0} OK (auth works)")
    else:
        print("Could not download first page; giving up")
        return

    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(fetch_one, p): p for p in pages[1:]}
        for fut in cf.as_completed(futs):
            idx, ok, err = fut.result()
            if ok:
                print(f"page {idx} OK")
            else:
                errors.append((idx, err))
                print(f"page {idx} FAIL: {err}")

    print(f"\ndone. {len(pages) - len(errors)}/{len(pages)} ok, {len(errors)} errors")
    for idx, err in errors[:10]:
        print("  ", idx, err)


if __name__ == "__main__":
    main()
