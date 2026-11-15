import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { Segment } from '../timeline/types';
import type { AudioConfig } from './codec';
import { silentSamples } from './silence';
import type { IndexedAsset } from './types';

export type AudioMode = 'replace' | 'mix' | 'silent';

export const AUDIO_MODES: { id: AudioMode; label: string; hint: string }[] = [
  {
    id: 'replace',
    label: 'Replace',
    hint: 'The clip takes over. A clip with no audio track plays a silent window.',
  },
  {
    id: 'mix',
    label: 'Mix',
    hint: 'Clip audio plus the 1.5 s before the cut, looped under it at −9 dB.',
  },
  {
    id: 'silent',
    label: 'Silent',
    hint: 'Clips are muted; main audio only plays for main-video segments.',
  },
];

const EPS = 1e-6;

/**
 * Mux the audio for one segment into a self-contained fragmented MP4
 * (init + media) whose timestamps start at 0.
 *
 * Self-contained on purpose: the engine can append it at any position, in any
 * order, with `timestampOffset = virtIn - srcIn`, and it can be dropped and
 * rebuilt on seek without touching any other state.
 *
 * Timestamps start at 0 because `mp4-muxer`'s strict mode requires it; the
 * offset to virtual time is applied by MSE, not baked in.
 */
export function muxSegmentAudio(
  segment: Segment,
  asset: IndexedAsset,
  config: AudioConfig,
): Uint8Array | null {
  const { srcIn, srcOut } = segment;
  const picked: { ts: number; dur: number; data: Uint8Array }[] = [];
  let last = -1;

  for (const sample of asset.audioSamples) {
    if (sample.time >= srcOut - EPS) break;
    // Keep frames that are still playing at srcIn; they carry the tail of the
    // previous moment and dropping them would click.
    if (sample.time + sample.duration <= srcIn + EPS) continue;

    let ts = Math.round((sample.time - srcIn) * 1e6);
    if (ts < 0) ts = 0;
    if (ts <= last) ts = last + 1;
    last = ts;

    picked.push({ ts, dur: Math.max(1, Math.round(sample.duration * 1e6)), data: sample.data });
  }

  if (!picked.length) return null;
  return muxPicked(picked, config);
}

/**
 * Digital silence covering `duration` seconds, muxed like any other segment.
 *
 * Used wherever the audio timeline would otherwise have a hole: a clip with no
 * audio track, or a clip muted by the `silent` audio mode. Chrome stalls
 * playback at an audio gap, so "no audio here" has to be actual silence.
 */
export function muxSilence(duration: number, config: AudioConfig): Uint8Array | null {
  const samples = silentSamples(duration, config.sampleRate, config.channels);
  if (!samples) return null;
  const picked: { ts: number; dur: number; data: Uint8Array }[] = [];
  let last = -1;
  for (const sample of samples) {
    let ts = Math.round(sample.ts * 1e6);
    if (ts <= last) ts = last + 1;
    last = ts;
    picked.push({ ts, dur: Math.max(1, Math.round(sample.duration * 1e6)), data: sample.data });
  }
  return muxPicked(picked, config);
}

function muxPicked(
  picked: { ts: number; dur: number; data: Uint8Array }[],
  config: AudioConfig,
): Uint8Array | null {
  if (!picked.length) return null;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    audio: {
      codec: 'aac',
      numberOfChannels: config.channels,
      sampleRate: config.sampleRate,
    },
    fastStart: 'fragmented',
    firstTimestampBehavior: 'strict',
    minFragmentDuration: 1,
  });

  for (const chunk of picked) muxer.addAudioChunkRaw(chunk.data, 'key', chunk.ts, chunk.dur);
  muxer.finalize();

  return new Uint8Array(target.buffer);
}

/**
 * Split a muxed audio buffer into its initialization part (everything before the
 * first `moof`) and the media part.
 *
 * The engine appends exactly one init per SourceBuffer per flush: a second init
 * mid-stream carries a config change, and Chrome answers that by discarding part
 * of the media around it. Same rule as the video path.
 */
export function splitAudioSegment(buffer: Uint8Array): { init: Uint8Array; media: Uint8Array } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = view.getUint32(offset);
    if (size < 8) break;
    const type = String.fromCharCode(
      buffer[offset + 4],
      buffer[offset + 5],
      buffer[offset + 6],
      buffer[offset + 7],
    );
    if (type === 'moof') break;
    offset += size;
  }
  if (offset === 0 || offset >= buffer.length) return { init: new Uint8Array(0), media: buffer };
  return { init: buffer.slice(0, offset), media: buffer.slice(offset) };
}

/**
 * The source window the "mix" bed loops: 1.5 s immediately before the cut,
 * clamped at the start of the file.
 */
export function bedWindow(cut: number, available = 1.5): { start: number; end: number } {
  const end = Math.max(0, cut);
  const start = Math.max(0, end - available);
  return { start, end: Math.max(end, start + 0.05) };
}
