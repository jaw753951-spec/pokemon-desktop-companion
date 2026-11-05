/**
 * The soundtrack's conversion: what the decomp's MIDI files and voicegroups
 * say, and what reaches the game of it.
 *
 * The files are built here byte by byte, a few events each, so every test
 * shows the one thing it is about: an instrument changed part way through a
 * channel, a volume, a pan, a bend, a loop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMidi } from '../tools/lib/midi.mjs';
import { instrumentFor, parseKeysplits, parseMidiConfig, parseVoicegroups, waveSteps } from '../tools/lib/voicegroups.mjs';

/** 96 ticks to the beat, at the default 120 beats a minute: a beat is half a second. */
const DIVISION = 96;

/**
 * A one-track MIDI file from events: [delta ticks, ...bytes].
 * @param {Array<number[]>} events
 */
function midi(events) {
  const body = [];
  for (const [delta, ...bytes] of events) {
    const varint = [delta & 0x7f];
    for (let rest = delta >> 7; rest > 0; rest >>= 7) varint.unshift((rest & 0x7f) | 0x80);
    body.push(...varint, ...bytes);
  }
  body.push(0, 0xff, 0x2f, 0);
  const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, DIVISION >> 8, DIVISION & 0xff]);
  const track = Buffer.concat([Buffer.from('MTrk'), Buffer.alloc(4), Buffer.from(body)]);
  track.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, track]);
}

const marker = (text) => [0xff, 0x06, text.length, ...Buffer.from(text)];

test('a channel that changes instrument keeps each note on the one it was written for', () => {
  const song = parseMidi(midi([
    [0, 0xc0, 56], [0, 0x90, 60, 100], [96, 0x80, 60, 0],
    [0, 0xc0, 60], [0, 0x90, 62, 100], [96, 0x80, 62, 0],
  ]));
  assert.deepEqual(song.tracks.map((track) => [track.program, track.notes.map((note) => note.n)]), [[56, [60]], [60, [62]]]);
});

test('a note is as loud as its velocity under the channel\'s volume, where the channel is panned', () => {
  const song = parseMidi(midi([
    [0, 0xb0, 7, 64], [0, 0xb0, 10, 127], [0, 0x90, 60, 127], [96, 0x80, 60, 0],
    [0, 0xb0, 7, 127], [0, 0xb0, 10, 64], [0, 0x90, 60, 127], [96, 0x80, 60, 0],
  ]));
  const [quiet, full] = song.tracks[0].notes;
  assert.equal(quiet.v, 0.504);
  assert.equal(quiet.p, 1);
  assert.equal(full.v, 1);
  assert.equal(full.p, undefined, 'the middle is left unsaid');
});

test('bends are kept in semitones, by the range the channel sets, and slide a held note', () => {
  const song = parseMidi(midi([
    // A range of 12 (an octave), and the bend a quarter of the way up.
    [0, 0xb0, 20, 12], [0, 0xe0, 0, 80], [0, 0x90, 60, 100],
    [48, 0xe0, 0, 64],
    [48, 0x80, 60, 0],
  ]));
  const [note] = song.tracks[0].notes;
  assert.equal(note.b, 3);
  assert.deepEqual(note.g, [[0.25, 0]], 'back to true half way through the note');
});

test('vibrato has the driver\'s depth and speed', () => {
  const song = parseMidi(midi([[0, 0xb0, 1, 8], [0, 0xb0, 21, 44], [0, 0x90, 60, 100], [96, 0x80, 60, 0]]));
  const [note] = song.tracks[0].notes;
  // mod/16 semitones either side; 24 ticks a beat at two beats a second,
  // a cycle every 256/44 ticks.
  assert.equal(note.m, 0.5);
  assert.equal(note.r, 8.25);
});

test('a looping song runs to its loop\'s end, which can be after its last note', () => {
  const song = parseMidi(midi([
    [0, ...marker('['), ], [0, 0x90, 60, 100], [96, 0x80, 60, 0],
    [96, ...marker(']')],
  ]));
  assert.equal(song.loop, 0);
  assert.equal(song.duration, 1, 'two beats to the marker, not the one the note lasts');
});

const GROUPS = `
voice_group test_song
	voice_keysplit_all voicegroup_test_drumset
	voice_keysplit voicegroup_test_piano_keysplit, keysplit_test_piano
	voice_square_1 60, 0, 0, 2, 0, 1, 7, 1
	voice_programmable_wave_alt 60, 0, ProgrammableWaveData_1, 0, 7, 15, 2
	voice_directsound 60, 0, DirectSoundWaveData_sc88pro_flute, 255, 0, 255, 165
	voice_square_1_alt 60, 0, 22, 2, 0, 2, 0, 0

voice_group test_drumset, 36
	voice_directsound_no_resample 60, 64, DirectSoundWaveData_sc88pro_rnd_kick, 255, 0, 255, 0
	voice_square_1 60, 0, 0, 2, 0, 0, 15, 0
	voice_directsound_no_resample 64, 54, DirectSoundWaveData_sd90_solo_snare, 255, 180, 175, 228

voice_group test_piano_keysplit
	voice_directsound 60, 0, DirectSoundWaveData_sc88pro_piano1_48, 255, 250, 0, 149
	voice_directsound 60, 0, DirectSoundWaveData_sc88pro_piano1_60, 255, 250, 0, 149
`;

const KEYSPLITS = `
keysplit test_piano, 36
	split 0, 55
	split 1, 108
`;

const library = {
  groups: parseVoicegroups(GROUPS),
  keysplits: parseKeysplits(KEYSPLITS),
  wave: (label) => (label === 'ProgrammableWaveData_1' ? waveSteps(Uint8Array.from([0x0f, 0xf0, ...Array(14).fill(0x88)])) : null),
};

test('a program is the entry of the song\'s own voicegroup, not a General MIDI instrument', () => {
  assert.deepEqual(instrumentFor(library, 'test_song', 2, [60]), { voice: { w: 'square', key: 60, duty: 2, env: [0, 1, 7, 1] } });
  assert.deepEqual(instrumentFor(library, 'test_song', 4, [60]), {
    voice: { w: 'sample', s: 'sc88pro_flute', key: 60, env: [255, 0, 255, 165] },
  });
  const wave = instrumentFor(library, 'test_song', 3, [60]);
  assert.deepEqual(wave?.voice?.w === 'wave' && wave.voice.wave.slice(0, 4), [0, 15, 15, 0]);
});

test("a first-pulse-channel voice keeps its sweep, and one that never slides carries none", () => {
  assert.deepEqual(instrumentFor(library, 'test_song', 5, [60]), { voice: { w: 'square', key: 60, duty: 2, env: [0, 2, 0, 0], sw: 22 } });
  assert.equal('sw' in (instrumentFor(library, 'test_song', 2, [60])?.voice ?? {}), false);
});

test('a kit gives each key its drum, counted from where the kit starts', () => {
  const kit = instrumentFor(library, 'test_song', 0, [36, 38, 38, 99])?.kit;
  assert.equal(kit?.[36]?.w === 'sample' && kit[36].s, 'sc88pro_rnd_kick');
  const snare = kit?.[38];
  assert.equal(snare?.w === 'sample' && snare.s, 'sd90_solo_snare');
  assert.equal(snare?.w === 'sample' && snare.fixed, true);
  assert.equal(snare?.p, -0.16, 'the kit pans its snare a little left');
  assert.equal(kit?.[99], undefined, 'a key past the kit has no drum');
});

test('a key split gives each range of keys its sample', () => {
  const split = instrumentFor(library, 'test_song', 1, [60])?.split;
  assert.deepEqual(split?.map((range) => [range.to, range.voice.w === 'sample' && range.voice.s]), [
    [55, 'sc88pro_piano1_48'],
    [108, 'sc88pro_piano1_60'],
  ]);
});

test('each song\'s voicegroup and volume come from midi.cfg', () => {
  const songs = parseMidiConfig('mus_vs_champion.mid:           -E -R50 -G_vs_champion -V080 -P1\nmus_heal.mid: -E -R50 -G_fanfare -V090\n');
  assert.deepEqual(songs.get('mus_vs_champion'), { group: 'vs_champion', volume: 80 });
  assert.deepEqual(songs.get('mus_heal'), { group: 'fanfare', volume: 90 });
});

/**
 * A sample WAV as the decomp keeps one: 8-bit, its rate, a loop in a `smpl`
 * chunk, and the cartridge's own pitch and end in `agbp` and `agbl`.
 */
function sampleWav({ rate, frames, loop = null, pitch = rate * 1024 }) {
  const chunk = (id, body) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, Buffer.alloc(body.length & 1)]);
  };
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate, 8);
  fmt.writeUInt16LE(1, 12);
  fmt.writeUInt16LE(8, 14);
  const smpl = Buffer.alloc(loop === null ? 36 : 60);
  smpl.writeUInt32LE(60, 12);
  if (loop !== null) {
    smpl.writeUInt32LE(1, 28);
    smpl.writeUInt32LE(loop, 44);
    smpl.writeUInt32LE(frames - 1, 48);
  }
  const u32 = (value) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return buffer;
  };
  const data = Buffer.from(Array.from({ length: frames }, (_, i) => (i % 2 ? 0 : 255)));
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('smpl', smpl), chunk('agbp', u32(pitch)), chunk('agbl', u32(frames - 1)), chunk('data', data)]);
  return Buffer.concat([Buffer.from('RIFF'), u32(body.length), body]);
}

test('a sample keeps its rate on key 60, its loop and its end', async () => {
  const { parseSample } = await import('../tools/lib/voicegroups.mjs');
  const flute = parseSample(sampleWav({ rate: 3344, frames: 1875, loop: 1312, pitch: 3425024 }));
  assert.equal(flute.rate, 3344);
  assert.equal(flute.pitch, 3344.75, 'the exact rate, which the file\'s own rounds');
  assert.equal(flute.loop, 1312);
  assert.equal(flute.end, 1874, 'the loop goes round before the copy of its start');
  assert.equal(Buffer.from(flute.pcm, 'base64').length, 1875, 'which is kept, for the buffer to read ahead into');
  const snare = parseSample(sampleWav({ rate: 11025, frames: 1762 }));
  assert.equal(snare.loop, null, 'a drum plays once');
});

test('a kit\'s unused key is silent, not a beep on C4', () => {
  const kit = instrumentFor(library, 'test_song', 0, [37])?.kit;
  assert.deepEqual(kit, {}, 'key 37 is the decomp\'s filler square');
});
