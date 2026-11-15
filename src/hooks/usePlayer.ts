import { useEffect, useRef, useState } from 'react';
import { createEngine } from '../lib/engine';
import { emptyState, type EngineKind, type PlaySource, type PlayerEngine, type PlayerState } from '../lib/engine/types';
import { toMain, toVirtual } from '../lib/timeline/map';

export interface PlayerApi {
  hostRef: React.RefObject<HTMLDivElement | null>;
  engineRef: React.RefObject<PlayerEngine | null>;
  state: PlayerState;
  error: string | null;
  loading: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (time: number) => void;
}

/**
 * Owns the player engine lifecycle.
 *
 * The engine is recreated only when the engine kind changes. A change to the
 * edit re-uses the same engine and the same `<video>`: the anchor below is what
 * keeps the user on the same main-video frame while the buffer is rebuilt.
 */
export function usePlayer(kind: EngineKind, source: PlaySource | null): PlayerApi {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<PlayerEngine | null>(null);
  const [state, setState] = useState<PlayerState>(emptyState());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const anchorRef = useRef<{ source: PlaySource | null; time: number }>({ source: null, time: 0 });
  const loadSeq = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let unsubscribe = () => {};
    setLoading(true);
    setError(null);

    const engine = createEngine(kind);
    engineRef.current = engine;

    engine
      .mount(host)
      .then(() => {
        if (disposed) return;
        unsubscribe = engine.subscribe((next) => {
          anchorRef.current.time = next.time;
          setState(next);
        });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      disposed = true;
      unsubscribe();
      engine.destroy();
      engineRef.current = null;
    };
  }, [kind]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || loading) return;

    const seq = ++loadSeq.current;
    const previous = anchorRef.current;

    let seekTo = 0;
    if (source && previous.source) {
      // Preserve the main-video position, not the virtual one: moving a clip that
      // sits after the playhead should not move what you are watching.
      seekTo = toVirtual(source.timeline, toMain(previous.source.timeline, previous.time));
    }

    anchorRef.current = { source, time: seekTo };

    engine.load(source, { seekTo }).catch((err: unknown) => {
      if (seq !== loadSeq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [source, loading]);

  const api = useRef<PlayerApi>(null as unknown as PlayerApi);
  api.current = {
    hostRef,
    engineRef,
    state,
    error,
    loading,
    play: () => void engineRef.current?.play(),
    pause: () => engineRef.current?.pause(),
    toggle: () => {
      const engine = engineRef.current;
      if (!engine) return;
      if (state.paused) void engine.play();
      else engine.pause();
    },
    seek: (time: number) => engineRef.current?.seek(time),
  };

  return api.current;
}
