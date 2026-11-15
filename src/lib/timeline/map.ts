import type { Segment, Timeline } from './types';

const EPS = 1e-6;

/** Index of the segment containing `virtT` (half-open `[virtIn, virtOut)`). */
export function findSegment(timeline: Timeline, virtT: number): { segment: Segment; index: number } | null {
  const { segments } = timeline;
  if (!segments.length) return null;

  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (virtT < s.virtIn - EPS) hi = mid - 1;
    else if (virtT >= s.virtOut - EPS) lo = mid + 1;
    else return { segment: s, index: mid };
  }
  // Past the end: clamp onto the final segment.
  return { segment: segments[segments.length - 1], index: segments.length - 1 };
}

export function locate(
  timeline: Timeline,
  virtT: number,
): { segment: Segment; index: number; srcTime: number } | null {
  const hit = findSegment(timeline, virtT);
  if (!hit) return null;
  const { segment } = hit;
  const clamped = Math.min(Math.max(virtT, segment.virtIn), segment.virtOut);
  return { ...hit, srcTime: segment.srcIn + (clamped - segment.virtIn) };
}

/**
 * Main-video time → virtual time.
 *
 * Half-open intervals: at exactly a cut point this returns the start of the first
 * clip inserted there, which is what the player shows at that moment.
 */
/**
 * Where a marker belongs on the *virtual* track.
 *
 * `toVirtual` is exclusive at a segment's end, which is right for a playhead but
 * wrong for a marker: a marker at main time 20 whose own clip occupies virtual
 * 20–26 would be drawn at 26, i.e. after the clip it created. Markers therefore
 * take the *first* main segment that reaches the time, so they sit at the start of
 * the region they mark.
 */
export function markerVirtualTime(timeline: Timeline, mainT: number): number {
  const { segments } = timeline;
  if (!segments.length) return Math.max(0, mainT);

  for (const s of segments) {
    if (s.kind !== 'main') continue;
    if (mainT >= s.srcIn - EPS && mainT <= s.srcOut + EPS) {
      const inside = Math.min(Math.max(mainT, s.srcIn), s.srcOut);
      return s.virtIn + (inside - s.srcIn);
    }
  }
  return toVirtual(timeline, mainT);
}

export function toVirtual(timeline: Timeline, mainT: number): number {
  const { segments, duration } = timeline;
  if (!segments.length) return Math.max(0, mainT);

  for (const s of segments) {
    if (s.kind !== 'main') continue;
    if (mainT >= s.srcIn - EPS && mainT < s.srcOut - EPS) {
      return s.virtIn + (mainT - s.srcIn);
    }
  }
  // Beyond the last main segment: either the very end, or inside a trailing clip.
  const last = segments[segments.length - 1];
  if (mainT >= last.srcOut - EPS) return duration;
  return Math.min(Math.max(mainT, 0), duration);
}

/**
 * Virtual time → main-video time.
 *
 * While the playhead sits inside a clip there is no single correct answer, so we
 * return the cut point the clip was inserted at. The UI labels this state
 * explicitly ("clip 3 playing") rather than pretending the mapping is total.
 */
export function toMain(timeline: Timeline, virtT: number): number {
  const hit = findSegment(timeline, virtT);
  if (!hit) return 0;
  const { segment, index } = hit;

  if (segment.kind === 'main') {
    const t = Math.min(Math.max(virtT, segment.virtIn), segment.virtOut);
    return segment.srcIn + (t - segment.virtIn);
  }

  // Inside a clip: anchor on the main position the clip was spliced into.
  for (let i = index - 1; i >= 0; i--) {
    const s = timeline.segments[i];
    if (s.kind === 'main') return s.srcOut;
  }
  return 0;
}

/** True when the playhead is inside a clip segment. */
export function isInClip(timeline: Timeline, virtT: number): boolean {
  return findSegment(timeline, virtT)?.segment.kind === 'clip';
}

/** Segments overlapping `[a, b)`, in virtual order. */
export function segmentsIn(timeline: Timeline, a: number, b: number): Segment[] {
  if (b <= a) return [];
  const out: Segment[] = [];
  for (const s of timeline.segments) {
    if (s.virtOut <= a + EPS) continue;
    if (s.virtIn >= b - EPS) break;
    out.push(s);
  }
  return out;
}

export function formatTime(seconds: number, withMillis = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = withMillis ? seconds : Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  const body = `${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : String(m)}:${String(s).padStart(2, '0')}`;
  return withMillis ? `${body}.${String(ms).padStart(3, '0')}` : body;
}

/** `1:02:03.456` style, for the HUD. */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/**
 * Parse `12`, `1:05`, `1:02:03` or `1:02:03.500` into seconds.
 * Returns null when the input is not a time at all.
 */
export function parseTime(input: string): number | null {
  const text = input.trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const values = parts.map((p) => Number(p));
  if (values.some((v) => !Number.isFinite(v) || v < 0)) return null;
  return values.length === 2
    ? values[0] * 60 + values[1]
    : values[0] * 3600 + values[1] * 60 + values[2];
}
