import { create } from 'zustand';
import type { AudioMode } from '../lib/media/audioPlan';
import { resolveAudioConfig } from '../lib/media/codec';
import { indexAsset } from '../lib/media/indexer';
import { PREFETCH_LEAD, dueMarkers, lateness } from './markerTrigger';
import { formatTime } from '../lib/timeline/map';
import { describeFetchFailure, downloadAsFile, normalizeRemoteUrl } from '../lib/media/remote';
import type { IndexedAsset } from '../lib/media/types';
import { insertionCutPoints, snapToCut } from '../lib/timeline/build';
import { buildTimeline } from '../lib/timeline/build';
import type { AssetKind, Insertion, Timeline } from '../lib/timeline/types';
import { validateInsertions, type Issue } from '../lib/timeline/validate';
import type { EngineKind } from '../lib/engine/types';
import type { PlaySource } from '../lib/engine/types';

/**
 * A square marker on the timeline that holds a remote clip URL.
 *
 * A marker is a placeholder: it is placed like an insertion (snapped to a legal
 * cut) and, once a URL is loaded, turns into a normal clip plus insertion. Keeping
 * them separate means an empty or broken marker never blocks playback.
 */
export interface Marker {
  id: string;
  /** Where the user asked for it, in main-video time. */
  atMainTime: number;
  /** Nearest legal cut, in main-video time. */
  snappedMainTime: number;
  url: string;
  /** The clip created from `url`, once loaded. */
  assetId: string | null;
  /** The insertion created from that clip. */
  insertionId: string | null;
  /**
   * `deferred` is the armed state: the URL is set but nothing has been fetched,
   * indexed or inserted yet. The load starts when the playhead reaches
   * `snappedMainTime` (`triggerArmedMarkers`), which is deliberately *after* the
   * moment the clip is needed.
   */
  status: 'empty' | 'deferred' | 'loading' | 'ready' | 'error';
  /** Download progress 0..1, or null while the size is unknown. */
  progress: number | null;
  error: string | null;
  /** `performance.now()` when the fetch started (null until then). */
  requestedAt: number | null;
  /** `performance.now()` when the clip was indexed and inserted. */
  readyAt: number | null;
}

export interface PlaybackAnchor {
  /** Main-video time to restore after a rebuild, if any. */
  mainTime: number | null;
}

interface ProjectStore {
  assets: IndexedAsset[];
  mainId: string | null;
  insertions: Insertion[];
  markers: Marker[];
  /** Last playhead sample, so armed markers can fire on a crossing. */
  lastMainTime: number | null;
  /** Seconds of head start before an armed marker starts loading. */
  prefetchLead: number;
  setPrefetchLead(lead: number): void;
  engine: EngineKind;
  audioMode: AudioMode;
  busy: { label: string; progress: number } | null;
  notice: string | null;
  failed: string | null;

  addFiles(files: File[], kind: AssetKind): Promise<void>;
  removeAsset(id: string): void;
  setMain(id: string): void;
  addMarker(atMainTime: number): string | null;
  setMarkerUrl(id: string, url: string): void;
  /** Arm the marker: keep the URL, fetch nothing until the playhead arrives. */
  armMarker(id: string): void;
  /** Start any armed marker whose insert point the playhead has reached. */
  triggerArmedMarkers(mainTime: number): void;
  loadMarker(id: string): Promise<void>;
  removeMarker(id: string): void;
  addInsertion(clipId: string, atMainTime: number): string | null;
  updateInsertion(id: string, patch: Partial<Insertion>): void;
  removeInsertion(id: string): void;
  setInsertionAt(id: string, atMainTime: number): void;
  setEngine(engine: EngineKind): void;
  setAudioMode(mode: AudioMode): void;
  dismissNotice(): void;
  clearAll(): void;
}

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export const useProject = create<ProjectStore>((set, get) => ({
  assets: [],
  mainId: null,
  insertions: [],
  markers: [],
  lastMainTime: null,
  prefetchLead: PREFETCH_LEAD,
  engine: 'native',
  audioMode: 'replace',
  busy: null,
  notice: null,
  failed: null,

  async addFiles(files, kind) {
    for (const file of files) {
      set({ busy: { label: file.name, progress: 0 }, failed: null });
      try {
        const asset = await indexAsset({
          id: uid(),
          kind,
          file,
          onProgress: (progress) => set({ busy: { label: file.name, progress } }),
        });
        set((state) => {
          const isFirstMain = kind === 'main' && !state.mainId;
          return {
            assets: [...state.assets, asset],
            mainId: isFirstMain ? asset.meta.id : state.mainId,
            notice:
              kind === 'clip' && !state.mainId
                ? 'Load a main video first — clips need something to be inserted into.'
                : state.notice,
          };
        });
      } catch (err) {
        set({ failed: `${file.name}: ${(err as Error).message}` });
      }
    }
    set({ busy: null });
  },

  removeAsset(id) {
    set((state) => {
      const assets = state.assets.filter((a) => a.meta.id !== id);
      const insertions = state.insertions.filter((i) => i.clipId !== id);
      const markers = state.markers.map((m) =>
        m.assetId === id ? { ...m, assetId: null, insertionId: null, status: 'empty' as const } : m,
      );
      const mainId = state.mainId === id ? (assets.find((a) => a.meta.kind === 'main')?.meta.id ?? null) : state.mainId;
      return { assets, insertions, markers, mainId };
    });
  },

  setMain(id) {
    set((state) => {
      const asset = state.assets.find((a) => a.meta.id === id);
      if (!asset || asset.meta.kind !== 'main') return state;
      const cuts = insertionCutPoints(asset.meta);
      return {
        mainId: id,
        insertions: state.insertions.map((ins) => {
          const snapped = snapToCut(ins.atMainTime, cuts, asset.meta.duration).time;
          return { ...ins, snappedMainTime: snapped };
        }),
        markers: state.markers.map((m) => ({
          ...m,
          snappedMainTime: snapToCut(m.atMainTime, cuts, asset.meta.duration).time,
        })),
      };
    });
  },

  addMarker(atMainTime) {
    const state = get();
    const main = state.assets.find((a) => a.meta.id === state.mainId);
    if (!main) return null;

    const cuts = insertionCutPoints(main.meta);
    const snapped = snapToCut(atMainTime, cuts, main.meta.duration).time;
    const marker: Marker = {
      id: uid(),
      atMainTime,
      snappedMainTime: snapped,
      url: '',
      assetId: null,
      insertionId: null,
      status: 'empty',
      progress: null,
      error: null,
      requestedAt: null,
      readyAt: null,
    };
    set((s) => ({ markers: [...s.markers, marker] }));
    return marker.id;
  },

  setMarkerUrl(id, url) {
    set((state) => ({
      markers: state.markers.map((m) =>
        m.id === id ? { ...m, url, status: m.assetId ? m.status : 'empty', error: null } : m,
      ),
    }));
  },

  armMarker(id) {
    const marker = get().markers.find((m) => m.id === id);
    if (!marker) return;

    const url = normalizeRemoteUrl(marker.url);
    if (!url) {
      set((state) => ({
        markers: state.markers.map((m) =>
          m.id === id ? { ...m, status: 'error', error: 'Enter an absolute http(s) URL to an MP4.' } : m,
        ),
      }));
      return;
    }

    // No fetch, no decode, no insertion: just a note that this is where a clip
    // should appear once playback gets there.
    set((state) => ({
      markers: state.markers.map((m) =>
        m.id === id
          ? { ...m, url, status: 'deferred', progress: null, error: null, requestedAt: null, readyAt: null }
          : m,
      ),
      failed: null,
    }));
  },

  setPrefetchLead(lead) {
    set({ prefetchLead: Math.max(0, lead) });
  },

  triggerArmedMarkers(mainTime) {
    const { lastMainTime: previousMainTime, prefetchLead } = get();
    if (previousMainTime !== mainTime) set({ lastMainTime: mainTime });
    for (const marker of dueMarkers(get().markers, mainTime, previousMainTime, prefetchLead)) {
      // `loadMarker` flips the status to `loading` synchronously, so this cannot
      // fire twice for the same marker.
      void get().loadMarker(marker.id);
    }
  },

  async loadMarker(id) {
    const marker = get().markers.find((m) => m.id === id);
    if (!marker) return;
    // Fired by playback reaching it, rather than by a click.
    const arriving = marker.status === 'deferred';

    const url = normalizeRemoteUrl(marker.url);
    if (!url) {
      set((state) => ({
        markers: state.markers.map((m) =>
          m.id === id ? { ...m, status: 'error', error: 'Enter an absolute http(s) URL to an MP4.' } : m,
        ),
      }));
      return;
    }

    set((state) => ({
      markers: state.markers.map((m) =>
        m.id === id
          ? { ...m, url, status: 'loading', progress: null, error: null, requestedAt: performance.now() }
          : m,
      ),
      failed: null,
    }));

    // Download, then index through the *same* path as a dropped file: the clip
    // that comes out is identical in every respect except where its bytes came
    // from.
    let file: File;
    try {
      file = await downloadAsFile(url, {
        onProgress: (progress) =>
          set((state) => ({
            markers: state.markers.map((m) => (m.id === id ? { ...m, progress } : m)),
            busy: { label: url.split('/').pop() || url, progress: progress ?? 0 },
          })),
      });
    } catch (err) {
      const message = describeFetchFailure(err, url);
      set((state) => ({
        markers: state.markers.map((m) =>
          m.id === id ? { ...m, status: 'error', error: message, progress: null } : m,
        ),
        failed: message,
        busy: null,
      }));
      return;
    }

    const before = get().assets.length;
    await get().addFiles([file], 'clip');
    const created = get().assets.slice(before).find((a) => a.meta.kind === 'clip');

    set({ busy: null });

    if (!created) {
      // Most often the URL returned an HTML page (login wall, redirect, SPA
      // fallback) rather than a video, so name that possibility.
      const detail = get().failed?.replace(/^[^:]+:\s*/, '') ?? 'could not be indexed';
      const message = `That URL did not return a playable MP4 (${detail}).`;
      set((state) => ({
        markers: state.markers.map((m) => (m.id === id ? { ...m, status: 'error', error: message } : m)),
      }));
      return;
    }

    const current = get().markers.find((m) => m.id === id);
    const insertionId = get().addInsertion(created.meta.id, current?.snappedMainTime ?? marker.snappedMainTime);
    const readyAt = performance.now();
    set((state) => {
      const markers = state.markers.map((m): Marker =>
        m.id === id
          ? {
              ...m,
              assetId: created.meta.id,
              insertionId,
              status: 'ready' as const,
              progress: null,
              error: null,
              readyAt,
            }
          : m,
      );

      // Say plainly what arriving late means: the edit changed under the playhead.
      const done = markers.find((m) => m.id === id);
      const late = done ? lateness(done) : null;
      // Only worth announcing when the clip genuinely missed its slot; a
      // prefetch that landed in time needs no explanation.
      const playheadNow = state.lastMainTime ?? 0;
      const tooLate = done ? playheadNow > done.snappedMainTime + 0.05 : false;
      const notice =
        arriving && late !== null && tooLate
          ? `${created.meta.name} arrived ${late.toFixed(2)} s after ${formatTime(done!.snappedMainTime, true)}. ` +
            `The clip is inserted there, so the timeline grew by ${created.meta.duration.toFixed(2)} s ` +
            `and the playhead has already moved to the far side of it.`
          : state.notice;

      return { markers, notice };
    });
  },

  removeMarker(id) {
    const marker = get().markers.find((m) => m.id === id);
    if (marker?.insertionId) get().removeInsertion(marker.insertionId);
    if (marker?.assetId) get().removeAsset(marker.assetId);
    set((state) => ({ markers: state.markers.filter((m) => m.id !== id) }));
  },

  addInsertion(clipId, atMainTime) {
    const state = get();
    const main = state.assets.find((a) => a.meta.id === state.mainId);
    const clip = state.assets.find((a) => a.meta.id === clipId);
    if (!main || !clip) return null;

    const cuts = insertionCutPoints(main.meta);
    const snapped = snapToCut(atMainTime, cuts, main.meta.duration).time;
    const lastFragment = clip.fragments.at(-1);
    const outPoint = lastFragment ? Math.min(lastFragment.end, clip.meta.duration) : clip.meta.duration;

    const insertion: Insertion = {
      id: uid(),
      clipId,
      atMainTime,
      snappedMainTime: snapped,
      inPoint: clip.meta.cutPoints[0] ?? 0,
      outPoint,
    };
    set((s) => ({ insertions: [...s.insertions, insertion] }));
    return insertion.id;
  },

  updateInsertion(id, patch) {
    set((state) => ({ insertions: state.insertions.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
  },

  setInsertionAt(id, atMainTime) {
    const state = get();
    const main = state.assets.find((a) => a.meta.id === state.mainId);
    if (!main) return;
    const cuts = insertionCutPoints(main.meta);
    const snapped = snapToCut(atMainTime, cuts, main.meta.duration).time;
    set((s) => ({
      insertions: s.insertions.map((i) => (i.id === id ? { ...i, atMainTime, snappedMainTime: snapped } : i)),
    }));
  },

  removeInsertion(id) {
    set((state) => ({ insertions: state.insertions.filter((i) => i.id !== id) }));
  },

  setEngine(engine) {
    set({ engine });
  },

  setAudioMode(audioMode) {
    set({ audioMode });
  },

  dismissNotice() {
    set({ notice: null, failed: null });
  },

  clearAll() {
    for (const asset of get().assets) URL.revokeObjectURL(asset.url);
    set({ assets: [], mainId: null, insertions: [], markers: [], lastMainTime: null, notice: null, failed: null });
  },
}));

// ------------------------------------------------------------------ selectors

export function assetMap(assets: IndexedAsset[]): Map<string, IndexedAsset> {
  return new Map(assets.map((a) => [a.meta.id, a]));
}

export function selectMain(assets: IndexedAsset[], mainId: string | null): IndexedAsset | null {
  return assets.find((a) => a.meta.id === mainId) ?? null;
}

export function selectClips(assets: IndexedAsset[]): IndexedAsset[] {
  return assets.filter((a) => a.meta.kind === 'clip');
}

export function selectTimeline(assets: IndexedAsset[], mainId: string | null, insertions: Insertion[]): Timeline | null {
  const main = selectMain(assets, mainId);
  if (!main) return null;
  const clips = new Map(selectClips(assets).map((a) => [a.meta.id, a.meta]));
  return buildTimeline(main.meta, clips, insertions);
}

export function selectIssues(assets: IndexedAsset[], mainId: string | null, insertions: Insertion[]): Issue[] {
  const main = selectMain(assets, mainId);
  if (!main) return [];
  const clips = new Map(selectClips(assets).map((a) => [a.meta.id, a.meta]));
  return validateInsertions(main.meta, clips, insertions);
}

export function buildPlaySource(
  assets: IndexedAsset[],
  mainId: string | null,
  insertions: Insertion[],
  engine: EngineKind,
  audioMode: AudioMode,
): PlaySource | null {
  const main = selectMain(assets, mainId);
  if (!main) return null;
  const clips = selectClips(assets);
  const timeline = selectTimeline(assets, mainId, insertions);
  if (!timeline || !timeline.segments.length) return null;

  const audioConfig = engine === 'simple' ? null : resolveAudioConfig(main.meta, clips.map((c) => c.meta));
  return {
    timeline,
    assets: assetMap(assets),
    audioMode,
    audioConfig,
    videoCodec: main.meta.video.codec,
  };
}
