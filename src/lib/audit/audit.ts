/**
 * Import audit.
 *
 * These are the problems that are invisible while tagging and obvious once the
 * album is in a player: one track quietly at 96 kbps among a set of 320s, a
 * source that was already clipped before we touched it, two copies of the same
 * song under different filenames.
 */

import type { AuditFinding, Track } from '../../types.ts';

/** Below this, a track will sound noticeably worse than its neighbours. */
const LOW_BITRATE_THRESHOLD = 128;

/** Enough clipped samples to be audible rather than incidental. */
const CLIPPING_SAMPLE_THRESHOLD = 100;

function finding(
  code: AuditFinding['code'],
  severity: AuditFinding['severity'],
  message: string,
): AuditFinding {
  return { code, severity, message };
}

/**
 * Normalise a title for comparison: lowercase, no punctuation, no bracketed
 * suffixes like "(Remastered)" that hide a genuine duplicate.
 */
function comparisonKey(track: Track): string {
  const title = track.tags.title || track.fileName;
  return title
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/** Audit a single track in isolation. */
function auditTrack(track: Track): AuditFinding[] {
  const findings: AuditFinding[] = [];

  if (track.status === 'failed') {
    findings.push(
      finding('decode-failed', 'error', track.error ?? 'This file could not be decoded.'),
    );
    return findings;
  }

  if (!track.tags.title.trim()) {
    findings.push(finding('missing-title', 'warning', 'No title set.'));
  }
  if (!track.tags.artist.trim() && !track.tags.albumArtist.trim()) {
    findings.push(finding('missing-artist', 'warning', 'No artist set.'));
  }

  if (
    track.audio.format === 'mp3' &&
    track.audio.bitrateKbps > 0 &&
    track.audio.bitrateKbps < LOW_BITRATE_THRESHOLD
  ) {
    findings.push(
      finding(
        'low-bitrate',
        'warning',
        `Encoded at ${Math.round(track.audio.bitrateKbps)} kbps. Re-encoding will not recover the lost detail.`,
      ),
    );
  }

  if (
    track.loudness &&
    track.loudness.clippedSamples > CLIPPING_SAMPLE_THRESHOLD
  ) {
    findings.push(
      finding(
        'already-clipped',
        'warning',
        `${track.loudness.clippedSamples.toLocaleString()} samples are already at full scale in the source. Turning this track up will make the distortion worse.`,
      ),
    );
  }

  return findings;
}

/** Audit the whole set, including the checks that only make sense across tracks. */
export function auditTracks(tracks: Track[]): Map<string, AuditFinding[]> {
  const results = new Map<string, AuditFinding[]>();
  for (const track of tracks) {
    results.set(track.id, auditTrack(track));
  }

  const usable = tracks.filter((track) => track.status !== 'failed');

  // Mixed sample rates across one album force a resample on some tracks, which
  // is worth knowing before the export rather than after.
  const sampleRates = new Set(
    usable.map((track) => track.audio.sampleRate).filter((rate) => rate > 0),
  );
  if (sampleRates.size > 1) {
    const list = [...sampleRates]
      .sort((a, b) => a - b)
      .map((rate) => `${(rate / 1000).toFixed(1)} kHz`)
      .join(', ');
    for (const track of usable) {
      results.get(track.id)?.push(
        finding(
          'mixed-sample-rate',
          'info',
          `This set mixes sample rates (${list}). Tracks that do not match the output rate will be resampled.`,
        ),
      );
    }
  }

  // Duplicates: same normalised title and a duration within a second.
  const byKey = new Map<string, Track[]>();
  for (const track of usable) {
    const key = comparisonKey(track);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) existing.push(track);
    else byKey.set(key, [track]);
  }

  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const track of group) {
      const others = group.filter((candidate) => candidate.id !== track.id);
      const similarLength = others.filter(
        (candidate) =>
          Math.abs(
            candidate.audio.durationSeconds - track.audio.durationSeconds,
          ) < 1.5,
      );
      if (similarLength.length === 0) continue;

      results.get(track.id)?.push(
        finding(
          'possible-duplicate',
          'warning',
          `Looks like a duplicate of ${similarLength
            .map((candidate) => candidate.fileName)
            .join(', ')}.`,
        ),
      );
    }
  }

  return results;
}

/** Findings about the cover art, which is album-level rather than per track. */
export function auditCover(
  cover: { width: number; height: number; bytes: Uint8Array } | undefined,
  trackCount: number,
): AuditFinding[] {
  if (!cover) {
    return [
      finding(
        'no-art',
        'info',
        'No cover art. Most players will show a placeholder.',
      ),
    ];
  }

  const findings: AuditFinding[] = [];

  const skew =
    Math.abs(cover.width - cover.height) / Math.max(cover.width, cover.height);
  if (skew > 0.02) {
    findings.push(
      finding(
        'non-square-art',
        'warning',
        `Art is ${cover.width} by ${cover.height}. Players crop to a square, so the edges will be cut off.`,
      ),
    );
  }

  // Embedded art is duplicated into every file, so the cost multiplies.
  const totalBytes = cover.bytes.length * trackCount;
  if (totalBytes > 20 * 1024 * 1024) {
    findings.push(
      finding(
        'oversized-art',
        'warning',
        `At ${(cover.bytes.length / 1024 / 1024).toFixed(1)} MB per file, this art adds about ${(totalBytes / 1024 / 1024).toFixed(0)} MB across ${trackCount} tracks.`,
      ),
    );
  }

  return findings;
}
