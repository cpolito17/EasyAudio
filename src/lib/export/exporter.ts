/**
 * The export pipeline.
 *
 * For each track it takes the shortest honest route to the output:
 *
 *   - MP3 in, no sample-level edit, gain expressible in whole steps: rewrite
 *     global_gain and copy the audio frames through untouched. No decode, no
 *     re-encode, no quality loss at all.
 *   - Anything else: decode, apply the edits, limit, re-encode, and write a
 *     gapless header so the album still plays without gaps.
 *
 * Tracks are processed one at a time and streamed into the archive as they
 * finish, so peak memory stays at roughly one track no matter how large the
 * album is.
 */

import type {
  ExportSettings,
  NormalizationSettings,
  Track,
  CoverImage,
} from '../../types';
import { buildId3 } from '../tags/id3-write.ts';
import { parseMp3, applyLosslessGain, dbToSteps } from '../mp3/frames.ts';
import { encodeMp3 } from '../mp3/encode.ts';
import { decodeForExport } from '../audio/decode.ts';
import {
  applyFades,
  applyGain,
  hardClip,
  limitTruePeak,
  measureTruePeakDb,
  trim,
} from '../audio/process';
import { readAudio } from '../storage/opfs.ts';
import { ZipWriter, createFileSink, createBlobSink } from '../zip/streamzip.ts';
import { renderPath, deduplicatePaths } from '../filename/template.ts';
import { buildM3u, buildCueSheet, buildLoudnessReport } from './playlist.ts';
import type { NormalizationPlan } from './plan.ts';
import { processCover } from '../art/cover.ts';

export interface ExportRequest {
  tracks: Track[];
  plan: NormalizationPlan;
  normalization: NormalizationSettings;
  settings: ExportSettings;
  albumCover?: CoverImage;
  albumName: string;
  albumArtist: string;
  albumYear: string;
  albumGenre: string;
  albumBarcode: string;
}

export interface ExportEvent {
  phase: 'processing' | 'packaging' | 'done' | 'failed' | 'cancelled';
  completed: number;
  total: number;
  label: string;
  /** Set when the archive was produced in memory rather than streamed to disk. */
  blob?: Blob;
  fileName?: string;
  error?: string;
}

export type ExportProgressHandler = (event: ExportEvent) => void;

/** Peak of the samples as a linear ratio, for the ReplayGain peak fields. */
function linearPeak(channels: Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const magnitude = Math.abs(channel[i]);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak;
}

interface RenderedTrack {
  bytes: Uint8Array;
  /** True when the audio was passed through without re-encoding. */
  lossless: boolean;
}

/**
 * Produce the final bytes for one track.
 *
 * `sourceBytes` is consumed destructively on the lossless path, so callers must
 * pass a private copy.
 */
async function renderTrack(
  track: Track,
  sourceBytes: Uint8Array,
  request: ExportRequest,
  cover: { bytes: Uint8Array; mimeType: string } | undefined,
): Promise<RenderedTrack> {
  const plan = request.plan.tracks.get(track.id);
  const gainDb = plan?.gainDb ?? 0;
  const { normalization, settings } = request;

  const replayGain = normalization.writeReplayGainTags
    ? {
        // ReplayGain is expressed relative to the 89 dB reference, which sits
        // at -18 LUFS in the loudness domain most tools use today. After our
        // own gain is applied, the remaining correction is what is left.
        replayGainTrackDb:
          track.loudness && Number.isFinite(track.loudness.integrated)
            ? -18 - (track.loudness.integrated + gainDb)
            : undefined,
        replayGainAlbumDb: Number.isFinite(request.plan.albumLoudness)
          ? -18 - (request.plan.albumLoudness + request.plan.albumGainDb)
          : undefined,
      }
    : {};

  // ---- Lossless path -------------------------------------------------------
  if (plan?.lossless) {
    const info = parseMp3(sourceBytes);
    if (info) {
      const steps = dbToSteps(gainDb);
      if (steps !== 0) applyLosslessGain(sourceBytes, info, steps);

      const audio = sourceBytes.subarray(info.audioStart, info.audioEnd);

      const peakLinear =
        track.loudness && Number.isFinite(track.loudness.truePeak)
          ? Math.pow(10, (track.loudness.truePeak + gainDb) / 20)
          : undefined;

      const tag = buildId3({
        tags: track.tags,
        cover,
        ...replayGain,
        replayGainTrackPeak: peakLinear,
      });

      const out = new Uint8Array(tag.length + audio.length);
      out.set(tag, 0);
      out.set(audio, tag.length);
      return { bytes: out, lossless: true };
    }
    // Parsing failed after the plan said it would work, so fall through and
    // re-encode rather than emitting a broken file.
  }

  // ---- Re-encode path ------------------------------------------------------
  const decoded = await decodeForExport(sourceBytes);

  let channels: Float32Array[] = decoded.channels.map(
    (channel) => new Float32Array(channel),
  );

  const { trimStart, trimEnd, fadeIn, fadeOut } = track.edits;
  if (trimStart > 0 || trimEnd > 0) {
    channels = trim(channels, decoded.sampleRate, trimStart, trimEnd);
  }
  if (fadeIn > 0 || fadeOut > 0) {
    applyFades(channels, decoded.sampleRate, fadeIn, fadeOut);
  }

  if (gainDb !== 0) applyGain(channels, gainDb);

  if (plan?.willLimit || measureTruePeakDb(channels) > normalization.truePeakCeiling) {
    limitTruePeak(channels, decoded.sampleRate, normalization.truePeakCeiling);
  }
  hardClip(channels);

  const peak = linearPeak(channels);

  const encoded = encodeMp3(channels, decoded.sampleRate, {
    bitrateKbps: settings.bitrateKbps,
    peak,
  });

  const tag = buildId3({
    tags: track.tags,
    cover,
    ...replayGain,
    replayGainTrackPeak: peak,
  });

  const out = new Uint8Array(tag.length + encoded.length);
  out.set(tag, 0);
  out.set(encoded, tag.length);
  return { bytes: out, lossless: false };
}

/**
 * Run the whole export.
 *
 * Returns when the archive is complete. Progress is reported through the
 * callback so the UI can show which track is being worked on.
 */
export async function runExport(
  request: ExportRequest,
  onProgress: ExportProgressHandler,
  signal?: AbortSignal,
): Promise<void> {
  const { tracks, settings } = request;
  const total = tracks.length;

  const archiveName = `${request.albumArtist || 'Export'} - ${request.albumName || 'Album'}.zip`
    .replace(/[/\\:*?"<>|]/g, '-');

  // Prefer streaming straight to a file the user picks; fall back to building
  // a Blob when the browser has no File System Access API.
  const fileSink = await createFileSink(archiveName);
  const blobSink = fileSink ? null : createBlobSink();
  const sink = fileSink?.sink ?? blobSink!.sink;

  const zip = new ZipWriter(sink);

  try {
    // Resize the cover once rather than per track.
    let embedCover: { bytes: Uint8Array; mimeType: string } | undefined;
    let folderJpg: Uint8Array | undefined;

    if (request.albumCover) {
      const { cover } = await processCover(request.albumCover.bytes, {
        maxEdge: settings.artMaxEdge,
        quality: settings.artQuality,
      });
      if (settings.embedArt) {
        embedCover = { bytes: cover.bytes, mimeType: cover.mimeType };
      }
      if (settings.writeFolderJpg) folderJpg = cover.bytes;
    }

    const paths = deduplicatePaths(
      tracks.map((track) => renderPath(settings.pathTemplate, track, 'mp3')),
    );

    const playlistEntries: { track: Track; relativePath: string }[] = [];

    for (let index = 0; index < tracks.length; index++) {
      if (signal?.aborted) {
        onProgress({ phase: 'cancelled', completed: index, total, label: '' });
        return;
      }

      const track = tracks[index];
      const label = track.tags.title || track.fileName;

      onProgress({ phase: 'processing', completed: index, total, label });

      const stored = await readAudio(track.storageKey);
      if (!stored) {
        throw new Error(
          `The audio for "${label}" is no longer in browser storage. Re-import the file and try again.`,
        );
      }

      // Per-track art overrides the album cover when one is set.
      let trackCover = embedCover;
      if (settings.embedArt && track.cover) {
        const { cover } = await processCover(track.cover.bytes, {
          maxEdge: settings.artMaxEdge,
          quality: settings.artQuality,
        });
        trackCover = { bytes: cover.bytes, mimeType: cover.mimeType };
      }

      const rendered = await renderTrack(track, stored, request, trackCover);

      await zip.add(paths[index], rendered.bytes);
      playlistEntries.push({ track, relativePath: paths[index] });

      // Yield so the progress bar actually paints between tracks.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    onProgress({ phase: 'packaging', completed: total, total, label: 'Writing extras' });

    // Extras go next to the audio, in whichever folder the tracks landed in.
    const firstPath = paths[0] ?? '';
    const folder = firstPath.includes('/')
      ? firstPath.slice(0, firstPath.lastIndexOf('/') + 1)
      : '';

    const relativeEntries = playlistEntries.map((entry) => ({
      track: entry.track,
      relativePath: entry.relativePath.startsWith(folder)
        ? entry.relativePath.slice(folder.length)
        : entry.relativePath,
    }));

    const encoder = new TextEncoder();

    if (folderJpg) {
      await zip.add(`${folder}folder.jpg`, folderJpg);
    }

    if (settings.writeM3u) {
      await zip.add(
        `${folder}${request.albumName || 'Album'}.m3u8`,
        encoder.encode(buildM3u(relativeEntries, request.albumName)),
      );
    }

    if (settings.writeCueSheet) {
      await zip.add(
        `${folder}${request.albumName || 'Album'}.cue`,
        encoder.encode(
          buildCueSheet(relativeEntries, {
            name: request.albumName,
            artist: request.albumArtist,
            genre: request.albumGenre,
            year: request.albumYear,
            barcode: request.albumBarcode,
          }),
        ),
      );
    }

    // The loudness report is always written: it is what makes the normalization
    // inspectable rather than something the tool did invisibly.
    await zip.add(
      `${folder}loudness-report.txt`,
      encoder.encode(
        buildLoudnessReport(tracks, {
          targetLufs: request.normalization.targetLufs,
          mode: request.normalization.mode,
          truePeakCeiling: request.normalization.truePeakCeiling,
        }),
      ),
    );

    await zip.close();

    if (blobSink) {
      const blob = await blobSink.result;
      onProgress({
        phase: 'done',
        completed: total,
        total,
        label: '',
        blob,
        fileName: archiveName,
      });
    } else {
      onProgress({ phase: 'done', completed: total, total, label: '' });
    }
  } catch (error) {
    onProgress({
      phase: 'failed',
      completed: 0,
      total,
      label: '',
      error: error instanceof Error ? error.message : 'The export failed.',
    });
    // Close the sink so a partially written file is not left locked open.
    try {
      await sink.close();
    } catch {
      // Already closed.
    }
  }
}
