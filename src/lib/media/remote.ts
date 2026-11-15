/**
 * Helpers for remote clip URLs.
 *
 * The MSE engine needs the *bytes* of a clip to index it (durations, keyframe
 * boundaries, audio samples), so a remote URL has to be fetched, not merely
 * pointed at a `<video>`. That makes CORS the deciding factor: a server that does
 * not send `Access-Control-Allow-Origin` cannot be played through this app, and
 * the UI has to say so plainly instead of failing mysteriously.
 */

/**
 * Download a URL into a `File`.
 *
 * The result is handed to exactly the same indexer as a dropped file, so the two
 * are indistinguishable downstream — same fragment table, same audio remux. The
 * only thing worth adding on top is progress: a dropped file reports its own read
 * progress, and a download should report its own the same way.
 */
export async function downloadAsFile(
  url: string,
  opts: { onProgress?: (fraction: number | null) => void; signal?: AbortSignal } = {},
): Promise<File> {
  const response = await fetch(url, { mode: 'cors', signal: opts.signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());

  const total = Number(response.headers.get('content-length') ?? 0);
  const type = response.headers.get('content-type') ?? '';
  const chunks: Uint8Array[] = [];
  let received = 0;

  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      // `null` means "unknown size" so the UI can show an indeterminate bar
      // instead of a progress bar stuck at zero.
      opts.onProgress?.(total > 0 ? Math.min(received / total, 1) : null);
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    chunks.push(buffer);
    received = buffer.byteLength;
  }

  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }

  const name = remoteFileName(url);
  return new File([bytes], name, { type: type.split(';')[0] || 'video/mp4' });
}

/** Accept only absolute http(s) URLs, with or without a scheme typed by hand. */
export function normalizeRemoteUrl(input: string): string | null {
  const raw = input.trim();
  // A bare path ("/clips/a.mp4") is not a remote URL, and prefixing a scheme
  // would silently turn it into a host name.
  if (!raw || raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('?')) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A sensible file name for the fetched blob.
 *
 * The name shows up in the library and in the timeline label, so it is worth
 * recovering something readable: the last path segment, URL-decoded, with an
 * `.mp4` extension when the URL has none (the app is MP4-only for now).
 */
export function remoteFileName(url: string, fallback = 'remote-clip.mp4'): string {
  let path = '';
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return fallback;
  }

  const last = path.split('/').filter(Boolean).at(-1) ?? '';
  if (!last) return fallback;
  // Strip characters that are awkward in a download-style name.
  const safe = last.replace(/[^\w.\-]+/g, '_').slice(0, 80);
  if (!safe) return fallback;
  return /\.[a-z0-9]{2,4}$/i.test(safe) ? safe : `${safe}.mp4`;
}

/** Why a fetch failed, in words a user can act on. */
export function describeFetchFailure(error: unknown, url: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|networkerror|cors/i.test(message)) {
    return (
      `Could not read ${url}. The server most likely does not allow cross-origin reads ` +
      `(no Access-Control-Allow-Origin header). The clip has to be downloadable from this ` +
      `app, so try a URL that sends that header, or download the file and add it locally.`
    );
  }
  return `Could not load ${url}: ${message}`;
}
