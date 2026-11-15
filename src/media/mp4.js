/**
 * A minimal MP4 demuxer: sample tables in, sample index out.
 *
 * Design notes, because they differ from a general-purpose demuxer on purpose:
 *
 * 1. **No mdat is ever loaded.** Only `moov` is read into memory; sample payloads
 *    are fetched on demand with `source.read()` when a fragment is built. Memory
 *    is O(sample count), not O(file size) — a 2 GB main video indexes the same as
 *    a 3 MB one. (mp4box's `createFile(true)` keeps every mdat byte, which is
 *    what we were paying before.)
 *
 * 2. **No decoding.** We need byte ranges, decode timestamps, durations and sync
 *    flags. That is all a splicer needs, so that is all this parses.
 *
 * 3. **AVC + AAC only.** Anything else is rejected with a sentence rather than
 *    half-supported. See `SUPPORTED` below.
 */

import { childBoxes, findBox, findPath, readBoxes, view } from './box.js';

/** Sample entries this demuxer understands. */
const SUPPORTED = {
  video: new Set(['avc1', 'avc3']),
  audio: new Set(['mp4a']),
};

export class DemuxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DemuxError';
  }
}

/**
 * @typedef {{ size: number, read(start: number, end: number): Promise<Uint8Array> }} Source
 */

/** @param {File|Blob} file @returns {Source} */
export function sourceFromFile(file) {
  return {
    name: file.name,
    size: file.size,
    async read(start, end) {
      const slice = file.slice(start, Math.min(end, file.size));
      return new Uint8Array(await slice.arrayBuffer());
    },
  };
}

/**
 * @param {Uint8Array} bytes
 * @param {string} [name]
 * @returns {Source & { name: string }}
 */
export function sourceFromBytes(bytes, name = 'remote.mp4') {
  return {
    name,
    size: bytes.byteLength,
    async read(start, end) {
      return bytes.slice(start, Math.min(end, bytes.byteLength));
    },
  };
}

/** @typedef {{ offset: number, size: number, dts: number, duration: number, cts: number, sync: boolean }} Sample */

/**
 * Read only the top-level box headers, so we can find `moov` without touching
 * media data.
 *
 * @param {Source} source
 * @param {(fraction: number) => void} [onProgress]
 * @param {AbortSignal} [signal]
 */
async function scanTopLevel(source, onProgress, signal) {
  /** @type {{ type: string, start: number, size: number, payload: number }[]} */
  const boxes = [];
  let at = 0;
  while (at + 8 <= source.size) {
    if (signal?.aborted) throw new DOMException('Indexing aborted', 'AbortError');
    const head = await source.read(at, at + 16);
    if (head.byteLength < 8) break;
    const v = view(head);
    let size = v.getUint32(0);
    const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
    let header = 8;
    if (size === 1) {
      if (head.byteLength < 16) break;
      size = Number(v.getBigUint64(8));
      header = 16;
    } else if (size === 0) {
      size = source.size - at;
    }
    if (size < header) break;
    boxes.push({ type, start: at, size, payload: at + header });
    at += size;
    onProgress?.(Math.min(1, at / source.size));
  }
  return boxes;
}

/**
 * @param {Uint8Array} bytes
 * @param {import('./box.js').Box} parent
 */
function readFullTable(bytes, parent) {
  const v = view(bytes);
  const count = v.getUint32(parent.payload + 4);
  const entries = [];
  let at = parent.payload + 8;
  for (let i = 0; i < count; i++) {
    entries.push([v.getUint32(at), v.getUint32(at + 4)]);
    at += 8;
  }
  return entries;
}

/**
 * Expand `stts` into a per-sample duration array.
 * @param {Uint8Array} bytes
 * @param {import('./box.js').Box | undefined} stts
 * @param {number} count
 */
function sampleDurations(bytes, stts, count) {
  const out = new Float64Array(count);
  if (!stts) return out.fill(0);
  const entries = readFullTable(bytes, stts);
  let index = 0;
  for (const [n, delta] of entries) {
    for (let i = 0; i < n && index < count; i++) out[index++] = delta;
  }
  // A truncated table is a real-world thing; pad the tail with the last delta
  // rather than producing zero-duration samples that break fragment math.
  const last = entries.length ? entries[entries.length - 1][1] : 0;
  while (index < count) out[index++] = last;
  return out;
}

/**
 * Expand `ctts` into composition offsets. Version 1 offsets are signed.
 * @param {Uint8Array} bytes
 * @param {import('./box.js').Box | undefined} ctts
 * @param {number} count
 */
function compositionOffsets(bytes, ctts, count) {
  const out = new Float64Array(count);
  if (!ctts) return out;
  const v = view(bytes);
  const version = bytes[ctts.payload];
  const entryCount = v.getUint32(ctts.payload + 4);
  let index = 0;
  let at = ctts.payload + 8;
  for (let i = 0; i < entryCount && index < count; i++) {
    const n = v.getUint32(at);
    const offset = version === 1 ? v.getInt32(at + 4) : v.getUint32(at + 4);
    for (let j = 0; j < n && index < count; j++) out[index++] = offset;
    at += 8;
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @param {import('./box.js').Box | undefined} stsz
 * @param {import('./box.js').Box | undefined} stz2
 * @param {number} count
 */
function sampleSizes(bytes, stsz, stz2, count) {
  const v = view(bytes);
  const sizes = new Float64Array(count);
  if (stsz) {
    const uniform = v.getUint32(stsz.payload + 4);
    const declared = v.getUint32(stsz.payload + 8);
    for (let i = 0; i < Math.min(count, declared); i++) {
      sizes[i] = uniform || v.getUint32(stsz.payload + 12 + i * 4);
    }
    return sizes;
  }
  if (stz2) {
    const fieldSize = bytes[stz2.payload + 7];
    const declared = v.getUint32(stz2.payload + 8);
    const at = stz2.payload + 12;
    for (let i = 0; i < Math.min(count, declared); i++) {
      if (fieldSize === 4) {
        const byte = bytes[at + (i >> 1)];
        sizes[i] = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
      } else if (fieldSize === 8) {
        sizes[i] = bytes[at + i];
      } else {
        sizes[i] = v.getUint16(at + i * 2);
      }
    }
  }
  return sizes;
}

/** @param {Uint8Array} bytes @param {import('./box.js').Box | undefined} stco @param {import('./box.js').Box | undefined} co64 */
function chunkOffsets(bytes, stco, co64) {
  const v = view(bytes);
  /** @type {number[]} */
  const out = [];
  const source = stco ?? co64;
  if (!source) return out;
  const count = v.getUint32(source.payload + 4);
  const wide = source.type === 'co64';
  for (let i = 0; i < count; i++) {
    out.push(wide ? Number(v.getBigUint64(source.payload + 8 + i * 8)) : v.getUint32(source.payload + 8 + i * 4));
  }
  return out;
}

/**
 * Resolve each sample's absolute file offset from the chunk tables.
 *
 * `stsc` is a run-length table: chunk numbers in the low byte are 1-based, and a
 * run applies until the next run's `first_chunk`. Getting this expansion wrong is
 * the classic way to produce a file that indexes but plays as garbage.
 *
 * @param {number[]} offsets
 * @param {Uint8Array} bytes
 * @param {import('./box.js').Box | undefined} stsc
 * @param {Float64Array} sizes
 * @returns {Float64Array}
 */
function sampleOffsets(offsets, bytes, stsc, sizes) {
  const count = sizes.length;
  const out = new Float64Array(count);
  if (!stsc || !offsets.length) return out;

  const v = view(bytes);
  const runCount = v.getUint32(stsc.payload + 4);
  /** @type {[number, number][]} */
  const runs = [];
  for (let i = 0; i < runCount; i++) {
    const at = stsc.payload + 8 + i * 12;
    runs.push([v.getUint32(at), v.getUint32(at + 4)]);
  }

  let sample = 0;
  for (let run = 0; run < runs.length; run++) {
    const firstChunk = runs[run][0];
    const perChunk = runs[run][1];
    const nextFirstChunk = run + 1 < runs.length ? runs[run + 1][0] : offsets.length + 1;
    for (let chunk = firstChunk; chunk < nextFirstChunk; chunk++) {
      let cursor = offsets[chunk - 1];
      if (cursor === undefined) break;
      for (let i = 0; i < perChunk && sample < count; i++) {
        out[sample] = cursor;
        cursor += sizes[sample];
        sample++;
      }
    }
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @param {import('./box.js').Box | undefined} stss
 * @param {number} count
 */
function syncFlags(bytes, stss, count) {
  const flags = new Uint8Array(count);
  if (!stss) {
    // No sync table means "every sample is a sync sample" per ISO/IEC 14496-12.
    flags.fill(1);
    return flags;
  }
  const v = view(bytes);
  const entryCount = v.getUint32(stss.payload + 4);
  for (let i = 0; i < entryCount; i++) {
    // stss entries are 1-based sample numbers.
    const index = v.getUint32(stss.payload + 8 + i * 4) - 1;
    if (index >= 0 && index < count) flags[index] = 1;
  }
  return flags;
}

/**
 * Media time at which presentation starts, in the track's media timescale.
 *
 * `elst` is what makes encoder priming invisible: an AAC encoder writes 1024
 * priming samples, and the edit list says "start presenting at media_time", so
 * those samples are decoded but never shown. Ignore it and every clip's audio is
 * shifted by its own priming delay — the classic click-at-the-seam bug.
 *
 * Layout (v0): segment_duration u32, media_time i32, media_rate i16+i16.
 * Layout (v1): segment_duration u64, media_time i64.
 *
 * @param {Uint8Array} bytes
 * @param {import('./box.js').Box | undefined} elst
 */
function editShift(bytes, elst) {
  if (!elst) return 0;
  const v = view(bytes);
  const version = bytes[elst.payload];
  const count = v.getUint32(elst.payload + 4);
  if (!count) return 0;
  const mediaTime = version === 1
    ? Number(v.getBigInt64(elst.payload + 20))
    : v.getInt32(elst.payload + 12);
  // media_time = -1 is an empty edit (a delay), which we do not model.
  return mediaTime < 0 ? 0 : mediaTime;
}

/**
 * @param {Uint8Array} bytes
 * @param {import('./box.js').Box} entry sample entry box
 */
function videoConfig(bytes, entry) {
  const v = view(bytes);
  const width = v.getUint16(entry.payload + 24);
  const height = v.getUint16(entry.payload + 26);
  const childrenStart = entry.payload + 78;
  const avcC = readBoxes(bytes, childrenStart, entry.start + entry.size).find((b) => b.type === 'avcC');
  return {
    width,
    height,
    avcC: avcC ? bytes.slice(avcC.payload, avcC.start + avcC.size) : null,
  };
}

/**
 * @param {Uint8Array} esdsPayload
 */
function parseEsds(esds) {
  let at = 4; // version + flags
  let objectTypeIndication = 0;
  /** @type {Uint8Array | null} */
  let asc = null;

  const readLength = () => {
    let length = 0;
    for (let i = 0; i < 4; i++) {
      const byte = esds[at++];
      length = (length << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    return length;
  };

  const walk = (end) => {
    while (at < end) {
      const tag = esds[at++];
      const length = readLength();
      const bodyStart = at;
      const bodyEnd = bodyStart + length;
      if (tag === 0x03) {
        at += 2; // ES_ID
        const flags = esds[at++];
        if (flags & 0x80) at += 2;
        if (flags & 0x40) at += 1 + esds[at];
        if (flags & 0x20) at += 2;
        walk(bodyEnd);
      } else if (tag === 0x04) {
        objectTypeIndication = esds[at];
        at += 13; // OTI, streamType, bufferSizeDB(3), maxBitrate(4), avgBitrate(4)
        walk(bodyEnd);
      } else if (tag === 0x05) {
        asc = esds.slice(bodyStart, bodyEnd);
        at = bodyEnd;
      } else {
        at = bodyEnd;
      }
      at = Math.max(at, bodyEnd);
    }
  };

  walk(esds.length);
  return { objectTypeIndication, asc };
}

/**
 * @param {Uint8Array} bytes
 * @param {import('./box.js').Box} entry
 */
function audioConfig(bytes, entry) {
  const v = view(bytes);
  const channels = v.getUint16(entry.payload + 16);
  const sampleRate = v.getUint32(entry.payload + 24) >>> 16;
  const childrenStart = entry.payload + 36;
  const esds = readBoxes(bytes, childrenStart, entry.start + entry.size).find((b) => b.type === 'esds');
  let asc = null;
  let objectType = 0x40;
  if (esds) {
    const parsed = parseEsds(bytes.subarray(esds.payload, esds.start + esds.size));
    asc = parsed.asc;
    objectType = parsed.objectTypeIndication;
  }
  return { channels, sampleRate, asc, objectType };
}

/**
 * @param {number} objectType
 * @param {Uint8Array | null} asc
 */
function audioCodecString(objectType, asc) {
  if (objectType !== 0x40) return null; // not MPEG-4 Audio
  if (!asc || !asc.length) return 'mp4a.40.2';
  let aot = asc[0] >> 3;
  if (aot === 31) aot = 32 + (((asc[0] & 0x07) << 3) | (asc[1] >> 5));
  return `mp4a.40.${aot}`;
}

const hex = (n) => n.toString(16).padStart(2, '0');

/**
 * @param {string} type sample entry type
 * @param {{ avcC: Uint8Array | null }} config
 */
function videoCodecString(type, config) {
  if (!config.avcC || config.avcC.length < 4) return null;
  const [, profile, compat, level] = config.avcC;
  return `${type}.${hex(profile)}${hex(compat)}${hex(level)}`;
}

/**
 * @param {Uint8Array} bytes
 * @param {import('./box.js').Box} trak
 */
function parseTrak(bytes, trak) {
  const v = view(bytes);
  const trakChildren = childBoxes(bytes, trak);
  const tkhd = findPath(bytes, trakChildren, ['tkhd']);
  const mdhd = findPath(bytes, trakChildren, ['mdia', 'mdhd']);
  const hdlr = findPath(bytes, trakChildren, ['mdia', 'hdlr']);
  const stbl = findPath(bytes, trakChildren, ['mdia', 'minf', 'stbl']);
  if (!tkhd || !mdhd || !hdlr || !stbl) return null;

  const tkhdVersion = bytes[tkhd.payload];
  const trackId = v.getUint32(tkhd.payload + (tkhdVersion === 1 ? 20 : 12));
  const handler = String.fromCharCode(
    bytes[hdlr.payload + 8],
    bytes[hdlr.payload + 9],
    bytes[hdlr.payload + 10],
    bytes[hdlr.payload + 11],
  );

  const mdhdVersion = bytes[mdhd.payload];
  const timescale = v.getUint32(mdhd.payload + (mdhdVersion === 1 ? 20 : 12));
  const mediaDuration = mdhdVersion === 1
    ? Number(v.getBigUint64(mdhd.payload + 24))
    : v.getUint32(mdhd.payload + 16);

  const stblChildren = childBoxes(bytes, stbl);
  const stsd = findBox(stblChildren, 'stsd');
  if (!stsd) return null;
  const entries = readBoxes(bytes, stsd.payload + 8, stsd.start + stsd.size);
  const entry = entries[0];
  if (!entry) return null;
  const sampleEntryCount = view(bytes).getUint32(stsd.payload + 4);
  if (sampleEntryCount > 1) {
    // Legal, but our fragments carry a single sample description; supporting
    // several would mean per-sample description indices in every `trun`.
    throw new DemuxError('This file uses more than one sample description per track, which is not supported yet.');
  }

  const kind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : null;
  if (!kind) return null;
  if (!SUPPORTED[kind].has(entry.type)) {
    throw new DemuxError(
      `Unsupported ${kind} codec "${entry.type}". This build handles AVC (avc1/avc3) video and AAC (mp4a) audio only.`,
    );
  }

  const sizes = sampleSizes(bytes, findBox(stblChildren, 'stsz'), findBox(stblChildren, 'stz2'), countFrom(bytes, stblChildren));
  const count = sizes.length;
  const durations = sampleDurations(bytes, findBox(stblChildren, 'stts'), count);
  const ctsOffsets = compositionOffsets(bytes, findBox(stblChildren, 'ctts'), count);
  const offsets = sampleOffsets(
    chunkOffsets(bytes, findBox(stblChildren, 'stco'), findBox(stblChildren, 'co64')),
    bytes,
    findBox(stblChildren, 'stsc'),
    sizes,
  );
  const sync = syncFlags(bytes, findBox(stblChildren, 'stss'), count);
  const edts = findPath(bytes, trakChildren, ['edts', 'elst']);
  const shift = editShift(bytes, edts);

  /** @type {Sample[]} */
  const samples = new Array(count);
  let dts = 0;
  for (let i = 0; i < count; i++) {
    samples[i] = {
      offset: offsets[i],
      size: sizes[i],
      dts: dts / timescale,
      duration: durations[i] / timescale,
      cts: (dts + ctsOffsets[i]) / timescale,
      sync: sync[i] === 1,
    };
    dts += durations[i];
  }

  const config = kind === 'video' ? videoConfig(bytes, entry) : audioConfig(bytes, entry);
  const codec = kind === 'video'
    ? videoCodecString(entry.type, /** @type {{ avcC: Uint8Array | null }} */ (config))
    : audioCodecString(/** @type {any} */ (config).objectType, /** @type {any} */ (config).asc);
  if (!codec) throw new DemuxError(`Could not read the ${kind} decoder configuration from this file.`);

  return {
    trackId,
    kind,
    timescale,
    sampleEntryType: entry.type,
    codec,
    width: kind === 'video' ? /** @type {any} */ (config).width : 0,
    height: kind === 'video' ? /** @type {any} */ (config).height : 0,
    sampleRate: kind === 'audio' ? /** @type {any} */ (config).sampleRate : 0,
    channels: kind === 'audio' ? /** @type {any} */ (config).channels : 0,
    asc: kind === 'audio' ? /** @type {any} */ (config).asc : null,
    mediaDuration: mediaDuration / timescale,
    editShiftSec: shift / timescale,
    samples,
  };
}

/** @param {Uint8Array} bytes @param {import('./box.js').Box[]} stblChildren */
function countFrom(bytes, stblChildren) {
  const v = view(bytes);
  const stsz = findBox(stblChildren, 'stsz');
  if (stsz) return v.getUint32(stsz.payload + 8);
  const stz2 = findBox(stblChildren, 'stz2');
  if (stz2) return v.getUint32(stz2.payload + 8);
  return 0;
}

/**
 * @typedef {Object} Asset
 * @property {string} id
 * @property {'main'|'clip'} kind
 * @property {string} name
 * @property {Source} source
 * @property {number} size
 * @property {Uint8Array} ftyp
 * @property {Uint8Array} moov
 * @property {number} duration
 * @property {number[]} cutPoints
 * @property {ReturnType<typeof parseTrak> & {}} video
 * @property {(ReturnType<typeof parseTrak> & {}) | null} audio
 */

/**
 * Index an MP4: sample tables, decoder configs, and nothing else.
 *
 * @param {Source & { name?: string }} source
 * @param {{ id: string, kind: 'main'|'clip', name?: string, onProgress?: (f: number) => void, signal?: AbortSignal }} options
 * @returns {Promise<Asset>}
 */
export async function indexMedia(source, options) {
  const top = await scanTopLevel(source, options.onProgress, options.signal);
  const moovBox = findBox(top, 'moov');
  const ftypBox = findBox(top, 'ftyp');
  if (!moovBox) throw new DemuxError('This file has no moov box — it may not be an MP4.');
  if (!findBox(top, 'mdat')) throw new DemuxError('This file has no mdat box — it may not be an MP4.');

  const moov = await source.read(moovBox.start, moovBox.start + moovBox.size);
  const ftyp = ftypBox
    ? await source.read(ftypBox.start, ftypBox.start + ftypBox.size)
    : new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d]);

  const moovBoxes = readBoxes(moov);
  const moovRoot = findBox(moovBoxes, 'moov');
  if (!moovRoot) throw new DemuxError('Could not parse the moov box.');
  if (findBox(childBoxes(moov, moovRoot), 'mvex')) {
    throw new DemuxError('This file is already fragmented (it has an mvex box). Re-index it as a regular MP4 first.');
  }

  const mvhd = findBox(childBoxes(moov, moovRoot), 'mvhd');
  if (!mvhd) throw new DemuxError('Could not read the movie header.');
  const mvhdVersion = moov[mvhd.payload];
  const movieTimescale = view(moov).getUint32(mvhd.payload + (mvhdVersion === 1 ? 20 : 12));
  const movieDuration = mvhdVersion === 1
    ? Number(view(moov).getBigUint64(mvhd.payload + 24))
    : view(moov).getUint32(mvhd.payload + 16);

  const traks = childBoxes(moov, moovRoot)
    .filter((b) => b.type === 'trak')
    .map((trak) => parseTrak(moov, trak))
    .filter((t) => t !== null);

  const video = traks.find((t) => t.kind === 'video');
  if (!video) throw new DemuxError('This file has no video track.');
  const audio = traks.find((t) => t.kind === 'audio') ?? null;

  // One shift for every track, so relative A/V timing is exactly what the file
  // says, and no fragment ever needs a negative `tfdt`.
  const tracks = [video, audio].filter((t) => t !== null);
  let earliest = Infinity;
  for (const track of tracks) {
    for (const sample of track.samples) earliest = Math.min(earliest, sample.dts - track.editShiftSec);
  }
  const shift = earliest < 0 ? -earliest : 0;
  for (const track of tracks) {
    const delta = shift - track.editShiftSec;
    for (const sample of track.samples) {
      sample.dts += delta;
      sample.cts = Math.max(0, sample.cts + delta);
    }
  }

  const cutPoints = [];
  for (const sample of video.samples) {
    if (sample.sync && (cutPoints.length === 0 || sample.dts > cutPoints[cutPoints.length - 1] + 1e-6)) {
      cutPoints.push(sample.dts);
    }
  }
  if (!cutPoints.length) cutPoints.push(0);

  const duration = tracks.reduce((end, track) => {
    const last = track.samples[track.samples.length - 1];
    return Math.max(end, last ? last.dts + last.duration : 0);
  }, 0);

  return {
    id: options.id,
    kind: options.kind,
    name: options.name ?? source.name ?? 'video.mp4',
    source,
    size: source.size,
    ftyp,
    moov,
    duration,
    movieDuration: movieDuration / movieTimescale,
    shift,
    cutPoints,
    video,
    audio,
  };
}

/**
 * Read the payload bytes for a contiguous run of samples, in the order given.
 *
 * Adjacent samples in the file are merged into one read; this matters because a
 * GOP is normally one contiguous mdat range, so a fragment costs a single read.
 *
 * @param {Asset} asset
 * @param {Sample[]} samples
 */
export async function readSampleBytes(asset, samples) {
  /** @type {Uint8Array[]} */
  const chunks = [];
  let runStart = -1;
  let runEnd = -1;
  /** @type {Sample[]} */
  let runSamples = [];

  const flush = async () => {
    if (runStart < 0) return;
    const bytes = await asset.source.read(runStart, runEnd);
    const base = runStart;
    for (const sample of runSamples) {
      const from = sample.offset - base;
      chunks.push(bytes.subarray(from, from + sample.size));
    }
    runStart = -1;
    runEnd = -1;
    runSamples = [];
  };

  for (const sample of samples) {
    if (runStart >= 0 && sample.offset === runEnd) {
      runEnd += sample.size;
      runSamples.push(sample);
      continue;
    }
    await flush();
    runStart = sample.offset;
    runEnd = sample.offset + sample.size;
    runSamples = [sample];
  }
  await flush();

  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Samples whose decode window falls inside `[from, to)` seconds. */
export function samplesInRange(track, from, to) {
  if (!track) return [];
  const start = track.samples.findIndex((s) => s.dts + s.duration > from + 1e-9);
  if (start === -1) return [];
  /** @type {Sample[]} */
  const out = [];
  for (let i = start; i < track.samples.length; i++) {
    const s = track.samples[i];
    if (s.dts >= to - 1e-9) break;
    out.push(s);
  }
  return out;
}
