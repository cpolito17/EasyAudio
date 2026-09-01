# EasyAudio

A browser-based audio metadata editor and loudness normalizer that exports a
tagged, correctly-levelled album as a ZIP. Runs as a single Cloudflare Worker.

Your audio never leaves your machine. Decoding, analysis, tag writing and ZIP
assembly all happen in the tab.

## Why it works this way

**The Worker serves the app; it does not touch the audio.** Cloudflare isolates
cap at 128 MB of memory and request bodies well below album size, so uploading
a 500 MB album to process it server-side would need chunked uploads, a queue and
per-minute CPU billing to do a job the browser does faster. The Worker's only
other role is proxying MusicBrainz and the Cover Art Archive, which browsers
cannot reach directly.

**MP3 is the export format.** Spotify's local-files support covers `.mp3`,
`.mp4` and `.m4p` and excludes iTunes lossless; FLAC, WAV and OGG are not
supported and do not sync to mobile. MP3 is therefore the only output that is
guaranteed to work. Any format can be imported.

**Normalization changes the samples, not just a tag.** Spotify normalizes
playback to −14 LUFS but derives that from loudness data measured at upload
time, which local files never go through. Writing a ReplayGain tag and hoping
the player honours it is not enough, so the level is baked into the file. The
ReplayGain tags are written as well, because they cost nothing.

## The lossless path

Every MP3 Layer III granule carries an 8-bit `global_gain` field, and the
decoder scales that granule by `2^((global_gain − 210) / 4)`. One step is
therefore exactly 1.5 dB. Rewriting those bytes changes how loud the file plays
with **no decoding and no re-encoding**, so the audio is otherwise bit-identical
to the source and the edit is perfectly reversible. This is the technique
`mp3gain` uses.

An MP3 that only needs a level change takes this path. A re-encode happens only
when the source is not MP3, when an edit changes the samples (trimming, fades),
or when a true-peak limiter is required. The track grid labels which path each
track will take, and the exported report records what was actually done.

The cost is granularity: gains land on 1.5 dB steps. Rounding to the nearest
step keeps the worst-case error at 0.75 dB, and the interface reports the gain
actually applied rather than the one requested.

## Measurement

Loudness is measured to ITU-R BS.1770-4 / EBU R128, implemented directly rather
than approximated:

- K-weighting from the analog prototype, so coefficients track the file's real
  sample rate instead of assuming 48 kHz
- Gated integrated loudness: 400 ms blocks, absolute gate at −70 LUFS, relative
  gate 10 LU below the ungated mean
- Loudness range per EBU Tech 3342
- True peak by 4× polyphase oversampling, which catches peaks between samples
  that would clip on playback despite no stored sample reaching full scale
- A crest-based dynamic range figure, so an over-compressed master is visible

It measures −22.99 LUFS on the EBU Tech 3341 −23 dBFS calibration tone at both
44.1 kHz and 48 kHz, inside the ±0.1 tolerance.

## Album mode

The default. One gain is applied across the whole release, computed from a
duration-weighted measurement, so a quiet interlude stays quieter than the
closer. Per-track mode brings every track to the target individually, which is
right for a playlist of unrelated songs and wrong for an album mixed as a whole.

## What it does

- **Import** MP3, M4A/AAC, FLAC, WAV, Ogg and Opus. Format is detected by
  content signature, not extension. Existing tags are read; gaps are filled by
  parsing the filename.
- **Edit** every field that matters, including album artist, disc and track
  totals, sort fields, compilation flag, ISRC, barcode, catalogue number and
  lyrics. Multi-select edits show "Multiple values" rather than flattening.
- **Batch tools**: title case, featured-artist normalisation, renumbering,
  find and replace.
- **Look up** a release on MusicBrainz to fill titles, dates, label, catalogue
  number and per-track ISRCs, and pull artwork from the Cover Art Archive.
- **Artwork** is resized, flattened onto white and re-encoded to sRGB JPEG on
  import, so what you see is what gets embedded. Non-square and oversized art
  are flagged, since art is duplicated into every file.
- **Audit** flags low bitrates, mixed sample rates, sources that were already
  clipped, and probable duplicates.
- **Export** a ZIP with a templated folder structure, embedded art, `folder.jpg`,
  an M3U playlist, an optional cue sheet, and a plain-text loudness report.

Gapless playback is preserved: a re-encoded track gets a Xing/Info header with
the LAME encoder delay and padding fields, without which every album develops an
audible gap between tracks. lamejs writes no such header, so EasyAudio builds one.

Large exports stream to disk through the File System Access API, so peak memory
stays at roughly one track. Browsers without it fall back to building the archive
in memory.

Work is saved automatically. Audio goes to OPFS, everything else to IndexedDB, so
closing the tab does not cost an afternoon of tagging.

## Development

```bash
npm install
npm run dev          # Vite dev server
npm run build        # typecheck + production build
npm test             # DSP, MP3 and ZIP unit tests
npm run e2e          # full browser run against the built app
npm run deploy       # build and deploy to Cloudflare
```

`npm test` covers the parts where a silent error would be invisible: the
loudness meter against its calibration tones, the MP3 gain rewrite (encode →
rewrite → decode → re-measure, plus a bit-identical round trip), and the ZIP
writer validated against `unzip` and Python's `zipfile`.

`npm run e2e` drives the real app in Chromium with generated MP3s, then unpacks
the exported archive and measures what came out. It needs a preview server
running (`npm run preview`).

### Optional configuration

Acoustic fingerprint lookup is wired up but disabled unless a key is present:

```bash
npx wrangler secret put ACOUSTID_API_KEY
```

Without it the app degrades to manual editing and MusicBrainz text search.

## Known limits

- **AAC/M4A output is not implemented.** MP3 only, which is what Spotify local
  files reliably accept.
- **Fingerprint-based auto-tagging** needs Chromaprint compiled to WASM to
  generate the fingerprints. The Worker endpoint exists; the client side does
  not. Text search covers the case where you can name the release.
- **Re-encoding is a lossy generation.** Unavoidable for non-MP3 sources and for
  sample-level edits, which is why the lossless path is preferred wherever it
  applies and why the interface always says which one a track will take.
- **A very large export on Firefox or Safari** builds the archive in memory,
  because neither implements the File System Access API.
