/**
 * Engine registry.
 *
 * `videojs` is gone with the library it wrapped, and `mix` audio with the encoder
 * it needed. What remains is the hand-written MSE engine and a non-MSE fallback.
 */

import { MseEngine } from './MseEngine';
import { SimpleEngine } from './SimpleEngine';
import type { EngineKind, PlayerEngine } from './types';

export * from './types';
export { MseEngine } from './MseEngine';
export { SimpleEngine } from './SimpleEngine';

export const ENGINES: { id: EngineKind; label: string; blurb: string }[] = [
  {
    id: 'native',
    label: 'Native MSE',
    blurb: 'One <video>, one MediaSource, one SourceBuffer. Fragments written by hand.',
  },
  {
    id: 'simple',
    label: 'Simple',
    blurb: 'No MSE: swaps a plain src at each cut. Works anywhere, seams are ±1 frame.',
  },
];

export function createEngine(kind: EngineKind): PlayerEngine {
  return kind === 'simple' ? new SimpleEngine() : new MseEngine();
}
