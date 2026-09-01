/**
 * The track grid.
 *
 * This is where the loudness report lives: measured level in, gain to be
 * applied, projected level out, and projected peak, per track, updating as the
 * normalization settings change. Showing the prediction next to the measurement
 * is what makes the normalization something you can check rather than trust.
 */

import { useMemo, useState } from 'react';
import {
  ArrowsDownUpIcon,
  CheckCircleIcon,
  DotsSixVerticalIcon,
  LightningIcon,
  WarningCircleIcon,
  XCircleIcon,
} from '@phosphor-icons/react';

import { Badge, cx } from './ui.tsx';
import { useStore } from '../state/store.ts';
import { formatDb, formatDuration, formatGain } from '../lib/util/format.ts';
import type { NormalizationPlan } from '../lib/export/plan.ts';
import type { Track } from '../types.ts';

interface TrackTableProps {
  tracks: Track[];
  plan: NormalizationPlan;
  albumId: string | null;
}

/** How far the projected loudness sits from the target, as a tone. */
function loudnessTone(projected: number | undefined, target: number) {
  if (projected === undefined || !Number.isFinite(projected)) return 'neutral' as const;
  const distance = Math.abs(projected - target);
  if (distance <= 0.6) return 'ok' as const;
  if (distance <= 2) return 'warn' as const;
  return 'bad' as const;
}

const TONE_TEXT = {
  neutral: 'text-[var(--text-3)]',
  ok: 'text-[var(--success)]',
  warn: 'text-[var(--warning)]',
  bad: 'text-[var(--danger)]',
} as const;

export function TrackTable({ tracks, plan, albumId }: TrackTableProps) {
  const selectedTrackIds = useStore((state) => state.selectedTrackIds);
  const toggleTrackSelection = useStore((state) => state.toggleTrackSelection);
  const selectTracks = useStore((state) => state.selectTracks);
  const reorderTracks = useStore((state) => state.reorderTracks);
  const findings = useStore((state) => state.findings);
  const normalization = useStore((state) => state.normalization);

  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const selected = useMemo(() => new Set(selectedTrackIds), [selectedTrackIds]);
  const allSelected = tracks.length > 0 && selected.size === tracks.length;

  const handleDrop = (targetId: string) => {
    if (!albumId) return;
    const order = tracks.map((track) => track.id);
    const moving = selectedTrackIds.length > 0 ? selectedTrackIds : [];
    if (moving.length === 0) return;

    const remaining = order.filter((id) => !moving.includes(id));
    const insertAt = remaining.indexOf(targetId);
    if (insertAt < 0) return;

    reorderTracks(albumId, [
      ...remaining.slice(0, insertAt),
      ...moving,
      ...remaining.slice(insertAt),
    ]);
  };

  return (
    <div className="tray flex h-full min-h-0 flex-col">
      <div className="tray-core flex min-h-0 flex-1 flex-col">
        {/* Column headings. Sticky so the numbers stay identifiable on scroll. */}
        <div
          className={cx(
            'sticky top-0 z-10 grid shrink-0 items-center gap-2 border-b border-[var(--hairline)]',
            'bg-[var(--surface-2)] px-3 py-2 text-[10.5px] font-semibold tracking-[0.02em]',
            'text-[var(--text-3)]',
            'grid-cols-[26px_28px_minmax(0,2.4fr)_minmax(0,1.4fr)_52px_66px_58px_66px_62px_86px]',
          )}
        >
          <span className="flex justify-center">
            <input
              type="checkbox"
              aria-label="Select all tracks"
              checked={allSelected}
              onChange={() =>
                selectTracks(allSelected ? [] : tracks.map((track) => track.id))
              }
              className="size-3.5 accent-[var(--accent)]"
            />
          </span>
          <span className="text-center">#</span>
          <span>Title</span>
          <span>Artist</span>
          <span className="text-right">Time</span>
          <span className="text-right" title="Measured integrated loudness">
            LUFS in
          </span>
          <span className="text-right" title="Gain this export will apply">
            Gain
          </span>
          <span className="text-right" title="Projected loudness after processing">
            LUFS out
          </span>
          <span className="text-right" title="Projected true peak after processing">
            Peak
          </span>
          <span className="text-right">Source</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tracks.map((track, index) => {
            const trackPlan = plan.tracks.get(track.id);
            const isSelected = selected.has(track.id);
            const trackFindings = findings.get(track.id) ?? [];
            const worst = trackFindings.some((finding) => finding.severity === 'error')
              ? 'error'
              : trackFindings.some((finding) => finding.severity === 'warning')
                ? 'warning'
                : trackFindings.length > 0
                  ? 'info'
                  : null;

            // Only per-track mode aims each track at the target. In album mode
            // the tracks are meant to differ, so scoring them against the
            // target would flag correct behaviour as a problem.
            const outTone =
              normalization.enabled && normalization.mode === 'track'
                ? loudnessTone(trackPlan?.projected.integrated, normalization.targetLufs)
                : ('neutral' as const);

            const peakOver =
              trackPlan &&
              Number.isFinite(trackPlan.projected.truePeak) &&
              trackPlan.projected.truePeak > normalization.truePeakCeiling + 0.05;

            return (
              <div
                key={track.id}
                role="row"
                tabIndex={0}
                draggable
                onDragStart={(event) => {
                  const ids = isSelected ? selectedTrackIds : [track.id];
                  if (!isSelected) selectTracks([track.id]);
                  event.dataTransfer.setData(
                    'application/x-easyaudio-tracks',
                    JSON.stringify(ids),
                  );
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes('application/x-easyaudio-tracks')) {
                    return;
                  }
                  event.preventDefault();
                  setDragOverId(track.id);
                }}
                onDragLeave={() =>
                  setDragOverId((current) => (current === track.id ? null : current))
                }
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setDragOverId(null);
                  handleDrop(track.id);
                }}
                onPointerDown={(event) => {
                  if ((event.target as HTMLElement).tagName === 'INPUT') return;
                  toggleTrackSelection(
                    track.id,
                    event.metaKey || event.ctrlKey,
                    event.shiftKey,
                  );
                }}
                className={cx(
                  'group grid cursor-default items-center gap-2 border-b border-[var(--hairline)]',
                  'px-3 py-[7px] text-[12.5px] transition-colors duration-150',
                  'grid-cols-[26px_28px_minmax(0,2.4fr)_minmax(0,1.4fr)_52px_66px_58px_66px_62px_86px]',
                  isSelected
                    ? 'bg-[var(--accent-soft)]'
                    : index % 2 === 1
                      ? 'bg-[var(--surface-2)]/45 hover:bg-[var(--surface-3)]'
                      : 'hover:bg-[var(--surface-3)]',
                  dragOverId === track.id && 'shadow-[inset_0_2px_0_var(--accent)]',
                  track.status === 'failed' && 'opacity-60',
                )}
              >
                <span className="flex items-center justify-center">
                  <input
                    type="checkbox"
                    aria-label={`Select ${track.tags.title || track.fileName}`}
                    checked={isSelected}
                    onChange={(event) =>
                      toggleTrackSelection(track.id, true, event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey)
                    }
                    className="size-3.5 accent-[var(--accent)]"
                  />
                </span>

                <span className="flex items-center justify-center gap-0.5 text-[var(--text-3)]">
                  <DotsSixVerticalIcon
                    size={11}
                    weight="bold"
                    className="opacity-0 transition-opacity group-hover:opacity-60"
                  />
                  <span className="numeric text-[11.5px]">
                    {track.tags.track || index + 1}
                  </span>
                </span>

                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cx(
                      'truncate font-medium',
                      track.tags.title ? 'text-[var(--text)]' : 'text-[var(--text-3)] italic',
                    )}
                    title={track.tags.title || track.fileName}
                  >
                    {track.tags.title || track.fileName}
                  </span>
                  {worst === 'error' ? (
                    <XCircleIcon
                      size={12}
                      weight="fill"
                      className="shrink-0 text-[var(--danger)]"
                    />
                  ) : worst === 'warning' ? (
                    <WarningCircleIcon
                      size={12}
                      weight="fill"
                      className="shrink-0 text-[var(--warning)]"
                    />
                  ) : null}
                </span>

                <span
                  className="truncate text-[var(--text-2)]"
                  title={track.tags.artist}
                >
                  {track.tags.artist || '-'}
                </span>

                <span className="numeric text-right text-[11.5px] text-[var(--text-2)]">
                  {formatDuration(track.audio.durationSeconds)}
                </span>

                <span className="numeric text-right text-[11.5px] text-[var(--text-2)]">
                  {track.status === 'analyzing' ? (
                    <span className="inline-block size-1.5 animate-pulse rounded-full bg-[var(--accent)]" />
                  ) : (
                    formatDb(track.loudness?.integrated)
                  )}
                </span>

                <span
                  className={cx(
                    'numeric text-right text-[11.5px] font-medium',
                    trackPlan && Math.abs(trackPlan.gainDb) > 0.05
                      ? 'text-[var(--accent)]'
                      : 'text-[var(--text-3)]',
                  )}
                >
                  {normalization.enabled ? formatGain(trackPlan?.gainDb) : '-'}
                </span>

                <span
                  className={cx(
                    'numeric text-right text-[11.5px] font-medium',
                    TONE_TEXT[outTone],
                  )}
                >
                  {formatDb(trackPlan?.projected.integrated)}
                </span>

                <span
                  className={cx(
                    'numeric text-right text-[11.5px]',
                    peakOver ? 'text-[var(--danger)]' : 'text-[var(--text-2)]',
                  )}
                  title={peakOver ? 'Above the true-peak ceiling' : undefined}
                >
                  {formatDb(trackPlan?.projected.truePeak)}
                </span>

                <span className="flex items-center justify-end gap-1">
                  {trackPlan?.lossless ? (
                    <Badge tone="ok" title="Will be adjusted without re-encoding">
                      <LightningIcon size={9} weight="fill" />
                      Lossless
                    </Badge>
                  ) : trackPlan ? (
                    <Badge tone="neutral" title={trackPlan.reencodeReason}>
                      <ArrowsDownUpIcon size={9} weight="bold" />
                      Re-encode
                    </Badge>
                  ) : (
                    <Badge tone="neutral">
                      {track.audio.format.toUpperCase()}
                    </Badge>
                  )}
                </span>
              </div>
            );
          })}

          {tracks.length === 0 ? (
            <div className="grid place-items-center py-16 text-center">
              <CheckCircleIcon size={22} weight="light" className="text-[var(--text-3)]" />
              <p className="mt-2 text-[13px] text-[var(--text-3)]">
                No tracks in this album.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
