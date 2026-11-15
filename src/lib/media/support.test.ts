import { describe, expect, it } from 'vitest';
import { detectSupport, type SupportEnv } from './support';

function env(over: Partial<SupportEnv> = {}): SupportEnv {
  return { mediaSource: true, managedMediaSource: false, changeType: true, h264: true, ...over };
}

describe('detectSupport', () => {
  it('picks the MSE engine when the browser can decode H.264 through it', () => {
    const support = detectSupport(env());
    expect(support.engine).toBe('native');
    expect(support.note).toBeNull();
  });

  it('falls back to the Simple engine without MediaSource (iPhone Safari)', () => {
    const support = detectSupport(env({ mediaSource: false }));
    expect(support.engine).toBe('simple');
    expect(support.note).toContain('no Media Source Extensions');
  });

  it('names ManagedMediaSource when that is all there is', () => {
    const support = detectSupport(env({ mediaSource: false, managedMediaSource: true }));
    expect(support.engine).toBe('simple');
    expect(support.note).toContain('ManagedMediaSource');
  });

  it('falls back when MSE exists but cannot decode the codec', () => {
    const support = detectSupport(env({ h264: false }));
    expect(support.engine).toBe('simple');
  });

  it('reports a missing changeType without changing the engine', () => {
    // Safari: MSE works, in-place codec switching does not. The native engine
    // never switches, so this is information, not a fallback.
    const support = detectSupport(env({ changeType: false }));
    expect(support.engine).toBe('native');
    expect(support.changeType).toBe(false);
    expect(support.note).toContain('changeType');
  });
});
