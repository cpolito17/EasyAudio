/**
 * Cover art and metadata lookup.
 *
 * Art is normalised on the way in rather than at export time so what you see is
 * what gets embedded: resized to a sane edge, flattened onto white, and
 * re-encoded to sRGB JPEG.
 */

import { useState } from 'react';
import {
  CloudArrowDownIcon,
  ImageSquareIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  WarningIcon,
} from '@phosphor-icons/react';

import { Badge, Button, Divider, SectionTitle, cx } from './ui.tsx';
import { useStore } from '../state/store.ts';
import { formatBytes } from '../lib/util/format.ts';
import {
  fetchCoverArt,
  fetchRelease,
  searchReleases,
  type ReleaseCandidate,
} from '../lib/musicbrainz/client.ts';
import type { Album, Track } from '../types.ts';

interface ArtPanelProps {
  album: Album | undefined;
  tracks: Track[];
}

export function ArtPanel({ album, tracks }: ArtPanelProps) {
  const setAlbumCover = useStore((state) => state.setAlbumCover);
  const clearAlbumCover = useStore((state) => state.clearAlbumCover);
  const coverFindings = useStore((state) => state.coverFindings);
  const updateTags = useStore((state) => state.updateTags);
  const updateAlbum = useStore((state) => state.updateAlbum);

  const [query, setQuery] = useState({ artist: '', album: '' });
  const [results, setResults] = useState<ReleaseCandidate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!album) {
    return (
      <p className="px-1 py-6 text-center text-[12.5px] text-[var(--text-3)]">
        Select an album to manage its artwork.
      </p>
    );
  }

  const artist = query.artist || album.albumArtist;
  const name = query.album || album.name;

  const pickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) await setAlbumCover(album.id, file);
    };
    input.click();
  };

  const runSearch = async () => {
    setBusy('search');
    setError(null);
    setResults(null);
    try {
      const found = await searchReleases(artist, name, tracks.length || undefined);
      setResults(found);
      if (found.length === 0) setError('No releases matched. Try a shorter album title.');
    } catch (searchError) {
      setError(
        searchError instanceof Error ? searchError.message : 'The lookup failed.',
      );
    } finally {
      setBusy(null);
    }
  };

  /** Apply a release: fill the tags, then fetch its front cover. */
  const applyRelease = async (candidate: ReleaseCandidate) => {
    setBusy(candidate.id);
    setError(null);
    try {
      const release = await fetchRelease(candidate.id);

      updateAlbum(album.id, {
        name: release.title,
        albumArtist: release.artist,
        year: release.date.slice(0, 4),
      });

      // Match by position within the disc. Falling back to the running order
      // keeps something sensible happening when the counts disagree.
      const ordered = album.trackIds
        .map((id) => tracks.find((track) => track.id === id))
        .filter((track): track is Track => Boolean(track));

      ordered.forEach((track, index) => {
        const match =
          release.tracks.find(
            (candidateTrack) =>
              candidateTrack.position === track.tags.track &&
              candidateTrack.discNumber === (track.tags.disc || 1),
          ) ?? release.tracks[index];
        if (!match) return;

        updateTags([track.id], {
          title: match.title,
          artist: match.artist,
          albumArtist: release.artist,
          album: release.title,
          track: match.position || index + 1,
          trackTotal: release.tracks.filter(
            (entry) => entry.discNumber === match.discNumber,
          ).length,
          disc: match.discNumber,
          discTotal: release.discTotal,
          date: release.date,
          year: release.date.slice(0, 4),
          isrc: match.isrc,
          barcode: release.barcode,
          publisher: release.label,
          catalogNumber: release.catalogNumber,
        });
      });

      const artwork = await fetchCoverArt(candidate.id);
      if (artwork) await setAlbumCover(album.id, artwork);
    } catch (applyError) {
      setError(
        applyError instanceof Error ? applyError.message : 'Could not apply that release.',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <SectionTitle
        action={
          album.cover ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<TrashIcon size={13} />}
              onPointerDown={() => clearAlbumCover(album.id)}
            >
              Remove
            </Button>
          ) : null
        }
      >
        Cover art
      </SectionTitle>

      <button
        type="button"
        onPointerDown={pickFile}
        className={cx(
          'group relative aspect-square w-full overflow-hidden rounded-[var(--radius-panel)]',
          'border border-[var(--border)] bg-[var(--surface-2)]',
          'transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
          'hover:border-[var(--accent)] active:scale-[0.99]',
        )}
      >
        {album.cover ? (
          <>
            <img
              src={album.cover.objectUrl}
              alt={`Cover for ${album.name}`}
              className="size-full object-cover"
            />
            <span
              className={cx(
                'absolute inset-0 grid place-items-center bg-[var(--accent)]/85 text-white',
                'opacity-0 transition-opacity duration-200 group-hover:opacity-100',
              )}
            >
              <span className="text-[13px] font-semibold">Replace image</span>
            </span>
          </>
        ) : (
          <span className="flex h-full flex-col items-center justify-center gap-2">
            <ImageSquareIcon size={26} weight="light" className="text-[var(--text-3)]" />
            <span className="text-[12.5px] text-[var(--text-3)]">
              Click to add cover art
            </span>
          </span>
        )}
      </button>

      {album.cover ? (
        <div className="flex items-center justify-between text-[11.5px] text-[var(--text-3)]">
          <span className="numeric">
            {album.cover.width} x {album.cover.height}
          </span>
          <span className="numeric">
            {formatBytes(album.cover.bytes.length)} per file
          </span>
        </div>
      ) : null}

      {coverFindings.map((finding) => (
        <div
          key={finding.code}
          className={cx(
            'flex gap-2 rounded-[var(--radius-inner)] px-3 py-2 text-[11.5px] leading-relaxed',
            finding.severity === 'warning'
              ? 'bg-[var(--warning-soft)] text-[var(--warning)]'
              : 'bg-[var(--surface-3)] text-[var(--text-2)]',
          )}
        >
          <WarningIcon size={13} weight="fill" className="mt-[3px] shrink-0" />
          <p>{finding.message}</p>
        </div>
      ))}

      <Divider />

      <SectionTitle>Look up on MusicBrainz</SectionTitle>
      <p className="-mt-2 text-[11.5px] leading-relaxed text-[var(--text-3)]">
        Fills in titles, track numbers, dates, label, catalogue number and per-track
        ISRCs, then pulls the front cover from the Cover Art Archive.
      </p>

      <div className="grid gap-2">
        <input
          value={artist}
          onChange={(event) => setQuery((current) => ({ ...current, artist: event.target.value }))}
          placeholder="Artist"
          className="h-9 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
        />
        <input
          value={name}
          onChange={(event) => setQuery((current) => ({ ...current, album: event.target.value }))}
          placeholder="Album"
          className="h-9 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
        />
        <Button
          variant="primary"
          size="sm"
          disabled={busy === 'search' || (!artist && !name)}
          onPointerDown={runSearch}
          icon={<MagnifyingGlassIcon size={13} weight="bold" />}
        >
          {busy === 'search' ? 'Searching' : 'Search releases'}
        </Button>
      </div>

      {error ? (
        <p className="rounded-[var(--radius-inner)] bg-[var(--danger-soft)] px-3 py-2 text-[11.5px] text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      {results && results.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {results.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                disabled={busy !== null}
                onPointerDown={() => applyRelease(candidate)}
                className={cx(
                  'flex w-full flex-col gap-1 rounded-[var(--radius-inner)] border border-[var(--border)]',
                  'bg-[var(--surface-2)] p-2.5 text-left transition-all duration-200',
                  'hover:border-[var(--accent)] hover:bg-[var(--accent-softer)]',
                  'disabled:opacity-50 active:scale-[0.99]',
                )}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="text-[12.5px] font-semibold text-[var(--text)]">
                    {candidate.title}
                  </span>
                  {busy === candidate.id ? (
                    <Badge tone="accent">
                      <CloudArrowDownIcon size={9} weight="bold" />
                      Applying
                    </Badge>
                  ) : (
                    <Badge tone={candidate.score >= 95 ? 'ok' : 'neutral'}>
                      {candidate.score}%
                    </Badge>
                  )}
                </span>
                <span className="text-[11.5px] text-[var(--text-2)]">
                  {candidate.artist}
                </span>
                <span className="numeric text-[10.5px] text-[var(--text-3)]">
                  {[
                    candidate.date?.slice(0, 4),
                    candidate.country,
                    candidate.format,
                    candidate.trackCount ? `${candidate.trackCount} tracks` : '',
                    candidate.label,
                  ]
                    .filter(Boolean)
                    .join('  ·  ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
