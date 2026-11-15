import type { AssetMeta } from '../timeline/types';

export interface VideoFragment {
  /** Source seconds (decode time of the first sample). */
  start: number;
  /** Source seconds (decode time of the last sample + its duration). */
  end: number;
  data: Uint8Array;
  /**
   * True when the fragment's first sample is a sync sample (I-frame).
   *
   * Only these are legal splice points: after a cut the decoder has nothing
   * buffered before the appended fragment, so it must find a keyframe at the
   * fragment's first sample. Sashes cut at a non-keyframe leave the previous
   * segment's last frame on screen until the next keyframe — measured as the
   * "clip bleeds over the main video" bug (`HANDOFF.md` §7(f)).
   */
  keyframe: boolean;
}

export interface AudioSampleChunk {
  /** Source seconds. */
  time: number;
  duration: number;
  data: Uint8Array;
}

export interface IndexedAsset {
  meta: AssetMeta;
  file: File;
  /** Object URL for the raw file, used by the Simple engine. */
  url: string;
  videoTrackId: number;
  audioTrackId?: number;
  /** Per-track init segment (moov with mvex) for the video SourceBuffer. */
  videoInit: Uint8Array;
  /** RAP-aligned fragments, ascending, contiguous. */
  fragments: VideoFragment[];
  /** Raw AAC frames, ascending. Empty when the asset has no audio track. */
  audioSamples: AudioSampleChunk[];
  /** Total bytes of media payload held in memory. */
  bytes: number;
  /**
   * The lazy demuxer asset this was built from.
   *
   * The split matters: `fragments`/`audioSamples` existed because mp4box kept
   * every mdat byte in memory. The hand-written demuxer keeps only the sample
   * table and reads payloads on demand, so the engine uses `native` and the
   * other fields carry metadata for the UI.
   */
  native?: unknown;
}
