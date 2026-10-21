/* ═══════════════════════════════════════════════════════════════════
   pitch.js — fundamental-frequency (f0) estimation.

   Method: YIN-style difference function with cumulative mean
   normalization (CMND), absolute threshold, parabolic interpolation,
   plus a half-period check to reduce octave-down errors. A raw
   "strongest spectral peak" approach is deliberately NOT used: a
   flute's harmonics often exceed the fundamental in amplitude, which
   would classify notes one octave too high.

   Difference function:   d(tau) = SUM ( x[j] − x[j+tau] )^2
   CMND:                  cmnd(tau) = d(tau) * tau / SUM_{k<=tau} d(k)
   Period estimate:       first tau where cmnd < threshold → local min
   Frequency:             f0 = sampleRate / tau   (parabolic-refined)
   Confidence:            1 − cmnd(tau_opt)

   Also provides:
     • RMS noise gate with a slowly-adapted noise floor,
     • rolling median smoothing + cents-spread stability estimate.
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";
  var FPA = (global.FPA = global.FPA || {});

  /* ───────────────────── raw frame detector ───────────────────── */

  /*
   * Detect f0 in a time-domain frame.
   * Returns { ok, freq, confidence, rms, reason } — never a guess:
   * when ok === false the caller must treat the frame as unusable.
   */
  function detectFrame(buffer, sampleRate, opts) {
    opts = opts || {};
    var minFreq = opts.minFreq || FPA.DEFAULTS.detector.minFreq;
    var maxFreq = opts.maxFreq || FPA.DEFAULTS.detector.maxFreq;
    var threshold = opts.yinThreshold || FPA.DEFAULTS.detector.yinThreshold;
    var confMin = Number.isFinite(opts.confidenceMin) ? opts.confidenceMin : FPA.DEFAULTS.detector.confidenceMin;
    var minRms = Number.isFinite(opts.minRms) ? opts.minRms : FPA.DEFAULTS.detector.minRms;
    var nfRatio = Number.isFinite(opts.noiseFloorRatio) ? opts.noiseFloorRatio : FPA.DEFAULTS.detector.noiseFloorRatio;

    var W = buffer.length;
    var rms = 0;
    var i, j;
    for (i = 0; i < W; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / W);

    /* Noise floor: track the quiet envelope slowly (EMA biased down). */
    var nf = opts._noiseFloor;
    if (!Number.isFinite(nf) || nf <= 0) nf = rms > 0 ? rms : 1e-4;
    var alpha = Number.isFinite(opts.noiseFloorEma) ? opts.noiseFloorEma : FPA.DEFAULTS.detector.noiseFloorEma;
    if (rms < nf * 1.2) nf = nf * (1 - alpha) + rms * alpha;
    nf = Math.max(nf, 1e-5);
    if (opts._noiseFloorHolder) opts._noiseFloorHolder.value = nf;

    var gate = Math.max(minRms, nf * nfRatio);
    if (rms < gate) {
      return { ok: false, freq: NaN, confidence: 0, rms: rms, reason: "quiet" };
    }

    /* YIN search bounds in samples (periods). */
    var tauMax = Math.min(Math.floor(W / 2), Math.ceil(sampleRate / minFreq));
    var tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
    if (tauMax <= tauMin + 2) {
      return { ok: false, freq: NaN, confidence: 0, rms: rms, reason: "config" };
    }

    var d = new Float64Array(tauMax + 1);
    var cmnd = new Float64Array(tauMax + 1);
    cmnd[0] = 1;
    var running = 0;
    for (var tau = 1; tau <= tauMax; tau++) {
      var sum = 0;
      var lim = W - tau;
      for (j = 0; j < lim; j++) {
        var diff = buffer[j] - buffer[j + tau];
        sum += diff * diff;
      }
      d[tau] = sum;
      running += sum;                       /* PREFIX sum — not the total */
      cmnd[tau] = running > 0 ? d[tau] * tau / running : 1;
    }

    /* First absolute-threshold crossing (biased to the smallest period). */
    var tauEst = -1;
    for (tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < threshold) {
        /* Descend to the local minimum. */
        while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
        tauEst = tau;
        break;
      }
    }
    if (tauEst < 0) {
      /* No trustworthy periodicity found in range. */
      return { ok: false, freq: NaN, confidence: 0, rms: rms, reason: "no-periodicity" };
    }

    /*
     * Octave-down guard: the first-crossing rule can select 2·T when the
     * half-period minimum is only marginally above threshold (common with
     * vibrato or amplitude wobble on sustained flute notes). If a genuine
     * local minimum near tau/2 is almost as good, prefer it.
     */
    var halfTol = Number.isFinite(opts.octaveHalfTolerance) ? opts.octaveHalfTolerance : FPA.DEFAULTS.detector.octaveHalfTolerance;
    /* Deliberately search BELOW tauMin as well: if the true period is shorter
       than the configured maximum frequency allows, we must detect that and
       reject the frame, not report a subharmonic one octave down. */
    var halfLo = Math.max(2, Math.round(tauEst * 0.45));
    var halfHi = Math.round(tauEst * 0.58);
    if (halfHi > halfLo + 2) {
      var halfBest = -1, halfVal = Infinity;
      for (tau = halfLo; tau <= halfHi; tau++) {
        if (cmnd[tau] < halfVal) { halfVal = cmnd[tau]; halfBest = tau; }
      }
      if (halfBest > 0 &&
          cmnd[halfBest - 1] > cmnd[halfBest] && cmnd[halfBest + 1] > cmnd[halfBest] &&
          halfVal < threshold * halfTol) {
        tauEst = halfBest;
      }
    }

    /* Parabolic interpolation around the selected minimum. */
    var betterTau = tauEst;
    if (tauEst > 1 && tauEst < tauMax) {
      var y0 = cmnd[tauEst - 1], y1 = cmnd[tauEst], y2 = cmnd[tauEst + 1];
      var denom = y0 - 2 * y1 + y2;
      if (Math.abs(denom) > 1e-12) {
        var delta = 0.5 * (y0 - y2) / denom;
        if (Math.abs(delta) < 1) betterTau = tauEst + delta;
      }
    }

    var freq = sampleRate / betterTau;
    var confidence = clamp01(1 - cmnd[tauEst]);

    /* Reject out-of-range results explicitly. */
    if (freq < minFreq * 0.98 || freq > maxFreq * 1.02) {
      return { ok: false, freq: NaN, confidence: confidence, rms: rms, reason: "range" };
    }
    if (confidence < confMin) {
      return { ok: false, freq: NaN, confidence: confidence, rms: rms, reason: "low-confidence" };
    }

    return { ok: true, freq: freq, confidence: confidence, rms: rms, reason: null };
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /* ───────────────────── smoothing + stability ───────────────────── */

  /*
   * Rolling median filter over recent valid frequencies with a
   * cents-spread stability read-out. Robust against single-frame
   * outliers while still following real note changes within a few frames.
   */
  function Smoother(windowLen) {
    this.windowLen = windowLen || FPA.DEFAULTS.note.medianWindow;
    this.buffer = [];
  }
  Smoother.prototype.push = function (freq) {
    if (!Number.isFinite(freq) || freq <= 0) return null;
    this.buffer.push(freq);
    if (this.buffer.length > this.windowLen) this.buffer.shift();
    return this.value();
  };
  Smoother.prototype.clear = function () { this.buffer = []; };
  Smoother.prototype.value = function () {
    if (!this.buffer.length) return null;
    var sorted = this.buffer.slice().sort(function (a, b) { return a - b; });
    var n = sorted.length;
    var med = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    /* Stability: cents span of the window relative to the median. */
    var lo = sorted[0], hi = sorted[n - 1];
    var spreadCents = 1200 * Math.log2(hi / lo);
    return { freq: med, spreadCents: spreadCents, count: n };
  };

  FPA.Pitch = {
    detectFrame: detectFrame,
    Smoother: Smoother
  };
})(typeof window !== "undefined" ? window : globalThis);
