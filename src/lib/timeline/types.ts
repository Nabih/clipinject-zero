/**
 * Shared types for the virtual timeline.
 *
 * These are deliberately media-agnostic: nothing here knows about MediaSource,
 * MP4 files or players. `docs/01-virtual-timeline.md` is the specification.
 */

export type AssetKind = 'main' | 'clip';

export interface VideoTrackInfo {
  codec: string;
  width: number;
  height: number;
  timescale: number;
  /**
   * Hex digest of the `avcC` payload (SPS/PPS + VUI) of this file.
   *
   * Two files with the same `codec` string can still carry different decoder
   * configurations. Chrome answers a mid-stream configuration change by dropping
   * the first GOP after it, so the MSE engine keys on this instead of switching.
   * See `docs/02-media-indexing.md` and `HANDOFF.md` §7.
   */
  configKey?: string;
  /** Structural part of `avcC` (profile/level/SPS head), ignoring VUI timing. */
  configCore?: string;
}

export interface AudioTrackInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  timescale: number;
}

export interface AssetMeta {
  id: string;
  kind: AssetKind;
  name: string;
  duration: number;
  video: VideoTrackInfo;
  audio?: AudioTrackInfo;
  /**
   * Legal cut points, in source seconds, ascending.
   *
   * These are video *fragment* starts produced by mp4box with
   * `rapAlignement: true`, which are exactly the sync samples. They are the only
   * places a splice can happen without re-encoding (decision D1).
   */
  cutPoints: number[];
}

export interface Insertion {
  id: string;
  clipId: string;
  /** What the user typed. */
  atMainTime: number;
  /** Nearest legal cut point; what the timeline actually uses. */
  snappedMainTime: number;
  /** Trim window inside the clip, in clip seconds. Both must be cut points. */
  inPoint: number;
  outPoint: number;
}

export interface Segment {
  id: string;
  kind: AssetKind;
  assetId: string;
  /** Source seconds. `srcOut - srcIn === virtOut - virtIn` always. */
  srcIn: number;
  srcOut: number;
  virtIn: number;
  virtOut: number;
  /** Present on clip segments. */
  insertionId?: string;
}

export interface Timeline {
  segments: Segment[];
  /** Total virtual duration. */
  duration: number;
  mainDuration: number;
}

export const EMPTY_TIMELINE: Timeline = { segments: [], duration: 0, mainDuration: 0 };

export function segmentDuration(s: Segment): number {
  return s.virtOut - s.virtIn;
}
