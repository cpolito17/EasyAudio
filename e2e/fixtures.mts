/**
 * Generate realistic test audio for the end-to-end run.
 *
 * The files carry real ID3 tags and real audio at deliberately different
 * loudness levels, so album-mode normalization has something meaningful to do
 * and the resulting gains can be checked against the measurements.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Mp3Encoder } from '@breezystack/lamejs';

import { buildId3 } from '../src/lib/tags/id3-write.ts';
import type { TrackTags } from '../src/types.ts';

function tags(overrides: Partial<TrackTags>): TrackTags {
  return {
    title: '', artist: '', albumArtist: '', album: '',
    track: 0, trackTotal: 0, disc: 0, discTotal: 0,
    year: '', date: '', originalDate: '', genre: '', composer: '',
    comment: '', lyrics: '', bpm: 0, publisher: '', isrc: '',
    barcode: '', catalogNumber: '',
    sortArtist: '', sortAlbumArtist: '', sortAlbum: '', sortTitle: '',
    compilation: false,
    ...overrides,
  };
}

/** Encode a tone at a chosen level, with a little movement so LRA is non-zero. */
function encodeTone(
  seconds: number,
  dbfs: number,
  frequency: number,
  sampleRate = 44100,
  kbps = 192,
): Uint8Array {
  const encoder = new Mp3Encoder(2, sampleRate, kbps);
  const total = Math.round(seconds * sampleRate);
  const peak = Math.pow(10, dbfs / 20) * 32767;
  const chunks: Uint8Array[] = [];

  for (let start = 0; start < total; start += 1152) {
    const count = Math.min(1152, total - start);
    const left = new Int16Array(count);
    const right = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      const t = (start + i) / sampleRate;
      // A slow amplitude sweep gives the loudness range something to measure.
      const envelope = 0.7 + 0.3 * Math.sin((2 * Math.PI * t) / seconds);
      const value = peak * envelope * Math.sin(2 * Math.PI * frequency * t);
      left[i] = value;
      right[i] = value * 0.92;
    }
    const encoded = encoder.encodeBuffer(left, right);
    if (encoded.length) chunks.push(new Uint8Array(encoded));
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(new Uint8Array(tail));

  let size = 0;
  for (const chunk of chunks) size += chunk.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface Fixture {
  path: string;
  name: string;
  expectedTitle: string;
}

export function writeFixtures(directory: string): Fixture[] {
  mkdirSync(directory, { recursive: true });

  const album = 'Harbour Lights';
  const albumArtist = 'Marisa Okonkwo';

  const specs = [
    // Tagged, quiet: needs a substantial gain up.
    { file: 'track1.mp3', title: 'Low Tide', level: -28, freq: 330, tagged: true, track: 1 },
    // Tagged, mid level.
    { file: 'track2.mp3', title: 'Signal Fire', level: -20, freq: 440, tagged: true, track: 2 },
    // Tagged, loud: caps how far album mode can push everything up.
    { file: 'track3.mp3', title: 'Breakwater', level: -9, freq: 220, tagged: true, track: 3 },
    // Untagged: the filename is the only metadata, which exercises inference.
    { file: '04 - Marisa Okonkwo - Night Ferry.mp3', title: 'Night Ferry', level: -18, freq: 550, tagged: false, track: 4 },
  ];

  const fixtures: Fixture[] = [];

  for (const spec of specs) {
    const audio = encodeTone(4, spec.level, spec.freq);

    let bytes: Uint8Array;
    if (spec.tagged) {
      const tag = buildId3({
        tags: tags({
          title: spec.title,
          artist: albumArtist,
          albumArtist,
          album,
          track: spec.track,
          trackTotal: specs.length,
          disc: 1,
          discTotal: 1,
          year: '2024',
          genre: 'Ambient',
        }),
      });
      bytes = new Uint8Array(tag.length + audio.length);
      bytes.set(tag, 0);
      bytes.set(audio, tag.length);
    } else {
      bytes = audio;
    }

    const path = join(directory, spec.file);
    writeFileSync(path, bytes);
    fixtures.push({ path, name: spec.file, expectedTitle: spec.title });
  }

  return fixtures;
}
