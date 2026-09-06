# BookWalker Native Downloader · v1.0.0

**[Download from GreasyFork](https://greasyfork.org/en/scripts/594508-bookwalker-native-downloader)** · or install the [raw userscript](bookwalker-native-downloader.user.js) · MIT licensed

Download the book you have open in the [BookWalker browser viewer](https://bookwalker.jp) as a **ZIP of clean, full-resolution page images**, or push its pages straight into a **mokuro Japanese-OCR pipeline** and have the finished volume land in your reader. All in one floating panel, without you flipping a single page.

<div align="center">
<img width="944" height="703" alt="image" src="https://github.com/user-attachments/assets/73fb5156-072b-496c-98db-00a931663993" />
</div>

**The short pitch:** most BookWalker downloaders *watch the viewer*. They turn pages, screenshot canvases, and scrape whatever happens to render on screen. This script ignores the screen entirely: it takes the viewer's own signed CDN URLs, fetches every page file directly, **reverses BookWalker's tile-shuffle offline**, and hands you the result: original-resolution pages, in a `Series/Volume/page-0001.jpg` layout, at download speed, with no babysitting.

## mokuro & mokuro-bridge are central to this project

Japanese OCR is a first-class feature here, not an afterthought, and it is powered by mokuro and the bridge that runs it:

- **[GolyBidoof/mokuro](https://github.com/GolyBidoof/mokuro)**, this project's mokuro: a performance-optimized fork of kha-white/mokuro (v0.3.0b, rebased on upstream v0.2.5) that OCRs the same volume in **less than half the time**: measured **2.09× faster** on a 187-page volume, with byte-format-identical output, via batched OCR inference, concurrent page loading, fp16 on GPU, and conv+bn fusion / `torch.compile` on CUDA. It reads Japanese text out of manga and light-novel pages and produces the `.mokuro` overlay data.
- **[kha-white/mokuro](https://github.com/kha-white/mokuro)**, the upstream OCR engine this fork is based on.
- **[GolyBidoof/mokuro-bridge](https://github.com/GolyBidoof/mokuro-bridge)**, the companion local app that sits on top of mokuro and makes it usable from a browser: it receives the downloaded pages, runs mokuro on them in chunks (so capture and OCR overlap), and stores or uploads the finished `.cbz` / `.mokuro` / `.webp` trio that [reader.mokuro.app](https://reader.mokuro.app/) reads. This userscript talks to the bridge directly; every "run through Mokuro" action here is the two projects working as one pipeline.

If you want OCR, you need the engine and the bridge: this script gets the pages off BookWalker, mokuro-bridge runs the OCR, and mokuro does the actual reading. All are free and open source.

> MIT licensed · single self-contained file · runs on [Tampermonkey](https://www.tampermonkey.net/) & [Violentmonkey](https://violentmonkey.github.io/) · works for full editions, trial/free samples, and subscription viewers.

---

## Features

- **Save as ZIP**. Fetches every page of the open book (manga, light novels, and trial/free samples), descrambles the tile-shuffled images, and saves a ZIP in a reader-friendly layout: `Series/Volume 2/page-0001.jpg`, `page-0002.jpg`, … (drop it into any CBZ-capable reader, or just rename it).
- **Save and run through Mokuro**. Sends the pages to the companion [mokuro-bridge](https://github.com/GolyBidoof/mokuro-bridge) app, which runs [GolyBidoof/mokuro](https://github.com/GolyBidoof/mokuro) (a performant fork of [kha-white/mokuro](https://github.com/kha-white/mokuro)) Japanese OCR and produces the `.cbz` / `.mokuro` / `.webp` trio that [reader.mokuro.app](https://reader.mokuro.app/) reads.
- **Pick where the finished volume goes, per run**. A dropdown of every destination the bridge knows: **Local**, **MEGA**, **Google Drive**, **OneDrive**, **WebDAV**, … Providers that aren't set up yet are marked *needs setup* and show the exact one-time bridge command to enable them.
- **One-click straight into your reader**. After an OCR run, the panel offers **Open Reader Mokuro** (jumps to the volume on reader.mokuro.app) and **Open stored file** (a direct link to the saved `.cbz`, including rebuilt WebDAV URLs).
- **Reading-stats cards**. Looks up the book on [manga-kotoba.com](https://manga-kotoba.com) and [Natively / LearnNatively](https://learnnatively.com) and shows difficulty & vocabulary stats inline: Natively **Level** with its exact JLPT-band colors, ratings average, reader counts, WK/BC badges, plus manga-kotoba word totals, unique words, used-once rate, new words and lexical density. Know before you download whether the book is above your level.
- **Resume, not restart**. Pages are cached to IndexedDB while running; an interrupted run picks up where it left off, and a partially failed run tells you exactly which pages are missing; the next run fetches only those.
- **Parallel engine**. Pages are prefetched over the network in parallel and descrambled across a Web-Worker pool (up to ~2× your CPU cores, capped), with a live **fetch** and **descramble** progress bar each.
- **A panel that gets out of your way**. Draggable, resizable, minimizable, with ARIA roles; remembers its size and position; never steals your arrow keys (Left/Right keep flipping viewer pages); and a **»** button *flaps* the whole panel off-screen to a small **«** tab on the right edge when you just want it gone.

## Cool gimmicks: why this one is different

Most scripts for this site fall into two camps: *page-turners* that flip through the book in the viewer and capture what renders, and *canvas scrapers* that screenshot the viewer one page at a time. This script is neither, and that buys several things the others can't offer:

| | Typical page-turn / canvas-capture scripts | **This script** |
| --- | --- | --- |
| How pages are obtained | Turn/flip the viewer through every page, wait for it to render, capture | **Fetch the CDN files directly** with the viewer's own signed URLs, no flipping, no rendering, no watching |
| Output quality | Whatever the viewer happened to draw on screen (display resolution, page-fit scaling) | **Original page resolution** from the CDN, tile-unscrambled offline and cropped to the declared size |
| Speed | Serial, one page at a time, bound to how fast the viewer renders | Parallel prefetch + a **worker-pool descramble engine**, so pages fly in with the main thread free |
| Expiring links | One stale URL and the run dies | **Auto-renews the CloudFront policy mid-run** the same way the viewer does, with 403/429 breakers, cooldowns, and retry rounds for anything that slips through |
| Interrupted runs | Start over from page 1 | **Resume from the IndexedDB cache**, re-fetching only the missing pages |
| Where it ends | A folder of captures you then have to OCR yourself | ZIP **or** an integrated **mokuro OCR → upload → open-in-reader** pipeline |

**The tile-shuffle, undone offline.** BookWalker doesn't serve plain images; each page is split into scrambled `32×32` blocks before it reaches the CDN, and the viewer reassembles them on a canvas (which is why capture scripts only ever see screen-rendered output). This script decrypts the page manifest, derives each page's scramble seeds, and **reverses the permutation in a Web Worker** with typed-array block copies + JPEG re-encode, so the ZIP contains the page as published, not as displayed.

**Auth that keeps working mid-download.** Signed CloudFront URLs only last a few minutes, and a whole volume takes longer than that. While a run is in progress the script re-negotiates auth through the same endpoints the viewer uses (`/browserWebApi/pb`), tracks its request budget per policy, and paces itself, so there is no 403 wall at page 87, no "go flip a page every five minutes" ritual.

**It doesn't fight your reading.** Arrow keys stay with the viewer, the panel starts compact and only widens when there's something to show, it makes no background requests while idle, and after a finished run it clears its cache so nothing accumulates in your browser's storage.

## Installation

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Firefox/Edge) or [Violentmonkey](https://violentmonkey.github.io/).
2. Install the script from [GreasyFork](https://greasyfork.org/en/scripts/594508-bookwalker-native-downloader) (recommended), or open [`bookwalker-native-downloader.user.js`](bookwalker-native-downloader.user.js) and click **Install**.
3. Open any book in the BookWalker viewer and use the panel.

> **Important: turn off other BookWalker userscripts.** Any other userscript that runs on BookWalker must be disabled for this script to work. Other downloaders and page-capture scripts interfere with the viewer's network traffic, which this script relies on to capture the signed CDN URLs it uses to fetch pages directly. Disable them in your userscript manager before running this one.

**Works on Windows, macOS and Linux**. The script runs in the browser, so any of those OSes with Chrome/Edge/Firefox + a userscript manager behaves the same. Saved archives are built to be filesystem-agnostic: ZIP entry names are UTF-8-flagged (Japanese titles survive Windows Explorer's extractor) and every folder/file name is sanitized against Windows rules (reserved characters *and* device names like `CON`/`NUL`, trailing dots/spaces), which Linux and macOS accept as-is. Only the OCR path has an OS-specific step: you run the mokuro-bridge app on your machine, following its README for your OS.

### Permissions (please read)

On first install, Tampermonkey asks for **cross-origin access to `learnnatively.com` and `manga-kotoba.com`**. That permission only powers the **reading-stats cards**.

- If you **accept**: stats load directly (fastest, most reliable).
- If you **decline**: the script still works fully for downloading and Mokuro. The Natively card is then fetched through a public CORS proxy instead; if that proxy is unreachable, the card simply shows a "not available" note and nothing breaks.

You can grant/revoke this later in Tampermonkey: Dashboard → this script → **Settings → User permissions → External connections**.

### Mokuro prerequisites (mokuro-bridge)

The Mokuro path needs the companion [mokuro-bridge](https://github.com/GolyBidoof/mokuro-bridge) app, a small local server that wraps [mokuro](https://github.com/kha-white/mokuro) OCR and produces the `.cbz` / `.mokuro` / `.webp` trio that [reader.mokuro.app](https://reader.mokuro.app/) reads. By default results stay on your machine (`output/<series>/`); uploads to MEGA/Drive/OneDrive/WebDAV are configured inside the bridge (interactive auth runs in the bridge's terminal, not the browser). The panel shows a green/amber **Mokuro Bridge** dot, disables the OCR button while the bridge is offline, and tracks **Store/Upload** progress with live byte/percent + speed for remote uploads.

## Architecture

The whole pipeline is three pieces that never touch the viewer's canvas:

```
BookWalker viewer
   │  (you open the book; the script passively watches its network)
   ▼
┌─────────────────────── bookwalker-native-downloader.user.js ────────────────────────┐
│ 1. capture signed CDN URLs + decrypt configuration_pack.json                        │
│ 2. fetch every page from the CDN (parallel prefetch, auth auto-renewal)             │
│ 3. descramble tile-shuffled pages in a Web-Worker pool                              │
│ 4. either pack a ZIP, or stream pages to mokuro-bridge                              │
└───────────────┬───────────────────────────────────────────────┬─────────────────────┘
                │ ZIP (offline)                                 │ pages (POST /session/…)
                ▼                                               ▼
      Series/Volume/page-0001.jpg          ┌──────────────── mokuro-bridge ────────────────┐
                                           │ FastAPI server on 127.0.0.1:62642             │
                                           │  · session per volume (start → page ×N)       │
                                           │  · chunked OCR, pages OCR'd as they arrive   │
                                           │  · assemble <volume>.mokuro / .cbz / .webp    │
                                           │  · keep locally and/or upload to a cloud      │
                                           └──────────────────────┬────────────────────────┘
                                                                  ▼
                                                      mokuro-reader/<series>/<volume>.{cbz,mokuro,webp}
                                                                  ▼
                                                       reader.mokuro.app  (in your browser)
```

### This userscript (browser side)

1. **Capture**. While you have a book open, the script passively watches the viewer's own `fetch`/`XHR` traffic and records the signed CloudFront auth (`Policy`/`Signature`/`Key-Pair-Id`), the CDN base URL, and the encrypted `configuration_pack.json` manifest. Nothing is requested by the script itself at this stage.
2. **Decrypt & plan**. `configuration_pack.json` is decrypted (custom base64 + RC4 key schedule) to recover every page's metadata: dimensions, block size, and per-page scramble seeds. The script knows the full page list before downloading anything.
3. **Fetch**. Pages are prefetched from the CDN in parallel (a burst window scaled to the worker pool, ~3× pool size). Because signed CloudFront URLs only last a few minutes, auth is re-negotiated mid-run through the viewer's own `/browserWebApi/pb` endpoint, with a request-count budget per policy, 403/429 circuit breakers with cooldowns, and up to 4 retry rounds for anything that slips through.
4. **Descramble**. Each page is reassembled offline in a Web-Worker pool (up to ~2× your CPU cores): derive the per-page permutation from the seeds, copy the `32×32` blocks back into place, crop to the declared size, and JPEG-re-encode. What lands on disk is the page as published, not as displayed.
5. **Deliver**. Either pack everything into a ZIP (`Series/Volume/page-0001.jpg`, …) or, for OCR, stream each finished page to mokuro-bridge as it's ready, starting with the cover so the destination shows life immediately.

### mokuro-bridge (local server, Python)

A small [FastAPI](https://fastapi.tiangolo.com/) server (`127.0.0.1:62642`) with a session-based HTTP API. Its [CORS allow-list defaults to the four BookWalker web viewers](https://github.com/GolyBidoof/mokuro-bridge), which is exactly what lets this userscript POST pages straight from the browser. Per volume it runs:

1. **`POST /session/start`** creates a session for a volume title (edition suffixes like `（２）` / `1巻` are stripped so volumes group under one series folder).
2. **`POST /session/{id}/page`** is one call per page image, streamed from the userscript as pages finish descrambling.
3. **Chunked OCR**. Pages are OCR'd **as they arrive** in chunks (default 8 pages, 1.5 s idle flush), so capture and OCR overlap instead of running one after the other. The fork's batched API streams per-page progress back.
4. **`POST /session/{id}/finalize`** assembles `<volume>.mokuro`, packs `<volume>.cbz`, generates the `.webp` cover, then keeps the trio locally and/or uploads it to the chosen method (MEGA / Google Drive / OneDrive / local), returning an NDJSON progress stream (byte/percent + speed). Uploads land in a `mokuro-reader/<series>/` folder, the exact layout reader.mokuro.app scans. Early cover upload and sticky per-user destination defaults are handled here too.

### mokuro (OCR engine, Python library)

The engine does the actual reading, in a performance-optimized fork of [kha-white/mokuro](https://github.com/kha-white/mokuro):

- **Batched OCR inference**. Upstream runs one model `generate()` call **per text line**; the fork batches all text-line crops from a chunk into **one call per `ocr_batch_size` crops** (64 on Apple Silicon, 32 on CUDA, 16 on CPU). That single change removes the per-line model round-trips.
- **Concurrent page loading**. Pages are decoded on a thread pool instead of sequentially.
- **Hardware-aware defaults**. `mokuro/config.py` auto-detects your machine: Apple Silicon gets 8 workers / batch 64 / fp16; NVIDIA gets 4 workers / batch 32 / fp16 + conv+bn fusion + `torch.compile`; CPU gets cores/2 workers / batch 16. Everything is tunable from one clearly-marked `EDIT ME` block.
- **Identical output, ~2× faster**. All output files (`.mokuro`, `.html`, `_ocr/` cache) are byte-format identical to upstream; measured **2.09× faster** than upstream 0.2.5 (173 s vs 362 s on a 187-page volume, Apple M4 Pro).
- Detection uses [comic-text-detector](https://github.com/dmMaze/comic-text-detector); OCR uses [manga-ocr](https://github.com/kha-white/manga-ocr).

The bridge auto-uses a sibling `mokuro/` checkout (or honors `MOKURO_REPO=/path/to/mokuro-fork`) and detects the fork's batched API at runtime, so you can switch between the fork and stock PyPI `mokuro` without touching anything else; the output is identical either way.

### reader.mokuro.app (web reader)

The hosted reader consumes the `.cbz` + `.mokuro` + `.webp` trio: it shows each page beside its selectable, copyable OCR text. Volumes can be imported by dragging the local series folder in (desktop Chromium) or by connecting the same cloud account the bridge uploaded to, which is why the panel's **Open Reader Mokuro** button jumps straight to the finished volume.

## How the page scrambling works

1. **Per-page seeds**. The decrypted manifest gives each page seeds derived from its filename, page number, and three keys. A xorshift PRNG (`B2y`) is seeded with these to drive a Fisher-Yates-style permutation (`a3f`).
2. **Block-move script (`A9p`)**. The permutation becomes a list of block moves: for each `32×32` tile (plus edge blocks for dimensions not divisible by 32), copy the scrambled source block back where it belongs, in reverse (`dest → src`).
3. **Crop to declared size**. CDN frames can carry padding (e.g. a raw `1456×2048` frame for a `1450×2048` page); after unscrambling, the page is cropped to its declared `Size` so no scrambled edge strips remain.

Everything runs in **Web Workers** (typed-array block copies + JPEG re-encode), which is what makes download + descramble fast and parallel.

> The seed derivation, PRNG/permutation and block-move logic were validated byte-for-byte against live captures during development.

## How it works (brief)

The full pipeline is described above in [Architecture](#architecture). In one line each:

- The viewer obtains **signed CloudFront URLs** for the book's CDN (`bw-bv-epubs.bookwalker.jp`); the script captures those (passive network hooks) and reuses the auth to fetch every page directly, with no canvas scraping.
- `configuration_pack.json` is decrypted (custom base64 + RC4 key schedule) to recover page metadata: dimensions, block size, and per-page scramble seeds.
- A validated implementation of BookWalker's tile-shuffle (PRNG + Fisher-Yates-style permutation + block-move script) reassembles each page, cropped to the declared page size.
- Trial/free samples and some light novels use a simpler scheme (plaintext config, pre-rendered images, or per-page-number filenames), all supported.
- Auth is renewed through the viewer's own endpoints mid-run so a full-volume download never outlives its signed URLs; failed pages are retried with fresh auth, and the IndexedDB cache makes any remainder resumable.

## Project layout

| Path | Description |
| --- | --- |
| `bookwalker-native-downloader.user.js` | The userscript (single file, self-contained) |
| `README.md` | This file |
| `LICENSE` | MIT |

## Credits

**Built by [GolyBidoof](https://github.com/GolyBidoof)**, author and maintainer of this userscript and of the companion [mokuro-bridge](https://github.com/GolyBidoof/mokuro-bridge), **together with DeepSeek V4 Flash**, the coding model that reverse-engineered BookWalker's protocol, ported the crypto and descramble logic, and iterated with the author against live captures until every step matched byte-for-byte.

The project also stands on the shoulders of a lot of great work. Thank you to:

- **[BookWalker](https://bookwalker.jp)**, for the service this tool works with. All downloaded content remains subject to BookWalker's terms of service.
- **[Brandon](https://learnnatively.com/user/brandon/), founder & lead developer of Natively (LearnNatively)**, for the difficulty levels, JLPT-band color coding, community ratings, and book metadata used in the stats card ([site](https://learnnatively.com), [X / @learnnatively](https://x.com/learnnatively), [introduction thread](https://community.wanikani.com/t/introducing-natively-now-with-movies-tv-shows-korean-spanish-german-and-more/51419)). Difficulty bands and level colors are reproduced faithfully from Natively's own styling.
- **[ChristopherFritz](https://community.wanikani.com/u/christopherfritz), the solo developer of [Manga Kotoba](https://manga-kotoba.com)**, a one-person project built by a Japanese learner for Japanese learners ([introduction thread](https://community.wanikani.com/t/manga-kotoba-manga-frequency-lists-and-stats/64151)); it supplies the per-volume vocabulary statistics (word totals, unique words, used-once rate, new words, lexical density) in the stats card. Its English word data builds on [JMDict](https://www.edrdg.org/jmdict/j_jmdict.html) by the Electronic Dictionaries Research Group.
- **[GolyBidoof / mokuro](https://github.com/GolyBidoof/mokuro)**, this project's OCR engine: a performant fork of kha-white/mokuro, used by mokuro-bridge.
- **[kha-white / mokuro](https://github.com/kha-white/mokuro)**, the upstream OCR engine this fork is based on.
- **[GolyBidoof / mokuro-bridge](https://github.com/GolyBidoof/mokuro-bridge)**, the companion local app that runs mokuro on the downloaded pages and handles uploads; this userscript talks to it directly. It sits on top of mokuro.
- **[megatools](https://megatools.megous.com)**, the MEGA upload backend used by mokuro-bridge (if you configure it to upload to MEGA).
- **[aaa4xu / bookworm](https://github.com/aaa4xu/bookworm)**, the offline BookWalker client whose algorithm the descramble implementation was validated against.
- **[VermiIIi0n / fuckBookWalker](https://github.com/VermiIIi0n/fuckBookWalker)**, an early inspiration for the direct-download approach to this site.
- The **BookWalker viewer itself**, whose network behavior was studied via captured HAR files to build a faithful, offline reimplementation.

### Trademarks & data

"BookWalker" is a trademark of its respective owner. Natively/LearnNatively and Manga Kotoba data are the property of Brandon / the Natively project and of ChristopherFritz respectively; this project is an independent tool and is not affiliated with or endorsed by any of them.

## Disclaimer

This tool is for **personal, lawful use**: download only content you are entitled to access (purchased books, free samples, trial chapters). Respect BookWalker's terms of service and the rights of authors and publishers. The maintainer(s) assume no liability for misuse.

## License

[MIT](LICENSE)
