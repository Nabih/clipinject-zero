import { useEffect, useRef } from 'react';
import type { Marker } from '../state/project';
import { formatTime } from '../lib/timeline/map';
import { lateness } from '../state/markerTrigger';

interface Props {
  marker: Marker;
  /** Horizontal position on the timeline, in percent. */
  leftPct: number;
  /** Place the panel under the timeline instead of over it. */
  below: boolean;
  onUrlChange: (url: string) => void;
  onArm: () => void;
  /** Seconds of head start currently configured, for the armed hint. */
  lead: number;
  onLoad: () => void;
  onRemove: () => void;
  onClose: () => void;
}

const GAP = 6;

/**
 * Pasting a URL into a marker.
 *
 * Positioned inside `.timeline`, not inside `.track` — the track is
 * `overflow: hidden` and would clip it. Horizontal placement is clamped with CSS
 * `clamp()`, so a marker near either edge still gets a fully visible panel
 * without measuring anything in JS.
 */
export function MarkerPopover({ marker, leftPct, below, lead, onUrlChange, onArm, onLoad, onRemove, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const loading = marker.status === 'loading';

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [marker.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={`marker-pop${below ? ' below' : ''}`}
      style={{
        // 320px wide, so 160px is the half-width; keep 8px of air at each end.
        left: `clamp(8px, calc(${leftPct}% - 160px), calc(100% - 328px))`,
        [below ? 'top' : 'bottom']: `calc(100% + ${GAP}px)`,
      }}
      role="dialog"
      aria-label="Marker"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="marker-pop-head">
        <span className="marker-pop-title">Marker</span>
        <span className="hint" style={{ margin: 0 }}>
          {formatTime(marker.snappedMainTime, true)}
        </span>
        <button className="btn btn-icon" onClick={onClose} aria-label="Close marker">
          ×
        </button>
      </div>

      <div className="marker-pop-body">
        <label className="hint" htmlFor={`marker-url-${marker.id}`}>
          Remote video URL
        </label>
        <input
          id={`marker-url-${marker.id}`}
          ref={inputRef}
          className="input"
          type="url"
          inputMode="url"
          spellCheck={false}
          placeholder="https://example.com/clip.mp4"
          value={marker.url}
          disabled={loading}
          onChange={(e) => onUrlChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && marker.url.trim() && !loading) onLoad();
          }}
        />

        {marker.status === 'error' && marker.error && <div className="hint bad">{marker.error}</div>}
        {marker.status === 'deferred' && (
          <div className="hint armed">
            Armed — nothing is downloaded yet. The load starts {lead.toFixed(1)} s before{' '}
            {formatTime(marker.snappedMainTime, true)}.
          </div>
        )}
        {marker.status === 'ready' && (
          <div className="hint ok">
            Loaded at {formatTime(marker.snappedMainTime, true)}.
            {lateness(marker) !== null && ` Fetch + index took ${lateness(marker)!.toFixed(2)} s.`}
            {lateness(marker) === null ? ' Paste another URL to replace it.' : ''}
          </div>
        )}
        {loading && (
          <div className="hint">
            {marker.progress === null ? 'Downloading…' : `Downloading… ${Math.round(marker.progress * 100)}%`}
          </div>
        )}

        <div className="marker-pop-actions">
          <button className="btn primary" onClick={onArm} disabled={loading || !marker.url.trim()}>
            {marker.status === 'deferred' ? 'Re-arm' : 'Arm (prefetch)'}
          </button>
          <button className="btn" onClick={onLoad} disabled={loading || !marker.url.trim()}>
            {loading ? 'Loading…' : marker.assetId ? 'Replace now' : 'Load now'}
          </button>
          <button className="btn" onClick={onRemove} disabled={loading}>
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The mark inside the square.
 *
 * Drawn as SVG rather than CSS gradients: at 15 px a hand-made glyph has to be
 * pixel-aligned or it reads as a smudge.
 */
export function MarkerGlyph({ status }: { status: Marker['status'] }) {
  if (status === 'ready') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden>
        <path d="M4 8.4l2.6 2.4L12 5.4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden>
        <path d="M8 4.4v4.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="8" cy="11.6" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  // empty / loading: a plus, so "add a clip here" reads at a glance
  return (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M8 4v8M4 8h8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
