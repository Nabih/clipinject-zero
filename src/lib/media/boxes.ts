/**
 * Minimal ISO-BMFF box helpers.
 *
 * The indexer needs two things from a raw init segment: the `avcC` payload (to
 * tell "same decoder configuration" from "different") and the `esds` payload.
 * A full box parser already exists in mp4box; this is deliberately just enough
 * to read one known box without depending on mp4box's internal object graph.
 */

const encoder = new TextEncoder();

function fourccBytes(fourcc: string): number[] {
  return [...encoder.encode(fourcc)];
}

/**
 * Find `fourcc` anywhere in `bytes` and return its payload.
 *
 * Scans for the fourcc and validates the 32-bit size that precedes it, which is
 * sufficient for the sample-entry level boxes we need and works regardless of
 * how deeply they are nested.
 */
export function findBoxPayload(bytes: Uint8Array, fourcc: string): Uint8Array | null {
  const target = fourccBytes(fourcc);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 4; i + 8 <= bytes.length; i++) {
    if (
      bytes[i] !== target[0] ||
      bytes[i + 1] !== target[1] ||
      bytes[i + 2] !== target[2] ||
      bytes[i + 3] !== target[3]
    ) {
      continue;
    }
    const size = view.getUint32(i - 4);
    const payload = i + 4;
    if (size <= 8 || payload + (size - 8) > bytes.length) continue;
    return bytes.slice(payload, payload + (size - 8));
  }
  return null;
}

/** Stable hex digest of a decoder configuration, for cheap equality checks. */
export function configFingerprint(bytes: Uint8Array, fourcc: string): string | null {
  const payload = findBoxPayload(bytes, fourcc);
  if (!payload) return null;
  let digest = '';
  for (const byte of payload) digest += byte.toString(16).padStart(2, '0');
  return digest;
}

/**
 * The structural part of an AVC decoder configuration: SPS/PPS minus the VUI.
 *
 * Two files encoded with the same settings often differ only in the VUI's
 * timing/HRD block, and those differences do not affect decoding. Comparing only
 * the leading bytes avoids reporting a mismatch for files that are in fact
 * interchangeable. Returns null when the box is absent.
 */
export function avcConfigCore(init: Uint8Array): string | null {
  const payload = findBoxPayload(init, 'avcC');
  if (!payload) return null;
  // configurationVersion, profile, compat, level, then SPS/PPS with lengths.
  return [...payload.slice(0, Math.min(payload.length, 12))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
