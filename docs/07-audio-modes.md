# 07 — Audio Modes (dropdown)

Three modes, chosen from a `<select>` next to the engine picker. The mode is part
of the project state and invalidates the audio buffer on change (video is
unaffected, so the change is nearly instant).

## First: the trap nobody sees coming

"Just let the main audio keep running underneath the clip" sounds obvious and is
**wrong**. Walk it through:

```
main video at 02:14 ──┤ cut
                       clip3 plays for 9.4 s (virtual 02:14 → 02:23.4)
main video resumes at 02:14
```

If the main *audio* kept running during those 9.4 s, it is now at main-time
02:23.4 while the main *video* resumes at 02:14. They are **9.4 s apart, forever**,
and the error compounds with every insertion. For talking-head or dialogue-driven
main video this is immediately unwatchable.

You cannot have main audio continue at natural speed under a clip without either
(a) letting main video advance too — which is overlay, not insertion — or
(b) desynchronising.

So the modes below are the three things that are physically coherent.

## Mode 1 — `Replace` (default)

Clip audio takes over completely. Main audio is cut out of the buffer for the
clip's window.

```
main audio ──────╮         ╭──────
                 ╰─ clip3 ─╯
```

- Clip **has** audio → clip audio plays.
- Clip **has no** audio → the window is filled with **real AAC silence**, never an
  empty range. A hole in the audio track does not play silently: it stalls the
  element at the gap (`readyState 2`, no error, picture frozen while `currentTime`
  keeps running). Measured, see `HANDOFF.md` §7(d).
  The filler is a constant AAC-LC silent frame (6 bytes stereo, 4 mono — the
  payload does not depend on sample rate), looped by `muxSilence()`. Verified with
  `ffmpeg -af volumedetect`: −91.0 dB across a 5.00 s fill.

Implementation:

| Engine | How |
|---|---|
| MSE | Main slices end at the cut and resume after the clip; the clip window gets `muxSilence(clipDuration)` when the clip has no audio. Every segment therefore contributes exactly its own duration, so the audio track has no holes and stays locked to video by construction. |
| Simple | Outgoing element `muted = true` during the clip; incoming unmuted only if the clip has audio. No filler needed — nothing is spliced. |

**`Mix` is not available on the MSE engine.** Summing the clip with the bed means
adding two AAC streams, which needs a decode and a re-encode; the engine plays the
clip audio instead (i.e. it behaves like `Replace`) and the UI says so. The simple
engine implements the bed. Absolute silence is not the only option: `Mix` mode (below) fills the same window
with the looped pre-cut bed instead, and `Silent` mode forces the filler for every
clip so the clips are muted but the timeline stays whole.

## Mode 2 — `Mix` (main audio bed)

Clip audio plays **and** a bed of the main audio continues underneath, ducked to
about −9 dB, with a 20 ms crossfade wherever the bed loops.

```
main audio ──────┤ hold: [01:59.6 → 02:01.4] looping ─┤──────
                 clip3 (own audio at 0 dB)
```

The bed is the **1.5 s immediately before the cut**, looped. That is the shortest
window that still sounds like the same room/ambience rather than a stuck sample,
and it contains no words the viewer is trying to follow (the words they *should*
hear are in the clip).

Implementation — identical in both engines, which is why it is a good mode to
ship: a third hidden element.

```ts
// created once per project
bed = new Audio(mainObjectUrl);
bed.volume = 0.35;                       // ≈ −9 dB

function bedStart(cutTime: number) {
  bed.currentTime = Math.max(0, cutTime - 1.5);
  bed.play();
}
bed.addEventListener('timeupdate', () => {         // loop with a hard reset
  if (bed.currentTime >= cutTime) bed.currentTime = Math.max(0, cutTime - 1.5);
});
```

The main video's own `volume` is never touched — it belongs to the user's slider.
In MSE, mode `Mix` emits the same audio slices as `Replace`, so switching between
them only needs a buffer change for the clip windows, not a full re-index.

Crossfade: a bare `currentTime` reset clicks. Fade `bed.volume` to 0 over the last
20 ms and back up over the first 20 ms, or overlap two bed elements if you want it
properly seamless (v1: accept a 20 ms fade, it is inaudible under clip audio).

## Mode 3 — `Silent`

All clips are silent; main audio plays for main segments, exactly like `Replace`
but clip audio is never emitted — the clip window is filled with silence instead.

Useful for B-roll where the clip's own soundtrack is unwanted.

## Decision table

| Clip has audio | Replace | Mix | Silent |
|---|---|---|---|
| yes | clip audio | clip audio + bed | silence |
| no | silence | bed only | silence |

"Silence" means the filler from `muxSilence`, not an omitted range — see mode 1.

## Step-by-step

1. Add `audioMode: 'replace' | 'mix' | 'silent'` to project state (default `replace`).
2. Timeline build is unchanged — audio mode is an **engine/render** concern, not a
   timeline concern. Keep `buildTimeline` pure and audio-agnostic.
3. Per segment, pick the audio source: the segment's own samples, or silence
   (`muxSilence`). Never "no slice": every segment contributes exactly
   `virtOut - virtIn` seconds, so the track cannot develop holes.
4. MSE engine consumes `audioPlan` when filling `queueAudio`, and starts/stops the
   bed element on entering/leaving a clip window.
5. Simple engine consumes the same plan for `muted` flags plus the bed element.
6. On mode change: pause, rebuild the audio queue only, flush `sba`, re-pump. Video
   `SourceBuffer` and `currentTime` stay untouched.
7. HUD shows `audio replace · bed −9 dB · 2 silent clips`.

## Gotchas

- The bed element is a **third media element**. In the Simple engine that is three
  decoders; on 4K it can be the straw that breaks the budget. Fall back to
  `Replace` automatically above 1440p and say so in the HUD.
- Autoplay: `bed.play()` runs off a user gesture chain (the play button), so it is
  allowed. Calling it from a `setTimeout` after a page load is not.
- If the main video's audio track is absent entirely, `Mix` degrades to `Silent`
  with a one-line notice rather than an error.
- Absolute main time 0 has no "1.5 s before the cut" — clamp the bed window to
  `[0, cut)` and loop whatever is available.
- Never change `video.volume` to implement ducking. It fights the user's slider and
  breaks volume persistence.

## Acceptance checklist

- [ ] Switching modes mid-playback keeps `currentTime` and the video frame.
- [ ] `Replace` + no-audio clip = silent window, video uninterrupted (both engines).
- [ ] `Mix` bed loops without a click for a 20 s clip (loop 13 times).
- [ ] `Silent` mutes every clip and never touches main audio.
- [ ] Audio stays in sync with video after 5 insertions in every mode.
- [ ] No mode ever writes `video.volume`.
