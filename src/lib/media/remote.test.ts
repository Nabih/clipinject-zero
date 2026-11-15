import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeFetchFailure, downloadAsFile, normalizeRemoteUrl, remoteFileName } from './remote';

describe('normalizeRemoteUrl', () => {
  it('accepts absolute http(s) URLs', () => {
    expect(normalizeRemoteUrl('https://cdn.example.com/a/clip.mp4')).toBe('https://cdn.example.com/a/clip.mp4');
    expect(normalizeRemoteUrl('  http://example.com/x.mp4  ')).toBe('http://example.com/x.mp4');
  });

  it('assumes https when the scheme is missing', () => {
    expect(normalizeRemoteUrl('example.com/clip.mp4')).toBe('https://example.com/clip.mp4');
  });

  it('rejects empty input and other protocols', () => {
    expect(normalizeRemoteUrl('   ')).toBeNull();
    expect(normalizeRemoteUrl('ftp://example.com/clip.mp4')).toBeNull();
    expect(normalizeRemoteUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeRemoteUrl('/local/clip.mp4')).toBeNull();
  });
});

describe('remoteFileName', () => {
  it('uses the last path segment', () => {
    expect(remoteFileName('https://cdn.example.com/a/b/holiday.mp4')).toBe('holiday.mp4');
  });

  it('decodes and sanitises the name, and adds an extension when missing', () => {
    expect(remoteFileName('https://x.test/my%20clip%21.mp4')).toBe('my_clip_.mp4');
    expect(remoteFileName('https://x.test/watch/abc123')).toBe('abc123.mp4');
  });

  it('falls back when there is no usable segment', () => {
    expect(remoteFileName('https://x.test/')).toBe('remote-clip.mp4');
  });
});

describe('describeFetchFailure', () => {
  it('turns a CORS/network failure into advice', () => {
    const text = describeFetchFailure(new TypeError('Failed to fetch'), 'https://x.test/a.mp4');
    expect(text).toContain('Access-Control-Allow-Origin');
  });

  it('passes other errors through', () => {
    expect(describeFetchFailure(new Error('HTTP 404 Not Found'), 'https://x.test/a.mp4')).toBe(
      'Could not load https://x.test/a.mp4: HTTP 404 Not Found',
    );
  });
});

describe('downloadAsFile', () => {
  function stubFetch(body: Uint8Array, headers: Record<string, string>, ok = true, status = 200) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Two chunks, so progress has to be accumulated rather than assumed.
            const half = Math.floor(body.length / 2);
            controller.enqueue(body.slice(0, half));
            controller.enqueue(body.slice(half));
            controller.close();
          },
        });
        return new Response(stream, { status, headers }) as unknown as Response;
      }),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it('collects the stream into a File with a name from the URL', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    stubFetch(payload, { 'content-length': '8', 'content-type': 'video/mp4' });

    const file = await downloadAsFile('https://cdn.test/clips/one.mp4');
    expect(file.name).toBe('one.mp4');
    expect(file.type).toBe('video/mp4');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(payload);
  });

  it('reports progress as a fraction when the size is known', async () => {
    stubFetch(new Uint8Array(8), { 'content-length': '8' });
    const seen: (number | null)[] = [];
    await downloadAsFile('https://cdn.test/a.mp4', { onProgress: (f) => seen.push(f) });
    expect(seen).toEqual([0.5, 1]);
  });

  it('reports null progress when the size is unknown', async () => {
    stubFetch(new Uint8Array(8), {});
    const seen: (number | null)[] = [];
    await downloadAsFile('https://cdn.test/a.mp4', { onProgress: (f) => seen.push(f) });
    expect(seen).toEqual([null, null]);
  });

  it('throws on a non-2xx response', async () => {
    stubFetch(new Uint8Array(0), {}, false, 404);
    await expect(downloadAsFile('https://cdn.test/a.mp4')).rejects.toThrow('HTTP 404');
  });
});
