/* ═══════════════════════════════════════════════════════════════════
   simulation.js — demonstration mode.

   Generates plausible-looking note frames so the interface can be
   explored without a microphone (e.g. while building or reviewing the
   UI). Every simulated value flows through the same pipeline as live
   audio — but is tagged source='simulation' at the frame level and is
   NEVER written into real practice history by default.

   Simulation must never request microphone permission.

   The generator is a plain state machine driven by an explicit
   monotonic time (`step(now)`), which keeps it deterministic enough to
   unit-test: phrases must keep recurring, not fall silent after the
   first one.
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";
  var FPA = (global.FPA = global.FPA || {});

  /* A musically plausible root for the demo: Sa ≈ D4 (293.66 Hz, ET). */
  var SIM_SA_MIDI = 62; // D4

  /* Degrees a free-practice phrase tends to touch (mostly shuddha). */
  var DEGREES = [0, 2, 4, 5, 7, 9, 11, 7, 4, 2, 0, 5, 9, 6 /* tivra Ma */];

  var TICK_MS = 33;

  function Simulation() {
    this.timer = null;
    this.running = false;
    this.onFrame = null;      // fn(frame) — same shape as live frames
    this.onPhase = null;      // fn('phrase'|'gap')
    this.t0 = null;           // first tick's monotonic time
    this.current = null;      // active phrase plan
    this._step = 0;
  }

  /* Plan the next phrase, anchored to `now` (NOT to t0: scheduling from the
     session origin would place every later phrase in the past, so the demo
     would emit one phrase and then silence forever). */
  Simulation.prototype._planPhrase = function (now) {
    var degree = DEGREES[Math.floor(Math.random() * DEGREES.length)];
    var dur = 700 + Math.random() * 2600;
    var gap = 250 + Math.random() * 900;
    this._step = 0;
    this.current = {
      midi: SIM_SA_MIDI + degree,
      startAt: now,
      dur: dur,
      gap: gap,
      vibratoPhase: Math.random() * 6.28
    };
    if (typeof this.onPhase === "function") this.onPhase("phrase");
  };

  Simulation.prototype._emit = function (frame) {
    if (typeof this.onFrame === "function") this.onFrame(frame);
  };

  /*
   * Advance the simulation to monotonic time `now` (ms) and emit one frame.
   * Returns true when a note is sounding, false during a gap.
   */
  Simulation.prototype.step = function (now) {
    if (this.t0 == null) this.t0 = now;
    if (!this.current || now >= this.current.startAt + this.current.dur + this.current.gap) {
      this._planPhrase(now);
    }
    var c = this.current;
    var t = now - c.startAt;
    var clockT = now - this.t0;

    if (t >= 0 && t < c.dur) {
      this._step++;
      /* Onset/decay envelope affects confidence like real breath. */
      var attack = Math.min(1, t / 120);
      var release = Math.min(1, (c.dur - t) / 160);
      var env = Math.min(attack, release);
      /* Slow vibrato + tiny drift, like a human sustain. */
      var vib = Math.sin((t / 1000) * 5.2 + c.vibratoPhase) * 12 +
                Math.sin((t / 1000) * 1.1) * 5;
      var drift = (Math.random() - 0.5) * 6;
      var cents = (vib + drift) * env;
      var freq = FPA.Notes.midiToFreq(c.midi) * Math.pow(2, cents / 1200);
      var confidence = 0.72 + 0.26 * env * (0.9 + Math.random() * 0.1);
      var rms = 0.05 + 0.05 * env;
      /* A short mid-note dropout now and then exercises the grace logic. */
      var dropout = (this._step % 97 >= 92);
      this._emit({
        t: clockT,
        freq: freq,
        confidence: dropout ? confidence * 0.4 : confidence,
        rms: rms,
        valid: !dropout && confidence > 0.8,
        source: "simulation"
      });
      return true;
    }

    this._emit({ t: clockT, freq: NaN, confidence: 0, rms: 0.004, valid: false, source: "simulation" });
    return false;
  };

  Simulation.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.t0 = null;
    this.current = null;
    this._step = 0;
    var self = this;
    this.timer = global.setInterval(function () {
      if (self.running) self.step(performance.now());
    }, TICK_MS);
  };

  Simulation.prototype.stop = function () {
    this.running = false;
    if (this.timer) { global.clearInterval(this.timer); this.timer = null; }
    this.current = null;
    this.t0 = null;
  };

  Simulation.SA_MIDI = SIM_SA_MIDI;
  Simulation.SA_FREQ = FPA.Notes.midiToFreq(SIM_SA_MIDI);

  FPA.Simulation = Simulation;
})(typeof window !== "undefined" ? window : globalThis);
