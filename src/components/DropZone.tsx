/**
 * Import surface.
 *
 * Doubles as the empty state and as a full-window drop target once the project
 * has content, because dragging a folder in is the fastest way to add tracks
 * and should keep working from anywhere in the app.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRightIcon,
  FolderOpenIcon,
  MusicNotesIcon,
  ShieldCheckIcon,
  WaveformIcon,
} from '@phosphor-icons/react';

import { Button, cx } from './ui.tsx';
import { useStore } from '../state/store.ts';

const AUDIO_PATTERN = /\.(mp3|m4a|mp4|m4b|aac|flac|wav|wave|ogg|oga|opus|aiff?|wma)$/i;

/** Pull every file out of a drag, walking into folders when the browser allows. */
async function collectFiles(dataTransfer: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  // Without directory support, fall back to the flat file list.
  if (entries.length === 0) {
    return Array.from(dataTransfer.files).filter((file) => AUDIO_PATTERN.test(file.name));
  }

  const files: File[] = [];

  async function walk(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => {
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
      });
      if (file && AUDIO_PATTERN.test(file.name)) files.push(file);
      return;
    }

    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns at most 100 at a time, so it has to be drained.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) => {
          reader.readEntries(resolve, () => resolve([]));
        });
        if (batch.length === 0) break;
        for (const child of batch) await walk(child);
      }
    }
  }

  for (const entry of entries) await walk(entry);
  return files;
}

/** Window-wide drag handling, so a drop anywhere imports. */
export function useGlobalDrop(): boolean {
  const importFiles = useStore((state) => state.importFiles);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      depth.current += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    const onDragLeave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = async (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = await collectFiles(event.dataTransfer);
      if (files.length > 0) await importFiles(files);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [importFiles]);

  return dragging;
}

/** A hidden input plus a click handler, for the browse path. */
export function useFilePicker(): () => void {
  const importFiles = useStore((state) => state.importFiles);

  return useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'audio/*,.mp3,.m4a,.flac,.wav,.ogg,.opus,.aiff,.aac';
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (files.length > 0) await importFiles(files);
    };
    input.click();
  }, [importFiles]);
}

const CAPABILITIES = [
  {
    icon: WaveformIcon,
    title: 'Measured, not guessed',
    body:
      'Every track is analysed to ITU-R BS.1770-4 for integrated loudness, ' +
      'range, true peak and dynamic range, before and after.',
  },
  {
    icon: MusicNotesIcon,
    title: 'Lossless where it counts',
    body:
      'An MP3 that only needs a level change is adjusted at the frame level. ' +
      'No decode, no re-encode, no generation loss.',
  },
  {
    icon: ShieldCheckIcon,
    title: 'Nothing is uploaded',
    body:
      'Decoding, tagging and packaging all run in this tab. Your audio never ' +
      'leaves the machine.',
  },
];

export function EmptyState() {
  const openPicker = useFilePicker();
  const importProgress = useStore((state) => state.importProgress);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center px-5 py-14 sm:px-8">
      <div className="max-w-2xl">
        <h1 className="display-lg max-w-[15ch] text-[var(--text)]">
          An album, ready for Spotify.
        </h1>
        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-[var(--text-2)]">
          Drop in any audio files. Edit the metadata, set the loudness, and export
          a ZIP that plays correctly everywhere.
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Button
            size="lg"
            variant="primary"
            onPointerDown={openPicker}
            trailingIcon={<ArrowRightIcon size={15} weight="bold" />}
            disabled={importProgress.active}
          >
            {importProgress.active ? 'Importing' : 'Choose files'}
          </Button>
          <span className="text-[13px] text-[var(--text-3)]">
            or drag a folder anywhere on this page
          </span>
        </div>
      </div>

      <div className="mt-12 grid gap-3 md:grid-cols-3">
        {CAPABILITIES.map((item) => (
          <div key={item.title} className="tray">
            <div className="tray-core flex h-full flex-col gap-3 p-4">
              <span
                className="grid size-8 place-items-center rounded-[9px] bg-[var(--accent-soft)]"
                aria-hidden
              >
                <item.icon size={17} weight="regular" className="text-[var(--accent)]" />
              </span>
              <h2 className="text-[13.5px] font-semibold text-[var(--text)]">
                {item.title}
              </h2>
              <p className="text-[12.5px] leading-relaxed text-[var(--text-2)]">
                {item.body}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The overlay shown while a drag is in progress. */
export function DropOverlay({ visible }: { visible: boolean }) {
  return (
    <div
      aria-hidden={!visible}
      className={cx(
        'pointer-events-none fixed inset-0 z-40 grid place-items-center p-8',
        'transition-opacity duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div className="absolute inset-0 bg-[var(--accent-soft)] backdrop-blur-[3px]" />
      <div
        className={cx(
          'relative flex flex-col items-center gap-3 rounded-[20px] border-2 border-dashed',
          'border-[var(--accent)] bg-[var(--surface)] px-12 py-10 shadow-[var(--shadow-lg)]',
          'transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
          visible ? 'scale-100' : 'scale-95',
        )}
      >
        <FolderOpenIcon size={30} weight="light" className="text-[var(--accent)]" />
        <p className="text-[15px] font-semibold text-[var(--text)]">
          Drop to import
        </p>
        <p className="text-[12.5px] text-[var(--text-3)]">
          Folders are read recursively
        </p>
      </div>
    </div>
  );
}
