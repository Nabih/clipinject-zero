/**
 * Glue between the React tree and the engine.
 *
 * The engine is plain JavaScript with no React inside it; this hook is the only
 * place that knows about both, and it is deliberately thin: load the main, hand
 * over a plan when the plan changes, pump the buffer on a frame loop.
 */

import { useEffect, useRef, useState } from 'react';
import { Player } from '../player/engine.js';

const players = new WeakMap<HTMLVideoElement, Player>();

/** Attach exactly one engine to a video element. */
function playerFor(video: HTMLVideoElement, onStatus: (status: any) => void): Player {
  const existing = players.get(video);
  if (existing) {
    existing.onStatus = onStatus;
    return existing;
  }
  const player = new Player(video, { onStatus });
  (globalThis as any).__player = player; // dev probe hook
  players.set(video, player);
  return player;
}
import { planFor, useProject } from '../state/project';

export interface PlayerApi {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  playing: boolean;
  currentTime: number;
  togglePlay(): void;
  seek(time: number): void;
  engine: Player | null;
}

export function usePlayer(): PlayerApi {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<Player | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  /** Plan signature of the last rebuild, so identical edits are not rebuilt. */
  const rebuiltKey = useRef<string | null>(null);

  const main = useProject((state) => state.main);
  const inserts = useProject((state) => state.inserts);
  const setStatus = useProject((state) => state.setStatus);
  const setError = useProject((state) => state.setError);
  const audioMode = useProject((state) => state.audioMode);

  // One engine per video element, for the life of that element.
  //
  // A ref is not enough: React 19's StrictMode mounts effects twice, and a second
  // Player would assign `video.src` a second time — which wedges the media element
  // (measured in the previous version of this app). Keying on the element makes
  // attachment idempotent no matter how often the effect runs.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const player = playerFor(video, setStatus);
    engineRef.current = player;

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onSeeked = () => player.pump();
    const onTime = () => setCurrentTime(video.currentTime);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('timeupdate', onTime);
    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('timeupdate', onTime);
    };
  }, [setStatus]);

  // A new main video means a new MediaSource.
  useEffect(() => {
    const player = engineRef.current;
    if (!player || !main) return;
    player
      .setMain(main)
      .then(() => player.pump())
      .catch((error: Error) => setError(error.message));
  }, [main, setError]);

  // A changed edit means "rebuild from here", which is a remove plus re-append.
  //
  // The key guards against rebuilding for an edit that did not actually change
  // anything: React runs this effect twice on mount in development, and a second
  // rebuild would throw away a perfectly good buffer and re-append it.
  useEffect(() => {
    const player = engineRef.current;
    if (!player || !main) return;
    const plan = planFor(main, inserts);
    if (!plan) return;
    const key = JSON.stringify([
      main.id,
      audioMode,
      plan.segments.map((segment: any) => [segment.kind, segment.asset.id, segment.srcIn, segment.srcOut]),
    ]);
    useProject.setState({ plan });
    if (key === rebuiltKey.current) return;
    rebuiltKey.current = key;
    player
      .setPlan(plan, player.video.currentTime)
      .catch((error: Error) => setError(error.message));
  }, [main, inserts, audioMode, setError]);

  useEffect(() => {
    const player = engineRef.current;
    if (player) player.audioMode = audioMode;
  }, [audioMode]);

  // Top up the buffer and refresh the clock, but at a human rate rather than every
  // animation frame. Rendering the whole edit 60 times a second saturates the main
  // thread; the playhead only needs to look smooth, and it moves every frame anyway
  // through direct style writes in <Timeline>.
  useEffect(() => {
    let raf = 0;
    let lastPaint = 0;
    const tick = (now: number) => {
      const player = engineRef.current;
      if (player && !player.video.paused && now - lastPaint > 120) {
        lastPaint = now;
        setCurrentTime(player.video.currentTime);
        player.pump();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return {
    videoRef,
    playing,
    currentTime,
    togglePlay() {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) video.play().catch((error: Error) => setError(error.message));
      else video.pause();
    },
    seek(time) {
      const video = videoRef.current;
      if (video) video.currentTime = Math.max(0, time);
    },
    engine: engineRef.current,
  };
}
