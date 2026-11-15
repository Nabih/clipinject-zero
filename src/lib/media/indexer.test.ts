import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { muxSilence } from './audioPlan';
import { indexAsset } from './indexer';
import { silentSamples } from './silence';

const FIXTURES = new URL('../../../tests/fixtures/', import.meta.url);

async function fixture(name: string): Promise<File> {
  const bytes = await readFile(new URL(name, FIXTURES));
  return new File([new Uint8Array(bytes)], name, { type: 'video/mp4' });
}

describe('indexAsset', () => {
  it('reads duration, codecs and track geometry', async () => {
    const asset = await indexAsset({ id: 'main', kind: 'main', file: await fixture('main-fast.mp4') });
    expect(asset.meta.duration).toBeCloseTo(30, 1);
    expect(asset.meta.video.codec).toMatch(/^avc1\./);
    expect(asset.meta.video.width).toBe(640);
    expect(asset.meta.video.height).toBe(360);
    expect(asset.meta.audio?.sampleRate).toBe(48000);
    expect(asset.meta.audio?.channels).toBe(2);
    expect(asset.meta.audio?.codec).toBe('mp4a.40.2');
  });

  it('produces RAP-aligned fragments that tile the file with no gaps', async () => {
    const asset = await indexAsset({ id: 'main', kind: 'main', file: await fixture('main-fast.mp4') });
    expect(asset.fragments.length).toBeGreaterThan(10);

    for (let i = 1; i < asset.fragments.length; i++) {
      expect(asset.fragments[i].start).toBeCloseTo(asset.fragments[i - 1].end, 4);
    }
    // 30 s at a 2 s GOP
    expect(asset.fragments[0].start).toBeCloseTo(0, 3);
    expect(asset.fragments.at(-1)!.end).toBeCloseTo(30, 1);
    expect(asset.meta.cutPoints).toEqual(asset.fragments.map((f) => f.start));
  });

  it('carries an init segment that MSE can identify', async () => {
    const asset = await indexAsset({ id: 'main', kind: 'main', file: await fixture('main-fast.mp4') });
    expect(asset.videoInit.byteLength).toBeGreaterThan(100);
    const ascii = new TextDecoder('latin1').decode(asset.videoInit);
    expect(ascii).toContain('ftyp');
    expect(ascii).toContain('moov');
    expect(ascii).toContain('mvex');
  });

  it('extracts audio frames that cover the whole timeline', async () => {
    const asset = await indexAsset({ id: 'main', kind: 'main', file: await fixture('main-fast.mp4') });
    expect(asset.audioSamples.length).toBeGreaterThan(1000);
    const first = asset.audioSamples[0];
    const last = asset.audioSamples.at(-1)!;
    expect(first.time).toBeCloseTo(0, 3);
    expect(last.time + last.duration).toBeCloseTo(30, 1);
    for (let i = 1; i < asset.audioSamples.length; i++) {
      expect(asset.audioSamples[i].time).toBeGreaterThanOrEqual(asset.audioSamples[i - 1].time);
    }
  });

  it('handles a clip with no audio track', async () => {
    const asset = await indexAsset({ id: 'c', kind: 'clip', file: await fixture('clip-silent.mp4') });
    expect(asset.meta.duration).toBeCloseTo(5, 1);
    expect(asset.meta.audio).toBeUndefined();
    expect(asset.audioSamples).toHaveLength(0);
    expect(asset.fragments.length).toBeGreaterThan(1);
  });

  it('handles a file whose moov atom is at the end', async () => {
    const asset = await indexAsset({ id: 'm', kind: 'main', file: await fixture('main-slowstart.mp4') });
    expect(asset.meta.duration).toBeCloseTo(10, 1);
    expect(asset.fragments.length).toBeGreaterThan(3);
    expect(asset.audioSamples.length).toBeGreaterThan(300);
  });

  it('reports abort', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      indexAsset({ id: 'm', kind: 'main', file: await fixture('main-fast.mp4'), signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });
});

describe('decoder configuration fingerprint', () => {
  it('detects identical avcC and different avcC', async () => {
    const main = await indexAsset({ id: 'a', kind: 'main', file: await fixture('main-fast.mp4') });
    const same = await indexAsset({ id: 'b', kind: 'clip', file: await fixture('clip-silent.mp4') });
    const different = await indexAsset({ id: 'c', kind: 'clip', file: await fixture('clip-a.mp4') });

    expect(main.meta.video.configKey).toBeTruthy();
    expect(main.meta.video.configKey).toBe(same.meta.video.configKey);
    expect(main.meta.video.configKey).not.toBe(different.meta.video.configKey);
    // Same codec string even though the config bytes differ: this is exactly the
    // case that used to cost a GOP at every splice.
    expect(main.meta.video.codec).toBe(different.meta.video.codec);
  });
});

describe('silence filler', () => {
  it('covers exactly the requested duration', () => {
    const frames = silentSamples(5, 48000, 2);
    expect(frames).not.toBeNull();
    expect(frames!.length).toBe(Math.ceil(5 / (1024 / 48000)));
    const total = frames!.reduce((n, f) => n + f.duration, 0);
    expect(total).toBeCloseTo(5, 3);
  });

  it('muxes to a playable AAC buffer and refuses unknown channel counts', () => {
    const config = { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2 };
    const buffer = muxSilence(1, config)!;
    expect(buffer.byteLength).toBeGreaterThan(500);
    const head = new TextDecoder('latin1').decode(buffer.slice(4, 12));
    expect(head).toContain('ftyp');
    expect(muxSilence(1, { ...config, channels: 6 })).toBeNull();
  });
});

describe('leading stub fragment', () => {
  it('is merged so cut points start at the first real GOP boundary', async () => {
    const asset = await indexAsset({ id: 'a', kind: 'main', file: await fixture('main-fast.mp4') });
    const first = asset.fragments[0];
    // Was a single 1-frame fragment (0.033 s) before the merge.
    expect(first.end - first.start).toBeGreaterThan(1);
    expect(first.start).toBeCloseTo(0, 3);
    expect(asset.meta.cutPoints[1]).toBeCloseTo(asset.fragments[1].start, 6);
    expect(asset.meta.cutPoints[1]).toBeGreaterThan(1);

    // Still a clean tiling after the merge.
    for (let i = 1; i < asset.fragments.length; i++) {
      expect(asset.fragments[i].start).toBeCloseTo(asset.fragments[i - 1].end, 4);
    }
  });
});
