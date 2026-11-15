/**
 * Building a single-track-pair byte stream for Safari.
 *
 * Chrome plays our edit with two SourceBuffers (video, audio). Safari's MSE is
 * happy with that too, but the Safari *phase* in `docs/08` is about the stricter
 * case: one SourceBuffer declared as `video/mp4; codecs="avc1…,mp4a…"`, which is
 * what `ManagedMediaSource` on iOS effectively demands.
 *
 * The trick is that a Media Segment may contain **several** `moof`+`mdat` pairs.
 * So we never have to rewrite a `moof` to carry two `traf`s: we keep the video
 * fragment exactly as mp4box produced it, keep the audio segment exactly as
 * mp4-muxer produced it, and put both in the same append. The only real work is
 *
 *   1. one init segment carrying **both** `trak`s and both `trex` entries, and
 *   2. making the audio track's id different from the video track's, because the
 *      two producers both number their single track 1.
 *
 * Step 2 is a handful of 32-bit fields (`tkhd`, `trex`, `tfhd`), which is why
 * this module is a patcher rather than a re-muxer: no video or audio payload is
 * copied, and the memory profile stays the same as the two-buffer engine.
 */

const CONTAINERS = new Set(['moov', 'trak', 'mvex', 'moof', 'traf', 'mdia', 'minf', 'stbl', 'edts']);

export interface Box {
  type: string;
  /** Offset of the box header in the buffer. */
  start: number;
  /** Total size including the header. */
  size: number;
  /** Offset of the first payload byte. */
  payload: number;
}

const decoder = new TextDecoder();

/** Read the top-level boxes of a byte stream. */
export function readBoxes(bytes: Uint8Array, from = 0, to = bytes.length): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = decoder.decode(bytes.subarray(at + 4, at + 8));
    let header = 8;
    if (size === 1) {
      // 64-bit size
      if (at + 16 > to) break;
      const hi = view.getUint32(at + 8);
      const lo = view.getUint32(at + 12);
      size = hi * 2 ** 32 + lo;
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

/** Flatten a container box into its children (non-container boxes come back as-is). */
export function childBoxes(bytes: Uint8Array, box: Box): Box[] {
  if (!CONTAINERS.has(box.type)) return [];
  return readBoxes(bytes, box.payload, box.start + box.size);
}

/** True when the buffer parses as whole boxes from start to end. */
export function isWellFormed(bytes: Uint8Array): boolean {
  const boxes = readBoxes(bytes);
  if (!boxes.length) return false;
  const last = boxes[boxes.length - 1];
  return last.start + last.size === bytes.length;
}

function find(boxes: Box[], type: string): Box | undefined {
  return boxes.find((b) => b.type === type);
}

/** Descend through container boxes by path, e.g. `['trak', 'tkhd']`. */
export function findPath(bytes: Uint8Array, root: Box[], path: string[]): Box | undefined {
  let current = root;
  let found: Box | undefined;
  for (const type of path) {
    found = find(current, type);
    if (!found) return undefined;
    current = childBoxes(bytes, found);
  }
  return found;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function sliceBox(bytes: Uint8Array, box: Box): Uint8Array {
  return bytes.slice(box.start, box.start + box.size);
}

/** Rewrite a box's 32-bit size field (the box is copied, not mutated). */
function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value);
}

/** Track id field of `tkhd`: version 0 at +12, version 1 at +20 (after the header). */
function tkhdTrackIdOffset(bytes: Uint8Array, tkhd: Box): number {
  const version = bytes[tkhd.payload];
  return tkhd.payload + (version === 1 ? 20 : 12);
}

/**
 * Renumber one track everywhere it is declared.
 *
 * `trex` and `tfhd` both start with version/flags then a 32-bit track id, so the
 * patch is the same shape three times. Returns a copy.
 */
export function renumberTrack(
  bytes: Uint8Array,
  opts: { from: number; to: number; kind: 'init' | 'segment' },
): Uint8Array {
  const out = bytes.slice(0);
  const top = readBoxes(out);

  const patchTrackIdsInMoov = (moov: Box) => {
    for (const trak of childBoxes(out, moov).filter((b) => b.type === 'trak')) {
      const tkhd = find(childBoxes(out, trak), 'tkhd');
      if (!tkhd) continue;
      const at = tkhdTrackIdOffset(out, tkhd);
      if (new DataView(out.buffer, out.byteOffset, out.byteLength).getUint32(at) === opts.from) {
        writeU32(out, at, opts.to);
      }
    }
    const mvex = find(childBoxes(out, moov), 'mvex');
    if (!mvex) return;
    for (const trex of childBoxes(out, mvex).filter((b) => b.type === 'trex')) {
      const at = trex.payload + 4;
      if (new DataView(out.buffer, out.byteOffset, out.byteLength).getUint32(at) === opts.from) {
        writeU32(out, at, opts.to);
      }
    }
  };

  const patchTfhd = (moof: Box) => {
    for (const traf of childBoxes(out, moof).filter((b) => b.type === 'traf')) {
      const tfhd = find(childBoxes(out, traf), 'tfhd');
      if (!tfhd) continue;
      const at = tfhd.payload + 4;
      if (new DataView(out.buffer, out.byteOffset, out.byteLength).getUint32(at) === opts.from) {
        writeU32(out, at, opts.to);
      }
    }
  };

  for (const box of top) {
    if (opts.kind === 'init' && box.type === 'moov') patchTrackIdsInMoov(box);
    if (opts.kind === 'segment' && box.type === 'moof') patchTfhd(box);
  }
  return out;
}

function makeBox(type: string, children: Uint8Array[]): Uint8Array {
  const size = 8 + children.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(size);
  writeU32(out, 0, size);
  out.set([...new TextEncoder().encode(type)].slice(0, 4), 4);
  let at = 8;
  for (const child of children) {
    out.set(child, at);
    at += child.byteLength;
  }
  return out;
}

/**
 * One init segment that declares both tracks.
 *
 * Layout: `ftyp` (from the video init) + `moov` holding the video `trak`, the
 * audio `trak`, and one `mvex` with both `trex` entries. The audio track is
 * renumbered before it is embedded so the two do not claim the same id.
 */
export function combineInits(
  videoInit: Uint8Array,
  audioInit: Uint8Array | null,
  opts: { audioTrackId: number },
): Uint8Array {
  const videoBoxes = readBoxes(videoInit);
  const videoMoov = find(videoBoxes, 'moov');
  if (!videoMoov) throw new Error('video init has no moov');

  const ftypBox = find(videoBoxes, 'ftyp');
  if (!ftypBox) throw new Error('video init has no ftyp');

  const videoChildren = childBoxes(videoInit, videoMoov);
  const mvhd = find(videoChildren, 'mvhd');
  const videoTrak = find(videoChildren, 'trak');
  const videoMvex = find(videoChildren, 'mvex');
  if (!mvhd || !videoTrak || !videoMvex) throw new Error('video init is missing mvhd/trak/mvex');

  const trexs: Uint8Array[] = childBoxes(videoInit, videoMvex)
    .filter((b) => b.type === 'trex')
    .map((b) => sliceBox(videoInit, b));

  const tracks: Uint8Array[] = [sliceBox(videoInit, videoTrak)];

  if (audioInit) {
    const renumbered = renumberTrack(audioInit, {
      from: 1,
      to: opts.audioTrackId,
      kind: 'init',
    });
    const audioMoov = find(readBoxes(renumbered), 'moov');
    if (audioMoov) {
      const audioChildren = childBoxes(renumbered, audioMoov);
      const audioTrak = find(audioChildren, 'trak');
      if (audioTrak) tracks.push(sliceBox(renumbered, audioTrak));

      const audioMvex = find(audioChildren, 'mvex');
      if (audioMvex) {
        for (const trex of childBoxes(renumbered, audioMvex).filter((b) => b.type === 'trex')) {
          trexs.push(sliceBox(renumbered, trex));
        }
      }
    }
  }

  const moov = makeBox('moov', [sliceBox(videoInit, mvhd), ...tracks, makeBox('mvex', trexs)]);
  return concat([sliceBox(videoInit, ftypBox), moov]);
}

/** Renumber a media segment's audio track so it can share a buffer with video. */
export function renumberSegment(segment: Uint8Array, from: number, to: number): Uint8Array {
  return renumberTrack(segment, { from, to, kind: 'segment' });
}

/**
 * Drop trailing index boxes (`mfra`, `mfro`).
 *
 * mp4-muxer appends a movie-fragment random-access index at the end of every
 * segment it finalises. Those offsets are absolute file positions, so the moment
 * a video fragment is prepended the index points at the wrong bytes. Nothing in
 * MSE reads it, and a stale index is worse than no index, so it goes.
 */
export function stripIndexBoxes(bytes: Uint8Array): Uint8Array {
  const boxes = readBoxes(bytes);
  const keep = boxes.filter((b) => b.type !== 'mfra' && b.type !== 'mfro');
  if (keep.length === boxes.length) return bytes;
  const end = keep.length ? keep[keep.length - 1].start + keep[keep.length - 1].size : 0;
  const out = new Uint8Array(end);
  let at = 0;
  for (const box of keep) {
    out.set(bytes.subarray(box.start, box.start + box.size), at);
    at += box.size;
  }
  return out;
}

/**
 * Video fragment then audio segment in one append.
 *
 * Two `moof`+`mdat` pairs, not one merged `moof`: a Media Segment may contain
 * several fragments, so the video bytes mp4box produced and the audio bytes
 * mp4-muxer produced can be handed over as they are. No payload is copied.
 */
export function joinSegments(videoSegment: Uint8Array, audioSegment: Uint8Array | null): Uint8Array {
  if (!audioSegment) return videoSegment;
  return concat([videoSegment, stripIndexBoxes(audioSegment)]);
}

export { concat as concatBytes };
