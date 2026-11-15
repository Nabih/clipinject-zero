import { describe, expect, it } from 'vitest';
import type { AssetMeta, Insertion } from './types';
import { buildTimeline, insertionCutPoints, snapToCut } from './build';
import { formatTime, isInClip, locate, markerVirtualTime, segmentsIn, toMain, toVirtual } from './map';
import { validateInsertions } from './validate';

/** 1800 s main, 2 s GOP, so cut points every 2 s. */
function mainAsset(overrides: Partial<AssetMeta> = {}): AssetMeta {
  const cutPoints: number[] = [];
  for (let t = 0; t <= 1800; t += 2) cutPoints.push(t);
  return {
    id: 'main',
    kind: 'main',
    name: 'main.mp4',
    duration: 1800,
    video: { codec: 'avc1.64001f', width: 1920, height: 1080, timescale: 30000 },
    audio: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, timescale: 48000 },
    cutPoints,
    ...overrides,
  };
}

function clipAsset(id: string, duration: number): AssetMeta {
  const cutPoints: number[] = [];
  for (let t = 0; t <= duration; t += 1) cutPoints.push(Number(t.toFixed(3)));
  return {
    id,
    kind: 'clip',
    name: `${id}.mp4`,
    duration,
    video: { codec: 'avc1.64001f', width: 1920, height: 1080, timescale: 30000 },
    audio: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, timescale: 48000 },
    cutPoints,
  };
}

function ins(partial: Partial<Insertion> & { id: string; clipId: string }): Insertion {
  return {
    atMainTime: 0,
    snappedMainTime: 0,
    inPoint: 0,
    outPoint: 10,
    ...partial,
  };
}

describe('snapToCut', () => {
  it('snaps to the nearest cut point and reports drift', () => {
    const r = snapToCut(134.7, [132, 134, 136], 1800);
    expect(r.time).toBe(134);
    expect(r.drift).toBeCloseTo(-0.7, 6);
  });

  it('clamps out-of-range requests', () => {
    expect(snapToCut(-50, [0, 2, 4], 1800).time).toBe(0);
    expect(snapToCut(99999, [0, 2, 4], 1800).time).toBe(4);
  });

  it('tolerates an asset with no cut points', () => {
    expect(snapToCut(10, [], 1800)).toEqual({ time: 10, drift: 0 });
  });
});

describe('insertionCutPoints', () => {
  it('drops the first and last frames so no segment is zero-length', () => {
    const points = insertionCutPoints(mainAsset());
    expect(points).not.toContain(0);
    expect(points).not.toContain(1800);
    expect(points[0]).toBe(2);
  });
});

describe('buildTimeline', () => {
  const main = mainAsset();
  const clips = new Map([
    ['clip3', clipAsset('clip3', 9.4)],
    ['clip7', clipAsset('clip7', 4.1)],
  ]);

  it('is contiguous with no gaps or overlaps', () => {
    const tl = buildTimeline(main, clips, [
      ins({ id: 'a', clipId: 'clip3', snappedMainTime: 134, outPoint: 9.4 }),
      ins({ id: 'b', clipId: 'clip7', snappedMainTime: 302, outPoint: 4.1 }),
    ]);
    for (let i = 1; i < tl.segments.length; i++) {
      expect(tl.segments[i].virtIn).toBeCloseTo(tl.segments[i - 1].virtOut, 9);
    }
    expect(tl.segments[0].virtIn).toBe(0);
    expect(tl.segments.at(-1)!.virtOut).toBeCloseTo(tl.duration, 9);
  });

  it('duration equals main duration plus the sum of clip durations', () => {
    const tl = buildTimeline(main, clips, [
      ins({ id: 'a', clipId: 'clip3', snappedMainTime: 134, outPoint: 9.4 }),
      ins({ id: 'b', clipId: 'clip7', snappedMainTime: 302, outPoint: 4.1 }),
    ]);
    expect(tl.duration).toBeCloseTo(1800 + 9.4 + 4.1, 6);
  });

  it('keeps every segment source-length equal to its virtual length', () => {
    const tl = buildTimeline(main, clips, [
      ins({ id: 'a', clipId: 'clip3', snappedMainTime: 134, outPoint: 9.4 }),
      ins({ id: 'b', clipId: 'clip7', snappedMainTime: 302, outPoint: 4.1 }),
    ]);
    for (const s of tl.segments) {
      expect(s.srcOut - s.srcIn).toBeCloseTo(s.virtOut - s.virtIn, 9);
    }
  });

  it('lays the clip between two main segments at the right place', () => {
    const tl = buildTimeline(main, clips, [
      ins({ id: 'a', clipId: 'clip3', snappedMainTime: 134, outPoint: 9.4 }),
    ]);
    expect(tl.segments.map((s) => [s.kind, s.srcIn, s.srcOut])).toEqual([
      ['main', 0, 134],
      ['clip', 0, 9.4],
      ['main', 134, 1800],
    ]);
    expect(tl.segments[1].virtIn).toBeCloseTo(134, 6);
  });

  it('chains clips that share a cut point in list order', () => {
    const tl = buildTimeline(main, clips, [
      ins({ id: 'a', clipId: 'clip3', snappedMainTime: 134, outPoint: 9.4 }),
      ins({ id: 'b', clipId: 'clip7', snappedMainTime: 134, outPoint: 4.1 }),
    ]);
    const kinds = tl.segments.map((s) => `${s.kind}:${s.assetId}`);
    expect(kinds).toEqual(['main:main', 'clip:clip3', 'clip:clip7', 'main:main']);
    expect(tl.duration).toBeCloseTo(1800 + 13.5, 6);
  });

  it('supports a clip at the very start and the very end', () => {
    const tl = buildTimeline(main, clips, [
      ins({ id: 'a', clipId: 'clip7', snappedMainTime: 0, outPoint: 4.1 }),
      ins({ id: 'b', clipId: 'clip3', snappedMainTime: 1800, outPoint: 9.4 }),
    ]);
    expect(tl.segments[0].kind).toBe('clip');
    expect(tl.segments.at(-1)!.kind).toBe('clip');
    expect(tl.duration).toBeCloseTo(1800 + 13.5, 6);
  });

  it('does not mutate the caller’s insertion order', () => {
    const list = [
      ins({ id: 'b', clipId: 'clip7', snappedMainTime: 302, outPoint: 4.1 }),
      ins({ id: 'a', clipId: 'clip3', snappedMainTime: 134, outPoint: 9.4 }),
    ];
    const copy = JSON.stringify(list);
    buildTimeline(main, clips, list);
    expect(JSON.stringify(list)).toBe(copy);
  });

  it('skips insertions whose clip is gone', () => {
    const tl = buildTimeline(main, clips, [ins({ id: 'x', clipId: 'nope', snappedMainTime: 134 })]);
    expect(tl.segments).toHaveLength(1);
    expect(tl.duration).toBeCloseTo(1800, 6);
  });

  it('handles an empty insertion list', () => {
    const tl = buildTimeline(main, clips, []);
    expect(tl.segments).toHaveLength(1);
    expect(tl.duration).toBe(1800);
  });
});

describe('time mapping', () => {
  const main = mainAsset();
  const clips = new Map([
    ['clip3', clipAsset('clip3', 9.4)],
    ['clip7', clipAsset('clip7', 4.1)],
  ]);
  const tl = buildTimeline(main, clips, [
    ins({ id: 'a', clipId: 'clip3', snappedMainTime: 134, outPoint: 9.4 }),
    ins({ id: 'b', clipId: 'clip7', snappedMainTime: 302, outPoint: 4.1 }),
  ]);

  it('maps main → virtual monotonically', () => {
    let prev = -1;
    for (let m = 0; m <= 1800; m += 7) {
      const v = toVirtual(tl, m);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(prev).toBeCloseTo(1799 + 13.5, 6);
    expect(toVirtual(tl, 1800)).toBeCloseTo(tl.duration, 6);
  });

  it('round-trips for every position that is not inside a clip', () => {
    for (let m = 0; m <= 1800; m += 3.5) {
      const v = toVirtual(tl, m);
      if (isInClip(tl, v)) continue;
      expect(toMain(tl, v)).toBeCloseTo(m, 6);
    }
  });

  it('maps a clip back to the cut that produced it', () => {
    const clipSeg = tl.segments.find((s) => s.kind === 'clip')!;
    expect(toMain(tl, clipSeg.virtIn + 1)).toBeCloseTo(134, 6);
    expect(toMain(tl, clipSeg.virtIn)).toBeCloseTo(134, 6);
  });

  it('handles the ends', () => {
    expect(toMain(tl, 0)).toBe(0);
    expect(toMain(tl, tl.duration)).toBeCloseTo(1800, 6);
    expect(toVirtual(tl, 0)).toBe(0);
    expect(toVirtual(tl, 1800)).toBeCloseTo(tl.duration, 6);
  });

  it('locates the correct source time inside a segment', () => {
    const hit = locate(tl, 10)!;
    expect(hit.segment.kind).toBe('main');
    expect(hit.srcTime).toBeCloseTo(10, 6);

    const clipSeg = tl.segments.find((s) => s.kind === 'clip')!;
    const inside = locate(tl, clipSeg.virtIn + 2)!;
    expect(inside.segment.assetId).toBe('clip3');
    expect(inside.srcTime).toBeCloseTo(2, 6);
  });

  it('finds overlapping segments for a lookahead window', () => {
    expect(segmentsIn(tl, 0, 10).map((s) => s.kind)).toEqual(['main']);
    expect(segmentsIn(tl, 130, 140).map((s) => s.kind)).toEqual(['main', 'clip']);
    // 140 sits inside clip3 (virtual 134 → 143.4)
    expect(segmentsIn(tl, 140, 140.5).map((s) => s.kind)).toEqual(['clip']);
    expect(segmentsIn(tl, 145, 150).map((s) => s.kind)).toEqual(['main']);
    expect(segmentsIn(tl, 10, 5)).toEqual([]);
  });
});

describe('formatTime', () => {
  it('formats sensibly', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(3661)).toBe('1:01:01');
    expect(formatTime(Number.NaN)).toBe('0:00');
  });
});

describe('validateInsertions', () => {
  const main = mainAsset();
  const clips = new Map([['clip3', clipAsset('clip3', 9.4)]]);

  it('passes a clean edit', () => {
    expect(validateInsertions(main, clips, [ins({ id: 'a', clipId: 'clip3', snappedMainTime: 134, outPoint: 9.4 })])).toEqual([]);
  });

  it('reports a removed clip as an error', () => {
    const issues = validateInsertions(main, clips, [ins({ id: 'a', clipId: 'gone' })]);
    expect(issues[0].level).toBe('error');
    expect(issues[0].code).toBe('missing-clip');
  });

  it('reports zero-length trims', () => {
    const issues = validateInsertions(main, clips, [
      ins({ id: 'a', clipId: 'clip3', snappedMainTime: 134, inPoint: 2, outPoint: 2 }),
    ]);
    expect(issues.some((i) => i.code === 'empty-trim' && i.level === 'error')).toBe(true);
  });
});

describe('markerVirtualTime', () => {
  const tl = buildTimeline(mainAsset({ duration: 30 }), new Map([['c1', clipAsset('c1', 5)]]), [
    ins({ id: 'i1', clipId: 'c1', atMainTime: 10, snappedMainTime: 10 }),
  ]);

  it('puts a marker at the start of the clip it created', () => {
    // Main 10 s is where the clip begins; toVirtual would give 15 (after it).
    expect(markerVirtualTime(tl, 10)).toBeCloseTo(10, 6);
    expect(toVirtual(tl, 10)).toBeCloseTo(15, 6);
  });

  it('maps a time inside main after the clip through the clip duration', () => {
    expect(markerVirtualTime(tl, 20)).toBeCloseTo(25, 6);
  });

  it('clamps at the end of the video', () => {
    expect(markerVirtualTime(tl, 30)).toBeCloseTo(35, 6);
  });
});
