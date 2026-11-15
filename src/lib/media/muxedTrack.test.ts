import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { muxSegmentAudio, splitAudioSegment } from './audioPlan';
import { indexAsset } from './indexer';
import {
  childBoxes,
  combineInits,
  findPath,
  isWellFormed,
  joinSegments,
  readBoxes,
  renumberSegment,
  stripIndexBoxes,
} from './muxedTrack';

const FIXTURES = new URL('../../../tests/fixtures/', import.meta.url);

async function fixture(name: string): Promise<File> {
  const bytes = await readFile(new URL(name, FIXTURES));
  return new File([new Uint8Array(bytes)], name, { type: 'video/mp4' });
}

const AUDIO_TRACK_ID = 2;

async function setup() {
  const asset = await indexAsset({ id: 'main', kind: 'main', file: await fixture('main-fast.mp4') });
  const segment = {
    id: 's1',
    kind: 'main' as const,
    assetId: 'main',
    srcIn: 0,
    srcOut: 2,
    virtIn: 0,
    virtOut: 2,
  };
  const audio = muxSegmentAudio(segment, asset, {
    codec: 'mp4a.40.2',
    sampleRate: 48000,
    channels: 2,
  });
  if (!audio) throw new Error('no audio segment');
  const { init: audioInit, media } = splitAudioSegment(audio);
  return { asset, audioInit, audioMedia: media };
}

describe('readBoxes', () => {
  it('walks a real init segment and sees ftyp then moov', async () => {
    const { asset } = await setup();
    const types = readBoxes(asset.videoInit).map((b) => b.type);
    expect(types).toContain('ftyp');
    expect(types).toContain('moov');
    expect(isWellFormed(asset.videoInit)).toBe(true);
  });
});

describe('combineInits', () => {
  it('emits a well-formed init with two traks and two trex entries', async () => {
    const { asset, audioInit } = await setup();
    const combined = combineInits(asset.videoInit, audioInit, { audioTrackId: AUDIO_TRACK_ID });

    expect(isWellFormed(combined)).toBe(true);
    expect(readBoxes(combined).map((b) => b.type)).toEqual(['ftyp', 'moov']);

    const moov = readBoxes(combined).find((b) => b.type === 'moov')!;
    const children = childBoxes(combined, moov);
    expect(children.filter((b) => b.type === 'trak')).toHaveLength(2);

    const mvex = children.find((b) => b.type === 'mvex')!;
    const trexs = childBoxes(combined, mvex).filter((b) => b.type === 'trex');
    expect(trexs).toHaveLength(2);

    // Track ids inside trex must be 1 (video) and AUDIO_TRACK_ID (audio).
    const view = new DataView(combined.buffer, combined.byteOffset, combined.byteLength);
    const ids = trexs.map((t) => view.getUint32(t.payload + 4));
    expect(ids.sort()).toEqual([1, AUDIO_TRACK_ID].sort());
  });

  it('keeps the video configuration untouched', async () => {
    const { asset, audioInit } = await setup();
    const combined = combineInits(asset.videoInit, audioInit, { audioTrackId: AUDIO_TRACK_ID });
    const before = findPath(asset.videoInit, readBoxes(asset.videoInit), ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
    const after = findPath(combined, readBoxes(combined), ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    const slice = (bytes: Uint8Array, box: { start: number; size: number }) => bytes.subarray(box.start, box.start + box.size);
    expect(slice(combined, after!)).toEqual(slice(asset.videoInit, before!));
  });

  it('works without an audio track', async () => {
    const { asset } = await setup();
    const combined = combineInits(asset.videoInit, null, { audioTrackId: AUDIO_TRACK_ID });
    expect(isWellFormed(combined)).toBe(true);
    const moov = readBoxes(combined).find((b) => b.type === 'moov')!;
    expect(childBoxes(combined, moov).filter((b) => b.type === 'trak')).toHaveLength(1);
  });
});

describe('renumberSegment', () => {
  it('rewrites the audio tfhd track id and nothing else', async () => {
    const { audioMedia } = await setup();
    const renumbered = renumberSegment(audioMedia, 1, AUDIO_TRACK_ID);

    expect(renumbered.byteLength).toBe(audioMedia.byteLength);
    expect(isWellFormed(renumbered)).toBe(true);

    const view = new DataView(renumbered.buffer, renumbered.byteOffset, renumbered.byteLength);
    const before = new DataView(audioMedia.buffer, audioMedia.byteOffset, audioMedia.byteLength);

    const moof = readBoxes(renumbered).find((b) => b.type === 'moof')!;
    const traf = childBoxes(renumbered, moof).find((b) => b.type === 'traf')!;
    const tfhd = childBoxes(renumbered, traf).find((b) => b.type === 'tfhd')!;
    expect(view.getUint32(tfhd.payload + 4)).toBe(AUDIO_TRACK_ID);

    // payload bytes unchanged: only the id field differs
    let differences = 0;
    for (let i = 0; i < renumbered.length; i++) if (renumbered[i] !== audioMedia[i]) differences++;
    expect(differences).toBeGreaterThan(0);
    expect(differences).toBeLessThanOrEqual(4);
    expect(before.getUint32(tfhd.payload + 4)).toBe(1);
  });
});

describe('joinSegments', () => {
  it('puts two moof+mdat pairs in one append and stays well formed', async () => {
    const { asset, audioMedia } = await setup();
    const video = asset.fragments[0].data;
    const patched = renumberSegment(audioMedia, 1, AUDIO_TRACK_ID);
    const joined = joinSegments(video, patched);

    // mp4-muxer emits one fragment per `minFragmentDuration` (1 s), so a 2 s
    // audio slice is two pairs; the trailing mfra is dropped because its offsets
    // would be stale once the video fragment precedes it.
    expect(isWellFormed(joined)).toBe(true);
    const types = readBoxes(joined).map((b) => b.type);
    expect(types).not.toContain('mfra');
    expect(types.filter((t) => t === 'moof').length).toBeGreaterThanOrEqual(2);
    expect(types.filter((t) => t === 'mdat').length).toBe(types.filter((t) => t === 'moof').length);
    expect(joined.byteLength).toBeLessThan(video.byteLength + patched.byteLength);
    // the video bytes are untouched
    expect(joined.subarray(0, video.byteLength)).toEqual(video);
  });

  it('strips the audio index box', async () => {
    const { audioMedia } = await setup();
    const stripped = stripIndexBoxes(audioMedia);
    expect(readBoxes(stripped).map((b) => b.type)).not.toContain('mfra');
    expect(isWellFormed(stripped)).toBe(true);
    expect(stripped.byteLength).toBeLessThan(audioMedia.byteLength);
  });

  it('returns the video fragment alone when there is no audio', async () => {
    const { asset } = await setup();
    expect(joinSegments(asset.fragments[0].data, null)).toBe(asset.fragments[0].data);
  });
});
