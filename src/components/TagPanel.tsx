/**
 * Tag editing.
 *
 * Edits apply to every selected track at once. Where the selection disagrees on
 * a field the box shows "Multiple values" and stays empty until you type, so a
 * bulk edit can never silently flatten twelve different titles into one.
 */

import { useMemo, useState } from 'react';
import {
  ArrowsClockwiseIcon,
  FolderPlusIcon,
  MagicWandIcon,
  TextAaIcon,
  UserSoundIcon,
} from '@phosphor-icons/react';

import {
  Button,
  Divider,
  Field,
  NumberField,
  SectionTitle,
  Select,
  TextArea,
  Toggle,
  cx,
} from './ui.tsx';
import { useStore } from '../state/store.ts';
import { splitFeatured, toTitleCase } from '../lib/filename/parse.ts';
import type { Track, TrackTags } from '../types.ts';

/** The shared value of a field across a selection, or null when they differ. */
function sharedValue<K extends keyof TrackTags>(
  tracks: Track[],
  key: K,
): TrackTags[K] | null {
  if (tracks.length === 0) return null;
  const first = tracks[0].tags[key];
  return tracks.every((track) => track.tags[key] === first) ? first : null;
}

interface TagPanelProps {
  selection: Track[];
  albumTracks: Track[];
}

export function TagPanel({ selection, albumTracks }: TagPanelProps) {
  const updateTags = useStore((state) => state.updateTags);
  const renumberAlbum = useStore((state) => state.renumberAlbum);
  const activeAlbumId = useStore((state) => state.activeAlbumId);
  const albums = useStore((state) => state.albums);
  const moveTracksToAlbum = useStore((state) => state.moveTracksToAlbum);
  const moveTracksToNewAlbum = useStore((state) => state.moveTracksToNewAlbum);

  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [replaceField, setReplaceField] = useState<'title' | 'artist' | 'album'>('title');

  const targets = selection.length > 0 ? selection : albumTracks;
  const ids = useMemo(() => targets.map((track) => track.id), [targets]);
  const multiple = targets.length > 1;

  const value = <K extends keyof TrackTags>(key: K) => sharedValue(targets, key);
  const text = (key: keyof TrackTags): string => {
    const shared = value(key);
    return typeof shared === 'string' ? shared : '';
  };
  const number = (key: keyof TrackTags): number => {
    const shared = value(key);
    return typeof shared === 'number' ? shared : 0;
  };
  const isMixed = (key: keyof TrackTags) => value(key) === null && multiple;

  const set = (patch: Partial<TrackTags>) => updateTags(ids, patch);

  /** Apply a transform to one field on every target track individually. */
  const transformEach = (
    key: 'title' | 'artist' | 'album' | 'albumArtist',
    transform: (input: string) => string,
  ) => {
    for (const track of targets) {
      const next = transform(track.tags[key]);
      if (next !== track.tags[key]) updateTags([track.id], { [key]: next });
    }
  };

  /** Move "feat. X" out of the artist field and into the title. */
  const normaliseFeatures = () => {
    for (const track of targets) {
      const split = splitFeatured(track.tags.artist);
      if (!split) continue;
      const alreadyInTitle = /\bfeat\.?\b/i.test(track.tags.title);
      updateTags([track.id], {
        artist: split.base,
        title: alreadyInTitle
          ? track.tags.title
          : `${track.tags.title} (feat. ${split.featured})`,
      });
    }
  };

  const findAndReplace = () => {
    if (!findText) return;
    for (const track of targets) {
      const current = track.tags[replaceField];
      if (!current.includes(findText)) continue;
      updateTags([track.id], {
        [replaceField]: current.split(findText).join(replaceText),
      });
    }
  };

  if (targets.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-[12.5px] text-[var(--text-3)]">
        Import tracks to start editing metadata.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-[var(--radius-inner)] bg-[var(--accent-softer)] px-3 py-2">
        <p className="text-[11.5px] leading-snug text-[var(--text-2)]">
          {selection.length === 0
            ? `Editing all ${albumTracks.length} tracks in this album.`
            : selection.length === 1
              ? 'Editing one track.'
              : `Editing ${selection.length} selected tracks.`}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <Field
          label="Title"
          value={text('title')}
          mixed={isMixed('title')}
          onChange={(event) => set({ title: event.target.value })}
        />
        <Field
          label="Artist"
          value={text('artist')}
          mixed={isMixed('artist')}
          onChange={(event) => set({ artist: event.target.value })}
        />
        <Field
          label="Album artist"
          value={text('albumArtist')}
          mixed={isMixed('albumArtist')}
          onChange={(event) => set({ albumArtist: event.target.value })}
          hint="Set this to the same value on every track, or the album splits apart in most libraries."
        />
        <Field
          label="Album"
          value={text('album')}
          mixed={isMixed('album')}
          onChange={(event) => set({ album: event.target.value })}
        />
      </div>

      <Divider />

      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Track"
          value={number('track')}
          mixed={isMixed('track')}
          onValueChange={(next) => set({ track: next })}
        />
        <NumberField
          label="of"
          value={number('trackTotal')}
          mixed={isMixed('trackTotal')}
          onValueChange={(next) => set({ trackTotal: next })}
        />
        <NumberField
          label="Disc"
          value={number('disc')}
          mixed={isMixed('disc')}
          onValueChange={(next) => set({ disc: next })}
        />
        <NumberField
          label="of"
          value={number('discTotal')}
          mixed={isMixed('discTotal')}
          onValueChange={(next) => set({ discTotal: next })}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Year"
          value={text('year')}
          mixed={isMixed('year')}
          maxLength={4}
          className="numeric"
          onChange={(event) => set({ year: event.target.value.replace(/\D/g, '') })}
        />
        <Field
          label="Genre"
          value={text('genre')}
          mixed={isMixed('genre')}
          onChange={(event) => set({ genre: event.target.value })}
        />
      </div>

      <Toggle
        label="Compilation"
        hint="Marks the release as various artists, so players keep it together."
        checked={value('compilation') === true}
        onChange={(next) => set({ compilation: next })}
      />

      <Divider />

      <SectionTitle>Grouping</SectionTitle>
      <p className="-mt-2 text-[11.5px] leading-relaxed text-[var(--text-3)]">
        Which album these tracks belong to. This is what decides how a player
        groups them, so a stray track here is why an album shows up split in two.
      </p>
      <div className="flex flex-col gap-2">
        <Select
          label="Move to album"
          value={activeAlbumId ?? ''}
          onChange={(event) => {
            if (event.target.value) moveTracksToAlbum(ids, event.target.value);
          }}
          options={[
            ...albums.map((album) => ({
              value: album.id,
              label: `${album.name || 'Unknown Album'} (${album.trackIds.length})`,
            })),
          ]}
        />
        <Button
          size="sm"
          icon={<FolderPlusIcon size={13} weight="bold" />}
          onPointerDown={() => {
            const first = targets[0];
            moveTracksToNewAlbum(
              ids,
              first?.tags.album || 'New Album',
              first?.tags.albumArtist || first?.tags.artist || 'Unknown Artist',
            );
          }}
        >
          Split into a new album
        </Button>
      </div>

      <Divider />

      <SectionTitle>Batch tools</SectionTitle>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          icon={<TextAaIcon size={13} weight="bold" />}
          onPointerDown={() => {
            transformEach('title', toTitleCase);
            transformEach('artist', toTitleCase);
          }}
          title="Capitalise titles and artists, leaving deliberate casing alone"
        >
          Title case
        </Button>
        <Button
          size="sm"
          icon={<UserSoundIcon size={13} weight="bold" />}
          onPointerDown={normaliseFeatures}
          title="Move featured artists out of the artist field and into the title"
        >
          Fix featured
        </Button>
        {activeAlbumId ? (
          <Button
            size="sm"
            icon={<ArrowsClockwiseIcon size={13} weight="bold" />}
            onPointerDown={() => renumberAlbum(activeAlbumId)}
            title="Number tracks 1..n in their current order and set the totals"
          >
            Renumber
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 rounded-[var(--radius-inner)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <span className="label-tiny">Find and replace</span>
        <div className="flex gap-2">
          {(['title', 'artist', 'album'] as const).map((field) => (
            <button
              key={field}
              type="button"
              onPointerDown={() => setReplaceField(field)}
              className={cx(
                'rounded-md px-2 py-1 text-[11.5px] font-medium capitalize transition-colors',
                replaceField === field
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--surface-3)] text-[var(--text-2)] hover:text-[var(--text)]',
              )}
            >
              {field}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input
            value={findText}
            onChange={(event) => setFindText(event.target.value)}
            placeholder="Find"
            className="h-8 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-2 text-[12.5px] focus:border-[var(--accent)] focus:outline-none"
          />
          <input
            value={replaceText}
            onChange={(event) => setReplaceText(event.target.value)}
            placeholder="Replace with"
            className="h-8 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-2 text-[12.5px] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={!findText}
          onPointerDown={findAndReplace}
          icon={<MagicWandIcon size={13} weight="bold" />}
        >
          Replace in {targets.length} track{targets.length === 1 ? '' : 's'}
        </Button>
      </div>

      <Divider />

      <SectionTitle>Catalogue</SectionTitle>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="ISRC"
            value={text('isrc')}
            mixed={isMixed('isrc')}
            onChange={(event) => set({ isrc: event.target.value.toUpperCase() })}
          />
          <Field
            label="Barcode"
            value={text('barcode')}
            mixed={isMixed('barcode')}
            className="numeric"
            onChange={(event) => set({ barcode: event.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Label"
            value={text('publisher')}
            mixed={isMixed('publisher')}
            onChange={(event) => set({ publisher: event.target.value })}
          />
          <Field
            label="Catalogue no."
            value={text('catalogNumber')}
            mixed={isMixed('catalogNumber')}
            onChange={(event) => set({ catalogNumber: event.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Composer"
            value={text('composer')}
            mixed={isMixed('composer')}
            onChange={(event) => set({ composer: event.target.value })}
          />
          <NumberField
            label="BPM"
            value={number('bpm')}
            mixed={isMixed('bpm')}
            onValueChange={(next) => set({ bpm: next })}
          />
        </div>
      </div>

      <Divider />

      <SectionTitle>Sort order</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Sort artist"
          value={text('sortArtist')}
          mixed={isMixed('sortArtist')}
          placeholder="Beatles, The"
          onChange={(event) => set({ sortArtist: event.target.value })}
        />
        <Field
          label="Sort album artist"
          value={text('sortAlbumArtist')}
          mixed={isMixed('sortAlbumArtist')}
          onChange={(event) => set({ sortAlbumArtist: event.target.value })}
        />
      </div>

      <TextArea
        label="Comment"
        rows={2}
        value={text('comment')}
        onChange={(event) => set({ comment: event.target.value })}
      />
      <TextArea
        label="Lyrics"
        rows={4}
        value={text('lyrics')}
        onChange={(event) => set({ lyrics: event.target.value })}
        hint={multiple ? 'Editing lyrics applies the same text to every selected track.' : undefined}
      />
    </div>
  );
}
