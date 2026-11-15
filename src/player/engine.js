/**
 * Playback: one `<video>`, one `MediaSource`, one `SourceBuffer`.
 *
 * The shape of this engine follows from writing our own fragments:
 *
 * - **One buffer for both tracks.** Every fragment carries its video and audio
 *   `traf` in the same `moof`, so there is no second buffer to keep in step and no
 *   `timestampOffset` per track to get wrong.
 * - **Absolute `tfdt`, zero `timestampOffset`.** Fragments state the virtual time
 *   they belong at, so an append means exactly what it says. Editing therefore
 *   means "remove from here and re-append", never "re-time the stream".
 * - **No audio hole, by construction.** A segment's audio is filled to its exact
 *   length — from the clip, or with real AAC silence — inside the same fragment as
 *   the video. The audio-sourcebuffer-stall bug has nothing to attach to.
 * - **`src` is assigned once.** Nothing here ever reassigns it.
 */

import { buildInit, buildSegment } from '../media/frag.js';
import { readSampleBytes, samplesInRange, samplesInRangeWithPreroll } from '../media/mp4.js';
import { canSilence, silenceFor } from '../media/silence.js';

const LOOKAHEAD = 16;
/** Seconds of media per fragment. Keeps appends (and memory) bounded on long mains. */
const CHUNK = 8;
/** Re-append this much behind the playhead so a small seek back does not stall. */
const KEEP_BEHIND = 4;

export class Player {
  /**
   * @param {HTMLVideoElement} video
   * @param {{ onStatus?: (status: any) => void, audioMode?: 'replace'|'silent' }} [options]
   */
  constructor(video, options = {}) {
    this.video = video;
    this.onStatus = options.onStatus ?? (() => {});
    /** 'replace' plays clip audio; 'silent' replaces it with real silence. */
    this.audioMode = options.audioMode ?? 'replace';
    /** @type {any} */
    this.main = null;
    /** @type {any} */
    this.plan = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.sourceBufferMime = null;
    this.sequence = 0;
    this.appendedThrough = 0;
    this.silenceFrames = 0;
    this.fragments = 0;
    this.bytesAppended = 0;
    this.rebuilds = 0;
    /** Nothing in the test suite reads this; it is here so a browser probe can. */
    this.trace = [];
    /** @type {Promise<void>} */
    this.lock = Promise.resolve();
    this.pumping = false;
    this.filling = false;
    /** Resolves once the init segment is in the buffer. */
    this.ready = Promise.resolve();
  }

  get mime() {
    const codecs = [this.main?.video.codec, this.main?.audio?.codec].filter(Boolean);
    return `video/mp4; codecs="${codecs.join(',')}"`;
  }

  /**
   * Attach to a main video. Creates the MediaSource and assigns `src` — once.
   * @param {any} main indexed main asset
   */
  async setMain(main) {
    // Never attach twice concurrently: the second call would tear down a buffer
    // the first is still filling.
    await this.ready;
    this.ready = this.#attach(main);
    await this.ready;
  }

  /** @param {any} main */
  async #attach(main) {
    this.main = main;
    this.plan = null;
    this.sequence = 0;
    this.appendedThrough = 0;
    this.silenceFrames = 0;
    this.fragments = 0;
    this.bytesAppended = 0;

    const mime = this.mime;
    if (!globalThis.MediaSource?.isTypeSupported(mime)) {
      throw new Error(`This browser cannot play ${mime}`);
    }

    if (!this.mediaSource) {
      this.mediaSource = new MediaSource();
      this.video.src = URL.createObjectURL(this.mediaSource);
      await new Promise((resolve) => {
        if (this.mediaSource.readyState === 'open') resolve(undefined);
        else this.mediaSource.addEventListener('sourceopen', () => resolve(undefined), { once: true });
      });
    }

    if (this.sourceBuffer && this.sourceBufferMime === mime) {
      // Same codecs: keep the buffer and flush it. Removing and re-adding a
      // SourceBuffer that has held data throws QuotaExceededError in Chrome, which
      // leaves the element with no buffer at all and appends silently doing nothing.
      const end = this.sourceBuffer.buffered.length
        ? this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1)
        : 0;
      if (end > 0) await this.#remove(0, end);
      this.plan = null;
      this.appendedThrough = 0;
      this.sequence = 0;
      this.fragments = 0;
      this.bytesAppended = 0;
      this.silenceFrames = 0;
      this.#emit();
      return;
    }
    if (this.sourceBuffer) {
      this.mediaSource.removeSourceBuffer(this.sourceBuffer);
      this.sourceBuffer = null;
    }
    this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
    this.sourceBufferMime = mime;
    this.sourceBuffer.mode = 'segments';
    await this.#appendBytes(buildInit(main));
    this.#emit();
  }

  /**
   * Replace the edit and rebuild the buffer from `fromTime`.
   * @param {any} plan
   * @param {number} [fromTime]
   */
  async setPlan(plan, fromTime) {
    // The UI can announce an edit before the main video finished attaching.
    await this.ready;
    if (!this.mediaSource || !this.sourceBuffer) return;
    this.plan = plan;
    this.mediaSource.duration = Math.max(plan.duration, 0.1);
    const start = fromTime ?? this.video.currentTime ?? 0;
    await this.#rebuild(Math.max(0, start - (start > KEEP_BEHIND ? KEEP_BEHIND : 0)));
    this.#emit();
  }

  /** Append more of the plan if the buffer is running low. */
  async pump() {
    if (!this.plan || !this.sourceBuffer || this.pumping) return;
    const time = this.video.currentTime;
    if (!Number.isFinite(time)) return;
    if (this.appendedThrough >= this.plan.duration - 1e-6) return;
    if (this.appendedThrough - time > LOOKAHEAD) return;
    this.pumping = true;
    let changed = false;
    try {
      changed = await this.#fill(time);
    } finally {
      this.pumping = false;
    }
    // Emitting on every frame would re-render the whole UI at 60 Hz for no reason;
    // the status only changes when bytes are appended.
    if (changed) this.#emit();
  }

  /**
   * @param {number} fromTime
   */
  async #rebuild(fromTime) {
    this.lock = this.lock.then(async () => {
      if (!this.plan || !this.sourceBuffer) return;
      this.rebuilds += 1;
      this.trace.push(`rebuild#${this.rebuilds}@${fromTime.toFixed(2)}`);
      const buffer = this.sourceBuffer;
      this.sequence = 0;
      this.appendedThrough = fromTime;
      this.silenceFrames = 0;
      this.fragments = 0;
      this.bytesAppended = 0;

      const end = buffer.buffered.length ? buffer.buffered.end(buffer.buffered.length - 1) : 0;
      if (end > fromTime + 1e-6) await this.#remove(fromTime, end);
      await this.#fill(fromTime);
    });
    await this.lock;
  }

  /**
   * Append the plan ahead of `fromTime`, one chunk at a time.
   *
   * Chunking matters more than it looks: a 2 hour main is one segment in the plan,
   * and appending it as a single fragment would mean one enormous `appendBuffer`
   * before anything could play. Fixed-size chunks also mean the append pattern is
   * the same shape for a 6 second clip and a 2 hour film.
   *
   * @param {number} fromTime
   */
  async #fill(fromTime) {
    // `setPlan` and `pump()` can both ask for more buffer, and `#fill` yields at
    // every append. Without this guard the two loops interleave and append the
    // same chunk twice — harmless to playback, wasteful of memory.
    if (this.filling) return false;
    this.filling = true;
    try {
      return await this.#fillUnsafe(fromTime);
    } finally {
      this.filling = false;
    }
  }

  /** @param {number} fromTime */
  async #fillUnsafe(fromTime) {
    const plan = this.plan;
    if (!plan) return false;
    const first = plan.segments.findIndex((s) => s.virtOut > fromTime + 1e-6);
    if (first === -1) return false;
    let changed = false;

    for (let i = first; i < plan.segments.length; i++) {
      const segment = plan.segments[i];
      let start = Math.max(this.appendedThrough, segment.virtIn);
      if (segment.virtOut <= start + 1e-6) continue;

      while (start < segment.virtOut - 1e-6) {
        // Enough is buffered ahead: stop, `pump()` will be called again later.
        if (this.appendedThrough > this.video.currentTime + LOOKAHEAD) return changed;
        const end = Math.min(segment.virtOut, start + CHUNK);
        const built = await this.#buildChunk(segment, start, end);
        if (!built) break;
        await this.#appendBytes(built.bytes);
        this.trace.push(`chunk ${start.toFixed(2)}-${end.toFixed(2)}`);
        this.appendedThrough = end;
        this.fragments++;
        this.bytesAppended += built.bytes.byteLength;
        this.silenceFrames += built.silenceFrames;
        start = end;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Build one fragment covering `[virtFrom, virtTo)` of a planned segment.
   *
   * @param {any} segment
   * @param {number} virtFrom
   * @param {number} virtTo
   */
  async #buildChunk(segment, virtFrom, virtTo) {
    const asset = segment.asset;
    const videoTrack = asset.video;
    const srcFrom = segment.srcIn + (virtFrom - segment.virtIn);
    const srcTo = segment.srcIn + (virtTo - segment.virtIn);

    // Backed up to a sync sample: a chunk that starts mid-GOP cannot be decoded.
    const videoSamples = samplesInRangeWithPreroll(videoTrack, srcFrom, srcTo);
    if (!videoSamples.length) return null;
    if (!videoSamples[0].sync) {
      throw new Error('internal: a fragment must start on a sync sample');
    }

    const videoPayload = await readSampleBytes(asset, videoSamples);
    /** @type {{ trackId: number, timescale: number, payload: Uint8Array, samples: any[] }[]} */
    const tracks = [
      {
        trackId: videoTrack.trackId,
        timescale: videoTrack.timescale,
        payload: videoPayload,
        samples: videoSamples.map((sample) => ({
          dtsTicks: Math.round((sample.dts - segment.srcIn + segment.virtIn) * videoTrack.timescale),
          durationTicks: Math.round(sample.duration * videoTrack.timescale),
          size: sample.size,
          ctsOffsetTicks: Math.round((sample.cts - sample.dts) * videoTrack.timescale),
          sync: sample.sync,
        })),
      },
    ];

    const audio = await this.#buildAudio(segment, srcFrom, srcTo, virtFrom, virtTo);
    if (audio) tracks.push(audio);

    return {
      bytes: buildSegment({ sequence: this.sequence++, tracks }),
      silenceFrames: audio?.silenceFrames ?? 0,
    };
  }

  /**
   * Audio for a chunk, filled to that chunk's exact length.
   *
   * Three cases, all ending in a full-length audio track: the asset has compatible
   * audio, the asset's audio ends early (or starts late), or there is nothing
   * usable at all — no track, or a decoder configuration that cannot be muxed into
   * the main's audio track. Silence is a real AAC frame, so the buffer never has a
   * gap for the element to stall on.
   *
   * @param {any} segment
   * @param {number} srcFrom
   * @param {number} srcTo
   * @param {number} virtFrom
   * @param {number} virtTo
   */
  async #buildAudio(segment, srcFrom, srcTo, virtFrom, virtTo) {
    const mainAudio = this.main?.audio;
    if (!mainAudio) return null;
    const asset = segment.asset;
    const compatible =
      this.audioMode !== 'silent' &&
      asset.audio &&
      asset.audio.codec === mainAudio.codec &&
      asset.audio.sampleRate === mainAudio.sampleRate &&
      asset.audio.channels === mainAudio.channels &&
      canSilence(mainAudio.channels);

    /** @type {{ dts: number, duration: number, size: number, offset: number }[]} */
    const picked = [];
    if (compatible) {
      for (const sample of samplesInRange(asset.audio, srcFrom, srcTo)) {
        picked.push({
          dts: sample.dts - segment.srcIn + segment.virtIn,
          duration: sample.duration,
          size: sample.size,
          offset: sample.offset,
        });
      }
    }

    /** @type {Uint8Array[]} */
    const parts = [];
    /** @type {any[]} */
    const samples = [];
    let silenceFrames = 0;

    const pushSilence = (start, length) => {
      if (length <= 1e-6) return;
      const silence = silenceFor({
        startSec: start,
        durationSec: length,
        sampleRate: mainAudio.sampleRate,
        channels: mainAudio.channels,
      });
      if (!silence) return;
      parts.push(silence.payload);
      silenceFrames += silence.frameCount;
      for (const sample of silence.samples) {
        samples.push({
          dtsTicks: Math.round(sample.dts * mainAudio.timescale),
          durationTicks: Math.round(sample.duration * mainAudio.timescale),
          size: silence.payload.byteLength / silence.samples.length,
          ctsOffsetTicks: 0,
          sync: true,
        });
      }
    };

    let cursor = virtFrom;

    if (picked.length) {
      const first = picked[0];
      if (first.dts > cursor + 1e-6) pushSilence(cursor, first.dts - cursor);
      // One contiguous read for the run: consecutive AAC frames live together.
      const payload = await readSampleBytes(asset, picked);
      parts.push(payload);
      for (const sample of picked) {
        if (sample.dts + sample.duration <= virtFrom + 1e-6) continue;
        samples.push({
          dtsTicks: Math.round(sample.dts * mainAudio.timescale),
          durationTicks: Math.round(sample.duration * mainAudio.timescale),
          size: sample.size,
          ctsOffsetTicks: 0,
          sync: true,
        });
        cursor = Math.max(cursor, sample.dts + sample.duration);
      }
    }

    if (cursor < virtTo - 1e-6) pushSilence(cursor, virtTo - cursor);
    if (!samples.length) return null;

    const payload = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
      payload.set(part, at);
      at += part.byteLength;
    }
    if (samples.reduce((n, s) => n + s.size, 0) !== payload.byteLength) {
      throw new Error('audio payload and sample table disagree');
    }

    return { trackId: mainAudio.trackId, timescale: mainAudio.timescale, payload, samples, silenceFrames };
  }

  /**
   * Append, waiting for any in-flight append first.
   *
   * `SourceBuffer.appendBuffer` throws if it is called while `updating`, so calls
   * are serialised here rather than at every call site.
   *
   * @param {Uint8Array} bytes
   */
  async #appendBytes(bytes) {
    const buffer = this.sourceBuffer;
    if (!buffer) throw new Error('no SourceBuffer');
    while (buffer.updating) await this.#settled();
    await new Promise((resolve, reject) => {
      const onEnd = () => {
        buffer.removeEventListener('updateend', onEnd);
        resolve(undefined);
      };
      buffer.addEventListener('updateend', onEnd, { once: true });
      buffer.addEventListener('error', () => reject(new Error('SourceBuffer error')), { once: true });
      try {
        buffer.appendBuffer(bytes);
      } catch (error) {
        buffer.removeEventListener('updateend', onEnd);
        reject(error);
      }
    });
  }

  /** Resolve on the next `updateend`. */
  #settled() {
    return new Promise((resolve) => {
      const buffer = this.sourceBuffer;
      if (!buffer || !buffer.updating) {
        resolve(undefined);
        return;
      }
      buffer.addEventListener('updateend', () => resolve(undefined), { once: true });
    });
  }

  /** @param {number} start @param {number} end */
  async #remove(start, end) {
    const buffer = this.sourceBuffer;
    if (!buffer) return;
    while (buffer.updating) await this.#settled();
    await new Promise((resolve) => {
      const onEnd = () => {
        buffer.removeEventListener('updateend', onEnd);
        resolve(undefined);
      };
      buffer.addEventListener('updateend', onEnd, { once: true });
      // Removing beyond the buffered end is legal; the browser clamps it.
      buffer.remove(start, Math.max(end, start + 0.05));
    });
  }

  #emit() {
    const buffered = [];
    const buffer = this.sourceBuffer?.buffered;
    if (buffer) for (let i = 0; i < buffer.length; i++) buffered.push([buffer.start(i), buffer.end(i)]);
    this.onStatus({
      mime: this.mime,
      buffered,
      appendedThrough: this.appendedThrough,
      fragments: this.fragments,
      bytesAppended: this.bytesAppended,
      silenceFrames: this.silenceFrames,
      rebuilds: this.rebuilds,
      trace: this.trace.slice(-12),
      duration: this.plan?.duration ?? 0,
    });
  }
}
