# ClipInject — Plan & Decision Record

Status: **plan locked, implementation not started.** This file is the index; each
method has its own step-by-step file in `docs/`.

## What it does

Load one long main video plus any number of short clips. Mark where each clip
should be injected on the main timeline. Press play. The result plays start to
finish in **one video element that never reloads**, with no gap at the seams.

## How it works, in one sentence

The main video is cut at keyframes and clips are laid inline into a **virtual
timeline**; the player is fed virtual time continuously through MSE (or a
pre-rolled two-element handoff), with `src` assigned exactly once.

## Locked decisions

| # | Decision | Your call |
|---|---|---|
| 1 | Insertion points snap to the nearest **keyframe**; drift is shown in the UI | v1 is fine, revisit later |
| 2 | Third-party player: **video.js first** (pinned to 8.24.1 — v10 removed source handlers) | yes |
| 3 | **Chrome-only** in v1; Safari/iOS written up as a follow-up | yes |
| 4 | Native MSE and video.js selectable from a **dropdown** | yes |
| 5 | Clip audio plays; a clip with no audio track is simply silent | yes |
| 6 | **No export/download** — realtime browser playback only | yes |

Audio behaviour gets its own dropdown with three modes (`Replace` / `Mix` /
`Silent`) — see `docs/07-audio-modes.md`, including why "let the main audio keep
running under the clip" is physically impossible without desync.

## Methods, one file each

| File | Method | Role |
|---|---|---|
| `docs/00-architecture.md` | System design, module map, build order | index |
| `docs/01-virtual-timeline.md` | Virtual timeline + time mapping | shared spine |
| `docs/02-media-indexing.md` | mp4box probing, fragmentation, storage | shared |
| `docs/03-native-mse-engine.md` | **Method A** — native `<video>` + MSE | default |
| `docs/04-simple-engine.md` | **Method B** — two pre-rolled elements | fallback |
| `docs/05-videojs-engine.md` | **Method C** — video.js source handler | dropdown option |
| `docs/06-jwplayer-engine.md` | **Method D** — pre-remux → blob | optional, keyed |
| `docs/07-audio-modes.md` | Audio dropdown semantics | shared |
| `docs/08-safari-next-steps.md` | Safari/iOS plan | follow-up |
| `docs/diagrams.html` | Rendered diagram sheet | visual |

## Phase 0 gate

Before any app code: a ~120-line throwaway page proving one hardcoded splice is
gapless in Chrome. Four specific questions in `docs/03-native-mse-engine.md`
step 0. If it fails, the Simple engine becomes primary instead.

## Stack

Vite · React · TypeScript · Tailwind · zustand · vitest · `mp4box` 2.5.0 ·
`mp4-muxer` 5.2.2 (audio only, plus the JW remux) · `video.js` 8.24.1 (lazy).
No backend, no uploads, no server. Files never leave the machine.
