/**
 * The edit: main video with clips spliced in, expressed as a list of segments.
 *
 * Insert points snap to sync samples, because a fragment may only start on one.
 * The drift that snapping causes is returned, not hidden — the UI shows it.
 */

/**
 * @typedef {Object} Segment
 * @property {object} asset
 * @property {number} srcIn   seconds, in the asset's own timeline
 * @property {number} srcOut
 * @property {number} virtIn  seconds, in the edit's timeline
 * @property {number} virtOut
 * @property {'main'|'clip'} kind
 * @property {string|null} insertId
 */

/**
 * Nearest sync-aligned cut point to `time`.
 * @param {number[]} cutPoints
 * @param {number} time
 */
export function snapToCutPoint(cutPoints, time) {
  if (!cutPoints.length) return { snapped: 0, drift: -time };
  let best = cutPoints[0];
  for (const point of cutPoints) {
    if (Math.abs(point - time) < Math.abs(best - time)) best = point;
  }
  return { snapped: best, drift: best - time };
}

/**
 * @typedef {Object} Insert
 * @property {string} id
 * @property {object} asset
 * @property {number} atMainTime  seconds, where the user asked for it
 * @property {number} clipIn      seconds into the clip
 * @property {number} clipOut
 */

/**
 * Build the edit.
 *
 * Clips are laid over the main timeline: the main video resumes where it would
 * have continued, so an insert never pushes later material out of sync with the
 * main track's own timeline.
 *
 * @param {object} main
 * @param {Insert[]} inserts
 */
export function buildPlan(main, inserts) {
  /** @type {{insertId: string, requested: number, snapped: number, drift: number}[]} */
  const snaps = [];
  const ordered = [...inserts]
    .map((insert) => {
      const { snapped, drift } = snapToCutPoint(main.cutPoints, insert.atMainTime);
      snaps.push({ insertId: insert.id, requested: insert.atMainTime, snapped, drift });
      return { ...insert, snapped };
    })
    .sort((a, b) => a.snapped - b.snapped);

  /** @type {Segment[]} */
  const segments = [];
  let cursor = 0;
  let virtualCursor = 0;

  const pushMain = (from, to) => {
    if (to - from <= 1e-6) return;
    segments.push({
      asset: main,
      srcIn: from,
      srcOut: to,
      virtIn: virtualCursor,
      virtOut: virtualCursor + (to - from),
      kind: 'main',
      insertId: null,
    });
    virtualCursor += to - from;
  };

  for (const insert of ordered) {
    // Two inserts snapping to the same cut point would produce an empty main
    // segment and a zero-length fragment; keep the first, drop the rest.
    if (insert.snapped <= cursor + 1e-6) {
      snaps[snaps.findIndex((s) => s.insertId === insert.id)].drift = insert.snapped - insert.atMainTime;
      continue;
    }
    pushMain(cursor, insert.snapped);
    const clipOut = Math.min(insert.clipOut, insert.asset.duration);
    const length = Math.max(0, clipOut - insert.clipIn);
    if (length <= 1e-6) {
      cursor = insert.snapped;
      continue;
    }
    segments.push({
      asset: insert.asset,
      srcIn: insert.clipIn,
      srcOut: clipOut,
      virtIn: virtualCursor,
      virtOut: virtualCursor + length,
      kind: 'clip',
      insertId: insert.id,
    });
    virtualCursor += length;
    cursor = insert.snapped;
  }
  pushMain(cursor, main.duration);

  return { segments, duration: virtualCursor, snaps };
}

/**
 * Virtual time of a main-timeline position, accounting for the clips before it.
 * @param {Segment[]} segments
 * @param {number} mainTime
 */
export function mainToVirtual(segments, mainTime) {
  let offset = 0;
  for (const segment of segments) {
    if (segment.kind === 'clip') {
      if (segment.virtIn > mainTime + offset) return mainTime + offset;
      offset += segment.virtOut - segment.virtIn;
      continue;
    }
    if (mainTime >= segment.srcIn && mainTime <= segment.srcOut) {
      return segment.virtIn + (mainTime - segment.srcIn);
    }
  }
  return mainTime + offset;
}

/**
 * Inverse of `mainToVirtual`: where a virtual position sits on the main timeline.
 * A position inside a clip maps to the main time the clip was inserted at.
 * @param {Segment[]} segments
 * @param {number} virtualTime
 */
export function virtualToMain(segments, virtualTime) {
  for (const segment of segments) {
    if (virtualTime < segment.virtIn - 1e-9) return segment.kind === 'main' ? segment.srcIn : segment.srcIn;
    if (virtualTime <= segment.virtOut + 1e-9) {
      if (segment.kind === 'main') return segment.srcIn + (virtualTime - segment.virtIn);
      return segment.srcIn;
    }
  }
  return segments.length ? segments[segments.length - 1].srcOut : 0;
}

/**
 * The segment containing `virtualTime`, plus the segment index.
 * @param {Segment[]} segments
 * @param {number} virtualTime
 */
export function segmentAt(segments, virtualTime) {
  for (let i = 0; i < segments.length; i++) {
    if (virtualTime < segments[i].virtOut - 1e-9) return { segment: segments[i], index: i };
  }
  return { segment: segments[segments.length - 1] ?? null, index: segments.length - 1 };
}
