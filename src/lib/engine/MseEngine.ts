/**
 * The native engine, adapted to the `PlayerEngine` contract the UI expects.
 *
 * All the byte work lives in `src/media` and `src/player/engine.js`, which are
 * plain modules with no React and no third-party video code. This class is the
 * seam between those two worlds:
 *
 * - it owns the `<video>` element and a single `Player`,
 * - it converts the UI's `PlaySource` (a timeline over `IndexedAsset`s) into the
 *   plan shape the engine appends,
 * - it publishes `PlayerState` for the HUD.
 */

import { Player } from '../../player/engine.js';
import type { IndexedAsset } from '../media/types';
import { findSegment, toMain } from '../timeline/map';
import type { Segment } from '../timeline/types';
import {
  createVideoElement,
  emptyState,
  rangesToArray,
  type EngineKind,
  type LoadOptions,
  type PlaySource,
  type PlayerEngine,
  type PlayerState,
} from './types';

/** The lazy demuxer asset stored on every `IndexedAsset`. */
interface NativeAsset {
  video: { codec: string; width: number; height: number };
  audio: { codec: string; sampleRate: number; channels: number } | null;
  duration: number;
  cutPoints: number[];
}

interface NativePlanSegment {
  asset: NativeAsset;
  srcIn: number;
  srcOut: number;
  virtIn: number;
  virtOut: number;
  kind: 'main' | 'clip';
  insertId: string | null;
}

export class MseEngine implements PlayerEngine {
  readonly kind: EngineKind = 'native';

  private video: HTMLVideoElement | null = null;
  private player: Player | null = null;
  private source: PlaySource | null = null;
  private current: PlayerState = emptyState();
  /** The native asset currently attached; re-attaching flushes the buffer. */
  private attachedMain: unknown = null;
  private listeners = new Set<(state: PlayerState) => void>();
  private frame = 0;

  get videoElement(): HTMLVideoElement | null {
    return this.video;
  }

  /** Exposed for browser probes: the underlying hand-written engine. */
  get debugPlayer(): Player | null {
    return this.player;
  }

  get time(): number {
    return this.video?.currentTime ?? 0;
  }

  async mount(container: HTMLElement): Promise<void> {
    const video = createVideoElement();
    container.textContent = '';
    container.append(video);
    this.video = video;

    this.player = new Player(video, {
      onStatus: (status: any) => {
        this.current = { ...this.current, appending: status.appendedThrough ?? 0, duration: status.duration ?? this.current.duration };
        this.emit();
      },
    });

    (globalThis as any).__engine = this; // dev probe hook

    const tick = () => {
      this.publish();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);

    video.addEventListener('seeked', () => void this.player?.pump());
    video.addEventListener('timeupdate', () => void this.player?.pump());
    this.publish();
  }

  async load(source: PlaySource | null, opts: LoadOptions = {}): Promise<void> {
    const player = this.player;
    if (!player) return;
    this.source = source;

    if (!source) {
      this.current = emptyState();
      this.emit();
      return;
    }

    const assets = [...source.assets.values()];
    const main = assets.find((asset) => asset.meta.kind === 'main') ?? assets[0];
    if (!main) throw new Error('the timeline has no assets');

    player.audioMode = source.audioMode === 'silent' ? 'silent' : 'replace';
    // Only attach when the main video actually changed. Re-attaching on every edit
    // re-creates the SourceBuffer, which Chrome refuses once it has held data.
    const native = (main as IndexedAsset).native;
    if (native !== this.attachedMain) {
      await player.setMain(native as NativeAsset);
      this.attachedMain = native;
    }

    const plan = {
      duration: source.timeline.duration,
      segments: source.timeline.segments.map((segment: Segment) => {
        const asset = source.assets.get(segment.assetId) as IndexedAsset | undefined;
        if (!asset) throw new Error(`missing asset ${segment.assetId}`);
        const planSegment: NativePlanSegment = {
          asset: asset.native as NativeAsset,
          srcIn: segment.srcIn,
          srcOut: segment.srcOut,
          virtIn: segment.virtIn,
          virtOut: segment.virtOut,
          kind: segment.kind === 'clip' ? 'clip' : 'main',
          insertId: segment.insertionId ?? null,
        };
        return planSegment;
      }),
      snaps: [],
    };

    await player.setPlan(plan, opts.seekTo ?? 0);
    void player.pump();
    if (opts.autoplay) await this.play();
    this.publish();
  }

  async play(): Promise<void> {
    await this.video?.play();
  }

  pause(): void {
    this.video?.pause();
  }

  seek(time: number): void {
    const video = this.video;
    if (!video) return;
    video.currentTime = Math.max(0, time);
    void this.player?.pump();
    this.publish();
  }

  subscribe(cb: (state: PlayerState) => void): () => void {
    this.listeners.add(cb);
    cb(this.current);
    return () => this.listeners.delete(cb);
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.listeners.clear();
    this.video?.remove();
    this.video = null;
    this.player = null;
  }

  /** Refresh the state from the element; called once per animation frame. */
  private publish(): void {
    const video = this.video;
    if (!video) return;
    const segment = this.source ? this.segmentLabel(video.currentTime) : '';
    this.current = {
      ...this.current,
      time: video.currentTime,
      duration: this.source?.timeline.duration ?? 0,
      paused: video.paused,
      buffered: video.buffered.length ? rangesToArray(video.buffered) : [],
      segmentLabel: segment,
      lastError: video.error ? video.error.message : null,
    };
    this.emit();
  }

  private segmentLabel(virtualTime: number): string {
    const source = this.source;
    if (!source) return '';
    const hit = findSegment(source.timeline, virtualTime);
    if (!hit) return '';
    return hit.segment.kind === 'clip' ? `clip at ${toMain(source.timeline, virtualTime).toFixed(1)}s` : 'main';
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }
}
