// The music engine turns the market state into songs.
// The page writes `state` every frame. The sequencer reads it on every 16th note.
//
// Mapping:
//   traffic (SPY volume vs. normal) -> tempo inside the theme's range
//   weather (SPY realized volatility) -> hi-hat density and swing
//   SPY direction at the start of a song -> that song's scale and chord progression (bright when up, dark when down)
//   SPY move size -> bass filter opening
//   11 sector moves -> the arpeggio (notes or accents, by theme)
//
// Each theme has a sound preset and a song form that fits its genre.
// A song plays its form once. Then one silent bar follows and a new song starts with a new seed.
// The seed sets the key, the bass lines, the hat accents, the lead and the section lengths.

// Each preset sets the voices, the tempo range, the drum pattern and the song form for one theme.
// drums.kick and drums.back list the 16th steps that play. drums.hats names the hat pattern. back is "clap" or "snare".
// swing is fixed for genres that swing. A missing swing follows the market volatility.
const PRESETS = {
  // Techno: four-on-the-floor kick, open hats on the off-beats, quiet 16th closed hats, clap on 2 and 4, chord stabs. 124 to 134 BPM.
  cyberpunk: {
    harmony: { roots: [33, 29, 31], scales: ["dorian", "aeolian"], prog: { up: [0, 0, 5, 6], down: [0, 0, 5, 6] }, chordBars: 2 },
    form: "techno", bpm: [124, 134], bass: "sawtooth", bassVol: -10, arp: { type: "sine", harmonicity: 2, modulationIndex: 6 }, arpVol: -19,
    crush: 0, drive: 0, reverb: 0.3, delay: 0.3, padVol: -18, padMode: "stab", hatVol: -22, clapVol: -8,
    drums: { kick: [0, 4, 8, 12], back: [4, 12], backVoice: "clap", hats: "techno" },
  },
  // Deep house: four-on-the-floor kick, swung 16th hats, open hats on the off-beats, clap on 2 and 4,
  // electric piano 7th chords in syncopated stabs and a warm rolling bass. 118 to 124 BPM.
  dusk: {
    harmony: { roots: [29, 33, 26], scales: ["dorian", "dorian"], prog: { up: [0, 3], down: [0, 3] }, chordBars: 2 },
    form: "house", bpm: [118, 124], bass: "triangle", bassVol: -6, arp: { type: "triangle", harmonicity: 1, modulationIndex: 1.5 }, arpVol: -22,
    crush: 0, drive: 0, reverb: 0.42, delay: 0.22, padVol: -26, padMode: "keys", keysPattern: [3, 6, 11], keysVol: -14, hatVol: -24, clapVol: -12,
    swing: 0.18, swingSub: "16n", drums: { kick: [0, 4, 8, 12], back: [4, 12], backVoice: "clap", hats: "house" },
  },
  // Synthwave: warm pads, bright leads, lots of arpeggio, a gated snare, punchy kicks, steady 16th hats, tom fills,
  // a driving 16th-note arpeggiated bass, sidechain pumping on the bass and pads, and deep reverb and delay. 84 to 112 BPM.
  synthwave: {
    harmony: { roots: [33, 28, 30], scales: ["ionian", "aeolian"], prog: { up: [0, 4, 5, 3], down: [0, 5, 2, 6] }, chordBars: 2 },
    form: "synthwave", style: "synthwave", bpm: [84, 112], bass: "fatsawtooth", bassVol: -13, arp: { type: "square", harmonicity: 1, modulationIndex: 0.3 }, arpVol: -17,
    crush: 0, drive: 0, reverb: 0.5, delay: 0.35, padVol: -21, padType: "fatsawtooth", padMode: "pump", hatVol: -27, clapVol: -2,
    swing: 0,
    drums: { kick: [0, 4, 8, 12], back: [4, 12], backVoice: "gated", hats: "straight" },
  },
  // Trip-hop: a laid-back broken beat (kick on 1, the "and" of 2 and on 3), snare on 2 and 4, swung 8th hats,
  // electric piano chords, a deep sine bass and vinyl crackle. 72 to 90 BPM.
  noir: {
    harmony: { roots: [26, 36, 31], scales: ["dorian", "aeolian"], prog: { up: [0, 5, 3, 4], down: [0, 5, 3, 4] }, chordBars: 2 },
    form: "ambient", bpm: [72, 90], bass: "sine", bassVol: -4, arp: { type: "sine", harmonicity: 3.01, modulationIndex: 10 }, arpVol: -22,
    crush: 0, drive: 0, reverb: 0.6, delay: 0.3, padVol: -28, padMode: "keys", keysPattern: [0], keysHold: "1m", keysVol: -15, hatVol: -24, clapVol: -18,
    swing: 0.3, swingSub: "8n", crackle: true, drums: { kick: [0, 6, 8], back: [4, 12], backVoice: "snare", hats: "eighths" },
  },
  // Industrial techno: a distorted kick, open hats, metallic 16ths and a bit-crushed arp. 130 to 145 BPM.
  matrix: {
    harmony: { roots: [28, 33], scales: ["aeolian", "aeolian"], prog: { up: [0, 0, 0, 5], down: [0, 0, 0, 5] }, chordBars: 2 },
    form: "techno", bpm: [130, 145], bass: "sawtooth", bassVol: -11, arp: { type: "square", harmonicity: 4, modulationIndex: 14 }, arpVol: -21,
    crush: 0.6, drive: 0.45, reverb: 0.25, delay: 0.4, padVol: -26, padMode: "none", hatVol: -19, clapVol: -9,
    drums: { kick: [0, 4, 8, 12], back: [4, 12], backVoice: "clap", hats: "techno" },
  },
};

// Each pad mode has its own envelope.
//   swell: a soft chord held for 2 bars.
//   stab: a short chord on the off-beats.
//   pump: a held chord that starts again on every beat, so it ducks with the kick.
//   keys: electric piano 7th chords on the preset's keysPattern steps.
const PAD_ENVELOPES = {
  swell: { attack: 0.8, decay: 0.6, sustain: 0.6, release: 1.5 },
  stab: { attack: 0.005, decay: 0.18, sustain: 0, release: 0.15 },
  pump: { attack: 0.06, decay: 0.2, sustain: 0.7, release: 0.12 },
  keys: { attack: 0.01, decay: 0.1, sustain: 0, release: 0.1 },
  none: { attack: 0.01, decay: 0.1, sustain: 0, release: 0.1 },
};

const SCALES = {
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
};
// Each preset's harmony lists its usual keys (MIDI roots), its bright and dark scales, and its chord roots
// as scale degrees for a bright song and a dark song. The chord changes every chordBars bars.

// Layer flags for one section. A missing flag is off.
//   kick, hats ("light" or "full"), back (backbeat clap or snare), bass ("a", "b" or "c"),
//   pad (the theme pad mode), swell (soft swell pad), arp, lead, fill (tom fill in the last bar),
//   sweep (the bass filter opens across the section), half (half-time drums), fade (layers drop out one by one).
const sec = (name, bars, flags) => ({ name, bars, ...flags });

// Each genre has its own song form. The forms are long and simple, so the music stays a background bed.
// Techno and house ride one groove and ease into a quiet passage. Synthwave alternates verse and chorus.
// Ambient drifts between a sparse theme and beatless passages.
const FORMS = {
  techno: (pick) => [
    sec("intro", 16, { kick: true, hats: "light", arp: true }),
    sec("groove", pick([32, 48]), { kick: true, hats: "full", back: true, bass: "a", arp: true, pad: true, sweep: true }),
    sec("breakdown", 16, { hats: "light", swell: true, arp: true }),
    sec("groove", pick([32, 48]), { kick: true, hats: "full", back: true, bass: "b", arp: true, pad: true }),
    sec("outro", 16, { kick: true, hats: "full", bass: "a", arp: true, fade: true }),
  ],
  house: (pick) => [
    sec("intro", 8, { kick: true, hats: "light", pad: true }),
    sec("groove", pick([32, 48]), { kick: true, hats: "full", back: true, bass: "a", pad: true, arp: true }),
    sec("breakdown", 16, { swell: true, pad: true, arp: true }),
    sec("groove", pick([32, 48]), { kick: true, hats: "full", back: true, bass: "b", pad: true, arp: true }),
    sec("outro", 16, { kick: true, hats: "full", bass: "a", pad: true, fade: true }),
  ],
  synthwave: (pick) => {
    const verse = sec("verse", 16, { kick: true, hats: "full", back: true, bass: "a", arp: true, fill: true });
    const chorus = sec("chorus", 16, { kick: true, hats: "full", back: true, bass: "b", pad: true, arp: true, lead: true, fill: true });
    return [
      sec("intro", 8, { swell: true, arp: true }),
      verse, chorus, verse, chorus,
      ...(pick([0, 1]) ? [chorus] : []),
      sec("outro", 8, { kick: true, hats: "full", bass: "a", pad: true, arp: true, fade: true }),
    ];
  },
  ambient: (pick) => [
    sec("intro", 8, { swell: true, arp: true }),
    sec("theme", pick([16, 32]), { kick: true, hats: "light", back: true, bass: "a", arp: true, pad: true }),
    sec("drift", 16, { swell: true, arp: true }),
    sec("theme", pick([16, 32]), { kick: true, hats: "light", back: true, bass: "b", arp: true, pad: true }),
    sec("outro", 8, { swell: true, arp: true, fade: true }),
  ],
};

// The function returns a small seeded random generator (mulberry32).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The function returns the section and the bar inside the section for a bar number.
// After the last section it returns "end". The song is over at that point.
function sectionAt(form, bar) {
  let b = bar;
  for (const f of form) { if (b < f.bars) return { ...f, barIn: b }; b -= f.bars; }
  return { name: "end", bars: 1, barIn: b };
}

// The function makes the parts that the seed controls.
// A song is bright when SPY is up as the song starts. The song keeps that key and scale to the end.
function compose(seed, preset, bright) {
  const r = seeded(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  // A bass line sits mostly on the off-beats. The seed picks which steps play.
  // Each note is the chord root, its fifth (4) or its octave (7), so the bass never clashes with the chord.
  const bassLine = () => Array.from({ length: 16 }, (_, st) => {
    const chance = st % 4 === 2 ? 0.9 : st % 2 === 1 ? 0.3 : 0.12;
    return r() < chance ? pick([0, 0, 0, 4, 7]) : null;
  });
  return {
    seed,
    form: FORMS[preset.form](pick, r),
    bright,
    root: pick(preset.harmony.roots),
    scale: SCALES[preset.harmony.scales[bright ? 0 : 1]],
    prog: preset.harmony.prog[bright ? "up" : "down"],
    bass: { a: bassLine(), b: bassLine(), c: bassLine() },
    accents: Array.from({ length: 16 }, () => 0.3 + r() * 0.5),
    // The synthwave bass arpeggio, as offsets from the chord root in scale degrees (4 is the fifth, 7 the octave).
    synthBass: pick([
      [0, 0, 7, 0, 0, 0, 7, 4, 0, 0, 7, 0, 0, 4, 7, 4],
      [0, 7, 0, 7, 0, 7, 4, 7, 0, 7, 0, 7, 4, 7, 4, 7],
      [0, 0, 4, 7, 0, 0, 4, 7, 0, 0, 4, 7, 0, 4, 7, 4],
    ]),
    // The slow lead picks one chord tone per half bar.
    slowLead: Array.from({ length: 16 }, () => pick([0, 2, 4, 4, 7])),
    arpOctave: pick([2, 2, 3]),
    arpEvery: pick([1, 1, 2]),
  };
}

export function createMusic(Tone) {
  const state = { spy: 0, weather: 0, traffic: 1, sectors: new Array(11).fill(0) };
  let preset = PRESETS.cyberpunk;
  let song = compose(1, preset, true);
  let step = 0;
  let playing = false;

  // The master chain keeps the music a background bed: low level, soft highs and a gentle compressor.
  const out = new Tone.Volume(-14);
  out.chain(new Tone.Filter(7000, "lowpass"), new Tone.Compressor({ threshold: -24, ratio: 3, attack: 0.03, release: 0.25 }), new Tone.Limiter(-3), Tone.getDestination());
  const reverb = new Tone.Reverb({ decay: 5, wet: 0.3 }).connect(out);
  const delay = new Tone.PingPongDelay({ delayTime: "8n.", feedback: 0.35, wet: 0.3 }).connect(out);
  const crusher = new Tone.BitCrusher(4).connect(delay);

  // Industrial themes push the kick through distortion.
  const kickDrive = new Tone.Distortion({ distortion: 0, wet: 1 }).connect(out);
  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.05, octaves: 6, envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.2 },
  }).connect(kickDrive);
  kick.volume.value = -7;

  const hat = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.045, sustain: 0 } })
    .connect(new Tone.Filter(7500, "highpass").connect(out));

  const openHat = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.22, sustain: 0 } })
    .connect(new Tone.Filter(6500, "highpass").connect(out));

  // The electric piano plays 7th chords for house and trip-hop.
  const keys = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 3, modulationIndex: 2.5, envelope: { attack: 0.005, decay: 1.2, sustain: 0.2, release: 0.8 },
    modulationEnvelope: { attack: 0.005, decay: 0.4, sustain: 0.1, release: 0.5 },
  }).connect(reverb);
  keys.connect(delay);

  // Vinyl crackle: quiet band-passed noise plus random clicks.
  const crackleBed = new Tone.Noise("pink").connect(new Tone.Filter(2200, "bandpass").connect(new Tone.Volume(-40).connect(out)));
  const crackleClick = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.008, sustain: 0 } }).connect(out);
  crackleClick.volume.value = -30;

  const clap = new Tone.NoiseSynth({ noise: { type: "pink" }, envelope: { attack: 0.002, decay: 0.16, sustain: 0 } })
    .connect(new Tone.Filter(1800, "bandpass").connect(reverb));

  // The duck gains copy sidechain compression. Each kick pulls the bass and the pads down, and they swell back.
  const bassDuck = new Tone.Gain(1).connect(out);
  const padDuck = new Tone.Gain(1).connect(reverb);
  const bassFilter = new Tone.Filter({ frequency: 300, type: "lowpass", Q: 6 }).connect(bassDuck);
  const bass = new Tone.MonoSynth({
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.005, decay: 0.15, sustain: 0.2, release: 0.1 },
    filterEnvelope: { attack: 0.001, decay: 0.12, sustain: 0.1, baseFrequency: 120, octaves: 2.5 },
  }).connect(bassFilter);

  const arp = new Tone.FMSynth({ envelope: { attack: 0.002, decay: 0.15, sustain: 0, release: 0.2 } }).connect(crusher);
  const arpHigh = new Tone.Synth({ oscillator: { type: "square" }, envelope: { attack: 0.002, decay: 0.12, sustain: 0, release: 0.15 } }).connect(delay);
  arpHigh.volume.value = -31;

  const chorus = new Tone.Chorus({ frequency: 0.6, delayTime: 4, depth: 0.7, wet: 0 }).connect(padDuck).start();
  const pad = new Tone.PolySynth(Tone.Synth, { oscillator: { type: "sine" }, envelope: PAD_ENVELOPES.swell }).connect(chorus);
  // The swell pad plays in quiet sections, whatever the theme's pad mode is.
  const swellPad = new Tone.PolySynth(Tone.Synth, { oscillator: { type: "sine" }, envelope: PAD_ENVELOPES.swell }).connect(chorus);
  swellPad.volume.value = -27;


  // The gated snare is a noise burst and a short tone body into a short, wet reverb.
  const snareVerb = new Tone.Reverb({ decay: 1.1, wet: 0.55 }).connect(out);
  const snareNoise = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.22, sustain: 0 } }).connect(snareVerb);
  snareNoise.volume.value = -16;
  const snareBody = new Tone.MembraneSynth({ pitchDecay: 0.02, octaves: 2, envelope: { attack: 0.001, decay: 0.15, sustain: 0 } }).connect(snareVerb);
  snareBody.volume.value = -17;
  const snare = (time, vel) => { snareNoise.triggerAttackRelease("16n", time, vel); snareBody.triggerAttackRelease("G2", "16n", time, vel); };
  const tom = new Tone.MembraneSynth({ pitchDecay: 0.08, octaves: 3, envelope: { attack: 0.001, decay: 0.4, sustain: 0 } }).connect(snareVerb);
  tom.volume.value = -18;

  const leadSynth = new Tone.MonoSynth({
    oscillator: { type: "fatsawtooth", count: 3, spread: 25 }, portamento: 0.06,
    envelope: { attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.3 },
    filterEnvelope: { attack: 0.02, decay: 0.3, sustain: 0.6, baseFrequency: 900, octaves: 2 },
  }).connect(delay);
  leadSynth.connect(reverb);
  leadSynth.volume.value = -28;

  const popper = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.3, sustain: 0 } })
    .connect(new Tone.Filter(2600, "lowpass").connect(reverb));
  popper.volume.value = -8;
  let lastPop = 0;

  // Thunder has 3 parts: a short bright crack, a long low rumble and a sub-bass boom.
  // The rumble filter closes while the rumble fades, so the sound gets darker as it rolls away.
  const crack = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.3, sustain: 0 } })
    .connect(new Tone.Filter(3000, "lowpass").connect(reverb));
  crack.volume.value = -10;
  const rumbleFilter = new Tone.Filter({ frequency: 500, type: "lowpass", rolloff: -24 });
  rumbleFilter.connect(out); rumbleFilter.connect(reverb);
  const rumble = new Tone.NoiseSynth({ noise: { type: "brown" }, envelope: { attack: 0.35, decay: 5.5, sustain: 0, release: 1 } }).connect(rumbleFilter);
  rumble.volume.value = 8;
  const boom = new Tone.MembraneSynth({ pitchDecay: 0.9, octaves: 2.5, envelope: { attack: 0.02, decay: 3.5, sustain: 0, release: 1 } }).connect(out);
  boom.volume.value = -3;
  let lastThunder = 0;

  const transport = Tone.getTransport();
  function applyPreset() {
    bass.set({ oscillator: { type: preset.bass } });
    bass.volume.value = preset.bassVol;
    arp.set({ oscillator: { type: preset.arp.type }, harmonicity: preset.arp.harmonicity, modulationIndex: preset.arp.modulationIndex });
    arp.volume.value = preset.arpVol;
    crusher.wet.value = preset.crush;
    reverb.wet.value = preset.reverb;
    delay.wet.value = preset.delay;
    pad.volume.value = preset.padVol;
    pad.set({ oscillator: { type: preset.padType ?? "sine" }, envelope: PAD_ENVELOPES[preset.padMode] });
    swellPad.set({ oscillator: { type: preset.padType ?? "sine" } });
    chorus.wet.value = preset.padType ? 0.6 : 0;
    hat.volume.value = preset.hatVol - 5;
    openHat.volume.value = preset.hatVol - 9;
    clap.volume.value = preset.clapVol - 6;
    keys.volume.value = preset.keysVol ?? -14;
    kickDrive.distortion = preset.drive;
    kickDrive.wet.value = preset.drive > 0 ? 1 : 0;
    transport.swingSubdivision = preset.swingSub ?? "8n";
    if (preset.crackle && crackleBed.state !== "started") crackleBed.start();
    if (!preset.crackle && crackleBed.state === "started") crackleBed.stop();
  }
  applyPreset();

  // The chord root follows the song's progression. It changes every chordBars bars.
  function chordRoot() {
    return song.prog[Math.floor(step / 16 / preset.harmony.chordBars) % song.prog.length];
  }
  function chord() {
    const root = chordRoot();
    return [note(root, 2), note(root + 2, 2), note(root + 4, 2)];
  }
  function chord7() {
    const root = chordRoot();
    return [note(root, 2), note(root + 2, 2), note(root + 4, 2), note(root + 6, 2)];
  }

  function note(degree, octave) {
    const o = Math.floor(degree / 7), i = ((degree % 7) + 7) % 7;
    return Tone.Frequency(song.root + 12 * (octave + o) + song.scale[i], "midi").toNote();
  }

  let section = sectionAt(song.form, 0);
  let onSong = () => {};
  transport.scheduleRepeat((time) => {
    const s = step % 16, bar = Math.floor(step / 16), w = state.weather, mag = Math.min(Math.abs(state.spy), 3) / 3;
    const sc = section = sectionAt(song.form, bar);

    // A song ends after its last section. One silent bar follows, then a new song starts with a new seed.
    if (sc.name === "end") {
      if (s === 0) { pad.releaseAll(time); swellPad.releaseAll(time); }
      if (s === 15) { song = compose(Math.floor(Math.random() * 10000), preset, state.spy >= 0); step = -1; onSong(); }
      step++;
      return;
    }

    const synth = preset.style === "synthwave";
    const progress = (sc.barIn * 16 + s) / (sc.bars * 16);
    const lastBar = sc.barIn === sc.bars - 1;
    // In a fading outro, the layers drop out one by one: arp, pad, bass, backbeat, hats, then kick.
    const on = (flag, fadeAt) => Boolean(sc[flag]) && !(sc.fade && progress >= fadeAt);

    if (s === 0) {
      const [lo, hi] = preset.bpm;
      transport.bpm.rampTo(lo + (Math.min(state.traffic, 4) / 4) * (hi - lo), 2, time);
      transport.swing = preset.swing ?? 0.04 + w * 0.25;
      bassFilter.frequency.rampTo(220 + mag * 2600 + w * 600 + (sc.sweep ? progress * 1500 : 0), 1, time);
      delay.feedback.rampTo(sc.swell && !sc.kick ? 0.55 : 0.35, 1, time);
      if (sc.swell && sc.barIn % 2 === 0) swellPad.triggerAttackRelease(chord(), "2m", time, 0.4);
      if (on("pad", 0.4) && preset.padMode === "swell" && sc.barIn % 2 === 0) pad.triggerAttackRelease(chord(), "2m", time, 0.4);
    }
    if (on("pad", 0.4) && preset.padMode === "stab" && (s === 2 || s === 10 || (s === 7 && Math.random() < 0.4))) pad.triggerAttackRelease(chord(), "16n", time, 0.6);
    if (on("pad", 0.4) && preset.padMode === "pump" && s % 4 === 0) pad.triggerAttackRelease(chord(), "8n.", time + 0.06, 0.5);
    // House and trip-hop play electric piano chords in the sections that have a pad or a swell.
    if (preset.padMode === "keys" && (on("pad", 0.4) || sc.swell) && preset.keysPattern.includes(s) && (!preset.keysHold || sc.barIn % 2 === 0)) {
      keys.triggerAttackRelease(chord7(), preset.keysHold ?? "8n", time, 0.5 + Math.random() * 0.2);
    }
    if (preset.crackle && Math.random() < 0.18) crackleClick.triggerAttackRelease("64n", time + Math.random() * 0.1, Math.random());

    if (sc.lead && (s === 0 || s === 8)) {
      const degree = chordRoot() + song.slowLead[(bar * 2 + s / 8) % 16];
      leadSynth.triggerAttackRelease(note(degree, 3), "2n", time, 0.55);
    }

    // Half-time drums play the kick on beat 1 and the backbeat on beat 3.
    const kickStep = sc.half ? s === 0 : preset.drums.kick.includes(s);
    if (on("kick", 0.875) && kickStep) {
      kick.triggerAttackRelease("C1", "8n", time);
      if (synth) for (const g of [bassDuck, padDuck]) { g.gain.cancelScheduledValues(time); g.gain.setValueAtTime(0.3, time); g.gain.linearRampToValueAtTime(1, time + 0.22); }
    }

    // Light hats play only the off-beats. Full hats follow the genre pattern. Volatility adds ghost notes in techno and house.
    if (on("hats", 0.75)) {
      const offbeat = s % 4 === 2;
      const kind = preset.drums.hats;
      if (sc.hats === "light") { if (offbeat) hat.triggerAttackRelease("32n", time, 0.5); }
      else if (kind === "straight") hat.triggerAttackRelease("32n", time, offbeat ? 0.8 : 0.35 + w * 0.3);
      else if (kind === "eighths") { if (s % 2 === 0) hat.triggerAttackRelease("32n", time, offbeat ? 0.7 : 0.4); }
      else {
        if (offbeat) openHat.triggerAttackRelease("16n", time, 0.7);
        else if (kind === "house" ? s % 2 === 1 : true) hat.triggerAttackRelease("32n", time, (s % 2 === 1 ? 0.35 : 0.22) + w * 0.3 * song.accents[s]);
      }
    }

    // Synthwave plays a tom fill in the second half of the last bar of a section.
    const filling = synth && sc.fill && lastBar && s >= 8;
    if (filling && s % 2 === 0) tom.triggerAttackRelease(["A2", "F2", "D2", "A1"][(s - 8) / 2], "8n", time, 0.8);

    const backStep = sc.half ? s === 8 : preset.drums.back.includes(s);
    if (on("back", 0.6) && backStep && !filling) {
      const voice = preset.drums.backVoice;
      if (voice === "gated") snare(time, 0.9);
      else if (voice === "snare") { snareNoise.triggerAttackRelease("16n", time + 0.02, 0.6); snareBody.triggerAttackRelease("D2", "16n", time + 0.02, 0.7); }
      else clap.triggerAttackRelease("16n", time);
    }

    if (on("bass", 0.5)) {
      if (synth) {
        // The synthwave bass plays a driving 16th-note arpeggio on the chord root, fifth and octave.
        bass.triggerAttackRelease(note(chordRoot() + song.synthBass[s], 1), "16n", time, s % 4 === 0 ? 1 : 0.75);
      } else {
        const line = song.bass[sc.bass];
        if (line[s] !== null) bass.triggerAttackRelease(note(chordRoot() + line[s], 1), "16n", time);
      }
    }

    if (on("arp", 0.25)) {
      const pct = state.sectors[step % state.sectors.length];
      if (synth) {
        // The synthwave arp walks the chord tones up and down. The sector moves set the accents.
        const k = [0, 1, 2, 3, 2, 1][step % 6];
        const vel = 0.4 + Math.min(Math.abs(pct) / 3, 1) * 0.5;
        arp.triggerAttackRelease(note(chordRoot() + [0, 2, 4, 7][k], song.arpOctave + 1), "16n", time, vel);
        // A chorus doubles the arp an octave up on the off-steps.
        if (sc.lead && s % 2 === 1) arpHigh.triggerAttackRelease(note(chordRoot() + [0, 2, 4, 7][3 - k], song.arpOctave + 2), "16n", time, vel * 0.7);
      } else if (s % song.arpEvery === 0) {
        // Each arp step plays the next sector. A quiet sector rests, so the data sets the rhythm.
        // The note is a tone of the current chord: a bigger move picks a higher tone, and a down sector plays an octave lower.
        const p = state.sectors[Math.floor(step / song.arpEvery) % state.sectors.length];
        if (Math.abs(p) >= 0.15) {
          const tone = [0, 2, 4, 7][Math.min(3, Math.floor(Math.abs(p) * 1.5))];
          arp.triggerAttackRelease(note(chordRoot() + tone, song.arpOctave + (p >= 0 ? 1 : 0)), "16n", time, 0.35 + Math.min(Math.abs(p) / 3, 1) * 0.5);
        }
      }
    }

    step++;
  }, "16n");

  return {
    state,
    get seed() { return song.seed; },
    get section() { return section.name; },
    // The page sets this callback. It runs when a new song starts.
    set onSong(fn) { onSong = fn; },
    async start() { await Tone.start(); playing = true; transport.start(); },
    stop() { playing = false; transport.pause(); },
    // The rumble starts after a random delay of 0.2 to 1 second, like a strike some distance away.
    thunder() {
      const now = Tone.now();
      if (now - lastThunder < 2) return;
      lastThunder = now;
      const t = now + 0.2 + Math.random() * 0.8;
      crack.triggerAttackRelease("8n", t, 0.4 + Math.random() * 0.6);
      boom.triggerAttackRelease("A0", "1n", t + 0.05);
      rumble.triggerAttackRelease(5, t + 0.08);
      rumbleFilter.frequency.cancelScheduledValues(t);
      rumbleFilter.frequency.setValueAtTime(700, t);
      rumbleFilter.frequency.exponentialRampToValueAtTime(110, t + 5);
    },
    // Pops closer than 80 ms together play as one, so a rally does not clip the output.
    pop(big) {
      const t = Tone.now();
      if (t - lastPop < 0.08) return;
      lastPop = t;
      popper.triggerAttackRelease(big ? "8n" : "16n", t, big ? 1 : 0.45);
    },
    // The function loads the theme preset, draws a new seed and starts a new song from bar 1.
    restyle(themeName) {
      preset = PRESETS[themeName] ?? PRESETS.cyberpunk;
      song = compose(Math.floor(Math.random() * 10000), preset, state.spy >= 0);
      applyPreset();
      pad.releaseAll();
      swellPad.releaseAll();
      keys.releaseAll();
      transport.stop();
      step = 0;
      if (playing) transport.start("+0.05");
    },
  };
}
