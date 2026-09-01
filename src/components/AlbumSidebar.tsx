/**
 * Album list.
 *
 * Grouping is the part of tagging that libraries are most sensitive to, so the
 * sidebar makes it visible and directly editable: tracks can be dragged between
 * albums, and dropping one adopts the destination's album artist and title,
 * which is what actually decides how a player groups them.
 */

import { useState } from 'react';
import { ImageSquareIcon, VinylRecordIcon, WarningIcon } from '@phosphor-icons/react';

import { Badge, cx } from './ui.tsx';
import { useStore } from '../state/store.ts';
import { formatTotalTime } from '../lib/util/format.ts';
import type { Album, Track } from '../types.ts';

function albumStats(album: Album, tracks: Track[]) {
  const members = album.trackIds
    .map((id) => tracks.find((track) => track.id === id))
    .filter((track): track is Track => Boolean(track));

  return {
    count: members.length,
    duration: members.reduce((total, track) => total + track.audio.durationSeconds, 0),
    unanalysed: members.filter((track) => !track.loudness && track.status !== 'failed').length,
    failed: members.filter((track) => track.status === 'failed').length,
  };
}

export function AlbumSidebar() {
  const albums = useStore((state) => state.albums);
  const tracks = useStore((state) => state.tracks);
  const activeAlbumId = useStore((state) => state.activeAlbumId);
  const setActiveAlbum = useStore((state) => state.setActiveAlbum);
  const moveTracksToAlbum = useStore((state) => state.moveTracksToAlbum);
  const selectedTrackIds = useStore((state) => state.selectedTrackIds);

  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const totalDuration = tracks.reduce(
    (total, track) => total + track.audio.durationSeconds,
    0,
  );

  return (
    <nav
      aria-label="Albums"
      className="flex h-full flex-col gap-3 overflow-y-auto p-3"
    >
      <div className="flex items-baseline justify-between px-1">
        <span className="label-tiny">Albums</span>
        <span className="numeric text-[11px] text-[var(--text-3)]">
          {tracks.length} tracks · {formatTotalTime(totalDuration)}
        </span>
      </div>

      <ul className="flex flex-col gap-1.5">
        {albums.map((album) => {
          const stats = albumStats(album, tracks);
          const active = album.id === activeAlbumId;
          const isDropTarget = dropTarget === album.id;

          return (
            <li key={album.id}>
              <button
                type="button"
                onPointerDown={() => setActiveAlbum(album.id)}
                onDragOver={(event) => {
                  // Only offer a drop when tracks are actually being dragged.
                  if (!event.dataTransfer.types.includes('application/x-easyaudio-tracks')) {
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setDropTarget(album.id);
                }}
                onDragLeave={() => setDropTarget((current) => (current === album.id ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  setDropTarget(null);
                  const raw = event.dataTransfer.getData('application/x-easyaudio-tracks');
                  const ids: string[] = raw ? JSON.parse(raw) : selectedTrackIds;
                  if (ids.length > 0) moveTracksToAlbum(ids, album.id);
                }}
                className={cx(
                  'group flex w-full items-center gap-2.5 rounded-[var(--radius-inner)] p-2 text-left',
                  'transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]',
                  active
                    ? 'bg-[var(--accent-soft)] shadow-[var(--shadow-sm)]'
                    : 'hover:bg-[var(--surface-2)]',
                  isDropTarget && 'ring-2 ring-[var(--accent)]',
                )}
              >
                <span
                  className={cx(
                    'grid size-10 shrink-0 place-items-center overflow-hidden rounded-[7px]',
                    'border border-[var(--border)] bg-[var(--surface-3)]',
                  )}
                >
                  {album.cover ? (
                    <img
                      src={album.cover.objectUrl}
                      alt=""
                      className="size-full object-cover"
                    />
                  ) : (
                    <ImageSquareIcon
                      size={15}
                      weight="light"
                      className="text-[var(--text-3)]"
                    />
                  )}
                </span>

                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cx(
                      'truncate text-[13px] font-semibold',
                      active ? 'text-[var(--accent)]' : 'text-[var(--text)]',
                    )}
                  >
                    {album.name || 'Unknown Album'}
                  </span>
                  <span className="truncate text-[11.5px] text-[var(--text-3)]">
                    {album.albumArtist || 'Unknown Artist'}
                  </span>
                </span>

                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="numeric text-[11px] text-[var(--text-3)]">
                    {stats.count}
                  </span>
                  {stats.failed > 0 ? (
                    <Badge tone="bad" title={`${stats.failed} could not be read`}>
                      <WarningIcon size={9} weight="fill" />
                      {stats.failed}
                    </Badge>
                  ) : stats.unanalysed > 0 ? (
                    <span
                      className="size-1.5 animate-pulse rounded-full bg-[var(--accent)]"
                      title={`Analysing ${stats.unanalysed}`}
                    />
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {albums.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-[var(--radius-inner)] border border-dashed border-[var(--border)] px-4 py-8 text-center">
          <VinylRecordIcon size={20} weight="light" className="text-[var(--text-3)]" />
          <p className="text-[12px] text-[var(--text-3)]">
            Albums appear here once you import tracks.
          </p>
        </div>
      ) : null}
    </nav>
  );
}
