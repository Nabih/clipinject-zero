import type { Timeline } from '../timeline/types';
import type { AudioMode } from '../media/audioPlan';
import type { AudioConfig } from '../media/codec';
import type { IndexedAsset } from '../media/types';

export type EngineKind = 'native' | 'simple';

export interface PlaySource {
  timeline: Timeline;
  assets: ReadonlyMap<string, IndexedAsset>;
  audioMode: AudioMode;
  audioConfig: AudioConfig | null;
  /** Codec string of the main video; decides the SourceBuffer mime type. */
  videoCodec: string;
}

export interface BufferedRange {
  start: number;
  end: number;
}

export interface PlayerState {
  time: number;
  duration: number;
  paused: boolean;
  buffered: BufferedRange[];
  /** Media time currently being appended, for the HUD. */
  appending: number;
  rendered: number;
  lastError: string | null;
  segmentLabel: string;
}

export interface LoadOptions {
  seekTo?: number;
  autoplay?: boolean;
}

export interface PlayerEngine {
  readonly kind: EngineKind;
  /** Create the engine's DOM inside `container` and get ready. */
  mount(container: HTMLElement): Promise<void>;
  /** Replace the edit. Never re-assigns `src`. */
  load(source: PlaySource | null, opts?: LoadOptions): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(time: number): void;
  readonly time: number;
  destroy(): void;
  subscribe(cb: (state: PlayerState) => void): () => void;
  /** Element the engine renders into, if it has exactly one. */
  readonly videoElement: HTMLVideoElement | null;
}

export function emptyState(): PlayerState {
  return {
    time: 0,
    duration: 0,
    paused: true,
    buffered: [],
    appending: 0,
    rendered: 0,
    lastError: null,
    segmentLabel: '',
  };
}

export function rangesToArray(ranges: TimeRanges): BufferedRange[] {
  const out: BufferedRange[] = [];
  for (let i = 0; i < ranges.length; i++) out.push({ start: ranges.start(i), end: ranges.end(i) });
  return out;
}

/** Largest gap in a buffered list, in seconds. */
export function largestGap(ranges: BufferedRange[]): number {
  let gap = 0;
  for (let i = 1; i < ranges.length; i++) {
    gap = Math.max(gap, ranges[i].start - ranges[i - 1].end);
  }
  return gap;
}

export function createVideoElement(): HTMLVideoElement {
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  video.controls = false;
  video.crossOrigin = 'anonymous';
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = 'contain';
  video.style.background = '#000';
  video.disableRemotePlayback = true;
  return video;
}
