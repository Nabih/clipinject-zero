import { muxSegmentAudio, muxSilence, splitAudioSegment } from '../media/audioPlan';
import { audioMimeType, videoMimeType } from '../media/codec';
import type { IndexedAsset } from '../media/types';
import { locate, segmentsIn } from '../timeline/map';
import type { Segment } from '../timeline/types';
import {
  createVideoElement,
  emptyState,
  rangesToArray,
  type BufferedRange,
  type EngineKind,
  type LoadOptions,
  type PlaySource,
  type PlayerEngine,
  type PlayerState,
} from './types';

/** Seconds of overrun tolerated on a segment's final fragment. */
const TAIL_TOLERANCE = 0.05;
const LOOKAHEAD = 30;
const KEEP_BEHIND = 20;
const REBUFFER_BEHIND = 2;

export interface AppendTrace {
  kind: 'video' | 'audio' | 'video-init';
  at: number;
  offset: number;
  bytes: number;
  assetId: string;
}

interface AppendJob {
  key: string;
  assetId: string;
  /** Virtual time the job lands at, used to keep queues ordered. */
  at: number;
  /** `virtIn - srcIn` for the owning segment. */
  offset: number;
  data: Uint8Array;
}

function byAt(a: AppendJob, b: AppendJob): number {
  return a.at - b.at;
}

/**
 * Resolve once the SourceBuffer stops updating.
 *
 * Bounded: `abort()` does not always produce an `updateend` in every case, and a
 * flush that waits forever would wedge every subsequent load and seek.
 */
function waitIdle(sb: SourceBuffer, timeoutMs = 1200): Promise<void> {
  if (!sb.updating) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      sb.removeEventListener('updateend', done);
      sb.removeEventListener('abort', done);
      sb.removeEventListener('error', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    sb.addEventListener('updateend', done);
    sb.addEventListener('abort', done);
    sb.addEventListener('error', done);
  });
}

/**
 * Method A — one `<video>`, one `MediaSource`, two `SourceBuffer`s.
 *
 * `docs/03-native-mse-engine.md` is the specification; step numbers in the
 * comments refer to it.
 */
export class MseEngine implements PlayerEngine {
  readonly kind: EngineKind = 'native';

  private container: HTMLElement | null = null;
  private ownsElement = false;
  private el: HTMLVideoElement | null = null;
  private ms: MediaSource | null = null;
  private url: string | null = null;
  private sbv: SourceBuffer | null = null;
  private sba: SourceBuffer | null = null;

  private vMime = '';
  private aMime: string | null = null;

  private source: PlaySource | null = null;
  private vQueue: AppendJob[] = [];
  private aQueue: AppendJob[] = [];
  private vPlanned = new Set<string>();
  private aPlanned = new Set<string>();
  private vInitDone = false;
  private aInitDone = false;
  private aInit: Uint8Array | null = null;
  private audioCache = new Map<string, Uint8Array | null>();

  /** Every append this engine issues, for debugging the splice. */
  readonly trace: AppendTrace[] = [];

  private listeners = new Set<(s: PlayerState) => void>();
  private state: PlayerState = emptyState();
  private error: string | null = null;
  private emitScheduled = false;
  private seekToken = 0;
  /** Seeks are serialised: two overlapping flushes leave the element stuck. */
  private seekChain: Promise<void> = Promise.resolve();
  /** While true the pump must not plan anything — a flush is tearing down. */
  private flushing = false;
  private seekTarget: number | null = null;
  private destroyed = false;

  get videoElement(): HTMLVideoElement | null {
    return this.el;
  }

  get time(): number {
    return this.el?.currentTime ?? 0;
  }

  async mount(container: HTMLElement): Promise<void> {
    const video = createVideoElement();
    container.appendChild(video);
    this.ownsElement = true;
    this.attach(video);
  }

  /**
   * Drive an existing element instead of creating one. video.js hands us its own
   * tech element, which must stay where it is.
   */
  attach(video: HTMLVideoElement): void {
    this.container = video.parentElement;
    this.el = video;
    this.wireElement(video);
  }

  subscribe(cb: (s: PlayerState) => void): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => this.listeners.delete(cb);
  }

  // ---------------------------------------------------------------- source

  async load(source: PlaySource | null, opts: LoadOptions = {}): Promise<void> {
    if (this.destroyed || !this.el) return;

    // A seek still flushing must finish first; its flush would otherwise land in
    // the middle of this load and abort the appends this one just planned.
    await this.seekChain;

    if (!source) {
      await this.flushAll();
      this.source = null;
      this.vPlanned.clear();
      this.aPlanned.clear();
      this.audioCache.clear();
      this.emit();
      return;
    }

    const vMime = videoMimeType(source.videoCodec);
    const aMime = source.audioConfig ? audioMimeType(source.audioConfig.codec) : null;

    await this.ensureMediaSource(vMime, aMime);
    await this.flushAll();

    this.source = source;
    this.audioCache.clear();
    this.vInitDone = false;
    this.aInitDone = false;
    this.aInit = null;
    this.error = null;
    this.seekTarget = null;

    if (this.ms && this.ms.readyState === 'open') {
      try {
        this.ms.duration = Math.max(source.timeline.duration, 0.1);
      } catch {
        /* duration can only be set while open */
      }
    }

    const seekTo = Math.max(0, Math.min(opts.seekTo ?? 0, Math.max(source.timeline.duration - 0.05, 0)));
    // Remember the target so the `seeking` handler does not immediately flush
    // again what we just flushed.
    this.seekTarget = seekTo;
    try {
      if (Math.abs(this.el.currentTime - seekTo) > 0.01) this.el.currentTime = seekTo;
    } catch {
      /* not seekable yet */
    }
    setTimeout(() => {
      if (this.seekTarget !== null && Math.abs(this.seekTarget - seekTo) < 1e-9) this.seekTarget = null;
    }, 400);

    this.pump();
    this.emit();

    if (opts.autoplay) await this.play();
  }

  // ------------------------------------------------------------- media source

  private async ensureMediaSource(vMime: string, aMime: string | null): Promise<void> {
    if (this.ms && this.vMime === vMime && this.aMime === aMime) return;
    if (!this.el) return;

    // Codec configuration changed: this is a new stream, not an edit.
    this.teardownMediaSource();
    const ms = new MediaSource();
    this.ms = ms;
    this.url = URL.createObjectURL(ms);
    this.el.src = this.url;

    await new Promise<void>((resolve) => {
      if (ms.readyState === 'open') return resolve();
      ms.addEventListener('sourceopen', () => resolve(), { once: true });
    });

    this.vMime = vMime;
    this.aMime = aMime;

    const sbv = ms.addSourceBuffer(vMime);
    sbv.mode = 'segments';
    sbv.addEventListener('updateend', this.onUpdateEnd);
    sbv.addEventListener('error', this.onBufferError);
    this.sbv = sbv;

    if (aMime) {
      const sba = ms.addSourceBuffer(aMime);
      sba.mode = 'segments';
      sba.addEventListener('updateend', this.onUpdateEnd);
      sba.addEventListener('error', this.onBufferError);
      this.sba = sba;
    }
  }

  private teardownMediaSource(): void {
    for (const sb of [this.sbv, this.sba]) {
      if (!sb) continue;
      sb.removeEventListener('updateend', this.onUpdateEnd);
      sb.removeEventListener('error', this.onBufferError);
      try {
        if (this.ms && this.ms.readyState === 'open') this.ms.removeSourceBuffer(sb);
      } catch {
        /* already gone */
      }
    }
    this.sbv = null;
    this.sba = null;
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.ms = null;
    this.vMime = '';
    this.aMime = null;
  }

  // ---------------------------------------------------------------- scheduler

  /** Step 4: fill both queues from the window around the playhead. */
  private pump(): void {
    const src = this.source;
    if (!src || !this.el || this.destroyed || this.flushing) return;

    const now = this.el.currentTime || 0;
    const window = segmentsIn(src.timeline, Math.max(0, now - REBUFFER_BEHIND), now + LOOKAHEAD);

    for (const segment of window) {
      const asset = assetOf(src, segment);
      if (!asset) continue;
      this.planVideo(segment, asset);
      this.planAudio(segment, asset, src);
    }

    this.vQueue.sort(byAt);
    this.aQueue.sort(byAt);
    this.pumpVideo();
    this.pumpAudio();
  }

  private planVideo(segment: Segment, asset: IndexedAsset): void {
    const offset = segment.virtIn - segment.srcIn;
    for (let i = 0; i < asset.fragments.length; i++) {
      const frag = asset.fragments[i];
      // Only whole fragments that sit entirely inside the segment: cut points
      // are fragment starts, so this is exact by construction.
      if (frag.start < segment.srcIn - 1e-3) continue;
      // A file's last fragment usually runs a fraction of a frame past the
      // container duration (30.016 s in a 30 s file). Dropping it lost the final
      // GOP; a sub-frame overrun is harmless, a whole fragment of overrun is not.
      if (frag.end > segment.srcOut + TAIL_TOLERANCE) continue;

      const key = `${segment.id}#${i}`;
      if (this.vPlanned.has(key)) continue;
      this.vPlanned.add(key);
      this.vQueue.push({
        key,
        assetId: segment.assetId,
        at: segment.virtIn + (frag.start - segment.srcIn),
        offset,
        data: frag.data,
      });
    }
  }

  private planAudio(segment: Segment, asset: IndexedAsset, src: PlaySource): void {
    if (!this.sba || !src.audioConfig) return;

    const key = `${segment.id}@${src.audioMode}`;
    if (this.aPlanned.has(key)) return;
    this.aPlanned.add(key);

    let data = this.audioCache.get(key);
    if (data === undefined) {
      // `mix` needs the clip and the bed summed, which is impossible without
      // decoding and re-encoding AAC. The MSE engine therefore behaves like
      // `replace` and the UI says so; SimpleEngine does implement the bed.
      const muted = segment.kind === 'clip' && src.audioMode === 'silent';
      // Never leave a hole: Chrome stalls the element when the audio track has a
      // gap ahead of the playhead. "No audio here" has to be real silence.
      data =
        (!muted && muxSegmentAudio(segment, asset, src.audioConfig)) ||
        muxSilence(segment.virtOut - segment.virtIn, src.audioConfig);
      this.audioCache.set(key, data);
    }
    if (!data) return;

    this.aQueue.push({
      key,
      assetId: segment.assetId,
      at: segment.virtIn,
      // Audio timestamps are already relative to the segment's own `srcIn`
      // (muxed from 0), so the placement offset is the virtual start — *not*
      // `virtIn - srcIn`. Using the video rule here shifted every audio segment
      // after the first splice back to `srcIn` seconds and silently overlapped
      // the previous audio.
      offset: segment.virtIn,
      data,
    });
  }

  /**
   * Step 5: video needs an init segment per asset, then one offset per segment.
   *
   * Exactly one init segment is appended per flush, bundled with the first
   * fragment, and never again for the rest of the stream.
   *
   * Measured behaviour: appending a second, *different* init mid-stream makes
   * Chrome discard the first GOP that follows it (a ~1.6 s frozen picture at
   * every splice back to the main video). With a byte-identical init it does not.
   * Since the whole edit is required to share one codec string, the first init is
   * the right configuration for every fragment; re-initialising buys nothing and
   * costs a GOP. See `HANDOFF.md` §7 for the experiment that established this.
   */
  private pumpVideo(): void {
    const sb = this.sbv;
    const src = this.source;
    if (!sb || !src || sb.updating || !this.vQueue.length) return;

    const job = this.vQueue[0];

    if (!this.vInitDone) {
      const asset = src.assets.get(job.assetId);
      if (!asset) {
        this.vQueue.shift();
        return;
      }
      this.vInitDone = true;
      this.vQueue.shift();
      const merged = concatBytes(asset.videoInit, job.data);
      this.record('video', job.at, job.offset, merged.byteLength, job.assetId);
      this.append(sb, merged, job.offset, 'video');
      return;
    }

    this.vQueue.shift();
    this.record('video', job.at, job.offset, job.data.byteLength, job.assetId);
    this.append(sb, job.data, job.offset, 'video');
  }

  /** Step 6: audio is self-contained per segment, so it only needs its offset. */
  private pumpAudio(): void {
    const sb = this.sba;
    if (!sb || sb.updating || !this.aQueue.length) return;
    const job = this.aQueue.shift()!;
    const { init, media } = splitAudioSegment(job.data);

    if (!this.aInitDone) {
      this.aInitDone = true;
      if (init.byteLength && !this.aInit) this.aInit = init;
      const merged = this.aInit ? concatBytes(this.aInit, media) : job.data;
      this.record('audio', job.at, job.offset, merged.byteLength, job.assetId);
      this.append(sb, merged, job.offset, 'audio');
      return;
    }

    this.record('audio', job.at, job.offset, media.byteLength, job.assetId);
    this.append(sb, media, job.offset, 'audio');
  }

  private record(kind: AppendTrace['kind'], at: number, offset: number, bytes: number, assetId: string): void {
    this.trace.push({ kind, at, offset, bytes, assetId });
    if (this.trace.length > 400) this.trace.shift();
  }

  private append(
    sb: SourceBuffer,
    data: Uint8Array,
    offset: number | undefined,
    kind: 'video' | 'audio',
  ): void {
    try {
      if (offset !== undefined && Math.abs(sb.timestampOffset - offset) > 1e-6) {
        sb.timestampOffset = offset;
      }
      sb.appendBuffer(data as unknown as BufferSource);
    } catch (err) {
      this.onAppendFailure(err, kind);
    }
  }

  private onAppendFailure(err: unknown, kind: 'video' | 'audio'): void {
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'QuotaExceededError') {
      this.evict(true);
      // Retry once after eviction; if the queue is drained we simply stop.
      setTimeout(() => {
        if (this.source) this.pump();
      }, 50);
      return;
    }
    this.error = `${kind} append failed: ${name || String(err)}`;
    if (kind === 'video') this.vInitDone = false;
    this.emit();
  }

  private onUpdateEnd = (): void => {
    if (this.destroyed) return;
    this.state.rendered += 1;
    this.evict(false);
    this.maybeEndStream();
    this.pump();
    this.emit();
  };

  private onBufferError = (): void => {
    this.error = 'SourceBuffer reported an error.';
    this.emit();
  };

  // ----------------------------------------------------------------- eviction

  /** Step 7: drop what is well behind the playhead, one range at a time. */
  private evict(force: boolean): void {
    const sb = this.sbv;
    if (!sb || sb.updating || !this.el) return;

    const threshold = this.el.currentTime - (force ? 0 : KEEP_BEHIND);
    const ranges = sb.buffered;
    for (let i = 0; i < ranges.length; i++) {
      const start = ranges.start(i);
      const end = ranges.end(i);
      if (end < threshold) {
        try {
          sb.remove(start, end);
        } catch {
          /* ignore */
        }
        return;
      }
    }
  }

  // --------------------------------------------------------------------- eos

  private maybeEndStream(): void {
    const ms = this.ms;
    const src = this.source;
    if (!ms || !src || ms.readyState !== 'open' || !this.sbv) return;
    if (this.vQueue.length) return;

    const last = src.timeline.segments.at(-1);
    if (!last) return;
    const asset = assetOf(src, last);
    if (!asset) return;

    const allPlanned = asset.fragments.every((_, i) => this.vPlanned.has(`${last.id}#${i}`));
    if (!allPlanned) return;

    const buffered = this.sbv.buffered;
    if (!buffered.length) return;
    if (buffered.end(buffered.length - 1) < src.timeline.duration - 0.25) return;

    try {
      ms.endOfStream();
    } catch {
      /* already ended */
    }
  }

  // ----------------------------------------------------------------- seeking

  /** Step 8: a seek outside the window flushes and refills. */
  private handleSeeking = (): void => {
    if (!this.el || !this.source) return;
    const target = this.el.currentTime;
    if (this.isCovered(target)) return;
    this.requestSeek(target);
  };

  private isCovered(target: number): boolean {
    const sb = this.sbv;
    if (!sb) return false;
    const ranges = sb.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (target >= ranges.start(i) - 0.05 && target < ranges.end(i) - 0.4) return true;
    }
    return false;
  }

  /**
   * Seeking must be idempotent. Writing `currentTime` inside a seek fires
   * `seeking` again, which would flush and refill forever; the target guard is
   * what stops that.
   */
  private requestSeek(target: number): void {
    if (this.seekTarget !== null && Math.abs(this.seekTarget - target) < 0.05) return;
    this.seekTarget = target;
    this.enqueueSeek(target);
  }

  /**
   * Run one seek at a time, always the most recent target.
   *
   * Rapid seeks (drag the scrubber, or two probes in a row) used to interleave
   * their flushes: the second `abort()` killed the first seek's appends after it
   * had already cleared the plan set, and the element stayed in `seeking` with an
   * empty buffer forever.
   */
  private enqueueSeek(target: number): void {
    this.seekChain = this.seekChain.then(() => this.runSeek(target)).catch(() => {});
  }

  private async runSeek(target: number): Promise<void> {
    const token = ++this.seekToken;
    const wasPlaying = this.el ? !this.el.paused : false;

    await this.flushAll();
    if (token !== this.seekToken || this.destroyed || !this.el) return;

    try {
      if (Math.abs(this.el.currentTime - target) > 0.01) this.el.currentTime = target;
    } catch {
      /* ignore */
    }
    this.pump();
    if (wasPlaying) void this.play().catch(() => {});

    setTimeout(() => {
      if (token === this.seekToken) this.seekTarget = null;
    }, 300);
  }

  private async flushAll(): Promise<void> {
    // Planning during a flush is how a fragment ends up marked as appended while
    // its append was aborted, which strands the playhead with an empty buffer and
    // nothing left to plan. Gate the pump for the whole teardown.
    this.flushing = true;
    try {
      await Promise.all([this.flushBuffer(this.sbv), this.flushBuffer(this.sba)]);
      this.vQueue = [];
      this.aQueue = [];
      this.vPlanned.clear();
      this.aPlanned.clear();
      this.vInitDone = false;
      this.aInitDone = false;
      this.aInit = null;
    } finally {
      this.flushing = false;
    }
    // Callers pump explicitly once they have installed the new source: pumping
    // here would plan against whatever source happened to be installed mid-load.
  }

  private async flushBuffer(sb: SourceBuffer | null): Promise<void> {
    if (!sb) return;
    if (sb.buffered.length === 0 && !sb.updating) return;
    if (sb.updating) {
      try {
        sb.abort();
      } catch {
        /* ignore */
      }
    }
    await waitIdle(sb);
    const duration = this.ms?.duration ?? 0;
    try {
      sb.remove(0, Number.isFinite(duration) && duration > 0 ? duration : 1e9);
    } catch {
      return;
    }
    await waitIdle(sb);
  }

  // ------------------------------------------------------------------ control

  async play(): Promise<void> {
    try {
      await this.el?.play();
    } catch {
      /* autoplay policy; the UI will show paused */
    }
    this.emit();
  }

  pause(): void {
    this.el?.pause();
    this.emit();
  }

  seek(time: number): void {
    if (!this.el) return;
    const clamped = Math.max(0, Math.min(time, this.source?.timeline.duration ?? time));
    if (this.isCovered(clamped)) {
      try {
        this.el.currentTime = clamped;
      } catch {
        /* ignore */
      }
      this.emit();
      return;
    }
    this.seekTarget = clamped;
    this.el.currentTime = clamped;
    this.enqueueSeek(clamped);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.el) {
      this.el.removeEventListener('seeking', this.handleSeeking);
      this.el.removeEventListener('timeupdate', this.handleTimeUpdate);
      this.el.removeEventListener('play', this.handleTimeUpdate);
      this.el.removeEventListener('pause', this.handleTimeUpdate);
      this.el.removeEventListener('error', this.handleMediaError);
      this.el.removeEventListener('waiting', this.handleTimeUpdate);
      this.el.removeEventListener('canplay', this.handleTimeUpdate);
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
    }
    this.teardownMediaSource();
    if (this.ownsElement && this.el?.parentElement === this.container) this.el.remove();
    this.el = null;
    this.listeners.clear();
  }

  // -------------------------------------------------------------------- state

  private wireElement(el: HTMLVideoElement): void {
    el.addEventListener('seeking', this.handleSeeking);
    el.addEventListener('timeupdate', this.handleTimeUpdate);
    el.addEventListener('play', this.handleTimeUpdate);
    el.addEventListener('pause', this.handleTimeUpdate);
    el.addEventListener('waiting', this.handleTimeUpdate);
    el.addEventListener('canplay', this.handleTimeUpdate);
    el.addEventListener('error', this.handleMediaError);
  }

  private handleTimeUpdate = (): void => {
    this.pump();
    this.emit();
  };

  private handleMediaError = (): void => {
    const code = this.el?.error?.code;
    if (code) this.error = `Media error ${code}: ${this.el?.error?.message ?? ''}`;
    this.emit();
  };

  /** Step 12: HUD state. */
  private emit(): void {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    requestAnimationFrame(() => {
      this.emitScheduled = false;
      const el = this.el;
      const src = this.source;
      let buffered: BufferedRange[] = [];
      try {
        buffered = this.sbv ? rangesToArray(this.sbv.buffered) : [];
      } catch {
        buffered = [];
      }

      let label = '';
      if (src && el) {
        const hit = locate(src.timeline, el.currentTime);
        if (hit) {
          const asset = src.assets.get(hit.segment.assetId);
          const index = src.timeline.segments.indexOf(hit.segment);
          label = `${index + 1}/${src.timeline.segments.length} · ${asset?.meta.name ?? hit.segment.assetId}`;
        }
      }

      this.state = {
        time: el?.currentTime ?? 0,
        duration: src?.timeline.duration ?? 0,
        paused: el?.paused ?? true,
        buffered,
        appending: this.vQueue.length + this.aQueue.length,
        rendered: this.state.rendered,
        lastError: this.error,
        segmentLabel: label,
      };
      for (const cb of this.listeners) cb(this.state);
    });
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function assetOf(src: PlaySource, segment: Segment): IndexedAsset | undefined {
  return src.assets.get(segment.assetId);
}
