# BookWalker Downloader

Download the book you have open in the [BookWalker browser viewer](https://viewer.bookwalker.jp) as a **ZIP of page images** — or run its pages through the **mokuro-bridge** app for Japanese OCR — without scraping the viewer's canvas.

The script fetches the page files directly from BookWalker's CDN using the same signed-URL scheme the viewer itself uses, reassembles (and where needed unscrambles) them offline, and packages them into a clean archive. No page-flipping, no canvas scraping, no watching the viewer render.

---

## Features

- **📦 Download ZIP** — fetches every page image for the open book (manga, light novels, and trial/free samples), descrambles the tile-shuffled pages, and saves a ZIP with pages ordered `page-0001.jpg`, `page-0002.jpg`, …
- **🤖 Run through mokuro-bridge** — sends the fetched pages to the local **[mokuro-bridge](https://github.com/GolyBidoof/mokuro-bridge)** app, which runs [kha-white/mokuro](https://github.com/kha-white/mokuro) Japanese OCR and can upload the results (`.cbz`, `.mokuro`, `.webp`) wherever the bridge is configured to send them.
- **📖 Open Reader Mokuro** — once a “Save and run through Mokuro” run finishes, the panel reveals an **Open Reader Mokuro** button that opens [reader.mokuro.app](https://reader.mokuro.app/) in a new tab (or the `reader_url` the bridge reports), so the volume you just stored/uploaded is one click away.
- **📊 Reading stats cards** — looks up the book on [manga-kotoba.com](https://manga-kotoba.com) and [LearnNatively](https://learnnatively.com) and shows word-count/difficulty/community stats inline:
  - manga-kotoba: total / unique words, used-once rate, new words, lexical density
  - LearnNatively: difficulty **Level** (with the site's exact JLPT-band colors), ratings ★ average, readers (reading/finished), WK/BC badges, alternative titles
- **⟳ Resume support** — pages are cached to IndexedDB while downloading; an interrupted run resumes instead of starting over. Completed runs clear the cache automatically so nothing accumulates.
- **🖥 Multi-worker engine** — fetches pages in parallel with the main thread and descrambles across a Web Worker pool (up to ~2× your CPU cores).
- **🕹 Accessible panel** — a draggable, minimizable panel with ARIA roles and live progress bars for each stage: **fetch** (network), **descramble** (tile reassembly), **Mokuro** (OCR — shows `done/received/total`), and **Store/Upload** (live byte/percent + speed when the bridge is uploading). The panel is laid out in two columns — the download + bridge controls (health, destination, actions, progress) on the left, and the book details + LearnNatively/Manga-Kotoba reading stats on the right, separated by a hairline divider. The stats column only appears once the book card has loaded — the LearnNatively/Manga-Kotoba reading cards arrive after the first download or OCR run, so the idle panel stays quiet and makes no background requests. The panel never shows an empty half — the panel starts at a compact single-column width and widens to its two-column size the moment the first card lands (it sits a comfortable distance from the right edge, so the growth stays on-screen). Drag anywhere on the header (or the grip dots at its left edge) to move the panel; drag the corner grip to resize it in both directions (width and height) — your size and position are remembered, and each column scrolls independently when the panel is smaller than its content. Arrow keys are deliberately left alone so Left/Right keep flipping viewer pages — repositioning is pointer-drag only, and keyboard users Tab straight into the panel controls. A **»** button in the header *flaps* the whole panel away off the right edge of the screen, leaving a small **«** tab on the right edge to bring it back. After a successful OCR run, two quiet **Open Reader Mokuro** / **Open stored file** buttons appear side by side on one row. The panel also shows a mokuro-bridge health indicator. While a run is in progress the **Save as ZIP** / **Save and run through Mokuro** buttons and the whole **destination section** (dropdown, output-folder field, “Use bridge default”) are disabled until the run finishes, so nothing can start a second download or change the destination mid-run. Closing the panel (**×**) removes it and stops its background bridge checks; use the **»** flap button instead when you just want it out of the way and back later.

## Installation

1. Install a userscript manager — [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Firefox/Edge) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [`bookwalker-downloader.user.js`](bookwalker-downloader.user.js) and click **Install** (Tampermonkey will offer a Raw → Install flow).
3. Open any book in the BookWalker viewer and use the panel.

### Permissions (please read)

On first install, Tampermonkey asks for **cross-origin access to `learnnatively.com` and `manga-kotoba.com`**. That permission only powers the **reading-stats cards**.

- If you **accept**: stats load directly (fastest, most reliable).
- If you **decline**: the script still works fully for downloading and Mokuro. The LearnNatively card is then fetched through a public CORS proxy instead; if that proxy is unreachable, the card simply shows a "not available" note and nothing breaks.

You can also grant/revoke this later in Tampermonkey: Dashboard → this script → **Settings → User permissions → External connections**.

### Mokuro prerequisites (mokuro-bridge)

The Mokuro path requires the companion **[mokuro-bridge](https://github.com/GolyBidoof/mokuro-bridge)** app — a small local server that wraps [mokuro](https://github.com/kha-white/mokuro) OCR and produces the `.cbz` / `.mokuro` / `.webp` trio that [reader.mokuro.app](https://reader.mokuro.app/) reads. By default the results stay on your machine (`output/<series>/`); the bridge can optionally upload them to your own MEGA account (via [megatools](https://megatools.megous.com/)) — this script asks the bridge to upload on finalize, which requires the bridge to have MEGA configured.

The panel shows a green/amber **Mokuro Bridge** dot; the "Run through Mokuro" button is disabled while the bridge is offline. While the bridge is online you can also pick, per run, **where the finished volume goes** — a dropdown lists every destination the bridge knows (`/upload-methods`: local, MEGA, Google Drive, OneDrive, WebDAV, …). Providers that aren't set up yet stay selectable and are marked "needs setup": picking one shows the exact one-time command to run in the bridge's terminal (`python server.py --setup-upload <provider>` — the interactive auth flow must run there, not in the browser) and disables the "Save and run through Mokuro" button until that provider is configured (the panel re-checks every few seconds, so the hint clears and the button re-enables automatically). Choosing **Local** reveals an output-folder field plus a "Use bridge default" button that fills the bridge's configured `output_dir`. When storing, the **Store/Upload** bar tracks live byte/percent progress + speed from `upload_progress` (only for remote uploads — local saves are quiet until done), and the completion message shows the real destination (`remote_path` / `output_dir`).

## How the page scrambling works

BookWalker does not serve pages as plain JPEGs — each page is **tile-shuffled** before it reaches the CDN, then reassembled in the viewer. The script reverses this offline:

1. **Per-page seeds** — the decrypted config (see above) gives each page a set of seeds derived from its filename, page number, and the three keys. A xorshift PRNG (`B2y`) is seeded with these to drive a Fisher–Yates-style permutation (`a3f`).
2. **Block-move script (`A9p`)** — the permutation produces a list of block moves: for each `32×32` tile (plus edge blocks for widths/heights not divisible by 32), the script knows where the source tile was scrambled to, and where it must be copied back. The raw image is read into a pixel buffer and the blocks are copied **in reverse** (`dest → src`).
3. **Crop to declared size** — the CDN image may carry padding (e.g. a raw `1456×2048` frame for a `1450×2048` page); after unscrambling, the image is cropped to the page's declared `Size` so no scrambled edge strips remain.

Everything runs in **Web Workers** (typed-array block copies + JPEG re-encode), which is what makes the whole download+descramble pipeline fast and parallel.

> For the implementation details, the `work/` directory contains the validated Python ports of the seed derivation, the PRNG/permutation, and the block-move script — all checked byte-for-byte against live captures.

## How it works (brief)

- The viewer obtains **signed CloudFront URLs** for the book's CDN (`bw-bv-epubs.bookwalker.jp`). The script captures those requests (via passive network hooks) and reuses the same auth to fetch every page directly — no canvas scraping.
- `configuration_pack.json` is decrypted (custom base64 + RC4 key schedule) to recover each page's metadata: dimensions, block size, and the per-page seeds used to **unscramble** the tile-shuffled images.
- A validated implementation of BookWalker's tile-shuffle (PRNG + Fisher–Yates-style permutation + block-move script) reassembles each page; the result is cropped to the declared page size.
- Trial/free samples and some light novels use a simpler scheme (plaintext config, pre-rendered images, or per-page-number filenames) — both are supported.

## Project layout

| Path | Description |
| --- | --- |
| `bookwalker-downloader.user.js` | The userscript (single file, self-contained) |
| `README.md` | This file |
| `LICENSE` | MIT |
| `work/` | Reverse-engineering reference: validated Python ports of the crypto / seeds / filename token, JS reference ports, and test harnesses |

## Credits

This project stands on the shoulders of a lot of great work. Thank you to:

- **[BookWalker](https://bookwalker.jp)** — for the service this tool works with. All downloaded content remains subject to BookWalker's terms of service.
- **[LearnNatively](https://learnnatively.com) & its team** — for the difficulty levels, JLPT-band color coding, community ratings, and book metadata used in the stats card. Difficulty bands and level colors are reproduced faithfully from LearnNatively's own styling.
- **[manga-kotoba.com](https://manga-kotoba.com) & its team** — for the per-volume vocabulary statistics (word totals, unique words, used-once rate, new words, lexical density) shown in the stats card.
- **[kha-white / mokuro](https://github.com/kha-white/mokuro)** — the OCR engine used by mokuro-bridge.
- **[GolyBidoof / mokuro-bridge](https://github.com/GolyBidoof/mokuro-bridge)** — the companion local app that runs mokuro on the downloaded pages and handles the upload; this userscript talks to it directly.
- **[megatools](https://megatools.megous.com)** — the MEGA upload backend used by mokuro-bridge (if you configure it to upload to MEGA).
- **[aaa4xu / bookworm](https://github.com/aaa4xu/bookworm)** — the offline BookWalker client whose algorithm the descramble implementation was validated against.
- **[DeepSeek V4 Flash](https://deepseek.com)** — the coding model that reverse-engineered the protocol, ported the crypto/descramble logic, and built this userscript together with the author through extensive iterative debugging against live captures.
- The **BookWalker viewer itself** — its network behavior was studied via captured HAR files to build a faithful, offline reimplementation.

### Trademarks & data

"BookWalker" is a trademark of its respective owner. LearnNatively and manga-kotoba data are the property of their respective teams; this project is an independent tool and is not affiliated with or endorsed by any of them.

## Disclaimer

This tool is for **personal, lawful use** — download only content you are entitled to access (purchased books, free samples, trial chapters). Respect BookWalker's terms of service and the rights of authors and publishers. The maintainer(s) assume no liability for misuse.

## License

[MIT](LICENSE)
