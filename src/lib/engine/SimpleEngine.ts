import type { IndexedAsset } from '../media/types';
import { findSegment, locate, toVirtual } from '../timeline/map';
import type { Segment, Timeline } from '../timeline/types';
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

const LEAD = 1.4;
const BED_LEVEL = 0.35;
const BED_WINDOW = 1.5;

/**
 * Method B — two pre-rolled `<video>` elements, swapped at the boundary.
 *
 * No MSE, no codec constraints, at the cost of about one frame of precision and
 * two decoders. `docs/04-simple-engine.md` is the specification.
 */
export class SimpleEngine implements PlayerEngine {
  readonly kind: EngineKind = 'simple';

  private layers: [HTMLVideoElement, HTMLVideoElement] | null = null;
  private active = 0;
  private bed: HTMLAudioElement | null = null;

  private source: PlaySource | null = null;
  private index = 0;
  private prerolledFor: string | null = null;
  private listeners = new Set<(s: PlayerState) => void>();
  private state: PlayerState = emptyState();
  private error: string | null = null;
  private destroyed = false;
  private emitScheduled = false;
  private ticking = false;

  get videoElement(): HTMLVideoElement | null {
    return this.layers ? this.layers[this.active] : null;
  }

  get time(): number {
    const el = this.currentEl();
    const segment = this.currentSegment();
    if (!el || !segment) return 0;
    return segment.virtIn + (el.currentTime - segment.srcIn);
  }

  async mount(container: HTMLElement): Promise<void> {
    container.style.position = 'relative';

    const a = createVideoElement();
    const b = createVideoElement();
    for (const el of [a, b]) {
      el.style.position = 'absolute';
      el.style.inset = '0';
      container.appendChild(el);
    }
    b.style.visibility = 'hidden';
    this.layers = [a, b];

    const bed = document.createElement('audio');
    bed.style.display = 'none';
    bed.volume = BED_LEVEL;
    container.appendChild(bed);
    this.bed = bed;

    for (const [i, el] of [a, b].entries()) {
      el.addEventListener('play', this.handleEvent);
      el.addEventListener('pause', this.handleEvent);
      el.addEventListener('timeupdate', this.handleEvent);
      el.addEventListener('error', () => {
        if (i === this.active) this.reportMediaError(el);
      });
    }
    this.startTick();
  }

  subscribe(cb: (s: PlayerState) => void): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => this.listeners.delete(cb);
  }

  async load(source: PlaySource | null, opts: LoadOptions = {}): Promise<void> {
    this.stopLayers();
    this.source = source;
    this.prerolledFor = null;
    this.error = null;

    if (!source || !this.layers) {
      this.emit();
      return;
    }

    const seekTo = Math.max(0, Math.min(opts.seekTo ?? 0, source.timeline.duration - 0.05));
    this.loadAt(seekTo);
    this.emit();
    if (opts.autoplay) await this.play();
  }

  async play(): Promise<void> {
    const el = this.currentEl();
    try {
      await el?.play();
    } catch {
      /* autoplay policy */
    }
    this.updateBed();
    this.emit();
  }

  pause(): void {
    this.currentEl()?.pause();
    this.stopBed();
    this.emit();
  }

  seek(time: number): void {
    if (!this.source) return;
    const wasPlaying = this.isPlaying();
    this.prerolledFor = null;
    this.stopBed();
    this.loadAt(Math.max(0, Math.min(time, this.source.timeline.duration - 0.05)));
    if (wasPlaying) void this.play();
    this.emit();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopLayers();
    this.stopBed();
    for (const el of this.layers ?? []) {
      el.pause();
      el.removeAttribute('src');
      el.remove();
    }
    this.bed?.remove();
    this.layers = null;
    this.bed = null;
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ loading

  private loadAt(virtualTime: number): void {
    const src = this.source;
    const el = this.currentEl();
    if (!src || !el) return;

    const hit = locate(src.timeline, virtualTime);
    if (!hit) return;
    this.index = hit.index;

    const asset = src.assets.get(hit.segment.assetId);
    if (!asset) return;
    el.src = asset.url;
    el.currentTime = hit.srcTime;
    el.muted = false;
    this.showLayer(this.active);
  }

  // ------------------------------------------------------------------ proroll

  private nextSegment(): Segment | null {
    const src = this.source;
    if (!src) return null;
    return src.timeline.segments[this.index + 1] ?? null;
  }

  private preroll(): void {
    const src = this.source;
    const next = this.nextSegment();
    if (!src || !next || !this.layers) return;
    if (this.prerolledFor === next.id) return;

    const asset = src.assets.get(next.assetId);
    if (!asset) return;

    const inactive = this.layers[1 - this.active];
    inactive.src = asset.url;
    inactive.currentTime = next.srcIn;
    inactive.muted = true;
    void inactive.play().catch(() => {});
    this.prerolledFor = next.id;
  }

  /** Step 4 of `docs/04-simple-engine.md`: swap at the boundary. */
  private swap(): void {
    const next = this.nextSegment();
    const src = this.source;
    if (!next || !src || !this.layers) return;

    const budget = this.prerolledFor === next.id;
    const outgoing = this.layers[this.active];

    this.active = 1 - this.active;
    this.index += 1;
    const incoming = this.layers[this.active];
    this.showLayer(this.active);

    incoming.muted = false;
    if (!budget) {
      const asset = src.assets.get(next.assetId);
      incoming.src = asset?.url ?? '';
      incoming.currentTime = next.srcIn;
    }
    void incoming.play().catch(() => {});
    outgoing.pause();

    this.prerolledFor = null;
    this.updateBed();
    this.emit();
  }

  private showLayer(index: number): void {
    if (!this.layers) return;
    this.layers[index].style.visibility = 'visible';
    this.layers[1 - index].style.visibility = 'hidden';
  }

  // ---------------------------------------------------------------------- bed

  /** Step 2 of `docs/07-audio-modes.md`: loop the audio just before the cut. */
  private updateBed(): void {
    const src = this.source;
    const segment = this.currentSegment();
    if (!this.bed || !src || !segment) return;

    const shouldPlay = false; // 'mix' needed an AAC encoder, which WebCodecs lacks
    if (!shouldPlay) {
      this.stopBed();
      return;
    }

    const cut = this.mainCutBefore(this.index);
    const asset = src.assets.get(src.timeline.segments[0]?.assetId ?? '');
    if (!asset) return;

    if (this.bed.dataset.cut !== String(cut)) {
      this.bed.dataset.cut = String(cut);
      this.bed.src = asset.url;
      this.bed.currentTime = Math.max(0, cut - BED_WINDOW);
    }
    if (this.bed.paused) void this.bed.play().catch(() => {});
  }

  private stopBed(): void {
    if (!this.bed) return;
    this.bed.pause();
  }

  private bedTick(): void {
    const bed = this.bed;
    if (!bed || bed.paused) return;
    const cut = Number(bed.dataset.cut ?? 0);
    if (bed.currentTime >= cut - 0.02) {
      bed.currentTime = Math.max(0, cut - BED_WINDOW);
    }
  }

  private mainCutBefore(index: number): number {
    const segments = this.source?.timeline.segments ?? [];
    for (let i = index - 1; i >= 0; i--) {
      if (segments[i].kind === 'main') return segments[i].srcOut;
    }
    return 0;
  }

  // --------------------------------------------------------------------- tick

  private startTick(): void {
    if (this.ticking) return;
    this.ticking = true;
    const el = this.currentEl();
    if (el?.requestVideoFrameCallback) {
      const frame = () => {
        if (this.destroyed) return;
        this.tick();
        const next = this.currentEl();
        next?.requestVideoFrameCallback?.(frame);
      };
      el.requestVideoFrameCallback(frame);
    } else {
      const loop = () => {
        if (this.destroyed) return;
        this.tick();
        setTimeout(loop, 40);
      };
      loop();
    }
  }

  private tick(): void {
    const src = this.source;
    const el = this.currentEl();
    const segment = this.currentSegment();
    if (!src || !el || !segment) return;

    this.bedTick();

    const remaining = segment.srcOut - el.currentTime;
    if (remaining <= LEAD) this.preroll();
    if (remaining <= 0.02 && this.nextSegment()) this.swap();
    else if (remaining <= 0.02 && !this.nextSegment()) el.pause();

    if (remaining <= LEAD) this.emit();
  }

  private currentEl(): HTMLVideoElement | null {
    return this.layers ? this.layers[this.active] : null;
  }

  private currentSegment(): Segment | null {
    return this.source?.timeline.segments[this.index] ?? null;
  }

  private isPlaying(): boolean {
    return this.currentEl() ? !this.currentEl()!.paused : false;
  }

  private stopLayers(): void {
    for (const el of this.layers ?? []) {
      el.pause();
      el.removeAttribute('src');
    }
    this.stopBed();
  }

  private reportMediaError(el: HTMLVideoElement): void {
    this.error = el.error ? `Media error ${el.error.code}: ${el.error.message}` : 'Media error';
    this.emit();
  }

  private handleEvent = (): void => {
    this.updateBed();
    this.emit();
  };

  private emit(): void {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    requestAnimationFrame(() => {
      this.emitScheduled = false;
      const src = this.source;
      const el = this.currentEl();
      const segment = this.currentSegment();
      const timeline: Timeline | null = src?.timeline ?? null;

      let label = '';
      if (src && timeline) {
        const seg = segment ?? findSegment(timeline, this.time)?.segment;
        const asset: IndexedAsset | undefined = seg ? src.assets.get(seg.assetId) : undefined;
        const index = seg ? timeline.segments.indexOf(seg) : -1;
        label = index >= 0 ? `${index + 1}/${timeline.segments.length} · ${asset?.meta.name ?? ''}` : '';
      }

      this.state = {
        time: this.time,
        duration: timeline?.duration ?? 0,
        paused: el?.paused ?? true,
        buffered: el?.buffered ? rangesToArray(el.buffered) : [],
        appending: 0,
        rendered: this.state.rendered,
        lastError: this.error,
        segmentLabel: label,
      };
      for (const cb of this.listeners) cb(this.state);
    });
  }
}

/** Exposed for the HUD: how much virtual time has been mapped back to main time. */
export function mainTimeAt(src: PlaySource, virtualTime: number): number {
  const hit = locate(src.timeline, virtualTime);
  if (!hit) return toVirtual(src.timeline, 0);
  return hit.segment.kind === 'main' ? hit.srcTime : hit.segment.srcIn;
}
