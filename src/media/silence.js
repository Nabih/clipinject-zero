/**
 * Real AAC silence, without an encoder.
 *
 * Chrome's WebCodecs has no AAC *encoder*, so silence cannot be generated at
 * runtime. These bytes were produced once with ffmpeg:
 *
 *   ffmpeg -f lavfi -i "anullsrc=r=48000:cl=stereo" -t 1 -c:a aac -b:a 32k -f adts silence.aac
 *
 * and frame #0 was dropped because it carries the encoder's priming. Every frame
 * after it is byte-identical, which is what makes a constant sufficient. The bytes
 * do not depend on sample rate — that lives in the AudioSpecificConfig — only on
 * the channel layout (SCE vs CPE).
 */

const SILENT_FRAME = {
  1: 'ARggBw==', // 0x21 0x08 0x20 0x07
  2: 'IRAEYIwc', // 0x21 0x10 0x04 0x60 0x8c
};

/** An AAC-LC frame always carries this many samples. */
export const FRAME_SAMPLES = 1024;

/** @param {string} value */
function fromBase64(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Frames of silence covering `durationSec`, starting at `startSec`.
 *
 * Returns null when the channel layout has no known constant — better an honest
 * failure than playing noise.
 *
 * @param {{ startSec: number, durationSec: number, sampleRate: number, channels: number }} spec
 */
export function silenceFor(spec) {
  const frame = SILENT_FRAME[spec.channels];
  if (!frame) return null;

  const bytes = fromBase64(frame);
  const frameDuration = FRAME_SAMPLES / spec.sampleRate;
  const count = Math.max(1, Math.ceil(spec.durationSec / frameDuration - 1e-9));

  const payload = new Uint8Array(bytes.byteLength * count);
  /** @type {{ dts: number, duration: number }[]} */
  const samples = [];
  for (let i = 0; i < count; i++) {
    payload.set(bytes, i * bytes.byteLength);
    samples.push({ dts: spec.startSec + i * frameDuration, duration: frameDuration });
  }
  return { payload, samples, frameCount: count };
}

/** Whether this channel count can be silenced. */
export function canSilence(channels) {
  return Boolean(SILENT_FRAME[channels]);
}
