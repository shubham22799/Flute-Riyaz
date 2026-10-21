/* ═══════════════════════════════════════════════════════════════════
   sargam.js — root-relative swara mapping (equal-tempered semitones).

     d = m_note − m_Sa
     s = ((d mod 12) + 12) mod 12     → swara
     o = floor(d / 12)                → octave displacement

   The table is a practical equal-tempered mapping, not a claim about
   Hindustani intonation, which varies by raga, context and performer.
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";
  var FPA = (global.FPA = global.FPA || {});

  /* Semitone positions within the octave, from Sa. */
  var TABLE = [
    { swara: "Sa", kind: "shuddha", short: "Sa" },
    { swara: "Re", kind: "komal",   short: "kRe" },
    { swara: "Re", kind: "shuddha", short: "Re" },
    { swara: "Ga", kind: "komal",   short: "kGa" },
    { swara: "Ga", kind: "shuddha", short: "Ga" },
    { swara: "Ma", kind: "shuddha", short: "Ma" },
    { swara: "Ma", kind: "tivra",   short: "tMa" },
    { swara: "Pa", kind: "shuddha", short: "Pa" },
    { swara: "Dha", kind: "komal",  short: "kDha" },
    { swara: "Dha", kind: "shuddha", short: "Dha" },
    { swara: "Ni", kind: "komal",   short: "kNi" },
    { swara: "Ni", kind: "shuddha", short: "Ni" }
  ];

  var REGISTERS = {
    mandra: "mandra saptak",
    madhya: "madhya saptak",
    taar: "taar saptak"
  };

  /* Compact octave markers are built inline in fromMidi (positional:
     'Sa = mandra · Sa = madhya · Sa' = taar). */

  var Sargam = {
    TABLE: TABLE,
    REGISTERS: REGISTERS,

    /* Register name of an octave displacement. */
    register: function (o) {
      if (o < 0) return "mandra";
      if (o > 0) return "taar";
      return "madhya";
    },

    /*
     * Map a detected note (by MIDI number) onto the confirmed Sa.
     * `cents` is optional tuning deviation of the measured pitch; when the
     * pitch lies near a semitone boundary the result is flagged ambiguous.
     *
     * Returns null when Sa is not confirmed (sargam genuinely pending).
     */
    fromMidi: function (noteMidi, saMidi, cents) {
      if (!Number.isFinite(noteMidi) || !Number.isFinite(saMidi)) return null;
      var d = noteMidi - saMidi;
      var s = ((d % 12) + 12) % 12;
      var o = Math.floor(d / 12);
      var entry = TABLE[s];
      var ambiguous = false;
      if (Number.isFinite(cents)) {
        /* Near the halfway point between two semitones (±50 ¢). */
        ambiguous = (50 - Math.abs(cents)) < 8;
      }
      return {
        semitones: s,
        distance: d,
        octave: o,
        swara: entry.swara,
        kind: entry.kind,
        label: (entry.kind === "shuddha" ? entry.swara : entry.kind + " " + entry.swara),
        fullLabel: entry.kind + " " + entry.swara,
        short: entry.short,
        register: this.register(o),
        registerLabel: REGISTERS[this.register(o)],
        /* Compact display code, apostrophes positioned by direction:
           'Sa = mandra · Sa = madhya · Sa' = taar.  Also 'kGa, tMa … */
        compact: (o < 0 ? "'".repeat(Math.min(3, -o)) : "") +
                 entry.short +
                 (o > 0 ? "'".repeat(Math.min(3, o)) : ""),
        ambiguous: ambiguous
      };
    },

    /* Convenience: map from a Notes.describe() result against a confirmed Sa. */
    fromDescribed: function (desc, saMidi) {
      if (!desc || !Number.isFinite(saMidi)) return null;
      return this.fromMidi(desc.midi, saMidi, desc.cents);
    },

    /* The seven shuddha swaras, for reference/legends. */
    shuddhaSwaras: function () {
      return TABLE.filter(function (e) { return e.kind === "shuddha"; }).map(function (e) { return e.swara; });
    }
  };

  FPA.Sargam = Sargam;
})(typeof window !== "undefined" ? window : globalThis);
