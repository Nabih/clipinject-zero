import { useEffect, useState } from 'react';
import type { IndexedAsset } from '../lib/media/types';
import { formatTime, parseTime } from '../lib/timeline/map';
import type { Insertion, Timeline } from '../lib/timeline/types';

interface Props {
  insertions: Insertion[];
  assets: Map<string, IndexedAsset>;
  timeline: Timeline | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onSetAt: (id: string, atMainTime: number) => void;
  onUpdate: (id: string, patch: Partial<Insertion>) => void;
  onRemove: (id: string) => void;
  onSeek: (virtualTime: number) => void;
}

export function InsertList({
  insertions,
  assets,
  timeline,
  selectedId,
  onSelect,
  onSetAt,
  onUpdate,
  onRemove,
  onSeek,
}: Props) {
  if (!insertions.length) {
    return <p className="empty">No insertions yet. Drop a clip, then press Insert.</p>;
  }

  const sorted = [...insertions].sort((a, b) => a.snappedMainTime - b.snappedMainTime);

  return (
    <div>
      {sorted.map((ins, index) => {
        const clip = assets.get(ins.clipId);
        const segment = timeline?.segments.find((s) => s.insertionId === ins.id);
        const drift = ins.atMainTime - ins.snappedMainTime;
        const cuts = clip?.meta.cutPoints ?? [];
        const duration = (ins.outPoint - ins.inPoint).toFixed(2);

        return (
          <div
            key={ins.id}
            className={`insert${selectedId === ins.id ? ' clip-seg' : ''}`}
            onPointerDown={() => onSelect(ins.id)}
          >
            <div className="insert-head">
              <span className="chip">#{index + 1}</span>
              <span className="insert-title" title={clip?.meta.name}>
                {clip?.meta.name ?? 'missing clip'}
              </span>
              <span className="chip">{duration}s</span>
              {segment && (
                <button
                  className="icon-btn"
                  title="Jump to this clip"
                  onClick={() => onSeek(segment.virtIn + 0.01)}
                >
                  ▸
                </button>
              )}
              <button className="icon-btn" title="Remove" onClick={() => onRemove(ins.id)}>
                ×
              </button>
            </div>

            <div className="insert-grid">
              <div>
                <label>Insert at (main)</label>
                <TimeField value={ins.atMainTime} onCommit={(seconds) => onSetAt(ins.id, seconds)} />
              </div>
              <div>
                <label>Snapped</label>
                <div className="snap" style={{ padding: '5px 0' }}>
                  {formatTime(ins.snappedMainTime, true)}{' '}
                  {Math.abs(drift) > 0.01 ? (
                    <span className="off">({drift > 0 ? '+' : ''}{drift.toFixed(2)}s)</span>
                  ) : (
                    <span style={{ color: 'var(--dim)' }}>exact</span>
                  )}
                </div>
              </div>
              <div>
                <label>In point</label>
                <CutSelect
                  value={ins.inPoint}
                  cuts={cuts}
                  max={ins.outPoint}
                  onChange={(v) => onUpdate(ins.id, { inPoint: v })}
                />
              </div>
              <div>
                <label>Out point</label>
                <CutSelect
                  value={ins.outPoint}
                  cuts={cuts}
                  min={ins.inPoint}
                  onChange={(v) => onUpdate(ins.id, { outPoint: v })}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TimeField({ value, onCommit }: { value: number; onCommit: (seconds: number) => void }) {
  const [text, setText] = useState(() => formatTime(value, true));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(formatTime(value, true));
  }, [value, focused]);

  const commit = () => {
    const parsed = parseTime(text);
    if (parsed === null) {
      setText(formatTime(value, true));
      return;
    }
    onCommit(parsed);
  };

  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === 'Escape') {
          setText(formatTime(value, true));
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function CutSelect({
  value,
  cuts,
  min = 0,
  max = Number.POSITIVE_INFINITY,
  onChange,
}: {
  value: number;
  cuts: number[];
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  const options = cuts.filter((c) => c >= min - 1e-6 && c <= max + 1e-6);
  const list = options.length ? options : [value];

  return (
    <select className="select" value={String(value)} onChange={(e) => onChange(Number(e.target.value))}>
      {list.map((cut) => (
        <option key={cut} value={cut}>
          {formatTime(cut, true)}
        </option>
      ))}
    </select>
  );
}
