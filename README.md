# EasyAudio

Edit audio metadata, normalize loudness, find album artwork, and export a
finished album without uploading the music you are working on.

**Live app:** [charliepolito.com/easyaudio](https://charliepolito.com/easyaudio/)

**Portfolio:** [charliepolito.com](https://charliepolito.com/)

**Source:** [github.com/cpolito17/EasyAudio](https://github.com/cpolito17/EasyAudio)

EasyAudio is a privacy-minded browser audio editor. Decoding, analysis, tag
writing, artwork processing, normalization, and ZIP assembly happen on the
user's device. A small Cloudflare Worker serves the app and proxies public
metadata lookups that browsers cannot call reliably on their own.

## What it can do

- Import MP3, M4A/AAC, FLAC, WAV, Ogg, and Opus using file signatures instead
  of trusting extensions.
- Read and batch-edit titles, artists, album details, track/disc numbers, ISRC,
  barcode, catalog number, lyrics, sort fields, and compilation flags.
- Search MusicBrainz and the Cover Art Archive for release metadata and art.
- Measure integrated loudness, loudness range, sample peak, and true peak using
  ITU-R BS.1770-4 / EBU R128 techniques.
- Normalize an album as one program or normalize unrelated tracks separately.
- Audit common library problems such as clipping, low bitrate, mixed sample
  rates, and probable duplicates.
- Export tagged MP3 files in a ZIP with optional cover art, playlist, cue sheet,
  and a plain-text loudness report.
- Save work locally with OPFS and IndexedDB so a tab can be closed and resumed.

## Privacy and architecture

Audio bytes stay in the browser. They are stored only in the browser's private
origin storage and are not sent to Cloudflare, MusicBrainz, or AcoustID.

```text
audio files -> browser workers -> metadata / loudness / tags -> local ZIP
                    |
                    +-> Cloudflare Worker -> public metadata providers
```

The production Worker is mounted at `/easyaudio/`. Its exact and wildcard
routes are intentionally more specific than the portfolio Worker's catch-all
route, so both apps can share `charliepolito.com`. Requests to the legacy
`workers.dev` hostname receive a permanent redirect to the canonical URL.

Metadata endpoints accept only `GET`, validate and cap every parameter, reject
cross-site browser requests, use upstream timeouts, and are protected by
per-visitor and per-network Cloudflare rate limits. Responses include a strict
Content Security Policy and defensive browser headers. The optional AcoustID
key is stored as a Worker secret and sent to AcoustID in a POST body rather than
being exposed in a URL.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## How normalization works

For an MP3 that only needs a level change, EasyAudio adjusts each Layer III
granule's `global_gain`. One step is 1.5 dB, so this changes playback level
without decoding or re-encoding the audio and can be reversed byte-for-byte.
The interface displays the actual rounded gain.

EasyAudio re-encodes only when the source is not MP3, a sample-level edit such
as a fade is requested, or a true-peak limiter is needed. Re-encoded files get
Xing/LAME gapless metadata so album transitions remain intact.

Measurement includes sample-rate-aware K-weighting, absolute and relative
gating, EBU Tech 3342 loudness range, and four-times polyphase true-peak
oversampling. The included calibration tests measure a -23 dBFS reference tone
at approximately -23 LUFS at both 44.1 and 48 kHz.

## Run locally

Requirements: Node.js 22 or newer and npm.

```bash
git clone https://github.com/cpolito17/EasyAudio.git
cd EasyAudio
npm ci
npm run dev
```

Useful commands:

```bash
npm run typecheck   # strict TypeScript checks
npm test            # loudness, MP3 frame, and ZIP compatibility tests
npm run build       # production bundle under dist/client
npm run preview     # serve the production bundle locally
npm run e2e         # browser workflow tests; preview must already be running
npm run cf-dev      # run the app through a local Cloudflare Worker
```

The ZIP test uses two independent readers when available: the system `unzip`
command and Python's standard `zipfile`. At least Python is required for that
compatibility test.

## Deploy to Cloudflare

Authenticate Wrangler, confirm that `charliepolito.com` is an active proxied
Cloudflare zone, and deploy:

```bash
npx wrangler login
npm run deploy
```

The checked-in `wrangler.jsonc` creates both required routes:

- `charliepolito.com/easyaudio`
- `charliepolito.com/easyaudio/*`

Both matter: the exact route handles the slash redirect, while the wildcard
route serves assets and API calls below the app root. The portfolio's broader
`charliepolito.com/*` route remains the fallback for every other path.

Fingerprint lookup is optional. Add its credential without committing it:

```bash
npx wrangler secret put ACOUSTID_API_KEY
```

The rest of EasyAudio works without that secret.

## Cost controls

The app is designed for the Cloudflare Workers free tier: audio processing uses
the user's own CPU, static assets are cached, and only small metadata requests
reach the Worker. Cloudflare's native rate-limit bindings cap each visitor and
network independently, reducing both provider abuse and accidental request
storms without maintaining a paid database.

## Known limits

- Export is MP3-only. This is the broadly supported local-file format across
  desktop and mobile music players.
- Fingerprint generation still needs a browser Chromaprint/WASM integration;
  text search works today.
- Re-encoding non-MP3 inputs or applying sample-level edits is lossy.
- Firefox and Safari do not currently expose the File System Access API, so a
  very large export may need to be assembled in memory on those browsers.

## License

No open-source license is currently granted. The public repository is available
for review and portfolio demonstration; all rights remain with Charlie Polito.
