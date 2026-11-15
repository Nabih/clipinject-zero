import { describe, expect, it } from 'vitest';
import { PREFETCH_LEAD, dueMarkers, lateness } from './markerTrigger';
import type { Marker } from './project';

function marker(over: Partial<Marker>): Marker {
  return {
    id: 'm',
    atMainTime: 20,
    snappedMainTime: 20,
    url: 'https://cdn.test/a.mp4',
    assetId: null,
    insertionId: null,
    status: 'deferred',
    progress: null,
    error: null,
    requestedAt: null,
    readyAt: null,
    ...over,
  };
}

describe('dueMarkers', () => {
  it('fires one second before the insert point', () => {
    const armed = marker({});
    expect(dueMarkers([armed], 18.9, 18.7)).toEqual([]);
    expect(dueMarkers([armed], 19.2, 18.9).map((m) => m.id)).toEqual(['m']);
    // a seek that jumps over the lead window still counts as arriving
    expect(dueMarkers([armed], 24, 17).map((m) => m.id)).toEqual(['m']);
  });

  it('takes the lead as a parameter', () => {
    const armed = marker({});
    // lead 0: fires exactly at the insert point
    expect(dueMarkers([armed], 19.5, 19.4, 0)).toEqual([]);
    expect(dueMarkers([armed], 20.1, 19.9, 0).map((m) => m.id)).toEqual(['m']);
    // lead 5: fires at 15, and 19 is already past that window
    expect(dueMarkers([armed], 15.2, 14.9, 5).map((m) => m.id)).toEqual(['m']);
    expect(dueMarkers([armed], 19.2, 19.0, 5)).toEqual([]);
    expect(PREFETCH_LEAD).toBe(1);
  });

  it('does not fire when the playhead is already there', () => {
    // Armed at the playhead: nothing has been crossed yet.
    expect(dueMarkers([marker({})], 20, 20)).toEqual([]);
    expect(dueMarkers([marker({})], 25, 24.8)).toEqual([]);
    expect(dueMarkers([marker({})], 20, null)).toEqual([]);
    expect(dueMarkers([marker({})], 19.5, 19.5)).toEqual([]);
  });

  it('ignores markers that are empty, loading, ready or failed', () => {
    const all = [
      marker({ id: 'empty', status: 'empty' }),
      marker({ id: 'loading', status: 'loading' }),
      marker({ id: 'ready', status: 'ready' }),
      marker({ id: 'error', status: 'error' }),
    ];
    expect(dueMarkers(all, 30, 12)).toEqual([]);
  });

  it('respects the snapped time rather than the requested one', () => {
    const snapped = marker({ atMainTime: 21.4, snappedMainTime: 20 });
    expect(dueMarkers([snapped], 19.1, 18.9).map((m) => m.id)).toEqual(['m']);
  });
});

describe('lateness', () => {
  it('measures how long the load took, in seconds', () => {
    expect(lateness(marker({ requestedAt: 1000, readyAt: 4250 }))).toBeCloseTo(3.25, 6);
  });

  it('is null until the load has both started and finished', () => {
    expect(lateness(marker({}))).toBeNull();
    expect(lateness(marker({ requestedAt: 1000 }))).toBeNull();
  });
});
