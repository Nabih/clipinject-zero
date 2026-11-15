/**
 * ISO-BMFF box primitives: readers and writers.
 *
 * Zero dependencies on purpose. The whole app needs three things from this
 * file — walk boxes, build boxes, and read 32/64-bit integers — so it does
 * exactly that and nothing more.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Container boxes whose payload is a sequence of child boxes. */
export const CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'mvex',
  'moof',
  'traf',
  'edts',
  'dinf',
  'udta',
]);

/** @typedef {{ type: string, start: number, size: number, payload: number }} Box */

/** @param {...number} values */
export function u8(...values) {
  return Uint8Array.from(values);
}

/** @param {...number} values */
export function u16(...values) {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint16(i * 2, value));
  return out;
}

/** @param {...number} values */
export function u32(...values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value));
  return out;
}

/** @param {number|bigint} value */
export function u64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

/** @param {Uint8Array[]} parts */
export function concat(parts) {
  const total = parts.reduce((n, part) => n + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * @param {string} type
 * @param {Uint8Array[]} parts
 */
export function box(type, ...parts) {
  const size = 8 + parts.reduce((n, part) => n + part.byteLength, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(encoder.encode(type).subarray(0, 4), 4);
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * @param {string} type
 * @param {number} version
 * @param {number} flags 24-bit
 * @param {Uint8Array[]} parts
 */
export function fullBox(type, version, flags, ...parts) {
  return box(type, u8(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...parts);
}

/**
 * Walk the boxes in `[from, to)`.
 *
 * Stops at the first malformed size rather than throwing: a truncated final box
 * is common in files still being written, and the caller can judge.
 *
 * @param {Uint8Array} bytes
 * @param {number} [from]
 * @param {number} [to]
 * @returns {Box[]}
 */
export function readBoxes(bytes, from = 0, to = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** @type {Box[]} */
  const out = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = decoder.decode(bytes.subarray(at + 4, at + 8));
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) break;
    out.push({ type, start: at, size, payload: at + header });
    at += size;
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @param {Box} parent
 * @returns {Box[]}
 */
export function childBoxes(bytes, parent) {
  if (!CONTAINERS.has(parent.type)) return [];
  return readBoxes(bytes, parent.payload, parent.start + parent.size);
}

/**
 * @param {Box[]} boxes
 * @param {string} type
 */
export function findBox(boxes, type) {
  return boxes.find((b) => b.type === type);
}

/**
 * @param {Box[]} boxes
 * @param {string} type
 */
export function findBoxes(boxes, type) {
  return boxes.filter((b) => b.type === type);
}

/**
 * Descend by box type path, e.g. `['trak', 'mdia', 'minf']`.
 *
 * @param {Uint8Array} bytes
 * @param {Box[]} boxes
 * @param {string[]} path
 * @returns {Box | undefined}
 */
export function findPath(bytes, boxes, path) {
  let scope = boxes;
  /** @type {Box | undefined} */
  let found;
  for (const type of path) {
    found = findBox(scope, type);
    if (!found) return undefined;
    scope = childBoxes(bytes, found);
  }
  return found;
}

/**
 * @param {Uint8Array} bytes
 * @param {Box} target
 */
export function boxBytes(bytes, target) {
  return bytes.subarray(target.start, target.start + target.size);
}

/**
 * @param {Uint8Array} bytes
 * @param {Box} target
 */
export function boxPayload(bytes, target) {
  return bytes.subarray(target.payload, target.start + target.size);
}

/** A DataView restricted to `bytes`' own window. */
export function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** True when the buffer parses as whole boxes from start to end. */
export function isWellFormed(bytes) {
  const boxes = readBoxes(bytes);
  if (!boxes.length) return false;
  const last = boxes[boxes.length - 1];
  return last.start + last.size === bytes.length;
}
