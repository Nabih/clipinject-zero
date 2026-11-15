# 09 — Remote markers

A marker is a square on the timeline that holds a **remote video URL**. It is the
"paste a link" alternative to adding a clip file, and it produces exactly the same
thing: an indexed clip plus an insertion.

```
 ＋ marker  ──►  □ (empty)   ──tap──►  paste URL  ──Load──►  ■ (ready)
                  │                                              │
                  │                                              └─ clip + insertion
                  └─ never touches the timeline until it is ready
```

## Why a placeholder rather than "add clip from URL"

Adding a clip needs bytes: the app indexes the file once (duration, keyframe
boundaries, audio samples) and everything downstream — snapping, the virtual
timeline, the audio plan — depends on that index. A URL is not bytes, it is a
promise of bytes, and the promise can fail (404, HTML login page, CORS). Keeping
the marker as its own object means a broken or empty marker is inert: it draws a
square and changes nothing else, so playback is never blocked by a URL you have not
loaded yet.

## State machine

| status | square | meaning |
|---|---|---|
| `empty` | outline, plus | placed, no URL loaded yet |
| `deferred` | dashed, amber | **armed**: URL kept, nothing fetched |
| `loading` | pulsing, amber | downloading then indexing |
| `ready` | filled | clip exists and is inserted at the marker's time |
| `error` | red | the fetch or the index failed; hover/expand for the reason |

Only `ready` has side effects on the edit. `remove` cascades: the insertion goes,
then the clip asset (which removes any other insertion that referenced it).

## Placement

Markers snap to a legal cut exactly like insertions do (`snapToCut` over
`AssetMeta.cutPoints`), so a marker can never point at a mid-GOP frame.

Drawing needs the *virtual* position, and that is where the naive mapping is wrong:
`toVirtual` treats a segment's end as exclusive, so a marker at main time 20 whose
own clip occupies virtual 20–26 maps to 26 and gets drawn *after* the clip it
created. `markerVirtualTime` instead takes the first main segment that reaches the
time and clamps inside it, which puts the square at the start of the region it
marks.

Only keyframe-aligned fragments are cut points (see `02-media-indexing.md`), so the
square always corresponds to a splice the engine can actually perform.

## The panel

The paste-URL panel lives inside `.timeline`, **not** inside `.track`:

```
.timeline  (position: relative, does not clip)
├── .track  (overflow: hidden — clips its own children)
│   ├── buffered ranges, segments, playhead
│   └── .marker squares
└── .marker-pop  (absolutely positioned, bottom: calc(100% + 6px))
```

The first version put the panel inside the track and it was invisible: `overflow:
hidden` on a 42 px-tall element clipped it completely. It then briefly moved to a
portal with `position: fixed` and JS-measured coordinates, which works but goes
stale on scroll and disappears if the measurement is missed. Keeping it in the
timeline card needs no measurement at all: horizontal placement is
`left: clamp(8px, calc(<pct>% - 160px), calc(100% - 328px))`, so a marker near
either edge still gets a fully visible panel, and it flips below the track when
there is no room above.

The square itself is a 15 px rounded button with an inline SVG glyph (plus /
check / exclamation) and an 8 px invisible margin, so it is easy to hit without
looking heavy on the track.

## Armed: prefetch before the insert point

`Arm (prefetch)` stores the URL and fetches nothing yet. The load starts when the
playhead **crosses** `insertPoint − lead` (`dueMarkers`), where the lead is chosen
in the timeline legend (1 s, 2 s or 5 s, default 1 s). Crossing, not "at or past":
a marker is created at the playhead, so "at or past" would fire the instant it was
armed.

The lead is the whole difference between the two outcomes.

**Lead 0 — load on arrival.** The edit changes *under* the playhead: the insertion
grows the timeline by the clip's duration, and the player restores the same
**main-video frame**, which now maps to the far side of the clip. The clip is
skipped, not played.

```
playhead   marker      insertions   element
4.14       deferred    0            main
5.94       deferred    0            main
6.00       → ready     1            edit changes here
12.06      ready       1            jumped past the new clip
```

**Lead 1 s — measured, clip plays.**

```
playhead   marker      insertions   element
4.13       deferred    0            main
5.27       → ready     1            fetched at 5.0, 0.02 s to index
6.00–12.00 ready       1            the clip plays
12.88      ready       1            back to main
```

**Lead 5 s — measured, same result with more margin.** Fires at 25.25 for a marker
at 0:30.000, ready in 0.03 s, and sampling `currentTime` every 100 ms across the
timeline rebuild at 0:25 showed **no stalled frames at all**.

Why there is no jump when pre-fetching: the insertion lands *ahead* of the playhead,
so nothing before it moves on the virtual timeline and the anchor restores the same
frame. At lead 0 it lands *behind* the playhead, and the same frame is now on the
other side of the new clip.

A fixed lead is still a heuristic: if the download takes longer than the lead the
clip arrives late and the timeline shifts under the playhead anyway. The banner
says so, and the popover reports the actual fetch+index time. A player that wants to
be safe either uses a longer lead or measures the previous load and adapts.

## Fetching

```ts
const file = await downloadAsFile(url, { onProgress });   // streams, reports %
await addFiles([file], 'clip');                           // identical to a drop
```

Two consequences worth stating plainly:

- **CORS is mandatory.** `mode: 'cors'` (and no `no-cors`, which yields an opaque
  body that cannot be indexed) means the server must send
  `Access-Control-Allow-Origin`. A URL that plays fine when opened directly can
  still fail here, and the UI says so instead of showing a mystery failure.
- **The whole file is downloaded before anything is inserted.** There is no
  streaming indexer yet, so a 200 MB clip is 200 MB in memory before its square
  turns solid. Byte-range indexing is the obvious next step.
- **The download reports progress like a file read does**, and falls back to
  "Downloading…" (indeterminate) when the server sends no `Content-Length`.

## It is the same clip, not a special case

A remote clip goes through `addFiles → indexAsset`, the same function a dropped
file hits, so it produces the same object: same cut points, same keyframe flags,
same audio sample list, same audio remux at playback (`muxSegmentAudio` /
`muxSilence`). Verified by loading `clip-red.mp4` both ways in one session — both
came out as 3 fragments (first `[0 → 2]`, keyframe, 3320 B), 283 audio samples,
105019 bytes, `avc1.4d401e` / `mp4a.40.2 48 kHz`.

The only thing the URL adds is the fetch.

`normalizeRemoteUrl` accepts `http(s)` only, adds `https://` when the scheme is
missing, and rejects bare paths — prefixing a scheme onto `/clips/a.mp4` would
silently turn a path into a host name.

## Files

| file | role |
|---|---|
| `src/lib/media/remote.ts` | URL normalisation, file naming, failure wording |
| `src/state/project.ts` | `Marker`, `addMarker`, `setMarkerUrl`, `loadMarker`, `removeMarker` |
| `src/components/MarkerPopover.tsx` | the paste-URL panel anchored to the square |
| `src/components/TimelineStrip.tsx` | the squares themselves, `＋ marker` button |
| `src/lib/timeline/map.ts` | `markerVirtualTime` |

## Tests

`src/lib/media/remote.test.ts` covers scheme handling, name derivation and the
CORS failure message; `timeline.test.ts` covers `markerVirtualTime` (start of the
clip, after the clip, clamped at the end).
