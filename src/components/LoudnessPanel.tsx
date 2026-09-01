/**
 * Normalization controls and the loudness report.
 *
 * The panel states plainly what will happen and why, because the whole point of
 * measuring is that the user should not have to take the result on faith. Where
 * a track cannot reach the target cleanly, it says so and says by how much.
 */

import {
  ArrowsInLineVerticalIcon,
  GaugeIcon,
  InfoIcon,
  SpeakerHighIcon,
  WarningIcon,
} from '@phosphor-icons/react';

import {
  Badge,
  Button,
  Divider,
  ScaleMeter,
  SectionTitle,
  Segmented,
  Select,
  Stat,
  Toggle,
} from './ui.tsx';
import { useStore } from '../state/store.ts';
import { LOUDNESS_TARGETS, type NormalizationPlan } from '../lib/export/plan.ts';
import { formatDb, formatGain } from '../lib/util/format.ts';
import type { Track } from '../types.ts';

interface LoudnessPanelProps {
  tracks: Track[];
  plan: NormalizationPlan;
}

export function LoudnessPanel({ tracks, plan }: LoudnessPanelProps) {
  const normalization = useStore((state) => state.normalization);
  const setNormalization = useStore((state) => state.setNormalization);
  const analyzeAll = useStore((state) => state.analyzeAll);

  const analysed = tracks.filter((track) => track.loudness);
  const pending = tracks.filter(
    (track) => !track.loudness && track.status !== 'failed',
  ).length;

  const preset = LOUDNESS_TARGETS.find((target) => target.id === normalization.targetId);

  // Tracks that will not reach the target, and tracks that need limiting.
  const shortfalls = [...plan.tracks.values()].filter(
    (entry) => entry.shortfallDb > 0.5,
  );
  const quantised = [...plan.tracks.values()].filter(
    (entry) => entry.quantisationDb > 0.1,
  );
  const limited = [...plan.tracks.values()].filter((entry) => entry.willLimit);
  const lossless = [...plan.tracks.values()].filter((entry) => entry.lossless);

  // The effective gain, not the requested one: on the lossless path the value
  // is quantised, and showing the request would promise a level we do not hit.
  const projectedAlbum =
    Number.isFinite(plan.albumLoudness) && normalization.enabled
      ? plan.albumLoudness + plan.albumEffectiveGainDb
      : plan.albumLoudness;

  const worstDr = analysed.reduce(
    (lowest, track) =>
      track.loudness && track.loudness.dynamicRange > 0
        ? Math.min(lowest, track.loudness.dynamicRange)
        : lowest,
    Infinity,
  );

  return (
    <div className="flex flex-col gap-5">
      <Toggle
        label="Normalize loudness"
        hint="Bakes the level into the exported files, so it works in players that ignore loudness tags."
        checked={normalization.enabled}
        onChange={(next) => setNormalization({ enabled: next })}
      />

      <Select
        label="Target"
        value={normalization.targetId}
        onChange={(event) =>
          setNormalization({
            targetId: event.target.value as typeof normalization.targetId,
          })
        }
        options={[
          ...LOUDNESS_TARGETS.map((target) => ({
            value: target.id,
            label: `${target.label} · ${target.lufs} LUFS`,
          })),
          { value: 'custom', label: 'Custom' },
        ]}
        hint={preset?.description}
      />

      {normalization.targetId === 'custom' ? (
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="label-tiny">Target LUFS</span>
            <input
              type="number"
              step={0.5}
              value={normalization.targetLufs}
              onChange={(event) =>
                setNormalization({ targetLufs: Number(event.target.value) })
              }
              className="numeric h-9 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-[13.5px] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label-tiny">Peak ceiling dBTP</span>
            <input
              type="number"
              step={0.5}
              value={normalization.truePeakCeiling}
              onChange={(event) =>
                setNormalization({ truePeakCeiling: Number(event.target.value) })
              }
              className="numeric h-9 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-[13.5px] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
        </div>
      ) : null}

      <Segmented
        label="Mode"
        value={normalization.mode}
        onChange={(mode) => setNormalization({ mode })}
        options={[
          {
            value: 'album',
            label: 'Album',
            title: 'One gain across the release, preserving the relative levels between tracks',
          },
          {
            value: 'track',
            label: 'Per track',
            title: 'Every track hits the target individually',
          },
        ]}
      />

      <p className="-mt-1 text-[11.5px] leading-relaxed text-[var(--text-3)]">
        {normalization.mode === 'album'
          ? 'One gain for the whole album, so a quiet interlude stays quieter than the closer. This is also how Spotify normalizes its own catalogue.'
          : 'Each track is brought to the target on its own. Right for a playlist of unrelated songs, wrong for an album that was mixed as a whole.'}
      </p>

      <Segmented
        label="When a track would clip"
        value={normalization.preferGainReduction ? 'reduce' : 'limit'}
        onChange={(choice) =>
          setNormalization({ preferGainReduction: choice === 'reduce' })
        }
        options={[
          { value: 'limit', label: 'Limit peaks', title: 'Hit the target and hold the peaks back' },
          { value: 'reduce', label: 'Stay quieter', title: 'Never limit; land below target instead' },
        ]}
      />

      <Toggle
        label="Write ReplayGain tags"
        hint="Costs nothing and helps players that do their own normalization."
        checked={normalization.writeReplayGainTags}
        onChange={(next) => setNormalization({ writeReplayGainTags: next })}
      />

      <Divider />

      <SectionTitle
        action={
          pending > 0 ? (
            <Badge tone="accent">{pending} pending</Badge>
          ) : (
            <Button size="sm" variant="ghost" onPointerDown={() => analyzeAll(true)}>
              Re-analyse
            </Button>
          )
        }
      >
        Album measurement
      </SectionTitle>

      <div className="tray">
        <div className="tray-core flex flex-col gap-4 p-4">
          <div className="grid grid-cols-3 gap-3">
            <Stat
              label="Measured"
              value={formatDb(plan.albumLoudness)}
              unit="LUFS"
              hint="Duration-weighted loudness of the whole album as imported"
            />
            <Stat
              label="Gain"
              value={normalization.enabled ? formatGain(plan.albumEffectiveGainDb) : '0.0'}
              unit="dB"
              tone={Math.abs(plan.albumEffectiveGainDb) > 0.05 ? 'accent' : 'neutral'}
              hint="The gain actually applied, after rounding to whole lossless steps"
            />
            <Stat
              label="Result"
              value={formatDb(projectedAlbum)}
              unit="LUFS"
              tone={
                normalization.enabled &&
                Math.abs(projectedAlbum - normalization.targetLufs) < 0.8
                  ? 'ok'
                  : 'neutral'
              }
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <ScaleMeter
              value={projectedAlbum}
              min={-30}
              max={-5}
              target={normalization.targetLufs}
              tone={
                Math.abs(projectedAlbum - normalization.targetLufs) < 0.6 ? 'ok' : 'accent'
              }
            />
            <div className="flex justify-between text-[10px] text-[var(--text-3)]">
              <span className="numeric">-30</span>
              <span>quieter · louder</span>
              <span className="numeric">-5</span>
            </div>
          </div>
        </div>
      </div>

      {/* What the export will actually do, stated plainly. */}
      <div className="flex flex-col gap-2">
        {lossless.length > 0 ? (
          <Note tone="ok" icon={<SpeakerHighIcon size={13} weight="fill" />}>
            {lossless.length} of {plan.tracks.size} tracks will be adjusted without
            re-encoding, so their audio is unchanged apart from the level.
          </Note>
        ) : null}

        {limited.length > 0 ? (
          <Note tone="warn" icon={<ArrowsInLineVerticalIcon size={13} weight="bold" />}>
            {limited.length} track{limited.length === 1 ? '' : 's'} will be peak
            limited to stay under {normalization.truePeakCeiling} dBTP. Switch to
            "Stay quieter" if you would rather keep the peaks untouched.
          </Note>
        ) : null}

        {shortfalls.length > 0 ? (
          <Note tone="warn" icon={<WarningIcon size={13} weight="fill" />}>
            {shortfalls.length} track{shortfalls.length === 1 ? '' : 's'} will land
            up to {Math.max(...shortfalls.map((entry) => entry.shortfallDb)).toFixed(1)} dB
            below target because there is not enough peak headroom.
          </Note>
        ) : null}

        {quantised.length > 0 ? (
          <Note tone="neutral" icon={<InfoIcon size={13} weight="bold" />}>
            A lossless level change moves in 1.5 dB steps, so the result lands
            within {Math.max(...quantised.map((entry) => entry.quantisationDb)).toFixed(2)} dB
            of the target rather than exactly on it. That is the cost of not
            re-encoding, and it is far below what anyone can hear.
          </Note>
        ) : null}

        {Number.isFinite(worstDr) && worstDr < 7 ? (
          <Note tone="warn" icon={<GaugeIcon size={13} weight="bold" />}>
            The quietest dynamic range here is DR{Math.round(worstDr)}. That is a
            heavily compressed master, and turning it up will not make it sound
            better, only louder.
          </Note>
        ) : null}

        {normalization.enabled && plan.tracks.size === 0 ? (
          <Note tone="neutral" icon={<InfoIcon size={13} weight="bold" />}>
            Analysis has not finished yet. Figures appear as each track is measured.
          </Note>
        ) : null}
      </div>

      <Divider />

      <SectionTitle>Per track</SectionTitle>
      <div className="tray">
        <div className="tray-core overflow-hidden">
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="border-b border-[var(--hairline)] bg-[var(--surface-2)] text-[10px] text-[var(--text-3)]">
                <th className="px-2.5 py-1.5 text-left font-semibold">Track</th>
                <th className="px-1.5 py-1.5 text-right font-semibold">LRA</th>
                <th className="px-1.5 py-1.5 text-right font-semibold">DR</th>
                <th className="px-1.5 py-1.5 text-right font-semibold">Peak in</th>
                <th className="px-2.5 py-1.5 text-right font-semibold">Clipped</th>
              </tr>
            </thead>
            <tbody>
              {analysed.map((track) => (
                <tr key={track.id} className="border-b border-[var(--hairline)] last:border-0">
                  <td className="max-w-0 truncate px-2.5 py-1.5 text-[var(--text-2)]">
                    {track.tags.title || track.fileName}
                  </td>
                  <td className="numeric px-1.5 py-1.5 text-right text-[var(--text-2)]">
                    {formatDb(track.loudness?.range)}
                  </td>
                  <td className="numeric px-1.5 py-1.5 text-right text-[var(--text-2)]">
                    {track.loudness && track.loudness.dynamicRange > 0
                      ? Math.round(track.loudness.dynamicRange)
                      : '-'}
                  </td>
                  <td className="numeric px-1.5 py-1.5 text-right text-[var(--text-2)]">
                    {formatDb(track.loudness?.truePeak)}
                  </td>
                  <td
                    className={
                      'numeric px-2.5 py-1.5 text-right ' +
                      ((track.loudness?.clippedSamples ?? 0) > 100
                        ? 'text-[var(--danger)]'
                        : 'text-[var(--text-3)]')
                    }
                  >
                    {track.loudness?.clippedSamples.toLocaleString() ?? '-'}
                  </td>
                </tr>
              ))}
              {analysed.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-2.5 py-6 text-center text-[var(--text-3)]">
                    Nothing measured yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--text-3)]">
        LRA is loudness range in LU. DR is a crest-based dynamic range figure, where
        lower means more compressed. Peak is true peak in dBTP, measured with 4x
        oversampling, which catches peaks that fall between samples and would clip on
        playback despite no stored sample reaching full scale.
      </p>
    </div>
  );
}

function Note({
  tone, icon, children,
}: {
  tone: 'ok' | 'warn' | 'neutral';
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const styles = {
    ok: 'bg-[var(--success-soft)] text-[var(--success)]',
    warn: 'bg-[var(--warning-soft)] text-[var(--warning)]',
    neutral: 'bg-[var(--surface-3)] text-[var(--text-2)]',
  }[tone];

  return (
    <div className={`flex gap-2 rounded-[var(--radius-inner)] px-3 py-2 ${styles}`}>
      <span className="mt-[3px] shrink-0">{icon}</span>
      <p className="text-[11.5px] leading-relaxed">{children}</p>
    </div>
  );
}
