/**
 * Loading: one main video, then any number of clips (local files or a URL).
 *
 * Indexing happens in the demuxer, so the only thing this component decides is
 * *where* a clip goes — which it asks for as a main-timeline time, because that is
 * the timeline the user is thinking in.
 */

import { useState } from 'react';
import { useProject } from '../state/project';

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(2).padStart(5, '0')}`;
}

/**
 * One clip, with its own insert time.
 *
 * The time starts as "the playhead" but stops following it after the user edits
 * the field, so typing a value is not undone by playback moving on.
 */
function ClipRow({
  clip,
  mainTime,
  onInsert,
  onRemove,
}: {
  clip: any;
  mainTime: number;
  onInsert: (id: string, at: number) => void;
  onRemove: (id: string) => void;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const value = typed ?? String(Math.round(mainTime * 2) / 2);

  return (
    <div className="item">
      <span className="name">{clip.name}</span>
      <span className="meta">
        {fmt(clip.duration)} · {clip.video.width}×{clip.video.height}
        {clip.audio ? '' : ' · no audio'}
      </span>
      <input
        type="number"
        min={0}
        step={0.5}
        value={value}
        onChange={(event) => setTyped(event.target.value)}
        aria-label="insert at (main time)"
      />
      <button type="button" className="primary tiny" onClick={() => onInsert(clip.id, Number(value) || 0)}>
        Insert
      </button>
      <button type="button" className="tiny" onClick={() => onRemove(clip.id)}>
        Remove
      </button>
    </div>
  );
}

export function Library({ mainTime }: { mainTime: number }) {
  const main = useProject((state) => state.main);
  const clips = useProject((state) => state.clips);
  const busy = useProject((state) => state.busy);
  const error = useProject((state) => state.error);
  const loadMain = useProject((state) => state.loadMain);
  const addClips = useProject((state) => state.addClips);
  const addRemoteClip = useProject((state) => state.addRemoteClip);
  const removeClip = useProject((state) => state.removeClip);
  const addInsert = useProject((state) => state.addInsert);

  const [url, setUrl] = useState('');

  return (
    <section className="panel">
      <div className="row">
        <label className="file">
          <input
            type="file"
            accept="video/mp4"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) loadMain(file);
              event.target.value = '';
            }}
          />
          <span>1 · Main video</span>
        </label>
        <label className="file">
          <input
            type="file"
            accept="video/mp4"
            multiple
            disabled={!main}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              if (files.length) addClips(files);
              event.target.value = '';
            }}
          />
          <span>2 · Add clips</span>
        </label>
        <span className="muted">
          {main ? `${main.name} · ${fmt(main.duration)} · ${main.video.codec} ${main.video.width}×${main.video.height}` : 'no main loaded'}
        </span>
      </div>

      <div className="row">
        <input
          type="url"
          placeholder="…or paste a clip MP4 URL (needs CORS)"
          value={url}
          disabled={!main}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button
          type="button"
          disabled={!main || !url.trim()}
          onClick={() => {
            addRemoteClip(url.trim());
            setUrl('');
          }}
        >
          Fetch clip
        </button>
        {busy ? <span className="muted">{busy.label}…</span> : null}
        {error ? <span className="error-text">{error}</span> : null}
      </div>

      <h2 style={{ marginTop: 16 }}>
        Clips <span className="muted">{clips.length ? `(${clips.length})` : ''}</span>
      </h2>
      {clips.length === 0 ? (
        <p className="muted">No clips yet.</p>
      ) : (
        <div className="library">
          {clips.map((clip) => (
            <ClipRow key={clip.id} clip={clip} mainTime={mainTime} onInsert={addInsert} onRemove={removeClip} />
          ))}
        </div>
      )}
    </section>
  );
}
