/* ═══════════════════════════════════════════════════════════════════
   sa.js — root-note (Sa) discovery and confirmation workflow.

   Core principle: frequency alone cannot establish musical role.
   This module only *proposes* candidates; the player confirms.
   Candidates are grouped by nearest equal-tempered pitch and scored
   by repetition + stability. Nothing here is a hard-coded guarantee —
   if the signal is unreliable the app waits, invites the user to play
   again, or lets them pick from recent stable detections.
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";
  var FPA = (global.FPA = global.FPA || {});

  function median(arr) {
    if (!arr.length) return NaN;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  function SaDiscovery(settings) {
    this.settings = settings || FPA.DEFAULTS.sa;
    this.a4 = FPA.DEFAULTS.a4;
    this.buckets = {};        // midi -> { midi, freqs[], spreads[], durations[], count, lastSeen }
    this.confirmed = null;    // { midi, freq, noteLabel, method, confirmedAt, detector }
    this.selectedMidi = null; // manual pick from recent list (pre-confirmation)
    this.remember = !!this.settings.rememberDefault;
  }

  SaDiscovery.prototype.setA4 = function (a4) { if (Number.isFinite(a4)) this.a4 = a4; };

  /*
   * Feed a completed (or sustaining) note event.
   * Only stable, confident events should reach here — the tracker has
   * already applied onset stability, which is what makes a proposal
   * meaningful. Works while unconfirmed; harmless if already confirmed
   * (kept so a future recalibration can reuse the same stats).
   */
  SaDiscovery.prototype.addEvent = function (event) {
    if (!event || !Number.isFinite(event.midi) || !Number.isFinite(event.freq)) return;
    if (!Number.isFinite(event.spreadCents)) return;         // need stability evidence
    var b = this.buckets[event.midi];
    if (!b) {
      b = this.buckets[event.midi] = {
        midi: event.midi,
        freqs: [], spreads: [], durations: [],
        count: 0, lastSeen: 0
      };
    }
    b.count += 1;
    b.freqs.push(event.freq);
    b.spreads.push(event.spreadCents);
    b.durations.push(event.durationMs || 0);
    b.lastSeen = Math.max(b.lastSeen, event.endT || 0);
    /* Keep bucket lists bounded. */
    if (b.freqs.length > 12) { b.freqs.shift(); b.spreads.shift(); b.durations.shift(); }
  };

  /* Summarise one bucket for display / scoring. */
  SaDiscovery.prototype._summarize = function (b) {
    var medFreq = median(b.freqs);
    var info = FPA.Notes.describe(medFreq, this.a4);
    var spread = median(b.spreads);
    var totalMs = b.durations.reduce(function (a, x) { return a + x; }, 0);
    var qualifies;
    if (b.count >= (this.settings.minEvents || 2)) {
      qualifies = spread <= (this.settings.stabilityCentsMax || 45) * 1.6;
    } else {
      qualifies = totalMs >= (this.settings.minEventMs || 700) &&
                  spread <= (this.settings.stabilityCentsMax || 45);
    }
    return {
      midi: b.midi,
      freq: medFreq,
      noteLabel: info ? info.label : "?",
      count: b.count,
      spreadCents: spread,
      totalMs: totalMs,
      lastSeen: b.lastSeen,
      qualifies: qualifies
    };
  };

  /* All buckets, best first (qualifying, then by weighted score). */
  SaDiscovery.prototype.recent = function (limit) {
    var self = this;
    var list = Object.keys(this.buckets).map(function (k) { return self._summarize(self.buckets[k]); });
    list.sort(function (a, b) {
      if (a.qualifies !== b.qualifies) return a.qualifies ? -1 : 1;
      var scoreA = a.count * 1000 + a.totalMs / 10 + a.spreadCents * -2;
      var scoreB = b.count * 1000 + b.totalMs / 10 + b.spreadCents * -2;
      return scoreB - scoreA;
    });
    return limit ? list.slice(0, limit) : list;
  };

  /* The current best proposal, or null when nothing is trustworthy yet. */
  SaDiscovery.prototype.candidate = function () {
    var list = this.recent(1);
    if (list.length && list[0].qualifies) return list[0];
    /* A manually selected recent detection acts as an explicit candidate. */
    if (this.selectedMidi != null && this.buckets[this.selectedMidi]) {
      var s = this._summarize(this.buckets[this.selectedMidi]);
      s.manual = true;
      return s;
    }
    return null;
  };

  SaDiscovery.prototype.select = function (midi) {
    this.selectedMidi = Number.isFinite(midi) ? Number(midi) : null;
  };

  /*
   * Confirm a candidate as Sa. `method` records provenance:
   * 'candidate' (proposed + confirmed), 'manual' (picked from list),
   * 'restored' (loaded from a saved preference).
   */
  SaDiscovery.prototype.confirm = function (midi, freq, method) {
    var info = FPA.Notes.describe(freq, this.a4);
    var m = Number.isFinite(midi) ? Number(midi) : (info ? info.midi : NaN);
    if (!Number.isFinite(m)) return null;
    if (!Number.isFinite(freq) || freq <= 0) freq = FPA.Notes.midiToFreq(m, this.a4);
    this.confirmed = {
      midi: m,
      freq: freq,
      noteLabel: FPA.Notes.midiInfo(m).label,
      method: method || "candidate",
      confirmedAt: Date.now(),
      detector: FPA.DEFAULTS.detector.method,
      a4: this.a4
    };
    this.selectedMidi = null;
    return this.confirmed;
  };

  /*
   * Confirm a Sa chosen by hand from the note picker — no measured evidence is
   * required, because the player is explicitly declaring the tonic. The pitch is
   * the equal-tempered reference for that note class (an honest, stated choice),
   * not a claim about the flute's actual tuning.
   */
  SaDiscovery.prototype.confirmFromPicker = function (midi) {
    if (!Number.isFinite(midi)) return null;
    var m = Math.round(midi);
    return this.confirm(m, FPA.Notes.midiToFreq(m, this.a4), "picked");
  };

  /* Restore a stored Sa without re-proposing (used for saved preferences). */
  SaDiscovery.prototype.restore = function (saObj) {
    if (!saObj || !Number.isFinite(saObj.midi)) return null;
    return this.confirm(saObj.midi, saObj.freq, "restored");
  };

  /* Change/clear Sa — never touches stored history (kept elsewhere). */
  SaDiscovery.prototype.clear = function () {
    this.confirmed = null;
    this.selectedMidi = null;
  };

  SaDiscovery.prototype.isConfirmed = function () { return !!this.confirmed; };

  /* Test hook: forget all observed buckets (UI "keep listening" reset). */
  SaDiscovery.prototype.resetBuckets = function () {
    this.buckets = {};
    this.selectedMidi = null;
  };

  FPA.SaDiscovery = SaDiscovery;
})(typeof window !== "undefined" ? window : globalThis);
