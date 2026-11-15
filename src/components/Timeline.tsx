/**
 * The edit, drawn to scale: main segments in blue, clips in amber, plus a playhead.
 *
 * Positions come straight from the plan's virtual times, so what is drawn is what
 * the buffer contains — including the drift from snapping an insert to a sync
 * sample.
 */

import { useProject } from '../state/project';

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00.00';
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(2).padStart(5, '0')}`;
}

export function Timeline({ currentTime, onSeek }: { currentTime: number; onSeek: (t: number) => void }) {
  const plan = useProject((state) => state.plan);
  const main = useProject((state) => state.main);

  if (!main) {
    return (
      <section className="panel">
        <h2>Timeline</h2>
        <div className="strip">
          <div className="strip-empty muted">Load a main video to build the edit.</div>
        </div>
      </section>
    );
  }

  const duration = plan?.duration ?? main.duration;
  const clipTime = (plan?.segments ?? [])
    .filter((segment: any) => segment.kind === 'clip')
    .reduce((total: number, segment: any) => total + (segment.virtOut - segment.virtIn), 0);

  return (
    <section className="panel">
      <h2>
        Timeline{' '}
        <span className="muted">
          {clipTime.toFixed(2)}s of clips in {fmt(duration)}
        </span>
      </h2>
      <div
        className="strip"
        role="slider"
        aria-label="seek"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={currentTime}
        tabIndex={0}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onSeek(((event.clientX - rect.left) / rect.width) * duration);
        }}
      >
        {(plan?.segments ?? []).map((segment: any, index: number) => {
          const left = (segment.virtIn / duration) * 100;
          const width = ((segment.virtOut - segment.virtIn) / duration) * 100;
          return (
            <div
              key={`${segment.insertId ?? 'main'}-${index}`}
              className={`block ${segment.kind}`}
              style={{ left: `${left}%`, width: `${Math.max(width, 0.15)}%` }}
              title={`${segment.kind} ${segment.srcIn.toFixed(2)}–${segment.srcOut.toFixed(2)}s at ${segment.virtIn.toFixed(2)}s`}
            >
              <span className="label">{segment.kind === 'clip' ? segment.asset.name : ''}</span>
            </div>
          );
        })}
        <div className="playhead" style={{ left: `${(currentTime / duration) * 100}%` }} />
      </div>
      <div className="legend muted">
        <span>
          <span className="swatch main" /> main
        </span>
        <span>
          <span className="swatch clip" /> clip
        </span>
        <span>
          <span className="swatch gap" /> re-appended after an edit
        </span>
      </div>
    </section>
  );
}
