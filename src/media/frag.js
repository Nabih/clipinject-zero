/**
 * Fragment writer: `moov` + `moof`/`mdat` built by hand.
 *
 * This replaces a general-purpose muxer, and it is deliberately narrower:
 *
 * - **One `moof` can carry several `traf`s.** Video and audio are written into the
 *   same fragment, so the whole edit is one SourceBuffer with no gaps to patch up
 *   later. That also means no `timestampOffset` juggling: every fragment writes
 *   absolute virtual time into its own `tfdt`, so what is appended is what plays.
 * - **Every sample is described explicitly** in `trun` (duration, size, flags,
 *   composition offset). Defaults would be smaller, but explicit fields mean the
 *   file cannot be misread because a `trex` default disagreed with reality.
 * - **`default-base-is-moof`** so `trun` data offsets are relative to the `moof`,
 *   which is the only form that survives being prepended to other bytes.
 */

import { box, concat, fullBox, u32, u64, u8 } from './box.js';
import { childBoxes, findBox, findPath, readBoxes, boxBytes, boxPayload } from './box.js';

/** No sample depends on another, and it is a sync sample. */
const FLAG_SYNC = 0x02000000;
/** Depends on other samples, and is not a sync sample. */
const FLAG_NON_SYNC = 0x01010000;

/**
 * Empty sample table: `stsd` stays, everything that describes where samples live
 * goes. A fragmented file must not advertise a sample table pointing at an `mdat`
 * that never arrives.
 */
function emptyStbl(stsd) {
  return box(
    'stbl',
    stsd,
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)),
  );
}

/**
 * Rebuild one `trak` for a fragmented file: keep the headers and the sample
 * entry, drop the sample tables.
 *
 * @param {Uint8Array} moov
 * @param {import('./box.js').Box} trak
 */
function fragmentTrak(moov, trak) {
  const children = childBoxes(moov, trak);
  const tkhd = findBox(children, 'tkhd');
  const mdia = findBox(children, 'mdia');
  if (!tkhd || !mdia) throw new Error('trak is missing tkhd/mdia');

  const mdiaChildren = childBoxes(moov, mdia);
  const mdhd = findBox(mdiaChildren, 'mdhd');
  const hdlr = findBox(mdiaChildren, 'hdlr');
  const minf = findBox(mdiaChildren, 'minf');
  if (!mdhd || !hdlr || !minf) throw new Error('mdia is missing boxes');

  const minfChildren = childBoxes(moov, minf);
  const header = findBox(minfChildren, 'vmhd') ?? findBox(minfChildren, 'smhd');
  const dinf = findBox(minfChildren, 'dinf');
  const stbl = findBox(minfChildren, 'stbl');
  if (!header || !stbl) throw new Error('minf is missing boxes');
  const stsd = findBox(childBoxes(moov, stbl), 'stsd');
  if (!stsd) throw new Error('stbl is missing stsd');

  return box(
    'trak',
    boxBytes(moov, tkhd),
    box(
      'mdia',
      boxBytes(moov, mdhd),
      boxBytes(moov, hdlr),
      box('minf', boxBytes(moov, header), dinf ? boxBytes(moov, dinf) : new Uint8Array(0), emptyStbl(boxBytes(moov, stsd))),
    ),
  );
}

/**
 * Build the init segment for a fragmented stream.
 *
 * `ftyp` is reused verbatim and each `trak` is rebuilt around its `stsd`, so the
 * decoder configuration is exactly the one the source declared — nothing is
 * re-derived, and no codec string is guessed.
 *
 * @param {{ ftyp: Uint8Array, moov: Uint8Array, video: {trackId:number}, audio: {trackId:number}|null }} asset
 */
export function buildInit(asset) {
  const moovBoxes = readBoxes(asset.moov);
  const moovRoot = findBox(moovBoxes, 'moov');
  if (!moovRoot) throw new Error('asset has no moov');
  const children = childBoxes(asset.moov, moovRoot);
  const mvhd = findBox(children, 'mvhd');
  const traks = children.filter((b) => b.type === 'trak');
  if (!mvhd || !traks.length) throw new Error('moov is missing mvhd/trak');

  const trackIds = [asset.video.trackId, asset.audio?.trackId].filter((id) => typeof id === 'number');
  const mvex = box(
    'mvex',
    ...trackIds.map((id) =>
      // default_sample_description_index 1, then zeroed duration/size/flags: the
      // per-fragment `trun` always states its own values.
      fullBox('trex', 0, 0, u32(id), u32(1), u32(0), u32(0), u32(0)),
    ),
  );

  return concat([asset.ftyp, box('moov', boxBytes(asset.moov, mvhd), ...traks.map((t) => fragmentTrak(asset.moov, t)), mvex)]);
}

/**
 * @typedef {Object} TrafSpec
 * @property {number} trackId
 * @property {number} timescale
 * @property {{ dtsTicks: number, durationTicks: number, size: number, ctsOffsetTicks: number, sync: boolean }[]} samples
 *   All times in the track's own timescale ticks; `ctsOffsetTicks` is composition
 *   minus decode.
 */

/** @param {TrafSpec} traf @param {number} dataOffset */
function buildTraf(traf, dataOffset) {
  const count = traf.samples.length;
  // tfdt is absolute virtual time, so the first sample's decode time is the base.
  const baseDts = traf.samples.length ? traf.samples[0].dtsTicks : 0;

  // version 1 of `trun` is required once any composition offset is negative.
  const needsSigned = traf.samples.some((s) => s.ctsOffsetTicks < 0);
  const flags =
    0x000001 | // data-offset-present
    0x000100 | // sample-duration-present
    0x000200 | // sample-size-present
    0x000400 | // sample-flags-present
    0x000800; // sample-composition-time-offsets-present

  const sampleBytes = new Uint8Array(count * 16);
  const view = new DataView(sampleBytes.buffer);
  traf.samples.forEach((sample, i) => {
    const at = i * 16;
    view.setUint32(at, sample.durationTicks);
    view.setUint32(at + 4, sample.size);
    view.setUint32(at + 8, sample.sync ? FLAG_SYNC : FLAG_NON_SYNC);
    if (needsSigned) view.setInt32(at + 12, sample.ctsOffsetTicks);
    else view.setUint32(at + 12, sample.ctsOffsetTicks);
  });

  return box(
    'traf',
    // default-base-is-moof: `trun` offsets are relative to the moof start.
    fullBox('tfhd', 0, 0x020000, u32(traf.trackId)),
    // tfdt version 1: 64-bit so a long main video cannot overflow.
    fullBox('tfdt', 1, 0, u64(baseDts)),
    fullBox('trun', needsSigned ? 1 : 0, flags, u32(count), u32(dataOffset), sampleBytes),
  );
}

/**
 * Build one media segment holding every track's samples in a single `moof`+`mdat`.
 *
 * @param {{
 *   sequence: number,
 *   tracks: { trackId: number, timescale: number, payload: Uint8Array, samples: {
 *     durationTicks: number, size: number, ctsOffsetTicks: number, sync: boolean, dtsTicks: number }[] }[],
 * }} spec
 */
export function buildSegment(spec) {
  const mfhd = fullBox('mfhd', 0, 0, u32(spec.sequence));
  const payloadSize = spec.tracks.reduce((n, t) => n + t.payload.byteLength, 0);
  // moof size does not depend on the offsets, so build once to measure, then
  // rebuild with real offsets. Sizes are deterministic, so two passes suffice.
  const skeleton = spec.tracks.map((track) => buildTraf(track, 0));
  const moofSize = 8 + mfhd.byteLength + skeleton.reduce((n, t) => n + t.byteLength, 0);

  let offset = moofSize + 8; // payload starts after moof and the mdat header
  const trafs = spec.tracks.map((track) => {
    const traf = buildTraf(track, offset);
    offset += track.payload.byteLength;
    return traf;
  });

  const moof = box('moof', mfhd, ...trafs);
  if (moof.byteLength !== moofSize) throw new Error('moof size drifted between passes');
  const mdat = box('mdat', ...spec.tracks.map((t) => t.payload));
  if (mdat.byteLength !== payloadSize + 8) throw new Error('mdat size mismatch');
  return concat([moof, mdat]);
}

export { FLAG_SYNC, FLAG_NON_SYNC };
