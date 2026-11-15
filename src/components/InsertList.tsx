/**
 * The insert list: what was asked for, where it actually lands, and the drift.
 *
 * Snapping to a sync sample is a real trade, so it is shown rather than swallowed.
 */

import { useProject } from '../state/project';

export function InsertList() {
  const inserts = useProject((state) => state.inserts);
  const plan = useProject((state) => state.plan);
  const removeInsert = useProject((state) => state.removeInsert);

  const snaps = new Map<string, any>((plan?.snaps ?? []).map((snap: any) => [snap.insertId, snap]));
  const ordered = [...inserts].sort(
    (a, b) => (snaps.get(a.id)?.snapped ?? 0) - (snaps.get(b.id)?.snapped ?? 0),
  );

  return (
    <section className="panel">
      <h2>Inserts</h2>
      {ordered.length === 0 ? (
        <p className="muted">No inserts yet. Add a clip, then insert it at a time.</p>
      ) : (
        <div className="library">
          {ordered.map((insert) => {
            const snap = snaps.get(insert.id);
            const drift = Math.round((snap?.drift ?? 0) * 1000);
            return (
              <div className="item" key={insert.id}>
                <span className="name">{insert.asset.name}</span>
                <span className="meta">
                  asked {insert.atMainTime.toFixed(2)}s → {Math.max(0, snap?.snapped ?? 0).toFixed(2)}s
                </span>
                <span className={`drift${Math.abs(drift) > 500 ? ' bad' : ''}`}>
                  {drift > 0 ? '+' : ''}
                  {drift} ms
                </span>
                <button type="button" className="tiny" onClick={() => removeInsert(insert.id)}>
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
