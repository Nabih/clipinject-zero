/**
 * Demuxer parity against ffprobe.
 *
 * The `*.packets.csv` fixtures are `ffprobe -show_packets` output, committed so
 * the tests are hermetic. That makes ffprobe an **oracle rather than a
 * dependency**: it produced these files once, and nothing at runtime or test time
 * shells out to it.
 *
 * Every field we build a fragment from is compared per packet: byte offset, size,
 * decode time, composition time, and sync flag. A wrong `stsc` expansion or a
 * dropped edit list fails here, not in the browser.
 */

import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { indexMedia, sourceFromFile } from '../src/media/mp4.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const EPS = 1e-5;

async function loadFixture(name) {
  const bytes = new Uint8Array(await readFile(new URL('samples/' + name, new URL('../', import.meta.url))));
  return new File([bytes], name, { type: 'video/mp4' });
}

/** @returns {Promise<Record<number, {dts:number,pts:number,size:number,pos:number,sync:boolean}[]>>} */
async function oracle(name) {
  const text = await readFile(new URL(name, FIXTURES), 'utf8');
  /** @type {Record<number, any[]>} */
  const byStream = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [stream, pts, dts, size, pos, flags] = line.split(',');
    (byStream[Number(stream)] ??= []).push({
      pts: Number(pts),
      dts: Number(dts),
      size: Number(size),
      pos: Number(pos),
      sync: flags.includes('K'),
    });
  }
  return byStream;
}

async function index(name, id) {
  return indexMedia(sourceFromFile(await loadFixture(name)), { id, kind: 'clip' });
}

describe('indexMedia', () => {
  it('reports codec, geometry and duration', async () => {
    const asset = await index('main.mp4', 'main');
    assert.equal(asset.video.codec, 'avc1.4d401e');
    assert.equal(asset.video.width, 640);
    assert.equal(asset.video.height, 360);
    assert.equal(asset.audio.codec, 'mp4a.40.2');
    assert.equal(asset.audio.sampleRate, 48000);
    assert.equal(asset.audio.channels, 2);
    assert.ok(Math.abs(asset.duration - 120) < 0.1, `duration ${asset.duration}`);
  });

  it('matches ffprobe sample for sample (video)', async () => {
    for (const [file, stream] of [['main.mp4', 0], ['clip-red.mp4', 0]]) {
      const asset = await index(file, 'x');
      const expected = (await oracle(file.replace('.mp4', '.packets.csv')))[stream];
      assert.equal(asset.video.samples.length, expected.length, `${file}: sample count`);

      for (let i = 0; i < expected.length; i++) {
        const got = asset.video.samples[i];
        const want = expected[i];
        assert.equal(got.offset, want.pos, `${file} v[${i}] offset`);
        assert.equal(got.size, want.size, `${file} v[${i}] size`);
        assert.ok(Math.abs(got.dts - (want.dts + asset.shift)) < EPS, `${file} v[${i}] dts ${got.dts} vs ${want.dts + asset.shift}`);
        assert.ok(Math.abs(got.cts - (want.pts + asset.shift)) < EPS, `${file} v[${i}] cts ${got.cts} vs ${want.pts + asset.shift}`);
        assert.equal(got.sync, want.sync, `${file} v[${i}] sync`);
      }
    }
  });

  it('matches ffprobe sample for sample (audio)', async () => {
    for (const [file, stream] of [['main.mp4', 1], ['clip-red.mp4', 1]]) {
      const asset = await index(file, 'x');
      const expected = (await oracle(file.replace('.mp4', '.packets.csv')))[stream];
      assert.ok(asset.audio, `${file}: has audio`);
      assert.equal(asset.audio.samples.length, expected.length, `${file}: sample count`);

      for (let i = 0; i < expected.length; i++) {
        const got = asset.audio.samples[i];
        const want = expected[i];
        assert.equal(got.offset, want.pos, `${file} a[${i}] offset`);
        assert.equal(got.size, want.size, `${file} a[${i}] size`);
        assert.ok(Math.abs(got.dts - (want.dts + asset.shift)) < EPS, `${file} a[${i}] dts`);
      }
    }
  });

  it('applies the edit list, so priming lands before zero', async () => {
    const asset = await index('main.mp4', 'main');
    // The first video sample is presented at cts = one frame, not 0, and its
    // decode time is 0 — the file's edit list says presentation starts 1024 ticks
    // in. Getting this wrong shifts every clip's audio against its video.
    assert.ok(asset.shift > 0.06 && asset.shift < 0.07, `shift ${asset.shift}`);
    assert.ok(Math.abs(asset.video.samples[0].dts) < EPS);
    assert.ok(asset.video.samples[0].cts > asset.video.samples[0].dts);
  });

  it('emits cut points that are sync samples', async () => {
    const asset = await index('main.mp4', 'main');
    assert.equal(asset.cutPoints.length, 60);
    assert.equal(asset.cutPoints[0], 0);
    for (const point of asset.cutPoints) {
      const match = asset.video.samples.find((s) => Math.abs(s.dts - point) < EPS);
      assert.ok(match, `cut point ${point} has a sample`);
      assert.equal(match.sync, true, `cut point ${point} is a sync sample`);
    }
    for (let i = 1; i < asset.cutPoints.length; i++) {
      assert.ok(asset.cutPoints[i] > asset.cutPoints[i - 1], 'cut points increase');
    }
  });

  it('rejects files it cannot handle with a sentence, not a stack trace', async () => {
    const bytes = new Uint8Array(64);
    const file = new File([bytes], 'nope.mp4', { type: 'video/mp4' });
    await assert.rejects(
      indexMedia(sourceFromFile(file), { id: 'x', kind: 'clip' }),
      /no moov box|no mdat box/,
    );
  });
});
