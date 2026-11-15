import { MseEngine } from './MseEngine';
import { SimpleEngine } from './SimpleEngine';
import { VideoJsEngine } from './videojs';
import type { EngineKind, PlayerEngine } from './types';

export * from './types';
export { MseEngine } from './MseEngine';
export { SimpleEngine } from './SimpleEngine';
export { VideoJsEngine } from './videojs';

export const ENGINES: { id: EngineKind; label: string; blurb: string }[] = [
  { id: 'native', label: 'Native MSE', blurb: 'One <video>, one MediaSource. Exact seams.' },
  { id: 'videojs', label: 'video.js', blurb: 'The same MSE core with video.js controls.' },
  { id: 'simple', label: 'Simple', blurb: 'Two pre-rolled elements. Any MP4, ±1 frame.' },
];

export function createEngine(kind: EngineKind): PlayerEngine {
  switch (kind) {
    case 'videojs':
      return new VideoJsEngine();
    case 'simple':
      return new SimpleEngine();
    case 'native':
    default:
      return new MseEngine();
  }
}
