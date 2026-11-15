# ClipInject Zero

Play one long video with short clips injected into it, as **one continuous stream in a single `<video>` element that never reloads its `src`** — with a hand-written MP4 demuxer, fragment muxer and MSE engine. No mp4box, no mp4-muxer, no video.js. React only draws the panels.

This is a fork of [Nabih/clipinject](https://github.com/Nabih/clipinject) that removes every third-party video library from the pipeline and rebuilds that layer from the ISO-BMFF spec.

## What changed, and why it is better

Both old libraries made a decision that shaped the whole design: mp4box emitted **one `moof` per track**, which forced two `SourceBuffer`s, two `timestampOffset`s, and a pile of seam fixes around audio holes and init re-appends.

Writing the fragments changes that. A `moof` can carry several `traf` boxes, so:

- **one `SourceBuffer`** for video and audio together,
- **absolute `tfdt`** and `timestampOffset` permanently 0 — an append means what it says,
- **audio filled to the exact length of every fragment**, with real AAC silence where a clip has none, so the buffer never contains a hole for the element to stall on,
- **`src` assigned once**, ever.

## How it works

```
File/Blob ──► mp4.js      parse moov, expand stbl tables → sample index
                 │        (mdat is never loaded; payloads are read on demand)
                 ▼
            edit.js       snap inserts to sync samples → plan of segments
                 │
                 ▼
            frag.js       rebuild moov (two traks + trex), write moof/mdat
                 │        one moof, one traf per track, 8 s chunks
                 ▼
          engine.js       one MediaSource + one SourceBuffer, append ahead
```

Everything in `src/media` and `src/player` is plain ES modules with **no React import**. The React tree reads state and forwards the playhead; it never touches bytes.

Clips are laid over the main timeline: the main video resumes where it would have continued, so inserts never push later material out of sync with itself. Insert points snap to the nearest sync sample, because a fragment may only start on one — and the drift is displayed rather than hidden.

## Measured, not claimed

The demuxer is checked **packet for packet against ffprobe** (`tests/fixtures/*.packets.csv`), so ffprobe is an oracle rather than a dependency — nothing shells out at test or runtime:

| file | video packets | audio packets | compared |
|---|---|---|---|
| `samples/main.mp4` | 3600 | 5626 | offset, size, dts, cts, sync flag |

Playback in Chrome, one insert at 8.00 s:

| check | result |
|---|---|
| mime | `video/mp4; codecs="avc1.4d401e,mp4a.40.2"` |
| buffered | `[[0, 30.07]]` — **one range, 0 gaps** |
| across the seam | main yellow → clip red, no stall |
| dropped frames | 0 |
| playback rate | 2.00 s of media per 2.00 s of wall clock |
| insert *during* playback | playback continued, buffer still one range |
| bundle | 250 KB JS / 79 KB gzip (was 504 KB + 685 KB video.js) |

`NOTES.md` has the full log, including the four bugs this exposed (an `elst` field read one slot early, which turned a 66.7 ms priming shift into 375 s).

## Run it

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # node --test, no test framework
npm run build
```

Load `samples/main.mp4` as the main video, then `samples/clip-red.mp4` (or `-green`, `-blue`) as a clip. Each clip plays a distinct tone, so a seam is audible as well as visible.

## Limits

- **AVC + AAC only** (`avc1`/`avc3`, `mp4a`); anything else is refused with a sentence.
- **No fragmented input** (a file with `mvex` is rejected).
- **Clip audio must match the main track** — codec, sample rate, channels — or that clip plays silent, since mixing rates would need a re-encode.
- **Chrome only**, and **Safari is unverified**: there is no `safaridriver` on the machine this was built on, so Safari support is reasoning, not measurement.
- The video.js engine, the `mix` audio mode and the remote-marker prefetch UX from the parent project are gone with the libraries. Remote URLs still load as clips (fetched as bytes, indexed like a file — so CORS applies), just without the armed-prefetch timing.

## Tests

`npm test` runs Node's built-in runner — no vitest, no config:

- **demux parity** against the committed ffprobe oracle,
- **fragment structure**: sizes that add up, `trun` data offsets pointing at their own payload, `tfdt` in the right timescale, sync flags, signed composition offsets,
- **edit maths**: snapping, virtual times, duplicate-cut handling.

## Licence

No licence file yet — all rights reserved by default. Ask if you want it opened up.
