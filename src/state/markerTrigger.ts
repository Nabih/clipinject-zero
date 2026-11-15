import type { Marker } from './project';

/**
 * Default head start for an armed marker, in seconds.
 *
 * Measured: a load that begins *on arrival* finishes after the seam, so the
 * insertion lands behind the playhead and the clip is skipped. Starting early
 * gives the fetch and the index time to finish while the playhead is still in
 * main video, so the clip is in place before it is needed.
 */
export const PREFETCH_LEAD = 1;

/** Leads offered in the UI, for comparing the behaviour. */
export const LEAD_OPTIONS = [1, 2, 5] as const;

/**
 * Markers the playhead has just **crossed**.
 *
 * A deferred (armed) marker is a promise to fetch later: it holds a URL but no
 * clip, no insertion and no decoder. The pure part of that decision, kept apart
 * from the store so the rule can be tested without a browser.
 *
 * Crossing, not "at or past": a marker is created at the playhead, so an
 * "at or past" rule fires the instant you arm it and never demonstrates anything.
 * The interesting case — and the one this rule models — is playback arriving at
 * the marker from before it.
 */
export function dueMarkers(
  markers: readonly Marker[],
  mainTime: number,
  previousMainTime: number | null,
  lead: number = PREFETCH_LEAD,
): Marker[] {
  if (previousMainTime === null) return [];
  return markers.filter((m) => {
    if (m.status !== 'deferred') return false;
    const fireAt = m.snappedMainTime - lead;
    return previousMainTime < fireAt - 1e-6 && mainTime >= fireAt - 1e-3;
  });
}

/** How late a load landed relative to the insert point, in seconds. */
export function lateness(marker: Marker): number | null {
  if (marker.requestedAt === null || marker.readyAt === null) return null;
  return Math.max(0, (marker.readyAt - marker.requestedAt) / 1000);
}
