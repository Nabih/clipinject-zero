import { createFile, type Movie, type MP4BoxBuffer, type Sample } from 'mp4box';
import type { AssetKind, AssetMeta } from '../timeline/types';
import { avcConfigCore, configFingerprint } from './boxes';
import type { AudioSampleChunk, IndexedAsset, VideoFragment } from './types';

const CHUNK_SIZE = 8 * 1024 * 1024;

export interface IndexOptions {
  id: string;
  kind: AssetKind;
  file: File;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export class IndexError extends Error {}

/**
 * Read a local MP4 into the shape the engines need, in one streaming pass.
 *
 * mp4box keeps the mdat payloads (`createFile(true)`) because fragmentation and
 * sample extraction need real bytes. Peak memory is therefore roughly twice the
 * file size while indexing; everything but the fragments is released afterwards.
 *
 * See `docs/02-media-indexing.md`.
 */
export async function indexAsset(opts: IndexOptions): Promise<IndexedAsset> {
  const { file, onProgress, signal } = opts;
  const iso = createFile(true);

  let movie: Movie | null = null;
  let videoTrackId = -1;
  let audioTrackId: number | undefined;
  let videoTimescale = 1;
  let videoInit: Uint8Array | null = null;
  let videoSamples: Sample[] = [];

  const fragments: VideoFragment[] = [];
  const audioSamples: AudioSampleChunk[] = [];
  let previousSample = 0;

  let failure: Error | null = null;

  iso.onReady = (info: Movie) => {
    const video = info.videoTracks?.[0];
    if (!video) {
      failure = new IndexError('This file has no video track.');
      return;
    }
    movie = info;
    videoTrackId = video.id;
    videoTimescale = video.timescale;
    videoSamples = iso.getTrackSamplesInfo(video.id) ?? [];

    // One fragment per GOP, starting *on* the keyframe.
    //
    // `rapAlignement: true` looks like the right switch but mp4box resolves it
    // by ending the segment *at* the RAP, so every fragment then starts one
    // frame after a keyframe. Those fragments are unusable as splice points:
    // after a cut the decoder has nothing buffered before them and cannot start
    // without a keyframe, so it holds the previous frame until the next one.
    // Cutting on a regular sample grid instead puts the keyframe first, which is
    // what we need; `keyframe` on each fragment records whether the cut landed
    // on a sync sample so the UI only offers legal insertion points.
    const gopSamples = dominantGopLength(videoSamples);
    iso.setSegmentOptions(video.id, 'video', { rapAlignement: false, nbSamples: gopSamples });
    const inits = iso.initializeSegmentation('per-track');
    const own = inits.find((i) => i.id === video.id);
    if (!own) {
      failure = new IndexError('Could not build an init segment for the video track.');
      return;
    }
    videoInit = new Uint8Array(own.buffer.slice(0));

    const audio = info.audioTracks?.[0];
    if (audio) {
      audioTrackId = audio.id;
      iso.setExtractionOptions(audio.id, 'audio', { nbSamples: 256 });
    }

    iso.start();
  };

  iso.onSegment = (_id, _user, buffer, nextSample) => {
    if (_id !== videoTrackId || !videoSamples.length) return;
    const startSample = previousSample;
    const endSample = Math.max(nextSample, startSample + 1);
    const first = videoSamples[startSample];
    const last = videoSamples[endSample - 1];
    if (!first || !last) return;

    fragments.push({
      start: first.dts / videoTimescale,
      end: (last.dts + last.duration) / videoTimescale,
      data: new Uint8Array(buffer.slice(0)),
      keyframe: Boolean(first.is_sync),
    });
    previousSample = endSample;
  };

  iso.onSamples = (id, _user, samples) => {
    if (id !== audioTrackId) return;
    const scale = trackTimescale(movie, id);
    for (const s of samples) {
      if (!s.data) continue;
      audioSamples.push({
        time: s.dts / scale,
        duration: s.duration / scale,
        data: new Uint8Array(s.data),
      });
    }
  };

  try {
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      if (signal?.aborted) throw new DOMException('Indexing aborted', 'AbortError');
      const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
      const buffer = (await slice.arrayBuffer()) as MP4BoxBuffer;
      buffer.fileStart = offset;
      iso.appendBuffer(buffer, offset + CHUNK_SIZE >= file.size);
      if (failure) throw failure;
      onProgress?.(Math.min(offset + CHUNK_SIZE, file.size) / file.size);
    }
    iso.flush();
    if (failure) throw failure;
  } finally {
    iso.onReady = undefined;
    iso.onSegment = undefined;
    iso.onSamples = undefined;
    iso.stop();
  }

  if (!movie || !videoInit) throw new IndexError('Could not parse this file.');

  const info = movie as Movie;
  const videoTrack = info.videoTracks[0];
  const audioTrack = info.audioTracks?.[0];

  fragments.sort((a, b) => a.start - b.start);
  mergeLeadingStub(fragments);
  audioSamples.sort((a, b) => a.time - b.time);

  const meta: AssetMeta = {
    id: opts.id,
    kind: opts.kind,
    name: file.name,
    duration: info.duration / info.timescale,
    video: {
      codec: videoTrack.codec,
      width: videoTrack.video?.width ?? 0,
      height: videoTrack.video?.height ?? 0,
      timescale: videoTrack.timescale,
      configKey: configFingerprint(videoInit, 'avcC') ?? undefined,
      configCore: avcConfigCore(videoInit) ?? undefined,
    },
    audio: audioTrack
      ? {
          codec: audioTrack.codec,
          sampleRate: audioTrack.audio?.sample_rate ?? 48000,
          channels: audioTrack.audio?.channel_count ?? 2,
          timescale: audioTrack.timescale,
        }
      : undefined,
    // Only keyframe-aligned fragment starts are legal splice points.
    cutPoints: fragments.filter((f) => f.keyframe).map((f) => f.start),
  };

  const bytes =
    fragments.reduce((n, f) => n + f.data.byteLength, 0) +
    audioSamples.reduce((n, s) => n + s.data.byteLength, 0);

  return {
    meta,
    file,
    url: typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '',
    videoTrackId,
    audioTrackId,
    videoInit,
    fragments,
    audioSamples,
    bytes,
  };
}

function trackTimescale(movie: Movie | null, trackId: number): number {
  if (!movie) return 1;
  const t = movie.tracks?.find((x) => x.id === trackId);
  return t?.timescale ?? 1;
}

/**
 * Merge a short leading fragment into the one after it.
 *
 * mp4box's RAP-aligned fragmentation emits a stub fragment for the frames before
 * the first real keyframe — typically a single frame at the very start of the
 * file. Left alone it becomes the first *cut point*, so insert points snap to
 * 0.03 s instead of the first real GOP boundary, and the engine appends a
 * one-frame fragment at every run start.
 *
 * Two fragments are concatenated rather than re-fragmented: a buffer holding
 * `moof+mdat` twice is a perfectly valid multi-fragment append, and each part
 * keeps its own `tfdt`.
 */
function mergeLeadingStub(fragments: VideoFragment[]): void {
  if (fragments.length < 2) return;
  const [first, second] = fragments;
  const firstDur = first.end - first.start;
  const secondDur = second.end - second.start;
  if (secondDur <= 0 || firstDur > secondDur / 4) return;

  const merged = new Uint8Array(first.data.byteLength + second.data.byteLength);
  merged.set(first.data, 0);
  merged.set(second.data, first.data.byteLength);
  fragments.splice(0, 2, { start: first.start, end: second.end, data: merged, keyframe: first.keyframe });
}

/**
 * The GOP length in samples, taken as the most common gap between consecutive
 * sync samples.
 *
 * The segmenter cuts on a fixed sample grid, so this has to match the file's
 * real GOP for the cuts to land on keyframes. A file with irregular GOPs will
 * produce some fragments that start mid-GOP; those are marked `keyframe: false`
 * and are simply never offered as insertion points, so correctness never
 * depends on the GOP being regular.
 */
function dominantGopLength(samples: Sample[]): number {
  const syncIndices: number[] = [];
  for (let i = 0; i < samples.length; i++) if (samples[i].is_sync) syncIndices.push(i);
  if (syncIndices.length < 2) return Math.max(1, samples.length);

  const counts = new Map<number, number>();
  for (let i = 1; i < syncIndices.length; i++) {
    const gap = syncIndices[i] - syncIndices[i - 1];
    if (gap > 0) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [gap, count] of counts) {
    if (count > bestCount || (count === bestCount && gap < best)) {
      best = gap;
      bestCount = count;
    }
  }
  return Math.max(1, best);
}
