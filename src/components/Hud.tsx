import type { PlayerState } from '../lib/engine/types';
import { largestGap } from '../lib/engine/types';
import { formatTimecode, isInClip, toMain } from '../lib/timeline/map';
import type { Timeline } from '../lib/timeline/types';

interface Props {
  engineLabel: string;
  state: PlayerState;
  timeline: Timeline | null;
  audioMode: string;
}

export function Hud({ engineLabel, state, timeline, audioMode }: Props) {
  const mainTime = timeline ? toMain(timeline, state.time) : 0;
  const inClip = timeline ? isInClip(timeline, state.time) : false;
  const gap = largestGap(state.buffered);
  const buffered = state.buffered
    .map((r) => `${formatTimecode(r.start)}–${formatTimecode(r.end)}`)
    .join('  ');

  return (
    <div className="hud">
      <Row label="engine" value={engineLabel} />
      <Row label="virtual" value={formatTimecode(state.time)} />
      <Row label="main" value={`${formatTimecode(mainTime)}${inClip ? '  (in clip)' : ''}`} />
      <Row label="segment" value={state.segmentLabel || '—'} />
      <Row label="buffered" value={`${state.buffered.length} range${state.buffered.length === 1 ? '' : 's'} · ${gap.toFixed(3)}s max gap`} />
      {buffered && <div style={{ color: 'var(--dim)' }}>{buffered}</div>}
      <Row label="queued" value={`${state.appending} appends`} />
      <Row label="audio" value={audioMode} />
      <Row label="error" value={state.lastError ?? 'none'} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
