/* ═══════════════════════════════════════════════════════════════════
   config.js — defaults & tunable detector/display parameters.
   Thresholds here are TESTING DEFAULTS, not universal constants.
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";
  var FPA = (global.FPA = global.FPA || {});

  FPA.DEFAULTS = {
    /* Western reference tuning (A4 = 440 Hz by default). */
    a4: 440,

    /* Fundamental-frequency detection (YIN). */
    detector: {
      method: "yin-nc",
      fftSize: 4096,          // analyser frame length in samples
      minFreq: 120,           // Hz — lowest flute fundamental accepted
      maxFreq: 1100,          // Hz — highest accepted (taar saptak)
      yinThreshold: 0.15,     // CMND absolute threshold (0..1)
      confidenceMin: 0.78,    // reject estimates with lower periodicity clarity
      octaveHalfTolerance: 1.25, // half-period CMND tolerance for octave-down correction
      analysisIntervalMs: 30, // analysis throttle (~33 analyses/sec)
      /* Noise gate: valid when rms > max(minRms, noiseFloor * noiseFloorRatio). */
      minRms: 0.014,          // slider 1..100 maps to 0.002..0.06
      noiseFloorRatio: 2.6,
      noiseFloorEma: 0.04     // EMA alpha for slow noise-floor tracking
    },

    /* Note-event lifecycle. */
    note: {
      onsetMs: 120,           // pitch must hold this long before an event starts
      releaseGraceMs: 320,    // grace: dropout tolerance AND wrong-pitch flicker window
      pitchChangeHoldMs: 90,  // floor for the flicker window (never shorter than this)
      centsMatch: 60,         // ±cents around event median to count as "same pitch"
      medianWindow: 5,        // rolling median filter length (frames)
      freqSampleCap: 2000     // max per-event frequency samples kept for stability stats
    },

    /* Sa discovery. */
    sa: {
      minEventMs: 700,        // an event must be at least this long to propose Sa
      stabilityCentsMax: 45,  // max within-event spread for a single-event proposal
      minEvents: 2,           // two qualifying events also suffice (even if shorter)
      rememberDefault: true
    },

    /* Timeline display. */
    timeline: {
      windowSeconds: 30,
      minBlockPx: 3
    },

    /* Persistence (localStorage; graceful degradation handled in history.js). */
    storage: {
      historyKey: "fpa.history.v1",
      settingsKey: "fpa.settings.v1",
      maxSessions: 300
    }
  };

  /* Sensitivity slider mapping: 1 (strict/quiet-rejecting) .. 100 (very sensitive). */
  FPA.sensitivityToMinRms = function (s) {
    var v = Math.max(1, Math.min(100, Number(s) || 50));
    // exponential mapping 0.06 .. 0.002
    return 0.06 * Math.pow(0.002 / 0.06, (v - 1) / 99);
  };
  FPA.minRmsToSensitivity = function (minRms) {
    var r = Math.max(1e-6, Math.min(1, Number(minRms) || 0.014));
    return Math.round(1 + 99 * Math.log(r / 0.06) / Math.log(0.002 / 0.06));
  };

  /* Deep-ish clone of defaults for a fresh settings object. */
  FPA.cloneDefaults = function () {
    var d = FPA.DEFAULTS;
    return {
      a4: d.a4,
      detector: Object.assign({}, d.detector),
      note: Object.assign({}, d.note),
      sa: Object.assign({}, d.sa),
      timeline: Object.assign({}, d.timeline)
    };
  };

  /* Merge persisted/partial settings over defaults, clamping to sane ranges. */
  FPA.mergeSettings = function (partial) {
    var s = FPA.cloneDefaults();
    if (!partial || typeof partial !== "object") return s;
    if (Number.isFinite(partial.a4)) s.a4 = clamp(partial.a4, 415, 466);
    mergeInto(s.detector, partial.detector, {
      fftSize: [1024, 16384],
      minFreq: [60, 400],
      maxFreq: [400, 2500],
      yinThreshold: [0.05, 0.4],
      confidenceMin: [0.4, 0.99],
      analysisIntervalMs: [15, 120],
      minRms: [0.001, 0.09],
      noiseFloorRatio: [1.2, 8]
    });
    mergeInto(s.note, partial.note, {
      onsetMs: [40, 600],
      releaseGraceMs: [50, 1500],
      pitchChangeHoldMs: [30, 400],
      centsMatch: [20, 110],
      medianWindow: [1, 15]
    });
    mergeInto(s.sa, partial.sa, {
      minEventMs: [200, 5000],
      stabilityCentsMax: [10, 150]
    });
    if (partial.timeline && Number.isFinite(partial.timeline.windowSeconds)) {
      s.timeline.windowSeconds = clamp(partial.timeline.windowSeconds, 10, 120);
    }
    /* minFreq must stay below maxFreq. */
    if (s.detector.minFreq >= s.detector.maxFreq) {
      s.detector.minFreq = FPA.DEFAULTS.detector.minFreq;
      s.detector.maxFreq = FPA.DEFAULTS.detector.maxFreq;
    }
    return s;
  };

  function mergeInto(target, source, ranges) {
    if (!source) return;
    Object.keys(ranges).forEach(function (k) {
      if (Number.isFinite(source[k])) {
        target[k] = clamp(Number(source[k]), ranges[k][0], ranges[k][1]);
      }
    });
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Number(v))); }

})(typeof window !== "undefined" ? window : globalThis);
