/**
 * ClipInject Zero — the React shell.
 *
 * Deliberately thin. The video work (demux, fragment writing, buffering) lives in
 * `src/media` and `src/player` and knows nothing about React; this file arranges
 * panels and hands the playhead back to the engine.
 */

import { useEffect } from 'react';
import { Hud } from './components/Hud';
import { InsertList } from './components/InsertList';
import { Library } from './components/Library';
import { Timeline } from './components/Timeline';
import { usePlayer } from './hooks/usePlayer';
import { useProject } from './state/project';

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00.00';
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(2).padStart(5, '0')}`;
}

export default function App() {
  const { videoRef, playing, currentTime, togglePlay, seek } = usePlayer();
  const notice = useProject((state) => state.notice);
  const error = useProject((state) => state.error);
  const setError = useProject((state) => state.setError);
  const plan = useProject((state) => state.plan);
  const audioMode = useProject((state) => state.audioMode);
  const setAudioMode = useProject((state) => state.setAudioMode);
  const mainTime = useProject((state) => state.mainTimeAt);

  const duration = plan?.duration ?? 0;

  // Space toggles playback, arrows nudge. The engine is happy to be seeked while
  // playing: a seek past the buffer triggers a remove-and-re-append.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (event.code === 'Space') {
        event.preventDefault();
        togglePlay();
      } else if (event.code === 'ArrowRight') {
        seek(currentTime + 5);
      } else if (event.code === 'ArrowLeft') {
        seek(currentTime - 5);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seek, currentTime]);

  return (
    <>
      <header>
        <h1>
          ClipInject <span className="zero">zero</span>
        </h1>
        <p className="tagline">
          Gapless clip insertion in one <code>&lt;video&gt;</code>, with a hand-written MP4 demuxer and
          fragment writer. No mp4box, no mp4-muxer, no video.js — React only draws the panels.
        </p>
      </header>

      <main>
        <Library mainTime={mainTime(currentTime)} />

        <section className="stage panel">
          <video ref={videoRef} playsInline />
          <div className="stage-bar">
            <button type="button" className="primary" onClick={togglePlay} disabled={!duration}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <span className="time">
              {fmt(currentTime)} / {fmt(duration)}
            </span>
            <label className="muted inline">
              clip audio
              <select value={audioMode} onChange={(event) => setAudioMode(event.target.value as 'replace' | 'silent')}>
                <option value="replace">play it</option>
                <option value="silent">silence</option>
              </select>
            </label>
            {notice ? <span className="muted">{notice}</span> : null}
            {error ? (
              <span className="error-text" onClick={() => setError(null)}>
                {error}
              </span>
            ) : null}
          </div>
        </section>

        <Timeline currentTime={currentTime} onSeek={seek} />
        <InsertList />
        <Hud />
      </main>
    </>
  );
}
