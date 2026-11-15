# 10 — Mixed codec configurations: what was measured

`MseEngine` requires every file in the edit to share one decoder configuration
(`docs/03`). This doc records an attempt to lift that limit, the measurements that
killed three candidate designs, and what is left.

## Why it looked easy

A `SourceBuffer` is created for one MIME type, but nothing in the MSE API forbids
adding more of them to the same `MediaSource`, and our virtual timeline already
gives every asset a disjoint time range. So "different configuration" could mean
"different buffer" — no re-encode, no GOP loss. That is the idea this investigation
started from, and it is wrong on this platform.

## Measurements (Chromium in DeepAI Code, macOS)

| # | Setup | Result |
|---|---|---|
| 1 | 8 video `SourceBuffer`s, no data appended | all added, no error |
| 2 | Append to buffer A, then `addSourceBuffer` | **`QuotaExceededError`** — "reached the limit of SourceBuffer objects" |
| 3 | Two video buffers declared up front, A covers `[0,4]`, B covers `[6,8]` | both accept data; `element.buffered` is **empty**, `readyState` 4 |
| 4 | Same, then `play()` from 5.2 | `play()` **never resolves**; `currentTime` frozen at 5.2; `readyState` 1 |
| 5 | `changeType()` while playing | playback freezes at the switch, later appends never fire `updateend` |
| 6 | `removeSourceBuffer(A)` then `addSourceBuffer(B)` | **`QuotaExceededError`**; playback jumps to `duration` |
| 7 | Buffer emptied (`remove`), `changeType`, append init + fragment, *then* `play()` | **works**: `videoWidth` becomes 1280, `currentTime` advances |
| 8 | Same as 7, but the element had already played | appends after `changeType` stall again |

Two rules fall out:

1. **The element is the intersection of its buffers.** `HTMLMediaElement.buffered`
   and playability are computed across *all* attached SourceBuffers, so two buffers
   with disjoint ranges make the whole element unplayable — even though each buffer
   individually holds valid data. This is the same rule that makes an audio hole
   stall playback, applied per buffer.
2. **A codec switch only works before the element has played.** `changeType` on a
   live element wedges the SourceBuffer: subsequent `appendBuffer` calls never
   produce `updateend`.

Together these mean MSE gives one decoder configuration per playback session in
this build. There is no arrangement of buffers or type changes that yields a
gapless switch between two configurations on one element.

## What is actually left

**Transcode on import.** Decode the clip with `VideoDecoder`, re-encode at the
main's profile/level/resolution with `VideoEncoder`, mux with `mp4-muxer` (already a
dependency). Measured on this machine: 285 fps at 640×360, 267 fps at 1080p →
**~0.65 s of CPU per 6 s clip**, and 23 ms for the audio. The result is an ordinary
compatible clip, so playback is unchanged and seams stay exact. Costs: a second
generation of compression, and a background encode per clip. Note the encoder emits
its own SPS/PPS, so adopting the main's `avcC` is only safe when the fields that
affect decoding already match — which `configCore` (SPS head) already compares.

**A WebCodecs playback engine.** Decode segments with `VideoDecoder`, composite to a
canvas, run audio through WebAudio. No MSE, therefore no configuration rule at all,
plus a real `mix` mode and no audio-hole constraints. Measured: 1080p frame to
canvas is ~0.04 ms. Costs: it replaces the playback core (frame scheduler, A/V
clock, seeking) and the "one `<video>`" property becomes "one canvas".

**The Simple engine** already handles mixed files today by layering two elements.
It is not a single stream, and it is ±1 frame at the seam, but it does not care
about codecs at all.

## Do not re-try

- Multiple SourceBuffers per track type. Dead by measurement 3 and 4.
- `changeType` on a playing element. Dead by measurement 5 and 8.
- Adding a buffer after media has been appended, or after removing one. Dead by
  measurement 2 and 6.
