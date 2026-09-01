/**
 * Export settings and the export run itself.
 *
 * The path template is previewed live against a real track, because a template
 * is much easier to judge from its output than from its tokens.
 */

import { useMemo, useRef, useState } from 'react';
import {
  DownloadSimpleIcon,
  FileZipIcon,
  InfoIcon,
  StopCircleIcon,
} from '@phosphor-icons/react';

import {
  Badge,
  Button,
  Divider,
  SectionTitle,
  Select,
  Toggle,
  cx,
} from './ui.tsx';
import { useStore } from '../state/store.ts';
import { DEFAULT_TEMPLATE, previewPath } from '../lib/filename/template.ts';
import { runExport, type ExportEvent } from '../lib/export/exporter.ts';
import type { NormalizationPlan } from '../lib/export/plan.ts';
import type { Album, Track } from '../types.ts';

interface ExportPanelProps {
  album: Album | undefined;
  tracks: Track[];
  plan: NormalizationPlan;
}

const TEMPLATE_PRESETS = [
  { value: DEFAULT_TEMPLATE, label: 'Artist / Album (Year) / 1-01 Title' },
  { value: '{albumartist}/{album}/{track:02} {title}.{ext}', label: 'Artist / Album / 01 Title' },
  { value: '{album}/{track:02} - {artist} - {title}.{ext}', label: 'Album / 01 - Artist - Title' },
  { value: '{track:02} {title}.{ext}', label: 'Flat: 01 Title' },
];

export function ExportPanel({ album, tracks, plan }: ExportPanelProps) {
  const settings = useStore((state) => state.exportSettings);
  const setExportSettings = useStore((state) => state.setExportSettings);
  const normalization = useStore((state) => state.normalization);

  const [progress, setProgress] = useState<ExportEvent | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const usable = tracks.filter((track) => track.status !== 'failed');
  const reencodeCount = [...plan.tracks.values()].filter((entry) => !entry.lossless).length;
  const unanalysed = usable.filter((track) => !track.loudness).length;

  const preview = useMemo(
    () => (usable[0] ? previewPath(settings.pathTemplate, usable[0]) : ''),
    [settings.pathTemplate, usable],
  );

  const estimatedBytes = useMemo(() => {
    let total = 0;
    for (const track of usable) {
      const entry = plan.tracks.get(track.id);
      if (entry?.lossless) total += track.fileSize;
      else total += (track.audio.durationSeconds * settings.bitrateKbps * 1000) / 8;
      if (settings.embedArt) total += 180_000;
    }
    return total;
  }, [usable, plan, settings.bitrateKbps, settings.embedArt]);

  // When tracks are shown without a matching album record, fall back to their
  // own tags. Doing nothing here would leave the button looking broken.
  const albumIdentity = {
    name: album?.name || usable[0]?.tags.album || 'Album',
    artist:
      album?.albumArtist ||
      usable[0]?.tags.albumArtist ||
      usable[0]?.tags.artist ||
      'Unknown Artist',
    year: album?.year || usable[0]?.tags.year || '',
    genre: album?.genre || usable[0]?.tags.genre || '',
  };

  const start = async () => {
    if (usable.length === 0) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ phase: 'processing', completed: 0, total: usable.length, label: '' });

    try {
      await runExport(
        {
          tracks: usable,
          plan,
          normalization,
          settings,
          albumCover: album?.cover,
          albumName: albumIdentity.name,
          albumArtist: albumIdentity.artist,
          albumYear: albumIdentity.year,
          albumGenre: albumIdentity.genre,
          albumBarcode: usable[0]?.tags.barcode ?? '',
        },
        (event) => {
          setProgress(event);
          // A blob result means the browser could not stream to disk, so the
          // download has to be triggered here.
          if (event.phase === 'done' && event.blob && event.fileName) {
            const url = URL.createObjectURL(event.blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = event.fileName;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
          }
        },
        controller.signal,
      );
    } catch (error) {
      // runExport reports its own failures, so reaching here means something
      // unexpected escaped. The UI must not be left showing a running export.
      setProgress({
        phase: 'failed',
        completed: 0,
        total: usable.length,
        label: '',
        error:
          error instanceof Error ? error.message : 'The export stopped unexpectedly.',
      });
    } finally {
      abortRef.current = null;
    }
  };

  const running =
    progress?.phase === 'processing' || progress?.phase === 'packaging';

  return (
    <div className="flex flex-col gap-5">
      <SectionTitle>Output</SectionTitle>

      <Select
        label="Bitrate for re-encoded tracks"
        value={String(settings.bitrateKbps)}
        onChange={(event) =>
          setExportSettings({ bitrateKbps: Number(event.target.value) })
        }
        options={[
          { value: '320', label: '320 kbps · highest quality' },
          { value: '256', label: '256 kbps' },
          { value: '192', label: '192 kbps' },
          { value: '128', label: '128 kbps · smallest' },
        ]}
        hint={
          reencodeCount === 0
            ? 'Nothing needs re-encoding, so this setting will not be used.'
            : `${reencodeCount} of ${plan.tracks.size} tracks will be re-encoded at this bitrate.`
        }
      />

      <Select
        label="Folder structure"
        value={
          TEMPLATE_PRESETS.some((preset) => preset.value === settings.pathTemplate)
            ? settings.pathTemplate
            : 'custom'
        }
        onChange={(event) => {
          if (event.target.value !== 'custom') {
            setExportSettings({ pathTemplate: event.target.value });
          }
        }}
        options={[
          ...TEMPLATE_PRESETS,
          { value: 'custom', label: 'Custom template' },
        ]}
      />

      <label className="flex flex-col gap-1.5">
        <span className="label-tiny">Template</span>
        <input
          value={settings.pathTemplate}
          onChange={(event) => setExportSettings({ pathTemplate: event.target.value })}
          spellCheck={false}
          className="numeric h-9 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-[12px] focus:border-[var(--accent)] focus:outline-none"
        />
        {preview ? (
          <span className="numeric mt-0.5 break-all rounded-[var(--radius-control)] bg-[var(--surface-3)] px-2 py-1.5 text-[11px] text-[var(--text-2)]">
            {preview}
          </span>
        ) : null}
      </label>

      <Divider />

      <SectionTitle>Included in the archive</SectionTitle>
      <div className="flex flex-col gap-1">
        <Toggle
          label="Embed cover art"
          hint="Written into every file, which is what players read."
          checked={settings.embedArt}
          onChange={(next) => setExportSettings({ embedArt: next })}
        />
        <Toggle
          label="Write folder.jpg"
          hint="A separate image file, for players that look for one."
          checked={settings.writeFolderJpg}
          onChange={(next) => setExportSettings({ writeFolderJpg: next })}
        />
        <Toggle
          label="Playlist (.m3u8)"
          hint="Preserves the running order in players that sort alphabetically."
          checked={settings.writeM3u}
          onChange={(next) => setExportSettings({ writeM3u: next })}
        />
        <Toggle
          label="Cue sheet"
          hint="Describes the album as an indexed programme."
          checked={settings.writeCueSheet}
          onChange={(next) => setExportSettings({ writeCueSheet: next })}
        />
      </div>

      <Select
        label="Embedded art size"
        value={String(settings.artMaxEdge)}
        onChange={(event) =>
          setExportSettings({ artMaxEdge: Number(event.target.value) })
        }
        options={[
          { value: '600', label: '600 px · smallest files' },
          { value: '1000', label: '1000 px · recommended' },
          { value: '1400', label: '1400 px' },
          { value: '3000', label: '3000 px · large files' },
        ]}
        hint="Art is duplicated into every track, so the cost multiplies across the album."
      />

      <Divider />

      <div className="tray">
        <div className="tray-core flex flex-col gap-3 p-4">
          <div className="flex items-baseline justify-between">
            <span className="label-tiny">Ready to export</span>
            <span className="numeric text-[11px] text-[var(--text-3)]">
              about {(estimatedBytes / 1024 / 1024).toFixed(0)} MB
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Badge tone="accent">{usable.length} tracks</Badge>
            {reencodeCount > 0 ? (
              <Badge tone="neutral">{reencodeCount} re-encoded</Badge>
            ) : null}
            {usable.length - reencodeCount > 0 ? (
              <Badge tone="ok">{usable.length - reencodeCount} lossless</Badge>
            ) : null}
          </div>

          {unanalysed > 0 ? (
            <div className="flex gap-2 rounded-[var(--radius-inner)] bg-[var(--warning-soft)] px-3 py-2">
              <InfoIcon
                size={13}
                weight="bold"
                className="mt-[3px] shrink-0 text-[var(--warning)]"
              />
              <p className="text-[11.5px] leading-relaxed text-[var(--warning)]">
                {unanalysed} track{unanalysed === 1 ? ' has' : 's have'} not been
                measured yet and will be exported without a level change.
              </p>
            </div>
          ) : null}

          {running ? (
            <div className="flex flex-col gap-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]">
                <div
                  className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
                  style={{
                    width: `${((progress?.completed ?? 0) / Math.max(1, progress?.total ?? 1)) * 100}%`,
                  }}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[11.5px] text-[var(--text-2)]">
                  {progress?.phase === 'packaging'
                    ? 'Writing playlist and report'
                    : progress?.label || 'Starting'}
                </span>
                <span className="numeric shrink-0 text-[11px] text-[var(--text-3)]">
                  {progress?.completed}/{progress?.total}
                </span>
              </div>
              <Button
                size="sm"
                variant="danger"
                icon={<StopCircleIcon size={13} weight="bold" />}
                onPointerDown={() => abortRef.current?.abort()}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              disabled={usable.length === 0}
              onPointerDown={start}
              icon={<FileZipIcon size={16} weight="bold" />}
              trailingIcon={<DownloadSimpleIcon size={14} weight="bold" />}
            >
              Export ZIP
            </Button>
          )}

          {progress?.phase === 'done' ? (
            <p className="rounded-[var(--radius-inner)] bg-[var(--success-soft)] px-3 py-2 text-[11.5px] text-[var(--success)]">
              Export complete. A loudness report is included in the archive.
            </p>
          ) : null}

          {progress?.phase === 'failed' ? (
            <p className="rounded-[var(--radius-inner)] bg-[var(--danger-soft)] px-3 py-2 text-[11.5px] text-[var(--danger)]">
              {progress.error}
            </p>
          ) : null}

          {progress?.phase === 'cancelled' ? (
            <p className="rounded-[var(--radius-inner)] bg-[var(--surface-3)] px-3 py-2 text-[11.5px] text-[var(--text-2)]">
              Export cancelled. The partial archive was discarded.
            </p>
          ) : null}
        </div>
      </div>

      <p
        className={cx(
          'text-[11px] leading-relaxed text-[var(--text-3)]',
        )}
      >
        Files are written straight to the archive as each track finishes, so a large
        album does not have to fit in memory. Where your browser supports it you will
        be asked where to save before the export starts.
      </p>
    </div>
  );
}
