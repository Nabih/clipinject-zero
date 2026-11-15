# HANDOFF — ClipInject

Live status file. **Update after every step.** Last update: **all three seam bugs are
fixed and verified — config change, audio hole, and keyframe alignment.** Playback is continuous across two
insertions, including a clip that has no audio track; video and audio each buffer as
a single range over the whole edit.

---

## 1. What this is

A Vite + React + TS app: load one long **main** MP4 plus N short **clip** MP4s,
mark where each clip is injected on the main timeline, and play the result as one
continuous stream in a single `<video>` element that never reloads.

Design documents (all written, all verified against real library APIs — read these
first, they are the spec):
- `PLAN.md` — decision record
- `docs/00-architecture.md` … `docs/08-safari-next-steps.md` — one file per method
- `docs/diagrams.html` — rendered diagram sheet

Locked decisions: keyframe-snapped insertion points; video.js first (pinned 8.24.1);
Chrome only; native-MSE and video.js switchable from a dropdown; clip audio plays,
a clip with no audio is silent; no export/download.

---

## 2. Environment

- macOS, Node v24.21.0, npm 12.2.0
- Project root: `/Users/nabih/Desktop/ImaGEN/Vid`
- `ffmpeg` / `ffprobe` in `/opt/homebrew/bin`
- Dev server: `npm run dev -- --port 5199 --strictPort`
  Check: `curl -s -o /dev/null -w "%{http_code}" http://localhost:5199/`
- No backend, no uploads.

### Commands

```
npx vitest run          # 49 tests, all passing
npx tsc -b --noEmit     # clean
npx vite build          # clean; video.js code-split into its own chunk
npm run dev -- --port 5199 --strictPort
```

### Test videos for manual runs (`samples/`)

Four files made for clicking around, not for the automated tests:

| file | duration | content |
|---|---|---|
| `main.mp4` | 120 s | `testsrc` pattern (has its own frame counter), 440 Hz tone |
| `clip-red.mp4` | 6 s | solid `#CC2222`, white bar sweeping across, 660 Hz |
| `clip-green.mp4` | 6 s | solid `#22AA44`, same bar, 880 Hz |
| `clip-blue.mp4` | 6 s | solid `#2244CC`, same bar, 1320 Hz |

All four: 640×360, 30 fps, 2 s GOP, H.264 Main + AAC 48 k stereo, and — checked
with the app's own indexer — an **identical `avcC`** (`configKey 014d401effe10018…`),
so insertion points are clean and no decoder reconfiguration happens at a seam.
Main indexes to 61 fragments, each clip to 4. Inserting the three clips at 20 / 60
/ 90 s gives 7 segments, duration 138 s, `video [[0,66]]` and `audio [[0,66]]` —
one range each — and the picture at 25 s is the red clip (sampled average
`rgb(200,49,50)` ≈ the fill colour) at `readyState 4`.

Regenerate:

```
V='-c:v libx264 -profile:v main -pix_fmt yuv420p -preset veryfast -crf 23 \
   -g 60 -keyint_min 60 -sc_threshold 0'
ffmpeg -y -f lavfi -i "testsrc=size=640x360:rate=30:duration=120" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=120" \
  $V -c:a aac -ar 48000 -ac 2 -movflags +faststart -shortest samples/main.mp4
# clips: color=c=0xCC2222:s=640x360:r=30:d=6 + sine, filter:
#   drawbox=x='(iw-w)*mod(t/3,1)':y=0:w=48:h=ih:color=white@0.95:t=fill,
#   drawbox=x=0:y='(ih-h)*mod(t/1.5,1)':w=iw:h=16:color=black@0.55:t=fill
```

(font/`drawtext` is not compiled into this ffmpeg build, hence no text labels.)

### Fixtures (`tests/fixtures/`, generated with ffmpeg)

| file | duration | notes |
|---|---|---|
| `main-fast.mp4` | 30 s | 640×360 H.264 **Main** (avc1.4d401e), AAC 48k stereo, 1.6 s GOP, faststart |
| `clip-a.mp4` | 8 s | smptebars + 880 Hz tone. **`avcC` differs from main's** (VUI/HRD bytes) — this is the fixture that exposed the splice bug |
| `clip-silent.mp4` | 5 s | **no audio track**; `avcC` byte-identical to main's |
| `main-slowstart.mp4` | 10 s | `moov` at the end |

Regenerate `main-fast.mp4`:
```
ffmpeg -y -f lavfi -i "testsrc2=size=640x360:rate=30:duration=30" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=30" \
  -c:v libx264 -profile:v main -pix_fmt yuv420p -g 48 -keyint_min 48 -sc_threshold 0 \
  -c:a aac -ar 48000 -ac 2 -movflags +faststart tests/fixtures/main-fast.mp4
```

---

## 3. Files

```
src/
  lib/timeline/   types.ts build.ts map.ts validate.ts timeline.test.ts (23 tests)
  lib/media/      types.ts codec.ts indexer.ts boxes.ts audioPlan.ts silence.ts
                  remote.ts  (+ remote.test.ts)
                  indexer.test.ts (11 tests)
  lib/engine/     types.ts MseEngine.ts SimpleEngine.ts videojs.ts index.ts
  hooks/usePlayer.ts
  state/project.ts
  components/     Library.tsx TimelineStrip.tsx InsertList.tsx Hud.tsx
                  MarkerPopover.tsx
  App.tsx main.tsx index.css
tests/fixtures/*.mp4
```

---

## 4. How it works

- Timeline: main chopped at keyframe (= mp4box RAP fragment) boundaries, clips laid
  inline. `srcOut - srcIn === virtOut - virtIn` for every segment.
- **Video**: mp4box `setSegmentOptions(id, 'video', { rapAlignement: false, nbSamples: gopSamples })`
  → one fragment per GOP, each starting **on** a keyframe (`rapAlignement: true`
  cuts one frame *after* the keyframe and breaks every splice — §7(f)). Fragments
  carry *source* timestamps, so they are appended with
  `timestampOffset = segment.virtIn - segment.srcIn`.
- **Audio**: raw AAC re-muxed per segment by `mp4-muxer` (audio-only,
  `fastStart:'fragmented'`, timestamps starting at 0), so the placement offset is
  **`segment.virtIn`**, not `virtIn - srcIn`. See §7.
- **One init segment per SourceBuffer per flush**, bundled with the first media
  append. Never re-initialise mid-stream.
- Edits rebuild queues and flush the SourceBuffers; `src` is untouched.

### Debug hook

`window.__clipinject` → `{ project, getEngine(), getState(), getTimeline(), getSource() }`.
`getEngine()` also exposes `engine.trace` (every append: kind/at/offset/bytes/asset),
`engine.sbv`, `engine.sba`, `engine.ms`. **Re-read `window.__clipinject` after a store
change** — `getTimeline`/`getState` close over the render that created them.

---

## 5. Verified in the browser (headless preview tab)

Setup: `main-fast.mp4` + `clip-a.mp4` + `clip-silent.mp4`, insertions at 10 s and
22 s.

```
segments : main 0→9.63 · clip-a 9.63→17.63 · main 17.63→30.43
           · clip-silent 30.43→35.43 · main 35.43→43
duration : 43          (with keyframe-aligned fragments the cuts are exact)
video buffered : [[0, 43]]       ← one continuous range, whole edit
audio buffered : [[0, 43.02]]    ← one continuous range, including the silent clip
seekable       : [[0, 43.02]]
offsets        : audio 0 / 9.63 / 17.63
```

Playback probes (wall clock ≈ simulated time, `readyState` never below 3):

| probe | result |
|---|---|
| 8.4 → 11.51 s (crosses clip-a splice at 9.63) | advanced 3.11 s in 3.2 s |
| 29.4 → 31.76 s (crosses into the audio-less clip at 30.43) | advanced 2.36 s in 2.4 s |
| 12 → 14.24 s (backward seek across a splice) | advanced 1.44 s in 1.4 s |
| 31.8 s (inside the silent clip) | `readyState 4`, `seeking false` |

**Seam content, after the keyframe-alignment fix** (`samples/main.mp4` + `clip-red`,
insert at 20 s → `main 0→20 · clip 20→26 · main 26→126`), sampled mean colour:

| time | colour | verdict |
|---|---|---|
| 19.5 s | rgb(120,124,132) | main ✓ |
| 20.4 / 23 / 25.9 s | rgb(199,50,50) | clip ✓ |
| 26.2 / 26.5 / 27.5 / 28.2 s | rgb(123,125,131) | main ✓ (was clip content before the fix) |

Live playback across that seam: red through 25.97 s, main from 26.00 s, 30 fps
throughout, 0 dropped frames in steady state.

Five insertions on one main video (alternating `clip-a` / `clip-silent`, seams at
roughly 4/9/15/20/26 s): 11 segments, duration 64 s, `video [[0,35.43]]`,
`audio [[0,35.43]]` — one range each, and playback 2 → 4.77 s crossed the first
seam at `readyState 4`, 0 dropped frames, 80 frames presented.

Silence fill decoded offline with ffmpeg (`volumedetect`):

```
muxSilence(5 s, 48k stereo)  → 5.00 s, mean_volume -91.0 dB   (digital silence)
muxSegmentAudio(main 4→6 s)  → 2.02 s, mean_volume -24.1 dB   (the 440 Hz tone)
```

## 6. Gotchas that already cost time (keep these)

1. `createFile()` in mp4box 2.5 defaults to **discarding** mdat. Pass
   `createFile(true)` or fragmentation/extraction yield nothing.
2. `setSegmentOptions` defaults to `nbSamples: 1000` (one giant fragment).
   `rapAlignement: true` is a trap: it cuts *after* the RAP, so every fragment
   starts one frame late and cannot be used as a splice point. Use
   `rapAlignement: false` with `nbSamples` = the GOP length and record
   `keyframe: first.is_sync` per fragment.
3. `onSegment` fires per **segment**, not per fragment.
4. video.js 10 removed `Tech`/`registerSourceHandler`. Adapter pinned to
   `video.js@8.24.1`; `videojs.getTech('Html5').registerSourceHandler(handler, 0)`.
5. A seek feedback loop (`seeking` → flush → write `currentTime` → `seeking` …)
   churned millions of buffer updates. Fixed with `seekTarget`/`seekToken` guards
   and by only writing `currentTime` when it differs by > 0.01 s.
6. `waitIdle` must be **bounded** — `abort()` does not always fire `updateend`, and
   an unbounded wait wedges every later load/seek. Now resolves on
   `updateend`/`abort`/`error` or after 1.2 s.
7. Playback "not stalling" is not proof of correctness. A dropped GOP shows up as
   `readyState: 1` and a frozen picture while `currentTime` keeps advancing. Check
   frame hashes, not just `paused`/`seeking`.

---

## 7. THE SPLICE BUG — root causes found and fixed (history worth keeping)

Symptom: after an insertion, `buffered` showed a hole of exactly one GOP
(`[[0,17.633],[19.2,38]]`), the picture froze for ~1.6 s while the clock ran on.

Three independent causes, all now fixed:

**(a) Mid-stream init with a changed decoder config.**
Bytes proved it: `clip-a.mp4`'s `avcC` differs from `main-fast.mp4`'s
(`674d401eeca05017fcb80880…` vs `…fcb80b50202054…`, same `avc1.4d401e` codec string).
Chrome answers "new init segment, different config" by discarding the first media
segment after it. Proof: using the *same file* as main and clip (byte-identical
init) gave a perfectly contiguous `[[0, 39.633]]`.
**Fix:** append exactly one init per SourceBuffer per flush, bundled with the first
fragment (`vInitDone`/`aInitDone` flags + `concatBytes`). Since the whole edit is
required to share one codec string, the first init is the right config for
everything.

**(b) Audio placement offset.**
Video fragments carry source timestamps → `offset = virtIn - srcIn`. Audio buffers
are muxed by us with timestamps starting at 0 → `offset = virtIn`. Using the video
rule put the audio for `main` #2 at 8 s instead of 17.63 s, overlapping existing
audio (which is why `buffered` looked continuous but only reached 20.8 s).
**Fix:** `planAudio` uses `offset: segment.virtIn`. The trace made this obvious:
`audio [17.63, 17.63]` before the fix vs `[17.63, 8]` after.

**(c) Re-appending audio inits per segment** — same class as (a). Each audio segment
is still self-contained (init+media) but only the first init is kept and reused
(`splitAudioSegment` in `audioPlan.ts`).

**(d) A hole in the audio track stalls the element.** After (a)–(c) the video played
through every splice, but an insertion of `clip-silent.mp4` still froze the picture
at the seam with `readyState 2`, `paused false`, `seeking false` and full `buffered`.
Control experiment: the same seam with `clip-a.mp4` (which has audio) played at
`readyState 4` with continuous audio. So the stall was the *audio* gap, not the video
path. Chrome does not skip an audio hole the way it skips a video hole — the audio
sink runs dry and the element stops.
**Fix:** never leave a hole. `muxSilence()` (`audioPlan.ts` + `silence.ts`) fills a
clip region with real AAC silence when the clip has no audio track, and `silent` mode
fills clip regions with silence too (so "mute the clips" keeps the timeline whole).
An edit whose assets have no audio at all simply gets no audio SourceBuffer, which
does *not* stall.

**(e) Two overlapping seeks wedged the element.** `flushAll()` could run while a
`pump()` had just planned fragments; the flush aborted their appends *after* the plan
set had been cleared, so nothing was left to re-plan and the element sat in `seeking`
with an empty buffer (`readyState 1`) forever.
**Fix:** a `flushing` flag that blocks `pump()`, seeks serialised through a
`seekChain` promise, and `load()` awaiting that chain.

**(f) FIXED — the clip's picture bled over the main video at a clip→main seam.**
Reported by the user: "when the clip finishes and switches back to main video the
videos kind of merge together".

Symptom, measured with `samples/` (clip-red at 20 s): the main video's first
fragment after the clip (~2 s) was not displayed; clip content stayed on screen
until the next fragment boundary, then main resumed.

```
before: 21 s red · 25.9 s red · 26.2 s red ✗ · 27.9 s red ✗ · 28.2 main
after : 19.5 main · 23 s red · 25.9 s red · 26.2 main ✓ · 27.5 main ✓ · 28.2 main
        live playback: red through 25.97, main from 26.00, 30 fps throughout
```

**Root cause: the fragments were not keyframe-aligned.** `rapAlignement: true`
sounds right, but mp4box resolves it by ending a segment *at* the RAP, so every
fragment starts one frame *after* a keyframe. Ground truth for `samples/main.mp4`
(keyframes at dts 0, 2.0, 4.0, 6.0 …) next to our fragment starts:

| options | fragment starts |
|---|---|
| `{ rapAlignement: true, nbSamples: 1 }` | 0, 0.033, **2.033, 4.033** |
| `{ rapAlignement: true, nbSamples: 60 }` | 0, **2.033**, 6.033, 10.033 |
| `{ rapAlignement: false, nbSamples: 60 }` | **0, 2.0, 4.0, 6.0** ✓ |

The `trun` sample flags had been saying so all along: every fragment's first
sample was marked `sample_is_non_sync_sample = 1`. After a cut the decoder has
nothing buffered before the appended fragment, so it needs a keyframe at its first
sample; without one it holds the previous frame until it can decode again. That is
exactly the 2 s bleed, and it is also why the seam "looked fine" in `buffered` and
in the frame counter: frames are parsed and presented, they just belong to the
previous segment.

**Fix:** cut on a regular sample grid whose length is the GOP
(`dominantGopLength`, the mode of sync-sample gaps), record
`keyframe: first.is_sync` per fragment, and build `AssetMeta.cutPoints` from
keyframe-aligned fragments only. A file with irregular GOPs now degrades into
"fewer legal insertion points" rather than "insertions that freeze".
Insert positions also became exact: `main 0→20, clip 20→26, main 26→126` instead of
`20.033`.

Chased first and ruled out (each checked, not assumed): two stacked `<video>`
elements, a clip tail overrunning its segment, `tfdt` not matching `frag.start`,
malformed `trun` durations, duplicate clip appends, and `timestampOffset` churn
(rewrote every fragment's `tfdt` so all appends used offset 0 — bug unchanged, so
that experiment was reverted). The negative result that mattered: `buffered` was a
single continuous range and `totalVideoFrames` advanced at 30 fps the whole time,
so only sampling pixels exposed it. **Never trust ranges alone at a seam.**

Lesson for the docs: **a SourceBuffer gets one init and one config; an audio track
gets no holes; a flush and a pump must not overlap; a seam can look right in
`buffered` and still show the wrong picture — always sample pixels, not just ranges.**

---

## 7h. Single-buffer (Safari-shaped) primitives — built, verified in Chrome

`src/lib/media/muxedTrack.ts`: `combineInits`, `renumberTrack`/`renumberSegment`,
`stripIndexBoxes`, `joinSegments`, plus a small box reader (`readBoxes`,
`childBoxes`, `findPath`, `isWellFormed`). 8 tests over the real fixtures.

The design does **not** merge `moof`s. A Media Segment may hold several
`moof`+`mdat` pairs, so one buffer can take the video fragment mp4box already
produces and the audio segment mp4-muxer already produces, provided the init
declares both tracks and the audio track id is renumbered (both producers use 1).
`mfra` is stripped from audio segments because its offsets are absolute.

Verified in Chrome with `video/mp4; codecs="avc1.4d401e,mp4a.40.2"`: 25 appends,
`buffered [[0,24]]`, playback 10.5 → 13.34 across a clip seam, 0 dropped frames,
audio decoded. Not yet wired into an engine, and **not tested in Safari** (no
`MediaSource` on iOS; `safaridriver` unavailable on this machine).

Two appends per segment, not one: video timestamps are absolute source times,
audio is muxed from 0, and one `timestampOffset` cannot serve both.

## 7g. Browser support detection

`src/lib/media/support.ts` reports what the browser can do (`MediaSource`,
`ManagedMediaSource`, `SourceBuffer.changeType`, H.264 through MSE) and which engine
can actually play. On startup `App` switches to that engine if the current one is
`native` and MSE is unusable, and shows the reason as a banner — before, an iPhone
Safari user only found out after loading a main video, as "nothing plays".

Pure `detectSupport(env)` is injectable and tested; `readSupportEnv()` does the
probing. Chrome here: `mediaSource` true, `managed` false, `changeType` true → no
banner, engine unchanged.

Safari was **not** measured: `safaridriver` exits immediately without "Allow Remote
Automation" (GUI toggle + authorisation). `docs/08` records which parts of the
remote-marker work are portable and which are Chrome-only.

## 7f. Armed markers: prefetch before the insert point

Remote markers no longer preload. `Arm (prefetch)` stores the URL and fetches
nothing; `loadMarker` starts when the playhead *crosses* `insertPoint − lead`
(`dueMarkers(markers, mainTime, previousMainTime, lead)`), with the lead selectable
in the timeline legend (1 s / 2 s / 5 s, default 1 s, `PREFETCH_LEAD`). Crossing,
not "at or past": a marker is created at the playhead, so the naive rule fired
instantaneously. `Load now` keeps the immediate behaviour.

Measured (local clip, fetch+index 0.02–0.03 s):

| lead | fires at | marker flips | playback |
|---|---|---|---|
| 0 s | 6.00 | `deferred` → `ready` at 6.00 | jumps 5.94 → virtual 12.06, **clip skipped** |
| 1 s | 5.00 | `ready` at 5.27 | 6.00–12.00 plays the clip, reaches 12.88 |
| 5 s | 25.00 | `ready` at 25.25 | no stalled frames across the rebuild (100 ms sampling) |

The lead is the whole difference. With a lead the insertion lands *ahead* of the
playhead, so the virtual timeline does not move under it and the anchor restores
the same frame; without one it lands *behind* the playhead and the same frame is
now on the far side of the new clip.

A fixed lead is still a heuristic: a download slower than the lead arrives late,
shifts the timeline and gets skipped anyway — the banner reports that case and the
popover shows the measured fetch+index time.

## 7e. Mixed codec configurations — investigated, MSE route abandoned

Attempted a new engine ("one SourceBuffer per codec configuration") so mixed
resolutions/profiles play without re-encoding. **It does not work on this
Chromium.** Measurements in `docs/10-mixed-codecs.md`; the two that matter:

- `HTMLMediaElement.buffered` and playability are the **intersection across all
  attached SourceBuffers**, so two buffers with disjoint ranges make the element
  unplayable — `play()` never resolves, `currentTime` freezes. Includes the
  `addSourceBuffer` → `QuotaExceededError` case once another buffer has data.
- `changeType()` on an element that has already played **wedges the buffer**:
  later `appendBuffer` calls never fire `updateend`. The only working order is
  empty → `changeType` → append → `play()` on a fresh, not-yet-played element.

Conclusion: MSE gives one decoder configuration per playback session here. The
engine was reverted rather than shipped broken; the `EngineKind` set is unchanged
(`native`, `videojs`, `simple`). Remaining options are transcode-on-import
(~0.65 s CPU per 6 s 1080p clip, measured) or a WebCodecs canvas engine, both
described in `docs/10-mixed-codecs.md`.

Fixtures added for this work: `samples/clip-720p.mp4` (High@3.1, 1280×720) and
`samples/clip-mono44.mp4` (main's video stream copied, AAC 44.1 kHz mono).

## 7d. Marker panel visibility bug (fixed)

The paste-URL panel was invisible: it was rendered *inside* `.track`, which is
`overflow: hidden` and 42 px tall, so the panel was clipped to nothing. Tapping
the square did open it — it was simply not painted anywhere.

- A portal with `position: fixed` + measured coordinates was tried next and
  worked, but it depends on a measurement that can go stale on scroll and leaves
  the panel invisible if it is missed.
- Final fix: `.timeline` gets `position: relative` and the panel is rendered there
  (outside `.track`), placed with `bottom: calc(100% + 6px)` and
  `left: clamp(8px, calc(<pct>% - 160px), calc(100% - 328px))`. No JS
  measurement, so it cannot go stale; it flips below via a `.below` class when
  the card is near the top of the viewport.
- The square was redrawn: 15 px, inline SVG glyph (plus / check / exclamation),
  8 px invisible hit margin, `ready` state filled.
- Scrubbing the track now dismisses the panel.
- Verified: tap opens with the panel fully on screen and the input hit-testing as
  itself, scrub closes it, tap reopens.

## 7c. Remote markers (feature)

`＋ marker` in the timeline legend places a square at the playhead (snapped to a
legal cut, like an insertion). Tapping the square opens a popover: paste an MP4
URL, press **Load clip**, and the app fetches the bytes, indexes them through the
same path as a dropped file, and inserts the result at the marker's time. The
square goes outline → pulsing → filled, or red with the reason.

- `Marker` lives in the project store (`empty | loading | ready | error`) so an
  empty or broken marker never touches the timeline.
- Placement uses `markerVirtualTime`, not `toVirtual`: the latter is exclusive at a
  segment end, which drew a marker *after* the clip it created.
- **CORS is mandatory** (`fetch(..., {mode:'cors'})`): the bytes have to be readable
  to index them. Failure text names that instead of showing a generic error
  (`describeFetchFailure`).
- Removing a marker removes its insertion and its clip.
- Whole file is downloaded before insertion — no byte-range indexing yet.
- Download streams with progress (`downloadAsFile`), so a URL load reports like a
  file read; indeterminate when the server sends no `Content-Length`.
- Proven identical to a dropped clip: same file loaded both ways in one session
  produced matching fragments (3, first `[0 → 2]` keyframe 3320 B), 283 audio
  samples, 105019 bytes, same codecs. The URL only adds the fetch.
- Verified in the browser: marker at 20 s → `clip-red.mp4` fetched and indexed from
  `http://localhost:5199/samples/clip-red.mp4` → 3 segments, duration 126; second
  marker → `clip-green.mp4` → 5 segments, 132 s; bad URL → red square with the
  reason and the edit unchanged; remove → clip + insertion gone, 126 s again; the
  square measures 15.87 % of the track = exactly 20 s of 126 s.
- Docs: `docs/09-remote-markers.md`.

## 7b. Done since the seam diagnosis (newest first)

- **video.js and Simple engines verified in the browser.** video.js mounts its own
  `.vjs-tech` element fed by the MSE blob and plays across a seam
  (19 → 20.14 s, `readyState 4`); Simple shows its two pre-rolled layers
  (hidden main at 20.1 s, visible clip at 2.15 s local) and keeps playing.
- **`mix` is now honest on MSE.** Summing clip + bed needs an AAC decode/re-encode,
  so the engine plays clip audio (like `replace`) and the UI says so; Simple still
  implements the bed. `docs/07`.
- **Non-blocking `avcC` warning.** `findConfigWarnings` compares `configKey` /
  `configCore` per clip and renders a banner: verified that `clip-a.mp4` raises it
  and `samples/clip-green.mp4` does not. It does not block playback.
- **Tail tolerance.** `planVideo` keeps a segment's final fragment when it overruns
  `srcOut` by ≤ 0.05 s, so the last GOP of a 30.016 s file is no longer dropped.
- **Leading stub fragment merged.** `mergeLeadingStub` in `indexer.ts` folds the
  one-frame 0.033 s stub into the next fragment; cut points for a 30 fps file now
  start at 2.033 s instead of 0.033 s (60 fragments instead of 61, first fragment
  2.033 s long). Unit test added.

## 8. Remaining work (in order)

1. **`captureStream()` contaminates the probe page.** Calling it on the MSE element
   leaves the element in a state where later seeks stall (`seeking: true`,
   `readyState 1`) — that is what made three probe runs look like engine bugs. Verify
   audio levels offline with ffmpeg instead (see §5), or reload the page after using
   it. Keep each browser probe **under ~3 s**; the automation tool times out at 15 s.
2. Clips with more than 2 channels cannot be silenced (`silentSamples` returns null)
   — such an edit would get a hole and stall. Either add the frame constants or refuse
   the insert with a message.
3. Persistence (save/load edit JSON). Deliberately not attempted: the assets are
   `File` handles, so surviving a reload needs the OPFS store (designed, not built).
   An edit JSON alone would restore insert points that point at files that no longer
   exist.
4. Keep `HANDOFF.md`, `docs/`, and `docs/diagrams.html` honest as fixes land.

## 9. Known deviations / rough edges

- `SimpleEngine` swap logic is written but **untested in a browser**.
- Indexing holds ~2× the file size in memory during the pass (mp4box mdat + our
  fragment copies). The OPFS store is designed but not implemented.
- No eviction for the audio SourceBuffer (deliberate — audio is small and this
  avoids holes on seek-back).
- `SimpleEngine` ignores the silence filler: it does not splice, so a silent clip is
  simply a silent moment there.
- Tailwind was dropped in favour of one hand-written `src/index.css` (vite 8 +
  Tailwind 4 adds build risk for no benefit here).
