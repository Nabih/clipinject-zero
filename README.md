# ClipInject

Play one long video with short clips injected into it — as **one continuous stream in a single `<video>` element that never reloads its `src`**.

You load a main MP4, drop in any number of short clips, and mark where each one is inserted. Playback is seamless: no reload, no second element swapping in, no visible seam. There is no export — this is a realtime playback engine, not a renderer.

![timeline](docs/diagrams.html)

## How it works

1. **Index** — each MP4 is streamed once through [mp4box.js](https://github.com/gpac/mp4box.js) and turned into keyframe-aligned fragments plus per-sample AAC audio. Nothing is decoded.
2. **Map** — insert points snap to the nearest keyframe-aligned fragment start, and a virtual timeline maps source time ⇄ playback time. Snapping drift is shown in the UI rather than hidden.
3. **Splice** — fragments are appended to a `MediaSource` with `timestampOffset` doing the time shifting. Audio is cut at exact AAC sample boundaries and muxed separately, so a clip that runs longer than the video it replaces gets real silence rather than a hole.
4. **Insert** — the playhead crosses a virtual boundary and simply keeps playing; the bytes it needs are already in the buffer.

Clip audio plays. A clip with no audio track gets **real AAC silence**, never a gap and never an error.

## Remote clips

A marker on the timeline can hold a URL instead of a file. Paste an MP4 URL and it is fetched, indexed and inserted exactly like a dropped clip — and it is *not* preloaded. Loading starts shortly before the insert point (1 s / 2 s / 5 s lead), so arrival behaviour is something you can actually watch and tune.

The URL is fetched as **bytes**, never handed to `<video src>` — the app has to index it to place it. That makes CORS mandatory, and failures name `Access-Control-Allow-Origin` rather than showing a mystery spinner.

## Engines

Switchable from a dropdown:

| engine | what it does |
|---|---|
| **native + MSE** | default; two `SourceBuffer`s, the real work |
| **video.js** (8.24.1) | the same source, driven by video.js |
| **simple** | no MSE, a plain playlist — the fallback when MSE is unusable |

Engine support is probed at startup (`MediaSource`, `ManagedMediaSource`, `SourceBuffer.changeType`, H.264 through MSE), and the app drops to the simple engine with a banner instead of failing at the first append.

## Status

**Chrome only for now.** 69 tests pass, `tsc` clean, `vite build` clean.

Not verified: Safari. `safaridriver` needs a GUI toggle this machine doesn't have, so every Safari claim in `docs/08` is marked as analysis, not measurement. The single-buffer path that Safari would need is built and measured in Chrome — see below.

## The single-buffer path

Safari's stricter MSE wants both tracks in one `SourceBuffer`. That does not require rewriting `moof`s: a Media Segment may contain several `moof`+`mdat` pairs, so the video fragments from mp4box and the audio segments from [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) are passed through untouched. Only the init is combined, and the audio track is renumbered (both producers use track id 1).

Measured in Chrome with `video/mp4; codecs="avc1.4d401e,mp4a.40.2"`: 25 appends, `buffered [[0,24]]`, playback across a clip seam with 0 dropped frames and audio decoded.

```
src/lib/media/muxedTrack.ts   combineInits, renumberTrack, stripIndexBoxes
```

## Run it

```bash
npm install
npm run dev     # http://localhost:5199
```

Load `samples/main.mp4` as the main video, then `samples/clip-red.mp4` (or `-green`, `-blue`) as clips: each clip plays a distinct tone, so a seam is audible as well as visible.

```bash
npm test        # vitest
npm run build
```

## Docs

`HANDOFF.md` is the running engineering log — it records what was measured, what broke, and what was reverted, including the dead ends.

- `docs/00-architecture.md` — the whole design
- `docs/01-virtual-timeline.md` — snapping and the time map
- `docs/02-media-indexing.md` — fragments, audio samples, init bytes
- `docs/03-native-mse-engine.md` — the default engine, seam bugs and all
- `docs/04-simple-engine.md`, `docs/05-videojs-engine.md`, `docs/06-jwplayer-engine.md`
- `docs/07-audio-modes.md` — `replace` / `mix` / `silent`
- `docs/08-safari-next-steps.md` — what Safari actually needs
- `docs/09-remote-markers.md` — deferred URL clips
- `docs/10-mixed-codecs.md` — why mixed-codec playback was attempted and reverted, with the measurements
- `docs/diagrams.html` — open in a browser
