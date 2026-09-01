/**
 * Application shell.
 *
 * Three panes on the desktop: albums, the track grid, and an inspector. Below
 * the medium breakpoint the panes stack and the inspector becomes a sheet, so
 * the tool stays usable on a phone even though tagging an album is desk work.
 */

import { useEffect, useState } from 'react';
import {
  FadersIcon,
  ImageSquareIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  TagIcon,
  TrashIcon,
  WarningCircleIcon,
  WaveformIcon,
  XIcon,
} from '@phosphor-icons/react';

import { Badge, Button, cx } from './components/ui.tsx';
import { AlbumSidebar } from './components/AlbumSidebar.tsx';
import { TrackTable } from './components/TrackTable.tsx';
import { TagPanel } from './components/TagPanel.tsx';
import { LoudnessPanel } from './components/LoudnessPanel.tsx';
import { ArtPanel } from './components/ArtPanel.tsx';
import { ExportPanel } from './components/ExportPanel.tsx';
import {
  DropOverlay,
  EmptyState,
  useFilePicker,
  useGlobalDrop,
} from './components/DropZone.tsx';
import {
  useActiveAlbum,
  useActiveTracks,
  usePlan,
  useStore,
} from './state/store.ts';
import { formatTotalTime } from './lib/util/format.ts';

type InspectorTab = 'tags' | 'loudness' | 'art' | 'export';

const TABS: { id: InspectorTab; label: string; icon: typeof TagIcon }[] = [
  { id: 'tags', label: 'Tags', icon: TagIcon },
  { id: 'loudness', label: 'Loudness', icon: WaveformIcon },
  { id: 'art', label: 'Artwork', icon: ImageSquareIcon },
  { id: 'export', label: 'Export', icon: FadersIcon },
];

export default function App() {
  const dragging = useGlobalDrop();
  const openPicker = useFilePicker();

  const tracks = useStore((state) => state.tracks);
  const restore = useStore((state) => state.restore);
  const restored = useStore((state) => state.restored);
  const importProgress = useStore((state) => state.importProgress);
  const selectedTrackIds = useStore((state) => state.selectedTrackIds);
  const removeTracks = useStore((state) => state.removeTracks);
  const storageWarning = useStore((state) => state.storageWarning);
  const findings = useStore((state) => state.findings);

  const album = useActiveAlbum();
  const albumTracks = useActiveTracks();
  const plan = usePlan(albumTracks);

  const [tab, setTab] = useState<InspectorTab>('tags');
  const [inspectorOpen, setInspectorOpen] = useState(false);

  // Restore the saved project once, on first paint.
  useEffect(() => {
    void restore();
  }, [restore]);

  // Warn before leaving while an import is still writing to storage.
  useEffect(() => {
    if (!importProgress.active) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [importProgress.active]);

  const selection = albumTracks.filter((track) =>
    selectedTrackIds.includes(track.id),
  );

  const warningCount = [...findings.values()].filter((list) =>
    list.some((finding) => finding.severity !== 'info'),
  ).length;

  const totalDuration = albumTracks.reduce(
    (total, track) => total + track.audio.durationSeconds,
    0,
  );

  const empty = restored && tracks.length === 0 && !importProgress.active;

  return (
    <div className="relative flex h-full flex-col">
      <div className="ambient-field" aria-hidden />
      <DropOverlay visible={dragging} />

      {/* Top chrome. Fixed, translucent, with content scrolling beneath it. */}
      <header className="chrome sticky top-0 z-30 flex shrink-0 items-center gap-3 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-[7px] bg-[var(--accent)] text-white shadow-[var(--shadow-sm)]">
            <WaveformIcon size={15} weight="bold" />
          </span>
          <span className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--text)]">
            EasyAudio
          </span>
        </div>

        {tracks.length > 0 ? (
          <div className="ml-2 hidden items-center gap-2 sm:flex">
            <Badge tone="neutral">{tracks.length} tracks</Badge>
            <Badge tone="neutral">{formatTotalTime(totalDuration)}</Badge>
            {warningCount > 0 ? (
              <Badge tone="warn" title="Tracks with an audit finding">
                <WarningCircleIcon size={9} weight="fill" />
                {warningCount}
              </Badge>
            ) : null}
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {selection.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<TrashIcon size={13} />}
              onPointerDown={() => removeTracks(selectedTrackIds)}
            >
              Remove {selection.length}
            </Button>
          ) : null}

          <Button
            size="sm"
            variant="secondary"
            icon={<PlusIcon size={13} weight="bold" />}
            onPointerDown={openPicker}
            disabled={importProgress.active}
          >
            Add files
          </Button>

          {tracks.length > 0 ? (
            <Button
              size="sm"
              variant="primary"
              className="lg:hidden"
              icon={<SlidersHorizontalIcon size={13} weight="bold" />}
              onPointerDown={() => setInspectorOpen(true)}
            >
              Edit
            </Button>
          ) : null}
        </div>
      </header>

      {/* Import progress, as a thin determinate bar under the chrome. */}
      {importProgress.active ? (
        <div className="relative z-20 shrink-0 px-4 pt-2">
          <div className="flex items-center gap-3 rounded-[var(--radius-inner)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow-sm)]">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
                style={{
                  width: `${(importProgress.completed / Math.max(1, importProgress.total)) * 100}%`,
                }}
              />
            </div>
            <span className="truncate text-[11.5px] text-[var(--text-2)]">
              {importProgress.label}
            </span>
            <span className="numeric shrink-0 text-[11px] text-[var(--text-3)]">
              {importProgress.completed}/{importProgress.total}
            </span>
          </div>
        </div>
      ) : null}

      {storageWarning ? (
        <div className="relative z-20 shrink-0 px-4 pt-2">
          <p className="rounded-[var(--radius-inner)] bg-[var(--warning-soft)] px-3 py-2 text-[11.5px] text-[var(--warning)]">
            {storageWarning}
          </p>
        </div>
      ) : null}

      {empty ? (
        <main className="relative z-10 flex-1 overflow-y-auto">
          <EmptyState />
        </main>
      ) : (
        <main className="relative z-10 grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[224px_minmax(0,1fr)_360px] xl:grid-cols-[248px_minmax(0,1fr)_396px]">
          {/* Albums. Hidden on small screens, where the grid is the priority. */}
          <aside className="panel hidden min-h-0 overflow-hidden lg:block">
            <AlbumSidebar />
          </aside>

          <section className="flex min-h-0 flex-col gap-3">
            {album ? (
              <div className="flex items-baseline justify-between gap-3 px-1">
                <div className="min-w-0">
                  <h1 className="display-sm truncate text-[var(--text)]">
                    {album.name || 'Unknown Album'}
                  </h1>
                  <p className="truncate text-[12.5px] text-[var(--text-2)]">
                    {album.albumArtist || 'Unknown Artist'}
                    {album.year ? ` · ${album.year}` : ''}
                  </p>
                </div>
                <span className="numeric shrink-0 text-[11.5px] text-[var(--text-3)]">
                  {albumTracks.length} · {formatTotalTime(totalDuration)}
                </span>
              </div>
            ) : null}

            <div className="min-h-0 flex-1">
              <TrackTable
                tracks={albumTracks}
                plan={plan}
                albumId={album?.id ?? null}
              />
            </div>
          </section>

          {/* Inspector: a column on desktop, a sheet on small screens. */}
          <aside
            className={cx(
              'panel z-40 flex min-h-0 flex-col overflow-hidden',
              'lg:static lg:translate-x-0',
              'max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:w-[min(94vw,400px)]',
              'max-lg:rounded-l-[var(--radius-panel)] max-lg:rounded-r-none',
              'max-lg:shadow-[var(--shadow-lg)] max-lg:transition-transform',
              'max-lg:duration-350 max-lg:ease-[cubic-bezier(0.32,0.72,0,1)]',
              !inspectorOpen && 'max-lg:translate-x-full',
            )}
          >
            <div className="flex shrink-0 items-center gap-1 border-b border-[var(--hairline)] bg-[var(--surface-2)] p-1.5">
              {TABS.map((entry) => {
                const active = entry.id === tab;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onPointerDown={() => setTab(entry.id)}
                    className={cx(
                      'flex flex-1 items-center justify-center gap-1.5 rounded-[7px] px-2 py-1.5',
                      'text-[12px] font-medium transition-all duration-200',
                      'ease-[cubic-bezier(0.32,0.72,0,1)]',
                      active
                        ? 'bg-[var(--surface)] text-[var(--accent)] shadow-[var(--shadow-sm)]'
                        : 'text-[var(--text-2)] hover:text-[var(--text)]',
                    )}
                  >
                    <entry.icon size={13} weight={active ? 'fill' : 'regular'} />
                    <span className="hidden sm:inline">{entry.label}</span>
                  </button>
                );
              })}
              <button
                type="button"
                aria-label="Close editor"
                onPointerDown={() => setInspectorOpen(false)}
                className="ml-1 grid size-7 shrink-0 place-items-center rounded-[7px] text-[var(--text-2)] hover:bg-[var(--surface-3)] lg:hidden"
              >
                <XIcon size={14} weight="bold" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {tab === 'tags' ? (
                <TagPanel selection={selection} albumTracks={albumTracks} />
              ) : tab === 'loudness' ? (
                <LoudnessPanel tracks={albumTracks} plan={plan} />
              ) : tab === 'art' ? (
                <ArtPanel album={album} tracks={albumTracks} />
              ) : (
                <ExportPanel album={album} tracks={albumTracks} plan={plan} />
              )}
            </div>
          </aside>

          {/* Scrim behind the mobile sheet. */}
          {inspectorOpen ? (
            <button
              type="button"
              aria-label="Close editor"
              onPointerDown={() => setInspectorOpen(false)}
              className="fixed inset-0 z-30 bg-black/25 backdrop-blur-[2px] lg:hidden"
            />
          ) : null}
        </main>
      )}
    </div>
  );
}
