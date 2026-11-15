/**
 * Audio behaviour for clip inserts.
 *
 * Only two modes survived the move to a hand-written muxer: `mix` needed a
 * decoder plus an AAC encoder to blend clip audio over the main bed, and Chrome
 * ships no AAC encoder in WebCodecs. `replace` and `silent` need neither.
 */

export type AudioMode = 'replace' | 'silent';

export const AUDIO_MODES: { id: AudioMode; label: string; hint: string }[] = [
  {
    id: 'replace',
    label: 'Replace',
    hint: 'Clip audio plays; a clip with no audio is filled with real AAC silence.',
  },
  {
    id: 'silent',
    label: 'Silent',
    hint: 'Every clip insert is filled with real AAC silence.',
  },
];
