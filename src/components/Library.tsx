import { useRef, useState } from 'react';
import type { IndexedAsset } from '../lib/media/types';
import { formatTime } from '../lib/timeline/map';
import type { AssetKind } from '../lib/timeline/types';

interface Props {
  main: IndexedAsset | null;
  clips: IndexedAsset[];
  busy: { label: string; progress: number } | null;
  playheadMainTime: number;
  onFiles: (files: File[], kind: AssetKind) => void;
  onRemove: (id: string) => void;
  onInsert: (clipId: string) => void;
}

export function Library({ main, clips, busy, playheadMainTime, onFiles, onRemove, onInsert }: Props) {
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Main video</h2>
          {main && <span className="chip accent">active</span>}
        </div>
        <div className="panel-body">
          {main ? (
            <>
              <AssetRow asset={main} onRemove={() => onRemove(main.meta.id)} main />
              <div style={{ marginTop: 9 }}>
                <DropZone
                  kind="main"
                  label="Replace main video"
                  hint="one long-form MP4"
                  onFiles={onFiles}
                  compact
                />
              </div>
            </>
          ) : (
            <DropZone kind="main" label="Drop the main video" hint="one long-form MP4" onFiles={onFiles} />
          )}
          {busy && (
            <div>
              <div className="progress">
                <i style={{ width: `${Math.round(busy.progress * 100)}%` }} />
              </div>
              <div className="hint" style={{ marginTop: 6, marginBottom: 0 }}>
                Indexing {busy.label} · {Math.round(busy.progress * 100)}%
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Clips</h2>
          <span className="chip">{clips.length}</span>
        </div>
        <div className="panel-body">
          {clips.length === 0 && <p className="hint">No clips yet. Add the short MP4s you want to inject.</p>}
          {clips.map((clip) => (
            <AssetRow
              key={clip.meta.id}
              asset={clip}
              onRemove={() => onRemove(clip.meta.id)}
              onInsert={main ? () => onInsert(clip.meta.id) : undefined}
              insertLabel={formatTime(playheadMainTime, true)}
            />
          ))}
          <div style={{ marginTop: clips.length ? 9 : 0 }}>
            <DropZone kind="clip" label="Drop clips" hint="any number of MP4s" onFiles={onFiles} multiple compact />
          </div>
          {main && <p className="hint" style={{ marginTop: 9, marginBottom: 0 }}>
            Insert lands at the playhead ({formatTime(playheadMainTime, true)}) snapped to the nearest cut.
          </p>}
        </div>
      </section>
    </>
  );
}

function AssetRow({
  asset,
  main,
  onRemove,
  onInsert,
  insertLabel,
}: {
  asset: IndexedAsset;
  main?: boolean;
  onRemove: () => void;
  onInsert?: () => void;
  insertLabel?: string;
}) {
  const { meta } = asset;
  return (
    <div className={`asset${main ? ' asset-main' : ''}`}>
      <div className="asset-info">
        <div className="asset-name" title={meta.name}>
          {meta.name}
        </div>
        <div className="asset-meta">
          {formatTime(meta.duration, true)} · {meta.video.width}×{meta.video.height} ·{' '}
          {meta.video.codec.replace(/^avc1\./, 'avc1.')} · {meta.audio ? `${meta.audio.channels}ch` : 'no audio'}
        </div>
      </div>
      {onInsert && (
        <button className="btn primary" onClick={onInsert} title={`Insert at ${insertLabel}`}>
          Insert
        </button>
      )}
      <button className="icon-btn" onClick={onRemove} title="Remove">
        ×
      </button>
    </div>
  );
}

function DropZone({
  kind,
  label,
  hint,
  onFiles,
  multiple,
  compact,
}: {
  kind: AssetKind;
  label: string;
  hint: string;
  onFiles: (files: File[], kind: AssetKind) => void;
  multiple?: boolean;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const take = (list: FileList | null) => {
    if (!list?.length) return;
    const files = [...list].filter((f) => /\.(mp4|m4v|mov)$/i.test(f.name) || f.type.startsWith('video/'));
    if (files.length) onFiles(files, kind);
  };

  return (
    <div
      className={`slot${drag ? ' drag' : ''}`}
      style={compact ? { padding: '9px 10px', fontSize: 11.5 } : undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        take(e.dataTransfer.files);
      }}
      onClick={() => input.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') input.current?.click();
      }}
    >
      {compact ? label : <strong>{label}</strong>}
      <div style={{ fontSize: 10.5, marginTop: compact ? 0 : 3 }}>{compact ? hint : `Drag & drop or click · ${hint}`}</div>
      <input
        ref={input}
        type="file"
        accept="video/mp4,video/quicktime,.mp4,.m4v,.mov"
        multiple={multiple}
        hidden
        onChange={(e) => {
          take(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
