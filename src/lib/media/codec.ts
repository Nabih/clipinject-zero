import type { AssetMeta } from '../timeline/types';

export interface AudioConfig {
  codec: string;
  sampleRate: number;
  channels: number;
}

export function videoMimeType(codec: string): string {
  return `video/mp4; codecs="${codec}"`;
}

export function audioMimeType(codec: string): string {
  return `video/mp4; codecs="${codec}"`;
}

export function hasMediaSource(): boolean {
  return typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function';
}

export function isTypeSupported(mime: string): boolean {
  try {
    return hasMediaSource() && MediaSource.isTypeSupported(mime);
  } catch {
    return false;
  }
}

/**
 * The MSE engine puts every video fragment into one SourceBuffer, so the whole
 * edit has to agree on one decoder configuration. Anything else is reported to
 * the user as a reason to switch to the Simple engine.
 */
export interface Incompatibility {
  assetId: string;
  reason: string;
}

/** The single audio configuration the timeline will use, if any. */
export function resolveAudioConfig(main: AssetMeta, clips: Iterable<AssetMeta>): AudioConfig | null {
  if (main.audio) {
    return { codec: main.audio.codec, sampleRate: main.audio.sampleRate, channels: main.audio.channels };
  }
  for (const clip of clips) {
    if (clip.audio) {
      return { codec: clip.audio.codec, sampleRate: clip.audio.sampleRate, channels: clip.audio.channels };
    }
  }
  return null;
}

export function findIncompatibilities(
  main: AssetMeta,
  clips: Iterable<AssetMeta>,
  audio: AudioConfig | null,
): Incompatibility[] {
  const problems: Incompatibility[] = [];

  const mainCodec = main.video.codec;
  for (const clip of [main, ...clips]) {
    if (clip.video.codec !== mainCodec) {
      problems.push({
        assetId: clip.id,
        reason: `video codec ${clip.video.codec} does not match the main video's ${mainCodec}`,
      });
      continue;
    }
    if (clip.video.width !== main.video.width || clip.video.height !== main.video.height) {
      problems.push({
        assetId: clip.id,
        reason: `${clip.video.width}×${clip.video.height} does not match the main video's ${main.video.width}×${main.video.height}`,
      });
    }
    if (audio && clip.audio) {
      if (
        clip.audio.codec !== audio.codec ||
        clip.audio.sampleRate !== audio.sampleRate ||
        clip.audio.channels !== audio.channels
      ) {
        problems.push({
          assetId: clip.id,
          reason: `audio ${clip.audio.codec}/${clip.audio.sampleRate}Hz/${clip.audio.channels}ch does not match ${audio.codec}/${audio.sampleRate}Hz/${audio.channels}ch`,
        });
      }
    }
  }

  return problems;
}

/**
 * Non-blocking warnings about decoder-configuration differences.
 *
 * A clip whose `avcC` differs from the main video's is still playable: the engine
 * appends one init per flush and decodes everything with the first
 * configuration. Chrome answers a *changed* config mid-stream by discarding the
 * next GOP, so this is the better trade — but the frames then come from a
 * slightly different encoder configuration, which can look wrong. Report it
 * instead of hiding it.
 */
export function findConfigWarnings(main: AssetMeta, clips: Iterable<AssetMeta>): string[] {
  const warnings: string[] = [];
  if (!main.video.configKey) return warnings;

  for (const clip of clips) {
    if (!clip.video.configKey || clip.video.configKey === main.video.configKey) continue;
    const structural = clip.video.configCore && main.video.configCore && clip.video.configCore !== main.video.configCore;
    warnings.push(
      `${clip.name}: ${structural ? 'SPS/PPS differ from' : 'settings differ from'} the main video's ` +
        `(${clip.video.codec} on both). ${structural ? 'MSE decodes it with the main video\'s configuration, which can look wrong' : 'MSE decodes it with the main video\'s configuration'}; ` +
        `use the Simple engine if the picture breaks up.`,
    );
  }
  return warnings;
}

/** Human-readable reason the MSE engine cannot be used, or null when it can. */
export function mseBlocker(
  main: AssetMeta,
  clips: Iterable<AssetMeta>,
  audio: AudioConfig | null,
): string | null {
  if (!hasMediaSource()) return 'This browser has no Media Source Extensions.';
  if (!isTypeSupported(videoMimeType(main.video.codec))) {
    return `Chrome cannot decode ${main.video.codec} through MSE.`;
  }
  if (audio && !isTypeSupported(audioMimeType(audio.codec))) {
    return `Chrome cannot decode ${audio.codec} through MSE.`;
  }
  const problems = findIncompatibilities(main, clips, audio);
  if (problems.length) {
    return `Streams must share one codec configuration: ${problems[0].reason}.`;
  }
  return null;
}
