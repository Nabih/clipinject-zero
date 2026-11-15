/**
 * Fragment writer structure.
 *
 * These tests read the writer's own output back through the box reader and check
 * the things a player would choke on: box sizes that lie, `trun` data offsets that
 * point at the wrong byte, and a `tfdt` that does not match the samples.
 */

import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { boxBytes, childBoxes, findBox, findPath, isWellFormed, readBoxes, view } from '../src/media/box.js';
import { buildInit, buildSegment } from '../src/media/frag.js';
import { indexMedia, sourceFromFile } from '../src/media/mp4.js';

async function asset() {
  const bytes = new Uint8Array(await readFile(new URL('../samples/clip-red.mp4', import.meta.url)));
  return indexMedia(sourceFromFile(new File([bytes], 'clip-red.mp4', { type: 'video/mp4' })), {
    id: 'clip',
    kind: 'clip',
  });
}

describe('buildInit', () => {
  it('produces ftyp + moov with both traks and one trex each', async () => {
    const main = await asset();
    const init = buildInit(main);
    assert.ok(isWellFormed(init));
    assert.deepEqual(readBoxes(init).map((b) => b.type), ['ftyp', 'moov']);

    const moov = findBox(readBoxes(init), 'moov');
    const children = childBoxes(init, moov);
    assert.equal(children.filter((b) => b.type === 'trak').length, 2);
    const mvex = findBox(children, 'mvex');
    assert.ok(mvex, 'mvex present');
    assert.equal(childBoxes(init, mvex).filter((b) => b.type === 'trex').length, 2);

    // trex track ids must be the ones the fragments use.
    const ids = childBoxes(init, mvex)
      .filter((b) => b.type === 'trex')
      .map((trex) => view(init).getUint32(trex.payload + 4));
    assert.deepEqual(ids.sort(), [main.video.trackId, main.audio.trackId].sort());
  });

  it('empties the sample tables but keeps the decoder configuration', async () => {
    const main = await asset();
    const init = buildInit(main);

    const stbl = findPath(init, readBoxes(init), ['moov', 'trak', 'mdia', 'minf', 'stbl']);
    assert.ok(stbl);
    const tables = childBoxes(init, stbl);
    for (const type of ['stts', 'stsc', 'stsz', 'stco']) {
      const box = findBox(tables, type);
      assert.ok(box, `${type} present`);
      const count = view(init).getUint32(box.payload + 4);
      assert.equal(count, 0, `${type} is empty`);
    }
    // ctts/stss describe a non-fragmented file and must not survive.
    assert.equal(findBox(tables, 'ctts'), undefined);
    assert.equal(findBox(tables, 'stss'), undefined);

    // The avcC payload must be byte-identical to the source's.
    const sourceStd = findPath(main.moov, readBoxes(main.moov), ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
    const initStd = findPath(init, readBoxes(init), ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
    assert.ok(sourceStd && initStd);
    assert.deepEqual(boxBytes(init, initStd), boxBytes(main.moov, sourceStd));
  });
});

describe('buildSegment', () => {
  it('points every trun data offset at its own payload', async () => {
    const main = await asset();
    const videoPayload = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const audioPayload = new Uint8Array([9, 9, 9]);
    const segment = buildSegment({
      sequence: 7,
      tracks: [
        {
          trackId: 1,
          timescale: 15360,
          payload: videoPayload,
          samples: [
            { dtsTicks: 15360, durationTicks: 512, size: 6, ctsOffsetTicks: 0, sync: true },
          ],
        },
        {
          trackId: 2,
          timescale: 48000,
          payload: audioPayload,
          samples: [
            { dtsTicks: 48000, durationTicks: 1024, size: 3, ctsOffsetTicks: 0, sync: true },
          ],
        },
      ],
    });

    assert.ok(isWellFormed(segment));
    assert.deepEqual(readBoxes(segment).map((b) => b.type), ['moof', 'mdat']);

    const moof = findBox(readBoxes(segment), 'moof');
    const mdat = findBox(readBoxes(segment), 'mdat');
    const trafs = childBoxes(segment, moof).filter((b) => b.type === 'traf');
    assert.equal(trafs.length, 2);

    const offsets = trafs.map((traf) => {
      const trun = findBox(childBoxes(segment, traf), 'trun');
      assert.ok(trun);
      return view(segment).getUint32(trun.payload + 8); // sample_count, then data_offset
    });

    // default-base-is-moof: offsets are relative to the moof start.
    assert.equal(offsets[0], moof.size + 8);
    assert.equal(offsets[1], moof.size + 8 + videoPayload.byteLength);
    assert.deepEqual(segment.subarray(offsets[0], offsets[0] + 6), videoPayload);
    assert.deepEqual(segment.subarray(offsets[1], offsets[1] + 3), audioPayload);
    assert.equal(mdat.size, 8 + 6 + 3);
  });

  it('writes tfdt in the track timescale and 64 bits wide', async () => {
    const segment = buildSegment({
      sequence: 1,
      tracks: [
        {
          trackId: 1,
          timescale: 15360,
          payload: new Uint8Array([0]),
          samples: [{ dtsTicks: 30720, durationTicks: 512, size: 1, ctsOffsetTicks: 0, sync: true }],
        },
      ],
    });
    const moof = findBox(readBoxes(segment), 'moof');
    const traf = childBoxes(segment, moof).find((b) => b.type === 'traf');
    const tfdt = findBox(childBoxes(segment, traf), 'tfdt');
    assert.equal(segment[tfdt.payload], 1, 'tfdt version 1');
    assert.equal(Number(view(segment).getBigUint64(tfdt.payload + 4)), 30720);
  });

  it('marks sync samples with the right flags, and uses signed offsets when needed', async () => {
    const segment = buildSegment({
      sequence: 1,
      tracks: [
        {
          trackId: 1,
          timescale: 15360,
          payload: new Uint8Array([0, 0]),
          samples: [
            { dtsTicks: 0, durationTicks: 512, size: 1, ctsOffsetTicks: -256, sync: true },
            { dtsTicks: 512, durationTicks: 512, size: 1, ctsOffsetTicks: 256, sync: false },
          ],
        },
      ],
    });
    const moof = findBox(readBoxes(segment), 'moof');
    const traf = childBoxes(segment, moof).find((b) => b.type === 'traf');
    const trun = findBox(childBoxes(segment, traf), 'trun');
    assert.equal(segment[trun.payload], 1, 'trun version 1 for negative offsets');
    const view8 = view(segment);
    // trun payload: version+flags (4), sample_count (4), data_offset (4), samples…
    const flags = view8.getUint32(trun.payload) & 0xffffff;
    assert.ok(flags & 0x800, 'composition offsets present');
    const firstSampleAt = trun.payload + 12;
    assert.equal(view8.getUint32(firstSampleAt + 8), 0x02000000, 'sync flag');
    assert.equal(view8.getInt32(firstSampleAt + 12), -256);
    assert.equal(view8.getUint32(firstSampleAt + 24), 0x01010000, 'non-sync flag');
  });
});
