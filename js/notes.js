/* ═══════════════════════════════════════════════════════════════════
   notes.js — Western pitch identification.
   Independent of Sa: works before any tonic is confirmed.

   MIDI-style pitch number:  m = 69 + 12 * log2(f / A4)
   Reference frequency:     f_ref = A4 * 2^((m_round - 69)/12)
   Deviation in cents:      c = 1200 * log2(f / f_ref)
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";
  var FPA = (global.FPA = global.FPA || {});

  var NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  var Notes = {
    NAMES: NAMES_SHARP,

    /* Continuous MIDI-style number for a frequency. */
    freqToMidiFloat: function (freq, a4) {
      a4 = a4 || FPA.DEFAULTS.a4;
      if (!(freq > 0)) return NaN;
      return 69 + 12 * Math.log2(freq / a4);
    },

    /* Equal-tempered reference frequency of an integer MIDI number. */
    midiToFreq: function (midi, a4) {
      a4 = a4 || FPA.DEFAULTS.a4;
      return a4 * Math.pow(2, (midi - 69) / 12);
    },

    /* Nearest equal-tempered MIDI number (integer). */
    nearestMidi: function (freq, a4) {
      return Math.round(this.freqToMidiFloat(freq, a4));
    },

    /* Note identity of a MIDI number: {midi, pc, name, octave, label}. */
    midiInfo: function (midi) {
      var pc = ((midi % 12) + 12) % 12;
      var octave = Math.floor(midi / 12) - 1;
      return {
        midi: midi,
        pc: pc,
        name: NAMES_SHARP[pc],
        octave: octave,
        label: NAMES_SHARP[pc] + octave   // e.g. "C#4"
      };
    },

    /*
     * Every equal-tempered note whose reference frequency falls inside
     * [minFreq, maxFreq], ascending. Used to build the manual Sa picker, so the
     * list always matches the detector's accepted range and the A4 reference.
     * Returns [] for unusable input rather than guessing a range.
     */
    midiRange: function (minFreq, maxFreq, a4) {
      a4 = a4 || FPA.DEFAULTS.a4;
      if (!Number.isFinite(minFreq) || !Number.isFinite(maxFreq) || minFreq <= 0 || maxFreq <= 0) return [];
      var lo = Math.ceil(this.freqToMidiFloat(minFreq, a4));
      var hi = Math.floor(this.freqToMidiFloat(maxFreq, a4));
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return [];
      var out = [];
      for (var m = lo; m <= hi && out.length < 96; m++) out.push(this.midiInfo(m));
      return out;
    },

    /*
     * Full description of a measured frequency.
     * Returns null for unusable input; never invents a pitch.
     */
    describe: function (freq, a4) {
      if (!Number.isFinite(freq) || freq <= 0) return null;
      a4 = a4 || FPA.DEFAULTS.a4;
      var midi = this.nearestMidi(freq, a4);
      var refFreq = this.midiToFreq(midi, a4);
      var cents = 1200 * Math.log2(freq / refFreq);
      var info = this.midiInfo(midi);
      info.freq = freq;
      info.refFreq = refFreq;
      info.cents = cents;
      info.midiFloat = this.freqToMidiFloat(freq, a4);
      /* Distance (in cents) from the semitone boundary: < 8 ¢ ⇒ ambiguous class. */
      info.boundaryCents = 50 - Math.abs(cents);
      return info;
    },

    /* Friendly duration formatting shared across modules. */
    formatSeconds: function (ms) {
      if (!Number.isFinite(ms) || ms < 0) ms = 0;
      return (ms / 1000).toFixed(1) + "\u2009s";
    },
    formatClock: function (ms) {
      if (!Number.isFinite(ms) || ms < 0) ms = 0;
      var total = Math.floor(ms / 1000);
      var m = Math.floor(total / 60);
      var s = total % 60;
      return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    }
  };

  FPA.Notes = Notes;
})(typeof window !== "undefined" ? window : globalThis);
