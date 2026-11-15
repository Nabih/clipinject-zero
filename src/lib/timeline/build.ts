import type { AssetMeta, Insertion, Segment, Timeline } from './types';
import { EMPTY_TIMELINE } from './types';

const EPS = 1e-6;

/** Nearest legal cut point, plus how far it had to move. */
export function snapToCut(
  at: number,
  cutPoints: readonly number[],
  duration: number,
): { time: number; drift: number } {
  const clamped = Math.min(Math.max(at, 0), Math.max(duration - 1 / 60, 0));
  if (!cutPoints.length) return { time: clamped, drift: 0 };

  let best = cutPoints[0];
  let bestD = Math.abs(best - clamped);
  for (const c of cutPoints) {
    const d = Math.abs(c - clamped);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  // Fall back to the requested time when even the nearest cut is far away and
  // the caller is only interested in an approximate marker.
  return { time: best, drift: best - at };
}

/**
 * Cut points usable as an insertion point for a main asset: strictly inside the
 * file, so every insertion produces a non-empty main segment on at least one
 * side and never a zero-length segment.
 */
export function insertionCutPoints(main: AssetMeta): number[] {
  return main.cutPoints.filter((t) => t > EPS && t < main.duration - EPS);
}

/**
 * Build the virtual timeline.
 *
 * Walks the main video, chopping it at each (already snapped) insertion point and
 * laying the clip in between. Clips sharing a cut point chain in list order.
 * Pure and total: never throws, always returns a contiguous timeline.
 */
export function buildTimeline(
  main: AssetMeta,
  clips: ReadonlyMap<string, AssetMeta>,
  insertions: readonly Insertion[],
): Timeline {
  const sorted = [...insertions].sort(
    (a, b) =>
      a.snappedMainTime - b.snappedMainTime ||
      a.id.localeCompare(b.id),
  );

  const segments: Segment[] = [];
  let m = 0; // cursor: main source seconds
  let v = 0; // cursor: virtual seconds

  const pushMain = (from: number, to: number) => {
    const end = Math.min(to, main.duration);
    if (end - from <= EPS) return;
    segments.push({
      id: `main:${segments.length}`,
      kind: 'main',
      assetId: main.id,
      srcIn: from,
      srcOut: end,
      virtIn: v,
      virtOut: v + (end - from),
    });
    v += end - from;
    m = end;
  };

  for (const ins of sorted) {
    const clip = clips.get(ins.clipId);
    if (!clip) continue; // removed from the library; validate() reports it

    const cut = Math.min(Math.max(ins.snappedMainTime, m), main.duration);
    if (cut > m) pushMain(m, cut);
    m = Math.max(m, cut);

    const srcIn = Math.max(0, Math.min(ins.inPoint, clip.duration));
    const srcOut = Math.max(srcIn, Math.min(ins.outPoint, clip.duration));
    if (srcOut - srcIn <= EPS) continue;

    segments.push({
      id: `clip:${ins.id}:${segments.length}`,
      kind: 'clip',
      assetId: clip.id,
      srcIn,
      srcOut,
      virtIn: v,
      virtOut: v + (srcOut - srcIn),
      insertionId: ins.id,
    });
    v += srcOut - srcIn;
  }

  pushMain(m, main.duration);

  if (!segments.length) return { ...EMPTY_TIMELINE, mainDuration: main.duration };
  return { segments, duration: v, mainDuration: main.duration };
}
