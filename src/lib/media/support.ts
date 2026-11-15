import type { EngineKind } from '../engine/types';

/**
 * What this browser can actually do.
 *
 * The marker/URL work itself is browser-agnostic — downloading a file, indexing it
 * and inserting it is plain JS. Playback is not: it needs MSE, and Safari differs
 * from Chrome in ways that matter (`docs/08`).
 */
export interface Support {
  /** Plain `MediaSource`. Chrome has it; iPhone Safari does not. */
  mse: boolean;
  /** `ManagedMediaSource` (Safari 17.1+ on iOS). Not the same API surface. */
  managedMse: boolean;
  /** `SourceBuffer.changeType`, used for in-place codec switching. Chrome yes. */
  changeType: boolean;
  /** Engine that can play here without the user having to know about any of this. */
  engine: EngineKind;
  /** One sentence for the UI, or null when the default engine is fine. */
  note: string | null;
}

export interface SupportEnv {
  mediaSource: boolean;
  managedMediaSource: boolean;
  changeType: boolean;
  h264: boolean;
}

export function detectSupport(env: SupportEnv): Support {
  const usable = env.mediaSource && env.h264;
  let note: string | null = null;

  if (!usable) {
    note = env.managedMediaSource
      ? 'This browser offers ManagedMediaSource rather than MediaSource, which the MSE engine does not use. Playing with the Simple engine: two elements, ±1 frame at the seam.'
      : 'This browser has no Media Source Extensions. Playing with the Simple engine: two elements, ±1 frame at the seam.';
  } else if (!env.changeType) {
    note = 'No SourceBuffer.changeType here, so a codec configuration can never be switched mid-stream. The MSE engine already avoids that.';
  }

  return {
    mse: env.mediaSource,
    managedMse: env.managedMediaSource,
    changeType: env.changeType,
    engine: usable ? 'native' : 'simple',
    note,
  };
}

/** Read the real environment. Kept apart from `detectSupport` so it stays testable. */
export function readSupportEnv(): SupportEnv {
  const hasMediaSource = typeof MediaSource !== 'undefined';
  let h264 = false;
  try {
    h264 = hasMediaSource && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"');
  } catch {
    h264 = false;
  }
  return {
    mediaSource: hasMediaSource,
    managedMediaSource: typeof (globalThis as { ManagedMediaSource?: unknown }).ManagedMediaSource !== 'undefined',
    changeType: typeof SourceBuffer !== 'undefined' && 'changeType' in SourceBuffer.prototype,
    h264,
  };
}
