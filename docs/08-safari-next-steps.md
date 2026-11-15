# 08 — Safari / iOS: follow-up plan

v1 ships Chrome-only. This file records exactly what changes, so the Chrome work
does not accidentally paint us into a corner.

## The five real differences

| # | Chrome | Safari |
|---|---|---|
| 1 | `MediaSource` | `ManagedMediaSource` (`window.managedMediaSource`), Safari 17.1+ |
| 2 | N SourceBuffers with different mime types | **one** SourceBuffer, muxed audio+video |
| 3 | `changeType()` available | **absent** |
| 4 | Remote playback irrelevant | must set `video.disableRemotePlayback = true`, or AirPlay grabs the stream |
| 5 | Autoplay with sound in some cases | requires muted or a user gesture, always |

Difference 2 is the structural one and it is worth designing for **now**, cheaply.

## What the remote-marker work assumes (portable vs not)

Added later: markers, remote URLs and the prefetch lead. Split by dependency:

| part | portable to Safari? |
|---|---|
| `normalizeRemoteUrl`, `downloadAsFile` (fetch + `response.body` reader) | yes — Safari 14.1+ streams response bodies |
| `indexAsset` (mp4box), `muxSegmentAudio`/`muxSilence` (mp4-muxer) | yes — pure JS |
| marker/insertion/timeline model, prefetch trigger, lateness measurement | yes — no browser API at all |
| playback through `MseEngine` | **no, not without the muxed-moof work below** |

So a URL clip can be downloaded, indexed and inserted in Safari today; what is
Chrome-only is playing the spliced result. On iPhone Safari that is not a subtle
difference: `MediaSource` does not exist (only `ManagedMediaSource`, 17.1+), which
made the failure look like "nothing plays" after loading a main video.

The app now detects this at startup (`src/lib/media/support.ts`) and picks the
Simple engine itself, with a banner saying why. `SourceBuffer.changeType` is also
probed: Safari does not have it, which costs nothing because the MSE engine never
switches configuration mid-stream.

**Not verified:** none of the above is measured in Safari. `safaridriver` needs
"Allow Remote Automation" switched on in Safari's Develop menu (a GUI action plus
authorisation), so Safari automation was unavailable on this machine. Everything in
this table is from the code's dependency surface, not from a run.

## Step 1a — The single-buffer path, built and measured in Chrome

The plan below assumed Safari needs **one** SourceBuffer holding **one** `moof`
with a `traf` per track, which would mean rewriting `moof` sizes, interleaving
`traf`s and patching `data_offset`s. Measured, that is not necessary.

A Media Segment may contain **several** `moof`+`mdat` pairs, so the two producers
can keep producing what they already produce:

```
combined init (ftyp + moov: video trak, audio trak, mvex with both trex)
  → append video fragment          (moof+mdat, track 1, absolute src timestamps)
  → append audio segment           (moof+mdat, track 2, 0-based timestamps)
```

`src/lib/media/muxedTrack.ts` does the only two things that are actually required:

1. `combineInits` — one `moov` carrying the video `trak`, the audio `trak`, and a
   `mvex` with both `trex` entries.
2. `renumberTrack` — the audio track is renumbered (1 → 2) in `tkhd`, `trex` and
   every `tfhd`, because mp4box and mp4-muxer each number their single track 1.
   Four-byte patches; no payload is copied.

`stripIndexBoxes` drops the `mfra` mp4-muxer appends to each audio segment: its
offsets are absolute, so prepending video makes it lie.

Two appends per segment rather than one, because video timestamps are absolute
source times while audio is muxed from 0 — one `timestampOffset` cannot serve both.
`joinSegments` builds the single-append variant for a future absolute-timestamp
audio muxer; it is tested but not used by the engine.

Measured in Chrome (`video/mp4; codecs="avc1.4d401e,mp4a.40.2"`):

| check | result |
|---|---|
| `MediaSource.isTypeSupported(combined mime)` | true |
| appends | 25 (init + video/audio pairs for main 0–12, clip 12–18, main 18–24) |
| `buffered` | `[[0, 24]]` — one range, no gaps |
| playback across the clip seam at 12 s | 10.5 → 13.34, `readyState` 4 throughout |
| dropped frames | 0 |
| audio decoded | `webkitAudioDecodedByteCount` 55268 |

What this does **not** prove: that Safari accepts it. Safari is untestable here
(see "Not verified" above). It does show the byte surgery is correct — the init
parses, the ids agree, and a real MSE implementation plays the result across a
splice — so a Safari failure would be about Safari's stricter parser, not about
malformed boxes.

## Step 1 — Keep the muxed path possible (do this in v1)

Three decisions in v1 keep the Safari door open:

1. `Segment`/`Timeline` never assume two tracks — audio is a separate **plan**, not
   part of the timeline model (already true, `07` step 2).
2. The audio slicer produces AAC chunks with **virtual timestamps**, so they can be
   muxed either into their own SourceBuffer (Chrome) or into a combined one
   (Safari) with no change to the slicing code.
3. The video fragmenter is asked for `initializeSegmentation('per-track')` today,
   but the same `ISOFile` can produce `'combined'` — one flag, not a rewrite.

The only genuinely new work is producing **muxed** `moof` fragments (one `traf`
per track in a single `moof`). mp4box's `onSegment` emits per-track buffers, so
Safari requires either:
- muxing the two fMP4 streams into one `moof` per boundary (rewrite `moof` sizes,
  interleave `traf`s, patch `data_offset`s), or
- `mp4-muxer` with both tracks enabled, which means feeding it **video samples**
  too — i.e. sample-level video extraction and the memory cost we avoided in v1.

Recommendation for the Safari phase: try the `moof`-merge route first (no video
copying, keeps the memory profile), fall back to `mp4-muxer` for projects under
~500 MB.

## Step 2 — Capability detection

```ts
const isSafari = !!(window as any).managedMediaSource;
const MS = isSafari ? (window as any).managedMediaSource : window.MediaSource;
if (!MS || !MS.isTypeSupported(mime)) → fall back to the Simple engine
```

`ManagedMediaSource` exposes `isTypeSupported` like `MediaSource`. Also gate on:

```ts
if (isSafari) video.disableRemotePlayback = true;
```

## Step 3 — Engine behaviour deltas

- `changeType()` does not exist → wrap it: if the codec differs, tear down and
  rebuild the MediaSource (`ms.readyState === 'closed'` flow already exists in
  `03` step 11). Same handling as the video.js recovery path.
- One `addSourceBuffer` call, mime with both codecs:
  `video/mp4; codecs="avc1.64001f,mp4a.40.2"`.
- `ms.duration` must be set **before** the first media append on Safari, otherwise
  it stays `Infinity` and the progress bar breaks.
- `endOfStream()` behaviour differs on short buffers — gate on
  `buffered.end(last) >= ms.duration - 0.1` as already written.
- `SourceBuffer.abort()` when `updating === false` is a no-op; treat errors from it
  as non-fatal.
- Eviction is less tolerant: remove in larger chunks, less often (Safari's buffer
  accounting is stricter and a mid-decode removal can drop the pipeline).

## Step 4 — The Simple engine on Safari

The Simple engine works today **if** frame callbacks are available:
Safari 15.4+ has `requestVideoFrameCallback`, so `04` step 5 runs unchanged minus
the Chrome-only assumption. For older Safari, fall back to a ~40 ms
`setInterval` + `currentTime` poll and accept ~1 frame of imprecision.

This makes the Simple engine the honest Safari v1: no MSE changes, no muxing work,
no managed-media-source cliff. The plan is therefore:

```
Safari phase A  →  route Safari to the Simple engine automatically, ship it.
Safari phase B  →  ManagedMediaSource + muxed single SourceBuffer for seam quality.
```

## Step 5 — Testing matrix

| Device / browser | Expectation |
|---|---|
| macOS Safari 17+ | Simple engine, no seam > 1 frame |
| macOS Chrome 111+ | MSE engine, exact |
| iOS Safari 17.1+ | Simple engine, `disableRemotePlayback` set |
| iPad Safari 17.1+ | same as iOS; verify 2 decoders do not get throttled |
| Chrome Android | MSE engine; verify eviction aggressiveness |

iOS is the risk: two simultaneous `<video>` decoders are more likely to be
throttled when the app is backgrounded, and `preload` is often ignored. Expect the
Simple engine's pre-roll to be less reliable there and to need a longer `LEAD`
(~2.5 s).

## Step 6 — Things to check before declaring Safari support

- [ ] Autoplay: playback always starts from a real click.
- [ ] AirPlay button does not appear for MSE-backed playback.
- [ ] Locking and unlocking the phone mid-clip resumes correctly.
- [ ] A 10-minute session does not hit the iPhone's memory ceiling.
- [ ] `buffered` reporting is monotonic (Safari has reported ranges out of order).
- [ ] Backgrounding the tab pauses instead of dropping the MediaSource.

## Explicitly out of scope until later

- Firefox (`mozRequestVideoFrameCallback`, MSE quirks, no `ManagedMediaSource`).
- Safari `HEVC` in MSE on iPhone (hardware-gated, effectively unusable).
