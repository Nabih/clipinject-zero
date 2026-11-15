/**
 * What the buffer actually holds. Every number is measured, not estimated: one
 * buffered range means the edit has no hole in it.
 */

import { useProject } from '../state/project';

export function Hud() {
  const status = useProject((state) => state.status);
  const main = useProject((state) => state.main);
  const plan = useProject((state) => state.plan);

  const rows: [string, string][] = [];
  if (status) {
    rows.push(['mime', status.mime]);
    rows.push([
      'buffered',
      status.buffered.length
        ? status.buffered.map(([from, to]) => `${from.toFixed(2)}–${to.toFixed(2)}s`).join(', ')
        : 'empty',
    ]);
    rows.push(['gaps', String(Math.max(0, status.buffered.length - 1))]);
    rows.push(['appended through', `${status.appendedThrough.toFixed(2)}s`]);
    rows.push(['fragments', String(status.fragments)]);
    rows.push(['bytes appended', `${(status.bytesAppended / 1024).toFixed(0)} KB`]);
    rows.push([
      'silence frames',
      `${status.silenceFrames} (${((status.silenceFrames * 1024) / 48000 * 1000).toFixed(0)} ms)`,
    ]);
  } else {
    rows.push(['—', 'nothing appended yet']);
  }
  if (plan?.snaps?.length) {
    const worst = plan.snaps.reduce(
      (max: any, snap: any) => (Math.abs(snap.drift) > Math.abs(max.drift) ? snap : max),
      plan.snaps[0],
    );
    rows.push(['worst snap drift', `${Math.round(worst.drift * 1000)} ms`]);
  }

  return (
    <section className="panel">
      <h2>Buffer</h2>
      <dl className="hud">
        {rows.map(([term, value]) => (
          <div key={term} className="hud-row">
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {!main ? <p className="muted">Load a main video first.</p> : null}
    </section>
  );
}
