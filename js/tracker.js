/* ═══════════════════════════════════════════════════════════════════
   tracker.js — note-event lifecycle and sustain-duration tracking.

   Lifecycle:  candidate → started → sustaining → ended → recorded

   Design rules (from the spec):
   • Durations derive from timestamps — never from animation frames.
   • Separate onset and offset logic prevents flicker-fragmentation.
   • A short release grace period bridges detection dropouts; the
     original event start is preserved when the pitch returns.
   • The SAME grace period absorbs wrong-pitch disturbances (wobble,
     harmonic/octave slip, breath noise read as another pitch): while a
     differing pitch is younger than the grace window the original note
     stays open, so if the original pitch comes back the disturbance
     disappears and ONE connected note is recorded — never a ghost note.
   • A differing pitch becomes a real note when
       – it outlives the grace window, or
       – a further differing pitch confirms it and it lasted ≥ onsetMs,
         (so fast passages still split at their true boundaries), or
       – its original note goes quiet (a real short note is not lost).
   • Durations of both notes stay exact: the original closes at its LAST
     RELIABLE frame, the new one starts at its true onset (back-dated).
   • A stale gap (tab hidden, CPU stall) larger than the grace period
     closes the active event before any new frame is processed.
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";
  var FPA = (global.FPA = global.FPA || {});

  var nextId = 1;

  /*
   * @param {Object} opts
   *   note      – lifecycle timings (merged over defaults)
   *   onEvent   – function(event) called when an event is finalized
   *   onActive  – function(active|Null) called when active state changes
   */
  function NoteTracker(opts) {
    opts = opts || {};
    this.settings = Object.assign({}, FPA.DEFAULTS.note, opts.note || {});
    this.onEvent = opts.onEvent || function () {};
    this.onActive = opts.onActive || function () {};

    this.state = "idle";           // idle | candidate | active
    this.active = null;            // current note event (unsaved)
    this.candidateMidi = null;
    this.candidateSinceT = 0;
    this.excursion = null;         // buffered differing pitch (possible disturbance)
    this.lastIngestT = -Infinity;
  }

  NoteTracker.prototype.reset = function () {
    this.state = "idle";
    this.active = null;
    this.candidateMidi = null;
    this.candidateSinceT = 0;
    this.excursion = null;
    this.lastIngestT = -Infinity;
  };

  /*
   * Process one analysis frame.
   * frame: { t, freq, midi, cents, noteLabel, confidence, valid, rms }
   * `t` is the monotonic session clock in ms (see app.js sessionClock).
   */
  NoteTracker.prototype.ingest = function (frame) {
    var S = this.settings;
    var t = frame.t;
    this.lastIngestT = t;

    /* ── Stale-gap rule: anything beyond the grace period ends the note ── */
    if (this.active && (t - this.active.lastValidT) > S.releaseGraceMs) {
      /* The active note is over. Resolve any disturbance we were watching:
         it was a real note only if it lasted at least the onset threshold. */
      this._close(t);
      this._settleExcursion();
      /* A promoted disturbance may itself be long gone. */
      if (this.active && (t - this.active.lastValidT) > S.releaseGraceMs) this._close(t);
    }
    if (this.state === "candidate" && (t - this.candidateSinceT) > (S.onsetMs + S.releaseGraceMs)) {
      this._clearCandidate();
    }

    /* ── Unusable frame: silence / noise / low confidence ── */
    if (!frame.valid) {
      /* Candidate dies quickly (it never had a start commitment). */
      if (this.state === "candidate") this._clearCandidate();
      return this.active;
    }

    /* ── Active note present ── */
    if (this.active) {
      /* Same pitch → extend the note and cancel any pending disturbance. */
      if (this._matchesActive(frame)) {
        this.excursion = null;
        this._extend(frame, t);
        return this.active;
      }

      var x = this.excursion;

      /* Same disturbance still present: keep watching it. */
      if (x && x.midi === frame.midi) {
        this._growExcursion(frame, t);
        if (t - x.sinceT >= this._changeWindowMs()) {
          /* It outlived the grace window → a genuine new note. */
          this._commitExcursion(t);
        }
        return this.active;
      }

      /* A further differing pitch arrived while a disturbance was pending:
         the pending one was a real note only if it lasted ≥ onsetMs. */
      if (x) {
        if (x.lastValidT - x.sinceT >= S.onsetMs) this._commitExcursion(t);
        else this.excursion = null;
      }
      this._beginExcursion(frame, t);
      return this.active;
    }

    /* ── No active note: accumulate a candidate ── */
    if (this.state !== "candidate" || this.candidateMidi !== frame.midi) {
      this._beginCandidate(frame.midi, t);
      return null;
    }
    if (t - this.candidateSinceT >= S.onsetMs) {
      this._promote(t);
    }
    return this.active;
  };

  /* How long a differing pitch must survive to count as a real new note.
     Equal to the release grace (with the classic hold as a floor), so the
     user-facing "release grace period" also controls flicker absorption. */
  NoteTracker.prototype._changeWindowMs = function () {
    var S = this.settings;
    return Math.max(S.pitchChangeHoldMs, S.releaseGraceMs);
  };

  /* Extend the active note with a matching frame. */
  NoteTracker.prototype._extend = function (frame, t) {
    var a = this.active;
    a.lastValidT = t;
    a.confSum += frame.confidence || 0;
    a.confN += 1;
    if (a.freqs.length < this.settings.freqSampleCap) {
      a.freqs.push(frame.freq);
      a.centsList.push(frame.cents);
    }
    this._updateRepresentative();
  };

  /* Begin watching a pitch that differs from the active note. Its frames are
     buffered so that, if it turns out to be a real note, the event carries
     the samples and onset it was actually detected from. */
  NoteTracker.prototype._beginExcursion = function (frame, t) {
    this.excursion = {
      midi: frame.midi,
      sinceT: t,
      lastValidT: t,
      freqs: [],
      centsList: [],
      confSum: 0,
      confN: 0
    };
    this._growExcursion(frame, t);
  };

  NoteTracker.prototype._growExcursion = function (frame, t) {
    var x = this.excursion;
    if (!x || frame.midi !== x.midi) return;
    x.lastValidT = t;
    x.confSum += frame.confidence || 0;
    x.confN += 1;
    if (x.freqs.length < this.settings.freqSampleCap) {
      x.freqs.push(frame.freq);
      x.centsList.push(frame.cents);
    }
  };

  /* Promote the buffered disturbance into the active note event. */
  NoteTracker.prototype._promoteExcursion = function () {
    var x = this.excursion;
    if (!x) return null;
    this._beginCandidate(x.midi, x.sinceT);
    this._promote(x.sinceT);
    var a = this.active;
    a.lastValidT = x.lastValidT;
    a.freqs = x.freqs;
    a.centsList = x.centsList;
    a.confSum = x.confSum;
    a.confN = x.confN;
    this._updateRepresentative();
    this.excursion = null;
    return a;
  };

  /* Close the active note at its last reliable frame and promote the pending
     disturbance into the new active note (back-dated to its true onset). */
  NoteTracker.prototype._commitExcursion = function (t) {
    if (!this.excursion) return null;
    var originalEnd = this.active ? this.active.lastValidT : null;
    var ended = this._close(t);
    if (ended && Number.isFinite(originalEnd)) ended.endT = Math.min(ended.endT, originalEnd);
    return this._promoteExcursion();
  };

  /* Resolve a pending disturbance when its original note is going away:
     keep it when it was long enough to stand as a note, drop it otherwise. */
  NoteTracker.prototype._settleExcursion = function () {
    var x = this.excursion;
    if (!x) return null;
    if (x.lastValidT - x.sinceT >= this.settings.onsetMs) return this._promoteExcursion();
    this.excursion = null;
    return null;
  };

  /* Does this frame belong to the active note (pitch class + tolerance)? */
  NoteTracker.prototype._matchesActive = function (frame) {
    if (frame.midi !== this.active.midi) return false;
    if (!Number.isFinite(frame.cents) || !Number.isFinite(this.active.centsRef)) return true;
    /* Vibrato-tolerant: within ±centsMatch of the event's running reference. */
    return Math.abs(frame.cents - this.active.centsRef) <= this.settings.centsMatch;
  };

  NoteTracker.prototype._beginCandidate = function (midi, t) {
    this.state = "candidate";
    this.candidateMidi = midi;
    this.candidateSinceT = t;
  };

  NoteTracker.prototype._clearCandidate = function () {
    if (this.state === "candidate") this.state = "idle";
    this.candidateMidi = null;
  };

  /* Promote the candidate to a real, started note event. */
  NoteTracker.prototype._promote = function (t) {
    var info = FPA.Notes.midiInfo(this.candidateMidi);
    this.active = {
      id: nextId++,
      source: "live",                       // app.js overrides for simulation
      startT: this.candidateSinceT,         // true onset ≈ first matching frame
      endT: null,
      lastValidT: this.candidateSinceT,
      midi: this.candidateMidi,
      noteLabel: info.label,
      freqs: [],
      centsList: [],
      freq: NaN, medianFreq: NaN, centsRef: 0,
      spreadCents: 0, stabilityCents: 0,
      confSum: 0, confN: 0, confidence: 0,
      durationMs: 0
    };
    this.state = "active";
    this.candidateMidi = null;
    this.onActive(this.active);
  };

  /* Running representative values. The representative frequency is a
     TRIMMED MEAN of the recent window (10 % trimmed from each end): robust
     against outlier frames while staying symmetric for vibrato, unlike a
     single median element. */
  NoteTracker.prototype._updateRepresentative = function () {
    var a = this.active;
    if (a.freqs.length) {
      var n = a.freqs.length;
      var take = Math.min(n, 41);
      var slice = a.freqs.slice(n - take).sort(function (x, y) { return x - y; });
      var trim = Math.floor(slice.length * 0.1);
      var core = slice.slice(trim, slice.length - trim);
      if (!core.length) core = slice;
      var sum = 0;
      for (var i = 0; i < core.length; i++) sum += core[i];
      var mean = sum / core.length;
      a.medianFreq = mean;
      a.freq = mean;
      var desc = FPA.Notes.describe(mean);
      if (desc) {
        a.centsRef = desc.cents;
        a.noteLabel = desc.label;      // self-corrects octave slips
      }
      var lo = slice[0], hi = slice[slice.length - 1];
      a.spreadCents = 1200 * Math.log2(hi / lo);
    }
    a.confidence = a.confN ? a.confSum / a.confN : 0;
  };

  /* Finalize the active event. `t` is used only as an upper bound. */
  NoteTracker.prototype._close = function (t) {
    var a = this.active;
    if (!a) return null;
    /* Offset rule: end at the last reliable note timestamp. */
    a.endT = Math.min(a.lastValidT, Number.isFinite(t) ? t : a.lastValidT);
    if (a.endT <= a.startT) a.endT = a.lastValidT = Math.max(a.lastValidT, a.startT + 1);
    a.durationMs = a.endT - a.startT;
    this._updateRepresentative();
    a.confidence = a.confN ? a.confSum / a.confN : 0;
    a.stabilityCents = a.spreadCents;

    this.active = null;
    this.state = "idle";
    this.candidateMidi = null;
    this.onActive(null);
    this.onEvent(a);
    return a;
  };

  /*
   * Session-level finalize (stop / pause / audio loss).
   * Closes any active event with the documented offset rule, and keeps a
   * pending disturbance only when it was long enough to stand as a note.
   */
  NoteTracker.prototype.finalize = function (t) {
    if (this.active) {
      var ended = this._close(Number.isFinite(t) ? t : this.active.lastValidT);
      this._settleExcursion();
      if (this.active) this._close(this.active.lastValidT);
      return ended;
    }
    this.excursion = null;
    this._clearCandidate();
    return null;
  };

  /* Duration to display for the active note right now. */
  NoteTracker.prototype.activeDurationMs = function (nowT) {
    if (!this.active) return 0;
    var end = Math.max(this.active.lastValidT, Math.min(nowT, this.active.lastValidT + this.settings.releaseGraceMs));
    return Math.max(0, end - this.active.startT);
  };

  FPA.NoteTracker = NoteTracker;
})(typeof window !== "undefined" ? window : globalThis);
