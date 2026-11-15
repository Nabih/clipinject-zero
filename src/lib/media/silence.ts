/**
 * A digital-silence AAC frame.
 *
 * Why this file exists: a hole in an audio SourceBuffer stalls the media element
 * in Chrome. With a clip that has no audio track the edit has exactly such a hole
 * (see `HANDOFF.md` §7), so the engine fills it with real silence instead of
 * leaving the range empty. Chrome has no AAC *encoder* in WebCodecs, so the frame
 * is a constant.
 *
 * Provenance of the bytes (regenerate with):
 *   ffmpeg -f lavfi -i "anullsrc=r=48000:cl=stereo" -t 1 -c:a aac -b:a 32k \
 *          -f adts silence.aac
 * and keep frame #1 onward (frame #0 carries the encoder's priming). Every frame
 * after the first is byte-identical, which is where these constants come from.
 * The bytes do not depend on the sample rate — that lives in the
 * AudioSpecificConfig — only on the channel count (SCE vs CPE).
 */

const SILENT_FRAME: Record<number, string> = {
  1: 'ARggBw==', // 0x21 0x08 0x20 0x07
  2: 'IRAEYIwc', // 0x21 0x10 0x04 0x60 0x8c
};

/** Samples an AAC-LC frame always carries. */
const FRAME_SAMPLES = 1024;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface SilentSample {
  /** Timestamp in seconds, relative to the start of the window. */
  ts: number;
  duration: number;
  data: Uint8Array;
}

/**
 * Build `duration` seconds of silence, frame by frame.
 *
 * Returns null when the channel count has no known frame (5.1 and friends), in
 * which case the caller has to fall back to leaving the gap.
 */
export function silentSamples(duration: number, sampleRate: number, channels: number): SilentSample[] | null {
  const encoded = SILENT_FRAME[channels];
  if (!encoded || duration <= 0) return null;

  const data = decodeBase64(encoded);
  const frameDur = FRAME_SAMPLES / sampleRate;
  const out: SilentSample[] = [];
  let ts = 0;
  // Guard against a runaway loop on absurd durations.
  while (ts < duration - 1e-9 && out.length < 100_000) {
    out.push({ ts, duration: Math.min(frameDur, duration - ts), data });
    ts += frameDur;
  }
  return out.length ? out : null;
}
