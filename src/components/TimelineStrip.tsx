import { useCallback, useEffect, useRef, useState } from 'react';
import type { IndexedAsset } from '../lib/media/types';
import { formatTime, markerVirtualTime } from '../lib/timeline/map';
import type { Marker } from '../state/project';
import { MarkerGlyph, MarkerPopover } from './MarkerPopover';
import { LEAD_OPTIONS } from '../state/markerTrigger';
import type { Timeline } from '../lib/timeline/types';
import type { BufferedRange } from '../lib/engine/types';

interface Props {
  timeline: Timeline;
  time: number;
  buffered: BufferedRange[];
  assets: Map<string, IndexedAsset>;
  selectedInsertionId: string | null;
  markers: Marker[];
  openMarkerId: string | null;
  onSeek: (virtualTime: number) => void;
  onSelect: (insertionId: string | null) => void;
  onAddMarker: () => void;
  onOpenMarker: (markerId: string | null) => void;
  onMarkerUrl: (markerId: string, url: string) => void;
  onMarkerArm: (markerId: string) => void;
  lead: number;
  onLead: (lead: number) => void;
  onMarkerLoad: (markerId: string) => void;
  onMarkerRemove: (markerId: string) => void;
}

export function TimelineStrip({
  timeline,
  time,
  buffered,
  assets,
  selectedInsertionId,
  markers,
  openMarkerId,
  onSeek,
  onSelect,
  onAddMarker,
  onOpenMarker,
  onMarkerUrl,
  onMarkerArm,
  lead,
  onLead,
  onMarkerLoad,
  onMarkerRemove,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const duration = Math.max(timeline.duration, 0.001);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const fraction = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
      onSeek(fraction * duration);
    },
    [duration, onSeek],
  );

  const pct = (value: number) => (value / duration) * 100;

  const openMarker = markers.find((m) => m.id === openMarkerId) ?? null;
  const openAt = openMarker
    ? Math.min(markerVirtualTime(timeline, openMarker.snappedMainTime), duration)
    : 0;

  // The panel floats above the timeline; flip it below only when there is no room
  // above. One measurement at open time is enough — it is not re-derived on scroll.
  const [placeBelow, setPlaceBelow] = useState(false);
  useEffect(() => {
    if (!openMarker) return;
    const card = trackRef.current?.closest('.timeline');
    setPlaceBelow((card?.getBoundingClientRect().top ?? Infinity) < 230);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMarker?.id]);

  return (
    <div className="timeline">
      <div
        ref={trackRef}
        className="track"
        onPointerDown={(e) => {
          dragging.current = true;
          (e.target as Element).setPointerCapture?.(e.pointerId);
          onSelect(null);
          // Scrubbing dismisses the marker panel; it is anchored to a point on
          // this track, so leaving it open over a moving playhead is noise.
          onOpenMarker(null);
          seekFromEvent(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging.current) seekFromEvent(e.clientX);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        {buffered.map((range, i) => (
          <div
            key={`b${i}`}
            className="track-buffered"
            style={{ left: `${pct(range.start)}%`, width: `${Math.max(pct(range.end - range.start), 0.15)}%` }}
          />
        ))}

        {timeline.segments.map((segment, index) => {
          const width = pct(segment.virtOut - segment.virtIn);
          const asset = assets.get(segment.assetId);
          const isClip = segment.kind === 'clip';
          const label =
            width > 4
              ? isClip
                ? asset?.meta.name.replace(/\.[^.]+$/, '') ?? 'clip'
                : `main ${index + 1}`
              : '';
          return (
            <div
              key={segment.id}
              className={`seg ${isClip ? 'clip' : 'main'}${
                segment.insertionId && segment.insertionId === selectedInsertionId ? ' sel' : ''
              }`}
              style={{ left: `${pct(segment.virtIn)}%`, width: `${Math.max(width, 0.25)}%` }}
              title={`${asset?.meta.name ?? segment.assetId} · ${formatTime(segment.virtOut - segment.virtIn, true)}`}
            >
              {label}
            </div>
          );
        })}

        {markers.map((marker) => {
          const at = Math.min(markerVirtualTime(timeline, marker.snappedMainTime), duration);
          const open = marker.id === openMarkerId;
          return (
            <button
              key={marker.id}
              type="button"
              className={`marker ${marker.status}${open ? ' open' : ''}`}
              style={{ left: `${pct(at)}%` }}
              title={
                marker.assetId
                  ? `${formatTime(marker.snappedMainTime, true)} · remote clip loaded`
                  : `${formatTime(marker.snappedMainTime, true)} · paste a remote video URL`
              }
              aria-label={`Marker at ${formatTime(marker.snappedMainTime, true)}`}
              onPointerDown={(e) => {
                // Do not let the track treat this as a scrub.
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                onOpenMarker(open ? null : marker.id);
              }}
            >
              <MarkerGlyph status={marker.status} />
            </button>
          );
        })}

        <div className="playhead" style={{ left: `${pct(Math.min(time, duration))}%` }} />
      </div>

      {openMarker && (
        <MarkerPopover
          marker={openMarker}
          leftPct={pct(openAt)}
          below={placeBelow}
          lead={lead}
          onUrlChange={(url) => onMarkerUrl(openMarker.id, url)}
          onArm={() => onMarkerArm(openMarker.id)}
          onLoad={() => onMarkerLoad(openMarker.id)}
          onRemove={() => {
            onMarkerRemove(openMarker.id);
            onOpenMarker(null);
          }}
          onClose={() => onOpenMarker(null)}
        />
      )}

      <div className="track-legend">
        <div className="keys">
          <span className="key">
            <i className="swatch" /> main video
          </span>
          <span className="key">
            <i className="swatch clip" /> inserted clip
          </span>
        </div>
        <div className="legend-right">
          <label className="hint" style={{ margin: 0 }} htmlFor="prefetch-lead">
            prefetch
          </label>
          <select
            id="prefetch-lead"
            className="select select-sm"
            value={lead}
            onChange={(e) => onLead(Number(e.target.value))}
            title="How early an armed marker starts loading"
          >
            {LEAD_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}s
              </option>
            ))}
          </select>
          <button className="btn btn-sm" onClick={onAddMarker} title="Add a marker at the playhead">
            + marker
          </button>
          <span>
            {formatTime(time, true)} / {formatTime(duration, true)}
          </span>
        </div>
      </div>
    </div>
  );
}
