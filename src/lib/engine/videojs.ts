import { MseEngine } from './MseEngine';
import type {
  EngineKind,
  LoadOptions,
  PlaySource,
  PlayerEngine,
  PlayerState,
} from './types';

/**
 * Method C — video.js as a control skin over the very same MSE engine.
 *
 * `docs/05-videojs-engine.md` is the specification. The important constraint is
 * the version: video.js 10 removed the Tech/source-handler architecture, so this
 * adapter depends on `video.js@8.x`.
 */

const SOURCE_TYPE = 'video/mp-virtual';
const SOURCE_URL = 'virtual://project';

type VideoJsPlayer = {
  src(source: { src: string; type: string }): void;
  dispose(): void;
  el(): HTMLElement;
  paused(): boolean;
  pause(): void;
  currentTime(): number;
  duration(): number;
  buffered(): TimeRanges;
  play(): Promise<void> | void;
};

interface Host {
  engine: MseEngine | null;
  source: PlaySource | null;
  seekTo: number;
  autoplay: boolean;
  resolveReady: (() => void) | null;
}

let registered = false;
let host: Host | null = null;

function registerSourceHandler(videojs: { getTech(name: string): any }): void {
  if (registered) return;
  registered = true;

  const sourceHandler = {
    name: 'mp-virtual',
    canHandleSource(srcObj: { type?: string }) {
      return this.canPlayType(srcObj.type);
    },
    canPlayType(type?: string) {
      return type === SOURCE_TYPE ? 'probably' : '';
    },
    handleSource(source: { src: string; type: string }, tech: { el(): HTMLVideoElement }) {
      const engine = new MseEngine();
      engine.attach(tech.el());
      if (host) {
        host.engine = engine;
        if (host.source) {
          void engine.load(host.source, { seekTo: host.seekTo, autoplay: host.autoplay });
        }
        host.resolveReady?.();
        host.resolveReady = null;
      }
      return {
        source,
        dispose() {
          engine.destroy();
          if (host?.engine === engine) host.engine = null;
        },
      };
    },
  };

  // Index 0 puts this ahead of the bundled VHS handler.
  videojs.getTech('Html5').registerSourceHandler(sourceHandler, 0);
}

export class VideoJsEngine implements PlayerEngine {
  readonly kind: EngineKind = 'videojs';

  private player: VideoJsPlayer | null = null;
  private inner: MseEngine | null = null;
  private source: PlaySource | null = null;

  get videoElement(): HTMLVideoElement | null {
    const el = this.player?.el().querySelector('video');
    return (el as HTMLVideoElement | null) ?? null;
  }

  get time(): number {
    return this.inner?.time ?? this.player?.currentTime() ?? 0;
  }

  async mount(container: HTMLElement): Promise<void> {
    const [{ default: videojs }] = await Promise.all([
      import('video.js'),
      import('video.js/dist/video-js.css'),
    ]);

    registerSourceHandler(videojs as unknown as { getTech(name: string): any });

    container.innerHTML = '';
    const video = document.createElement('video');
    video.className = 'video-js vjs-big-play-centered';
    video.setAttribute('playsinline', 'true');
    container.appendChild(video);

    const player = videojs(video, {
      controls: true,
      autoplay: false,
      preload: 'auto',
      fluid: false,
      fill: true,
      playsinline: true,
      liveui: false,
      sources: [],
    }) as unknown as VideoJsPlayer;
    this.player = player;

    const ready = new Promise<void>((resolve) => {
      host = { engine: null, source: null, seekTo: 0, autoplay: false, resolveReady: resolve };
      // If the handler never fires the player is unusable; fail open after 4 s.
      setTimeout(resolve, 4000);
    });

    player.src({ src: SOURCE_URL, type: SOURCE_TYPE });
    await ready;

    this.inner = host?.engine ?? null;
    if (!this.inner) {
      throw new Error('video.js did not route the source to the virtual timeline handler.');
    }
    if (this.source) await this.inner.load(this.source, { seekTo: host?.seekTo ?? 0 });
  }

  async load(source: PlaySource | null, opts: LoadOptions = {}): Promise<void> {
    this.source = source;
    if (host) {
      host.source = source;
      host.seekTo = opts.seekTo ?? 0;
      host.autoplay = opts.autoplay ?? false;
    }
    if (this.inner) await this.inner.load(source, opts);
  }

  async play(): Promise<void> {
    if (this.player) await this.player.play();
    else await this.inner?.play();
  }

  pause(): void {
    if (this.inner) this.inner.pause();
    else this.player?.pause();
  }

  seek(time: number): void {
    this.inner?.seek(time);
  }

  subscribe(cb: (s: PlayerState) => void): () => void {
    if (!this.inner) {
      // Not mounted yet: report an inert state so the UI can render.
      cb({
        time: 0,
        duration: 0,
        paused: true,
        buffered: [],
        appending: 0,
        rendered: 0,
        lastError: null,
        segmentLabel: '',
      });
      return () => {};
    }
    return this.inner.subscribe(cb);
  }

  destroy(): void {
    this.inner?.destroy();
    this.inner = null;
    try {
      this.player?.dispose();
    } catch {
      /* already gone */
    }
    this.player = null;
    host = null;
  }
}
