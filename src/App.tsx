import { useCallback, useEffect, useMemo, useState } from 'react';
import { Hud } from './components/Hud';
import { InsertList } from './components/InsertList';
import { Library } from './components/Library';
import { TimelineStrip } from './components/TimelineStrip';
import { usePlayer } from './hooks/usePlayer';
import { AUDIO_MODES, type AudioMode } from './lib/media/audioPlan';
import { findConfigWarnings, mseBlocker, resolveAudioConfig } from './lib/media/codec';
import { detectSupport, readSupportEnv } from './lib/media/support';
import { ENGINES } from './lib/engine';
import { formatTime, isInClip, toMain } from './lib/timeline/map';
import {
  assetMap,
  buildPlaySource,
  selectClips,
  selectIssues,
  selectMain,
  selectTimeline,
  useProject,
} from './state/project';

export default function App() {
  const assets = useProject((s) => s.assets);
  const mainId = useProject((s) => s.mainId);
  const insertions = useProject((s) => s.insertions);
  const engine = useProject((s) => s.engine);
  const audioMode = useProject((s) => s.audioMode);
  const busy = useProject((s) => s.busy);
  const notice = useProject((s) => s.notice);
  const failed = useProject((s) => s.failed);
  const addFiles = useProject((s) => s.addFiles);
  const removeAsset = useProject((s) => s.removeAsset);
  const addInsertion = useProject((s) => s.addInsertion);
  const updateInsertion = useProject((s) => s.updateInsertion);
  const removeInsertion = useProject((s) => s.removeInsertion);
  const setInsertionAt = useProject((s) => s.setInsertionAt);
  const markers = useProject((s) => s.markers);
  const addMarker = useProject((s) => s.addMarker);
  const setMarkerUrl = useProject((s) => s.setMarkerUrl);
  const loadMarker = useProject((s) => s.loadMarker);
  const armMarker = useProject((s) => s.armMarker);
  const triggerArmedMarkers = useProject((s) => s.triggerArmedMarkers);
  const prefetchLead = useProject((s) => s.prefetchLead);
  const setPrefetchLead = useProject((s) => s.setPrefetchLead);
  const removeMarker = useProject((s) => s.removeMarker);
  const setEngine = useProject((s) => s.setEngine);
  const setAudioMode = useProject((s) => s.setAudioMode);
  const dismissNotice = useProject((s) => s.dismissNotice);

  const main = selectMain(assets, mainId);
  const clips = useMemo(() => selectClips(assets), [assets]);
  const timeline = useMemo(() => selectTimeline(assets, mainId, insertions), [assets, mainId, insertions]);
  const issues = useMemo(() => selectIssues(assets, mainId, insertions), [assets, mainId, insertions]);
  const assetsById = useMemo(() => assetMap(assets), [assets]);
  const source = useMemo(
    () => buildPlaySource(assets, mainId, insertions, engine, audioMode),
    [assets, mainId, insertions, engine, audioMode],
  );

  /**
   * Pick the engine this browser can actually play before the first load: on a
   * browser without MediaSource the MSE engine cannot work, and making the user
   * discover that from a failure is pointless.
   */
  const support = useMemo(() => detectSupport(readSupportEnv()), []);
  const [engineReady, setEngineReady] = useState(false);
  useEffect(() => {
    const current = useProject.getState().engine;
    if (support.engine !== 'native' && current === 'native') setEngine(support.engine);
    setEngineReady(true);
  }, [support, setEngine]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openMarkerId, setOpenMarkerId] = useState<string | null>(null);
  const player = usePlayer(engine, source);

  const playheadMain = timeline ? toMain(timeline, player.state.time) : 0;

  // Deferred markers fire when the playhead reaches them. This runs on every
  // time update, which is cheap: `triggerArmedMarkers` only looks at armed ones
  // and flips them to `loading` before any await, so it cannot double-fire.
  useEffect(() => {
    if (!markers.length) return;
    triggerArmedMarkers(playheadMain);
  }, [markers, triggerArmedMarkers, playheadMain]);

  const blocker = useMemo(() => {
    if (!main || engine === 'simple') return null;
    return mseBlocker(main.meta, clips.map((c) => c.meta), resolveAudioConfig(main.meta, clips.map((c) => c.meta)));
  }, [main, clips, engine]);

  // Non-blocking things the user should know before blaming the app.
  const warnings = useMemo(() => {
    if (!main || engine === 'simple') return [];
    const list = findConfigWarnings(main.meta, clips.map((c) => c.meta));
    if (audioMode === 'mix' && clips.length) {
      list.push(
        'Mix needs the clip and the bed summed, which the MSE engine cannot do without re-encoding audio — it plays the clip audio instead. Switch to Simple for the mix bed.',
      );
    }
    return list;
  }, [main, clips, engine, audioMode]);

  const addMarkerAtPlayhead = useCallback(() => {
    const id = addMarker(playheadMain);
    if (id) setOpenMarkerId(id);
  }, [addMarker, playheadMain]);

  const insertAtPlayhead = useCallback(
    (clipId: string) => {
      const id = addInsertion(clipId, playheadMain);
      if (id) setSelectedId(id);
    },
    [addInsertion, playheadMain],
  );

  // Keyboard: space toggles playback.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable) return;
      if (e.code === 'Space') {
        e.preventDefault();
        player.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player]);

  // Debug/automation surface. Harmless in production and useful in the console.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__clipinject = {
      project: useProject,
      getEngine: () => player.engineRef.current,
      getState: () => player.state,
      getTimeline: () => timeline,
      getSource: () => source,
    };
  }, [player, timeline, source]);

  const engineLabel = ENGINES.find((e) => e.id === engine)?.label ?? engine;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>ClipInject</h1>
          <span>virtual timeline</span>
        </div>

        <div className="field">
          <label htmlFor="engine">Engine</label>
          <select
            id="engine"
            className="select"
            value={engine}
            onChange={(e) => setEngine(e.target.value as typeof engine)}
          >
            {ENGINES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="audio">Audio</label>
          <select
            id="audio"
            className="select"
            value={audioMode}
            onChange={(e) => setAudioMode(e.target.value as AudioMode)}
          >
            {AUDIO_MODES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <span className="spacer" />

        <span className="chip">{assets.length} file{assets.length === 1 ? '' : 's'}</span>
        <span className="chip">{insertions.length} insertion{insertions.length === 1 ? '' : 's'}</span>
        {timeline && <span className="chip accent">result {formatTime(timeline.duration)}</span>}
      </header>

      <div className="layout">
        <aside className="rail-left">
          <Library
            main={main}
            clips={clips}
            busy={busy}
            playheadMainTime={playheadMain}
            onFiles={(files, kind) => void addFiles(files, kind)}
            onRemove={removeAsset}
            onInsert={insertAtPlayhead}
          />
        </aside>

        <section className="stage">
          {failed && (
            <div className="banner bad">
              <span>{failed}</span>
              <button className="btn" onClick={dismissNotice}>
                Dismiss
              </button>
            </div>
          )}
          {!failed && notice && (
            <div className="banner warn">
              <span>{notice}</span>
              <button className="btn" onClick={dismissNotice}>
                Dismiss
              </button>
            </div>
          )}
          {warnings.map((text) => (
            <div className="banner warn" key={text}>
              <span>{text}</span>
            </div>
          ))}
          {engineReady && support.note && (
            <div className="banner warn">
              <span>{support.note}</span>
            </div>
          )}
          {blocker && (
            <div className="banner warn">
              <span>
                {engineLabel} cannot play this edit: {blocker} Switch to <strong>Simple</strong>.
              </span>
            </div>
          )}
          {player.error && (
            <div className="banner bad">
              <span>{player.error}</span>
            </div>
          )}

          <div className="player">
            <div ref={player.hostRef} style={{ position: 'absolute', inset: 0 }} />
            {!main && (
              <div className="player-empty">
                <div style={{ fontSize: 13 }}>Add a main video to begin</div>
                <div style={{ fontSize: 11 }}>MP4 · H.264 + AAC recommended</div>
              </div>
            )}
          </div>

          <div className="transport">
            <button
              className="play-btn"
              onClick={player.toggle}
              disabled={!source}
              title={player.state.paused ? 'Play (space)' : 'Pause (space)'}
            >
              {player.state.paused ? '▶' : '❚❚'}
            </button>
            <div className="time">
              {formatTime(player.state.time, true)} <span className="total">/ {formatTime(player.state.duration, true)}</span>
            </div>
            <div className="time" style={{ color: 'var(--muted)' }}>
              main {formatTime(playheadMain, true)}
              {timeline && isInClip(timeline, player.state.time) ? ' · in clip' : ''}
            </div>
            <span className="spacer" />
            <span className="chip">{player.state.buffered.length} buffered</span>
            {player.state.lastError && <span className="chip bad">error</span>}
            {source && !player.state.paused && <span className="chip accent">playing</span>}
          </div>

          {timeline ? (
            <TimelineStrip
              timeline={timeline}
              time={player.state.time}
              buffered={player.state.buffered}
              assets={assetsById}
              selectedInsertionId={selectedId}
              markers={markers}
              openMarkerId={openMarkerId}
              onSeek={player.seek}
              onSelect={setSelectedId}
              onAddMarker={addMarkerAtPlayhead}
              onOpenMarker={setOpenMarkerId}
              onMarkerUrl={setMarkerUrl}
              onMarkerArm={armMarker}
              lead={prefetchLead}
              onLead={setPrefetchLead}
              onMarkerLoad={(id) => void loadMarker(id)}
              onMarkerRemove={removeMarker}
            />
          ) : (
            <div className="timeline">
              <div className="track" />
              <div className="track-legend">
                <span>timeline appears once a main video is loaded</span>
              </div>
            </div>
          )}

          <section className="panel">
            <div className="panel-head">
              <h2>Insertions</h2>
              <span className="chip">{insertions.length}</span>
            </div>
            <div className="panel-body">
              <InsertList
                insertions={insertions}
                assets={assetsById}
                timeline={timeline}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onSetAt={setInsertionAt}
                onUpdate={updateInsertion}
                onRemove={removeInsertion}
                onSeek={player.seek}
              />
              {issues.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  {issues.map((issue, i) => (
                    <div key={`${issue.code}-${i}`} className={`issue${issue.level === 'error' ? ' error' : ''}`}>
                      <span className="chip">{issue.level}</span>
                      <span>{issue.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </section>

        <aside className="rail-right">
          <section className="panel">
            <div className="panel-head">
              <h2>Diagnostics</h2>
            </div>
            <div className="panel-body">
              <Hud engineLabel={engineLabel} state={player.state} timeline={timeline} audioMode={audioMode} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Audio mode</h2>
            </div>
            <div className="panel-body">
              <p className="hint" style={{ margin: 0 }}>
                {AUDIO_MODES.find((m) => m.id === audioMode)?.hint}
              </p>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Engine</h2>
            </div>
            <div className="panel-body">
              <p className="hint" style={{ margin: 0 }}>
                {ENGINES.find((e) => e.id === engine)?.blurb}
              </p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
