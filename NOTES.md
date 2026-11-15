# Engineering notes

What was built, what was measured, and what broke on the way. The short version:
the video layer is now hand-written, and every claim below was checked in this
browser or against `ffprobe`, not assumed.

## Why this fork exists

The parent project (`Nabih/clipinject`) used **mp4box** for demuxing, **mp4-muxer**
for audio fragments, and **video.js** as an optional engine. This fork removes all
three from the video work and keeps React for the UI.

Removing them did not just delete code — it changed the architecture, because both
libraries made a decision that got baked into the old design:

- mp4box emitted **one `moof` per track**, which forced two `SourceBuffer`s and a
  separate `timestampOffset` per track. That is where the old audio-hole stall,
  the init re-append bug and the per-track offset rules came from.
- mp4-muxer timestamps audio from 0 while mp4box used absolute source times, so
  the two streams could never share an append.

Writing the fragments means one `moof` can carry both `traf`s. So this version has
**one `SourceBuffer`, absolute `tfdt`, `timestampOffset` always 0, and audio filled
to the exact length of every fragment**. The old bug classes have nothing to
attach to.

## The pieces

| file | job |
|---|---|
| `src/media/box.js` | ISO-BMFF read/write primitives |
| `src/media/mp4.js` | demuxer: `stbl` tables → sample index, init bytes, codec strings |
| `src/media/frag.js` | `moov` rebuild + `moof`/`mdat` writer |
| `src/media/silence.js` | real AAC silence from four constants (no encoder exists in WebCodecs) |
| `src/media/edit.js` | snapping to sync samples, virtual timeline, plan |
| `src/player/engine.js` | one `MediaSource`, chunked appends, remove-and-re-append |

`src/media` and `src/player` are plain ES modules with no React import. The React
tree only draws panels and forwards the playhead.

## Measurements

### Demuxer parity vs ffprobe

`tests/fixtures/*.packets.csv` are committed `ffprobe -show_packets` outputs, so
ffprobe is an **oracle, not a dependency**: nothing shells out at test or runtime
time, and the tests stay hermetic.

For `samples/main.mp4` and `samples/clip-red.mp4`, every packet is compared field
by field — byte offset, size, decode time, composition time, sync flag:

| file | video packets | audio packets | matches |
|---|---|---|---|
| main.mp4 | 3600 | 5626 | offset, size, dts, cts, sync |
| clip-red.mp4 | 180 | 282 | offset, size, dts, cts, sync |

### Playback (Chrome, this machine)

| check | result |
|---|---|
| mime | `video/mp4; codecs="avc1.4d401e,mp4a.40.2"` |
| buffered after one insert at 8.00 s | `[[0, 30.07]]` — one range, 0 gaps |
| frames shown across the seam | main yellow → clip red at 8.4 s, no stall |
| dropped frames while playing 6.5 → 13.5 s | 0 |
| audio decoded | `webkitAudioDecodedByteCount` 120919 |
| playback rate | 2.00 s of media in 2.00 s of wall clock |
| insert during playback | playback continued, buffer still one range |
| snap drift at insert 11.00 s | −1000 ms (main keyframes are every 2 s) |

### Bundle

250 KB JS / 79 KB gzip, versus 504 KB + 685 KB (video.js) before. `node_modules`
contains no `mp4box`, `mp4-muxer` or `video.js`.

## Bugs found while building

All four were caught by a test or a measurement, not by reading code:

1. **`findPath` scope.** Passing a `trak` box where its *children* were expected
   made every lookup fail, so the video track was silently dropped and the error
   was "this file has no video track".
2. **`elst` off by one field.** Reading `media_time` from the `segment_duration`
   offset turned the 66.7 ms encoder-priming shift into 375 s. It surfaced as a
   duration of 0 and a single keyframe. ffprobe reports first video DTS
   `-0.066667`, which is what a correct read produces.
3. **Double append.** `setPlan`'s fill and `pump()`'s fill both yielded at the same
   `await`, so each chunk was appended twice: 1141 KB where 570 KB was expected.
   Guarded with a `filling` flag.
4. **Render storm.** `pump()` emitted a status object every animation frame, and
   each emit re-rendered the whole tree at 60 Hz until the tab stopped responding
   to input. Status now only emits when bytes were actually appended, and the clock
   updates at ~8 Hz.

Plus one that the previous project had already taught: React 19 StrictMode runs
effects twice, and a second `Player` assigns `video.src` a second time, which
wedges the element. Players are now kept in a `WeakMap` keyed by the video element.

## Deliberate limits

- **AVC + AAC only** (`avc1`/`avc3`, `mp4a`). Anything else is rejected with a
  sentence instead of half-working.
- **No fragmented input.** A file that already has an `mvex` box is refused.
- **Audio must match the main track** (codec, sample rate, channels) or that clip
  plays silent. Muxing 44.1 kHz AAC into a 48 kHz track would need a re-encode.
- **Multi-channel silence unsupported** — only mono and stereo constants exist.
- **Removed with the libraries:** the video.js engine (it *is* a library), the
  similarity/`mix` audio mode (needs decode + encode), and the remote-marker
  prefetch UX. Remote URLs still work as clips, but they are fetched immediately
  rather than armed for a lead time.
- **Safari untested.** No `safaridriver` on this machine. The single-fragment-per-
  append design is what Safari wants, but that is analysis, not measurement.

## Next

1. Restore armed/prefetch remote markers on top of `sourceFromBytes` (the demuxer
   already accepts fetched bytes).
2. Trim handles on inserts (`clipIn`/`clipOut` exist in the plan and store).
3. Re-index after a container change (currently a file's sample table is read once).
4. If mixed-codec clips matter, transcode on import — the fragment writer already
   takes arbitrary sample tables.
