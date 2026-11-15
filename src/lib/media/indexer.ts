/**
 * Indexing, adapted to the UI's asset shape.
 *
 * This file is a shim. The real demuxer is `src/media/mp4.js`, which parses the
 * `stbl` tables by hand and never loads `mdat`. The components were written
 * against `IndexedAsset`, so this maps one to the other instead of rewriting
 * every consumer:
 *
 * - `meta` carries what the timeline and HUD display,
 * - `fragments` reports keyframe-aligned boundaries (no payload, because the
 *   demuxer is lazy now),
 * - `native` is the real asset, which the native engine consumes.
 */

import { indexMedia, sourceFromFile } from '../../media/mp4.js';
import type { AssetKind } from '../timeline/types';
import type { AudioSampleChunk, IndexedAsset, VideoFragment } from './types';

export interface IndexOptions {
  id: string;
  kind: AssetKind;
  file: File;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export class IndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexError';
  }
}

interface NativeAsset {
  video: { codec: string; width: number; height: number; timescale: number; samples: { dts: number; duration: number; sync: boolean }[] };
  audio: { codec: string; sampleRate: number; channels: number; timescale: number; samples: { dts: number }[] } | null;
  cutPoints: number[];
  duration: number;
  videoTrackId: number;
  audioTrackId: number | null;
}

export async function indexAsset(opts: IndexOptions): Promise<IndexedAsset> {
  let native: NativeAsset;
  try {
    native = (await indexMedia(sourceFromFile(opts.file), {
      id: opts.id,
      kind: opts.kind,
      onProgress: opts.onProgress,
      signal: opts.signal,
    })) as unknown as NativeAsset;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new IndexError(error instanceof Error ? error.message : String(error));
  }

  // Keyframe-aligned ranges. `data` stays empty on purpose: nothing reads it any
  // more, and filling it would restore exactly the memory cost we removed.
  const fragments: VideoFragment[] = [];
  const samples = native.video.samples;
  for (let i = 0; i < samples.length; i++) {
    if (!samples[i].sync) continue;
    const next = samples.findIndex((sample, j) => j > i && sample.sync);
    const last = next === -1 ? samples[samples.length - 1] : samples[next - 1];
    fragments.push({
      start: samples[i].dts,
      end: last.dts + last.duration,
      data: new Uint8Array(0),
      keyframe: true,
    });
  }

  const audioSamples: AudioSampleChunk[] = (native.audio?.samples ?? []).map((sample) => ({
    time: sample.dts,
    duration: 0,
    data: new Uint8Array(0),
  }));

  return {
    meta: {
      id: opts.id,
      kind: opts.kind,
      name: opts.file.name,
      duration: native.duration,
      video: {
        codec: native.video.codec,
        width: native.video.width,
        height: native.video.height,
        timescale: native.video.timescale,
      },
      audio: native.audio
        ? {
            codec: native.audio.codec,
            sampleRate: native.audio.sampleRate,
            channels: native.audio.channels,
            timescale: native.audio.timescale,
          }
        : undefined,
      cutPoints: native.cutPoints,
    },
    file: opts.file,
    url: typeof URL.createObjectURL === 'function' ? URL.createObjectURL(opts.file) : '',
    videoTrackId: native.videoTrackId,
    audioTrackId: native.audioTrackId ?? undefined,
    videoInit: new Uint8Array(0),
    fragments,
    audioSamples,
    bytes: 0,
    native,
  };
}
