/**
 * Project state.
 *
 * Zustand only — the video work lives in `src/media` and `src/player`, which know
 * nothing about React. The store's job is to hold indexed assets, the insert list
 * and the latest playback status, so components can render and the engine can be
 * handed plain data.
 */

import { create } from 'zustand';
import { buildPlan, virtualToMain } from '../media/edit.js';
import { indexMedia, sourceFromBytes, sourceFromFile } from '../media/mp4.js';

export type AssetKind = 'main' | 'clip';

export interface Insert {
  id: string;
  asset: any;
  atMainTime: number;
  clipIn: number;
  clipOut: number;
}

export interface PlaybackStatus {
  mime: string;
  buffered: [number, number][];
  appendedThrough: number;
  fragments: number;
  bytesAppended: number;
  silenceFrames: number;
  duration: number;
}

interface ProjectStore {
  main: any | null;
  clips: any[];
  inserts: Insert[];
  plan: any | null;
  status: PlaybackStatus | null;
  audioMode: 'replace' | 'silent';
  busy: { label: string; progress: number } | null;
  notice: string | null;
  error: string | null;

  loadMain(file: File): Promise<void>;
  addClips(files: File[]): Promise<void>;
  addRemoteClip(url: string): Promise<void>;
  removeClip(id: string): void;
  addInsert(clipId: string, atMainTime: number): void;
  removeInsert(id: string): void;
  setAudioMode(mode: 'replace' | 'silent'): void;
  setStatus(status: PlaybackStatus): void;
  setError(message: string | null): void;
  clearNotice(): void;
  /** Main-timeline position for a virtual playhead position. */
  mainTimeAt(virtualTime: number): number;
}

let insertSeq = 0;

export const useProject = create<ProjectStore>((set, get) => ({
  main: null,
  clips: [],
  inserts: [],
  plan: null,
  status: null,
  audioMode: 'replace',
  busy: null,
  notice: null,
  error: null,

  async loadMain(file) {
    set({ busy: { label: `indexing ${file.name}`, progress: 0 }, error: null });
    try {
      const asset = await indexMedia(sourceFromFile(file), {
        id: 'main',
        kind: 'main',
        onProgress: (progress) => set({ busy: { label: `indexing ${file.name}`, progress } }),
      });
      set({
        main: asset,
        clips: [],
        inserts: [],
        plan: null,
        busy: null,
        notice: `${asset.video.codec} · ${asset.video.width}×${asset.video.height} · ${asset.video.samples.length} video samples · ${asset.audio?.samples.length ?? 0} audio samples`,
      });
    } catch (error: any) {
      set({ busy: null, error: error.message });
    }
  },

  async addClips(files) {
    for (const file of files) {
      set({ busy: { label: `indexing ${file.name}`, progress: 0 }, error: null });
      try {
        const asset = await indexMedia(sourceFromFile(file), {
          id: `clip${get().clips.length + 1}-${Math.random().toString(36).slice(2, 6)}`,
          kind: 'clip',
        });
        set((state) => ({ clips: [...state.clips, asset], busy: null }));
      } catch (error: any) {
        set({ busy: null, error: `${file.name}: ${error.message}` });
      }
    }
  },

  async addRemoteClip(url) {
    set({ busy: { label: 'fetching clip', progress: 0 }, error: null });
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      // The bytes are indexed like a local file — the app needs the sample table,
      // so the URL is never handed to `<video src>`. That is also why CORS is
      // mandatory for remote clips.
      const asset = await indexMedia(sourceFromBytes(bytes, url.split('/').pop() || 'remote.mp4'), {
        id: `clip${get().clips.length + 1}`,
        kind: 'clip',
      });
      set((state) => ({ clips: [...state.clips, asset], busy: null }));
    } catch (error: any) {
      set({
        busy: null,
        error:
          error instanceof TypeError
            ? 'Fetch blocked — the server must send Access-Control-Allow-Origin.'
            : error.message,
      });
    }
  },

  removeClip(id) {
    set((state) => ({
      clips: state.clips.filter((clip) => clip.id !== id),
      inserts: state.inserts.filter((insert) => insert.asset.id !== id),
    }));
  },

  addInsert(clipId, atMainTime) {
    const { clips, inserts, main } = get();
    const clip = clips.find((c) => c.id === clipId);
    if (!clip || !main) return;
    insertSeq += 1;
    set({
      inserts: [
        ...inserts,
        {
          id: `i${insertSeq}`,
          asset: clip,
          atMainTime,
          clipIn: 0,
          clipOut: clip.duration,
        },
      ],
    });
  },

  removeInsert(id) {
    set((state) => ({ inserts: state.inserts.filter((insert) => insert.id !== id) }));
  },

  setAudioMode(audioMode) {
    set({ audioMode });
  },

  setStatus(status) {
    set({ status });
  },

  setError(error) {
    set({ error });
  },

  clearNotice() {
    set({ notice: null });
  },

  mainTimeAt(virtualTime) {
    const plan = get().plan;
    if (!plan) return virtualTime;
    return virtualToMain(plan.segments, virtualTime);
  },
}));

/** Recompute the plan whenever the main video or the inserts change. */
export function planFor(main: any | null, inserts: Insert[]) {
  if (!main) return null;
  return buildPlan(
    main,
    inserts.map((insert) => ({
      id: insert.id,
      asset: insert.asset,
      atMainTime: insert.atMainTime,
      clipIn: insert.clipIn,
      clipOut: insert.clipOut,
    })),
  );
}
