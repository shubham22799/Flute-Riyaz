/* ═══════════════════════════════════════════════════════════════════
   tests/suite.js — runtime-agnostic test suite.

   Used by:
     • tests/run.js      (Node:  node tests/run.js)
     • tests/index.html  (browser: open in a tab, results in the DOM)

   Covers the pure logic that must not regress:
     • YIN f0 accuracy, octave-error resistance, gate & range rejection
     • Western pitch math (MIDI / reference / cents)
     • Sargam mapping table, octave registers, boundary ambiguity
     • Note-event lifecycle: onset, grace, splitting, stale gap, finalize
     • Session statistics (denominators, distribution, per-swara shares)
     • Sa discovery buckets, qualification, manual pick, confirmation
     • Settings merge/clamp + sensitivity mapping
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  function runSuite(FPA) {
    var passed = 0, failed = 0;
    var failures = [];
    var lines = [];

    function log(s) { lines.push(s); }
    function section(t) { log("\n" + t); }
    function test(name, fn) {
      try {
        fn();
        passed++;
        log("  \u2713 " + name);
      } catch (err) {
        failed++;
        failures.push({ name: name, message: err && err.message ? err.message : String(err) });
        log("  \u2717 " + name + "\n      " + (err && err.message ? err.message : err));
      }
    }
    function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
    function assertClose(actual, expected, tol, msg) {
      if (!(Math.abs(actual - expected) <= tol)) {
        throw new Error((msg || "assertClose") + " \u2192 got " + actual + ", expected " + expected + " \u00B1" + tol);
      }
    }
    function centsBetween(a, b) { return 1200 * Math.log2(a / b); }

    /* ── signal generators ── */
    var FS = 48000;
    function sine(freq, amp, n, phase) {
      var b = new Float32Array(n);
      for (var i = 0; i < n; i++) b[i] = amp * Math.sin(2 * Math.PI * freq * i / FS + (phase || 0));
      return b;
    }
    function add(a, b) { var o = new Float32Array(a.length); for (var i = 0; i < a.length; i++) o[i] = a[i] + b[i]; return o; }
    function noise(amp, n) { var b = new Float32Array(n); for (var i = 0; i < n; i++) b[i] = amp * (Math.random() * 2 - 1); return b; }
    function frame(freq, amp, n, harmonics) {
      var sig = sine(freq, amp || 0.25, n, Math.random() * 6.28);
      if (harmonics) harmonics.forEach(function (h) { sig = add(sig, sine(freq * h[0], h[1], n, Math.random() * 6.28)); });
      return add(sig, noise(0.002, n));
    }
    function detect(freq, opts, harmonics) {
      return FPA.Pitch.detectFrame(frame(freq, opts && opts.amp, 4096, harmonics), FS, Object.assign({
        minFreq: 120, maxFreq: 1100, yinThreshold: 0.15, confidenceMin: 0.78, minRms: 0.005,
        noiseFloorRatio: 2.6, noiseFloorEma: 0.04, octaveHalfTolerance: 1.25,
        _noiseFloor: 0.003, _noiseFloorHolder: { value: 0 }
      }, opts || {}));
    }

    /* ══════════════════ 1 · pitch detection ══════════════════ */
    section("Pitch detection (YIN)");

    test("detects A4 440 Hz within \u00B110 cents", function () {
      var r = detect(440);
      assert(r.ok, "expected ok, got reason=" + r.reason);
      assertClose(centsBetween(r.freq, 440), 0, 10, "440 Hz");
    });

    test("detects low register \u2248130 Hz within \u00B120 cents", function () {
      var r = detect(130, { minFreq: 120 });
      assert(r.ok, "expected ok, reason=" + r.reason);
      assertClose(centsBetween(r.freq, 130), 0, 20, "130 Hz");
    });

    test("detects mid notes (D4 293.66, E5 659.26) accurately", function () {
      [293.66, 659.26].forEach(function (f) {
        var r = detect(f);
        assert(r.ok, f + " not detected (" + r.reason + ")");
        assertClose(centsBetween(r.freq, f), 0, 12, f + " Hz");
      });
    });

    test("harmonic-rich tone returns the fundamental, not the 2nd harmonic", function () {
      var r = detect(200, {}, [[2, 0.4], [3, 0.25]]);
      assert(r.ok, "expected ok, reason=" + r.reason);
      assertClose(centsBetween(r.freq, 200), 0, 25, "should stay at 200 Hz");
    });

    test("pure 400 Hz with small 200 Hz leak stays at 400 Hz", function () {
      var r = detect(400, {}, [[0.5, 0.03]]);
      assert(r.ok, "expected ok, reason=" + r.reason);
      assertClose(centsBetween(r.freq, 400), 0, 20, "should be 400 Hz");
    });

    test("quiet noise is rejected by the noise gate", function () {
      var r = FPA.Pitch.detectFrame(noise(0.002, 4096), FS, {
        minFreq: 120, maxFreq: 1100, minRms: 0.014, noiseFloorRatio: 2.6,
        _noiseFloor: 0.002, _noiseFloorHolder: { value: 0 }
      });
      assert(!r.ok && r.reason === "quiet", "expected quiet rejection, got " + r.reason);
    });

    test("out-of-range pitch is rejected (no octave-down fallback)", function () {
      var r = detect(440, { maxFreq: 300 });
      assert(!r.ok, "expected rejection, got " + r.freq);
      assert(r.reason === "range" || r.reason === "no-periodicity" || r.reason === "low-confidence",
        "unexpected reason " + r.reason);
    });

    test("confidence is high for a clean tone and reflects periodicity", function () {
      var r = detect(440);
      assert(r.confidence > 0.9, "confidence too low: " + r.confidence);
    });

    test("smoother rejects single-frame outliers (median)", function () {
      var s = new FPA.Pitch.Smoother(5);
      [440, 441, 439, 880, 440.5].forEach(function (f) { s.push(f); });
      var v = s.value();
      assert(v.freq < 445 && v.freq > 438, "median filter leaked outlier: " + v.freq);
    });

    /* ══════════════════ 2 · Western pitch ══════════════════ */
    section("Western pitch identification");

    test("440 Hz \u2192 A4, 0 cents", function () {
      var d = FPA.Notes.describe(440);
      assert(d.label === "A4", "label " + d.label);
      assertClose(d.cents, 0, 0.5);
    });

    test("MIDI mapping matches equal temperament", function () {
      assert(FPA.Notes.nearestMidi(261.63) === 60, "C4 midi");
      assert(FPA.Notes.midiInfo(60).label === "C4", "C4 label");
      assert(FPA.Notes.midiInfo(69).label === "A4", "A4 label");
      assert(FPA.Notes.midiInfo(61).label === "C#4", "C#4 label");
      assert(FPA.Notes.nearestMidi(277.18) === 61, "C#4 midi from 277.18 Hz");
    });

    test("cents deviation is signed and correct", function () {
      var sharp = FPA.Notes.describe(440 * Math.pow(2, 20 / 1200));
      assertClose(sharp.cents, 20, 1, "sharp cents");
      var flat = FPA.Notes.describe(440 * Math.pow(2, -35 / 1200));
      assertClose(flat.cents, -35, 1, "flat cents");
    });

    test("configurable A4 reference shifts note identity", function () {
      var d = FPA.Notes.describe(440, 432);
      assertClose(d.cents, 1200 * Math.log2(440 / 432), 1, "A4=432 cents");
    });

    test("boundary proximity is reported for ambiguity checks", function () {
      var near = FPA.Notes.describe(440 * Math.pow(2, 47 / 1200));
      assert(near.boundaryCents < 8, "boundary distance should be < 8 cents");
    });

    test("manual Sa picker list spans the detector range as equal-tempered notes", function () {
      var list = FPA.Notes.midiRange(120, 1100, 440);
      assert(list.length > 12, "a chromatic list is expected, got " + list.length);
      assert(list[0].midi < list[list.length - 1].midi, "ascending order");
      var a4 = 440;
      list.forEach(function (n) {
        var f = FPA.Notes.midiToFreq(n.midi, a4);
        assert(f >= 120 && f <= 1100, n.label + " (" + f.toFixed(1) + " Hz) inside range");
        assert(/^[A-G]#?\d+$/.test(n.label), "playable label expected, got " + n.label);
      });
      assert(list[0].label === "B2" && list[list.length - 1].label === "C6",
        "range endpoints, got " + list[0].label + "\u2026" + list[list.length - 1].label);
    });

    test("manual Sa picker list follows the A4 reference and rejects bad ranges", function () {
      assert(FPA.Notes.midiRange(430, 445, 440).length === 1, "single A4 at 440 Hz");
      assert(FPA.Notes.midiRange(430, 445, 440)[0].label === "A4", "A4 at 440 Hz");
      assert(FPA.Notes.midiRange(430, 445, 432)[0].label === "A4", "A4 stays A4 when A4 reference = 432");
      assert(FPA.Notes.midiRange(NaN, 500, 440).length === 0, "NaN input yields no list");
      assert(FPA.Notes.midiRange(500, 400, 440).length === 0, "inverted range yields no list");
    });

    /* ══════════════════ 3 · Sargam ══════════════════ */
    section("Sargam mapping");

    test("semitone table maps all twelve positions from Sa (D4 = 64)", function () {
      var expected = ["Sa", "komal Re", "Re", "komal Ga", "Ga", "Ma",
        "tivra Ma", "Pa", "komal Dha", "Dha", "komal Ni", "Ni"];
      var expectedShort = ["Sa", "kRe", "Re", "kGa", "Ga", "Ma", "tMa", "Pa", "kDha", "Dha", "kNi", "Ni"];
      for (var s = 0; s < 12; s++) {
        var m = FPA.Sargam.fromMidi(64 + s, 64, 0);
        assert(m.label === expected[s], "semitone " + s + " \u2192 " + m.label + ", expected " + expected[s]);
        assert(m.short === expectedShort[s], "semitone " + s + " short \u2192 " + m.short);
        var full = expected[s].indexOf(" ") >= 0 ? expected[s] : "shuddha " + expected[s];
        assert(m.fullLabel === full, "fullLabel at " + s + " \u2192 " + m.fullLabel + ", expected " + full);
        assert(m.octave === 0 && m.register === "madhya", "octave/register at " + s);
      }
    });

    test("octave displacement: below Sa \u2192 mandra, above \u2192 taar", function () {
      var lower = FPA.Sargam.fromMidi(64 - 2, 64, 0);
      assert(lower.octave === -1 && lower.register === "mandra", "lower octave");
      assert(lower.short === "kNi", "lower short " + lower.short);
      assert(lower.compact === "'kNi", "lower compact " + lower.compact);

      var upper = FPA.Sargam.fromMidi(64 + 12, 64, 0);
      assert(upper.octave === 1 && upper.register === "taar", "upper octave");
      assert(upper.swara === "Sa" && upper.compact === "Sa'", "upper compact " + upper.compact);

      var twoBelow = FPA.Sargam.fromMidi(64 - 13, 64, 0);
      assert(twoBelow.octave === -2 && twoBelow.compact === "''Ni", "double-mandra compact " + twoBelow.compact);
    });

    test("arbitrary intervals resolve including tivra Ma and Pa", function () {
      assert(FPA.Sargam.fromMidi(70, 64, 0).short === "tMa", "tivra Ma");
      assert(FPA.Sargam.fromMidi(71, 64, 0).short === "Pa", "Pa");
      assert(FPA.Sargam.fromMidi(76, 71, 0).short === "Ma", "arithmetic from Pa-root");
    });

    test("near-boundary pitch is flagged ambiguous, not confidently mapped", function () {
      var amb = FPA.Sargam.fromMidi(66, 64, 46);
      assert(amb.ambiguous === true, "expected ambiguity flag");
      var solid = FPA.Sargam.fromMidi(66, 64, 3);
      assert(solid.ambiguous === false, "in-tune note must not be flagged");
    });

    test("no Sa \u21D2 mapping returns null (sargam genuinely pending)", function () {
      assert(FPA.Sargam.fromMidi(66, NaN, 0) === null, "should be null without Sa");
    });

    /* ══════════════════ 4 · timeline swara axis ══════════════════ */
    section("Timeline swara axis");

    test("lane index counts semitones up from Sa", function () {
      assert(FPA.Timeline.laneOf(64, 64) === 0, "Sa sits on the top row");
      assert(FPA.Timeline.laneOf(66, 64) === 2, "Re is two semitones above Sa");
      assert(FPA.Timeline.laneOf(70, 64) === 6, "tivra Ma position");
      assert(FPA.Timeline.laneOf(71, 64) === 7, "Pa position");
      assert(FPA.Timeline.laneOf(75, 64) === 11, "Ni position");
    });

    test("registers fold onto the same swara row", function () {
      assert(FPA.Timeline.laneOf(76, 64) === 0, "taar Sa shares the Sa row");
      assert(FPA.Timeline.laneOf(52, 64) === 0, "mandra Sa shares the Sa row");
      assert(FPA.Timeline.laneOf(63, 64) === 11, "komal Ni just below Sa is row 11");
    });

    test("lane mapping is safe when Sa is unknown or input is bad", function () {
      assert(FPA.Timeline.laneOf(62, null) === 2, "without Sa, rows are pitch classes from C");
      assert(FPA.Timeline.laneOf(NaN, 64) === null, "NaN midi yields no row");
      assert(FPA.Timeline.laneOf(64, undefined) === 4, "missing Sa falls back to C");
    });

    test("axis labels are sargam once Sa is known, note names otherwise", function () {
      var sargam = FPA.Timeline.axisLabels(64);
      assert(sargam.length === 12, "twelve rows");
      assert(sargam[0] === "Sa", "top row = Sa");
      assert(sargam[3] === "kGa", "row 3 = komal Ga");
      assert(sargam[6] === "tMa", "row 6 = tivra Ma");
      var plain = FPA.Timeline.axisLabels(null);
      assert(plain.length === 12 && plain[0] === "C" && plain[6] === "F#", "note names before Sa");
    });

    /* ══════════════════ 5 · note-event tracker ══════════════════ */
    section("Note-event lifecycle & durations");

    function mkTracker(override) {
      var settings = Object.assign({}, FPA.DEFAULTS.note, override || {});
      var events = [];
      var t = new FPA.NoteTracker({
        note: settings,
        onEvent: function (e) { events.push(e); },
        onActive: function () {}
      });
      return { t: t, events: events, settings: settings };
    }
    function vf(t, midi, cents, conf) {
      midi = midi == null ? 64 : midi;
      var freq = FPA.Notes.midiToFreq(midi) * Math.pow(2, (cents || 0) / 1200);
      return { t: t, valid: true, freq: freq, midi: midi, cents: cents || 0,
        noteLabel: FPA.Notes.midiInfo(midi).label, confidence: conf || 0.95, rms: 0.05, spreadCents: 4 };
    }
    function sf(t) { return { t: t, valid: false, freq: NaN, confidence: 0, rms: 0.002 }; }

    test("onset requires sustained evidence; start timestamp is the true onset", function () {
      var k = mkTracker();
      k.t.ingest(vf(0));
      assert(k.t.active === null, "must not start on the first frame");
      k.t.ingest(vf(60));
      k.t.ingest(vf(100));
      assert(k.t.active === null, "must not start before onsetMs");
      k.t.ingest(vf(120));
      assert(k.t.active !== null, "should be active after onsetMs");
      assert(k.t.active.startT === 0, "onset should be first matching frame (0), got " + k.t.active.startT);
      assert(k.events.length === 0, "event not finalized while sustaining");
    });

    test("sustain duration derives from timestamps, closes at last reliable frame", function () {
      var k = mkTracker();
      for (var x = 0; x <= 1000; x += 20) k.t.ingest(vf(x));
      for (var y = 1020; y <= 1400; y += 20) k.t.ingest(sf(y));
      assert(k.events.length === 1, "one event expected, got " + k.events.length);
      var e = k.events[0];
      assert(e.durationMs === e.endT - e.startT, "duration must equal end\u2212start");
      assert(e.endT === 1000, "end should be last reliable frame (1000), got " + e.endT);
      assert(e.durationMs === 1000, "duration 1000 ms, got " + e.durationMs);
    });

    test("brief dropout inside the grace period does not split a note", function () {
      var k = mkTracker();
      for (var x = 0; x <= 500; x += 20) k.t.ingest(vf(x));
      for (var y = 520; y <= 700; y += 20) k.t.ingest(sf(y));   // 200 ms gap < 320 ms grace
      assert(k.events.length === 0, "note must not close during grace");
      for (var z = 720; z <= 1200; z += 20) k.t.ingest(vf(z));
      assert(k.t.active !== null && k.t.active.startT === 0, "original start preserved");
      k.t.finalize(1200);
      assert(k.events.length === 1, "still exactly one event, got " + k.events.length);
      assert(k.events[0].startT === 0 && k.events[0].endT === 1200, "span preserved through dropout");
    });

    test("a sustained pitch change splits at the last matching frame without overlap", function () {
      var k = mkTracker();
      for (var x = 0; x <= 600; x += 20) k.t.ingest(vf(x, 64));
      for (var y = 620; y <= 1200; y += 20) k.t.ingest(vf(y, 67));   // outlives the grace window
      assert(k.events.length === 1, "first event should close, got " + k.events.length);
      assert(k.events[0].midi === 64 && k.events[0].endT === 600, "old event ends at 600, got " + k.events[0].endT);
      assert(k.t.active !== null, "new note should be active");
      assert(k.t.active.midi === 67, "new midi");
      assert(k.t.active.startT >= k.events[0].endT,
        "no overlapping timestamps: " + k.t.active.startT + " vs " + k.events[0].endT);
      assert(k.t.active.startT === 620, "new note starts at the first non-matching frame, got " + k.t.active.startT);
      assert(k.t.active.freqs.length > 0, "the new event keeps the samples it was detected from");
    });

    test("wrong-pitch disturbance inside the grace period keeps ONE connected note", function () {
      var k = mkTracker();
      for (var x = 0; x <= 500; x += 20) k.t.ingest(vf(x, 64));
      /* A 200 ms excursion to the neighbouring semitone (wobble / harmonic
         slip). The grace period must absorb it: no ghost note, one note. */
      for (var b = 520; b <= 700; b += 20) k.t.ingest(vf(b, 65));
      for (var z = 720; z <= 1300; z += 20) k.t.ingest(vf(z, 64));
      k.t.finalize(1300);
      assert(k.events.length === 1, "disturbance must not create a second event, got " + k.events.length);
      var e = k.events[0];
      assert(e.midi === 64, "the surviving note is the original pitch");
      assert(e.startT === 0 && e.endT === 1300, "note stays connected across the disturbance");
      assert(k.t.active === null, "nothing left active after finalize");
    });

    test("a returning disturbance does not corrupt the note's pitch summary", function () {
      var k = mkTracker();
      for (var x = 0; x <= 500; x += 20) k.t.ingest(vf(x, 64));
      for (var b = 520; b <= 760; b += 20) k.t.ingest(vf(b, 71));    // octave-5 blip, 240 ms
      for (var z = 780; z <= 1300; z += 20) k.t.ingest(vf(z, 64));
      k.t.finalize(1300);
      assert(k.events.length === 1, "one event expected, got " + k.events.length);
      assertClose(centsBetween(k.events[0].medianFreq, FPA.Notes.midiToFreq(64)), 0, 5,
        "median must describe the real note, not the blip");
      assert(k.events[0].durationMs === 1300, "duration spans the whole connected note");
    });

    test("a fast passage keeps its middle note (no collapsing)", function () {
      var k = mkTracker();
      for (var a = 0; a <= 400; a += 20) k.t.ingest(vf(a, 64));      // D4
      for (var b = 420; b <= 660; b += 20) k.t.ingest(vf(b, 65));    // D#4, 240 ms
      for (var c = 680; c <= 1200; c += 20) k.t.ingest(vf(c, 67));   // G4
      k.t.finalize(1200);
      assert(k.events.length === 3, "three notes expected, got " + k.events.length);
      assert(k.events[0].midi === 64 && k.events[0].endT === 400, "first note closes at 400, got " + k.events[0].endT);
      assert(k.events[1].midi === 65, "middle note preserved (got midi " + k.events[1].midi + ")");
      assert(k.events[1].startT === 420, "middle note keeps its true onset, got " + k.events[1].startT);
      assert(k.events[1].endT === 660, "middle note ends at its last frame, got " + k.events[1].endT);
      assert(k.events[1].durationMs === 240, "middle note duration 240 ms, got " + k.events[1].durationMs);
      assert(k.events[2].midi === 67 && k.events[2].startT === 680, "third note starts at 680");
      assert(k.events[1].startT >= k.events[0].endT && k.events[2].startT >= k.events[1].endT, "no overlaps");
    });

    test("a blip shorter than the onset threshold is not recorded", function () {
      var k = mkTracker();
      for (var x = 0; x <= 600; x += 20) k.t.ingest(vf(x, 64));
      for (var b = 620; b <= 700; b += 20) k.t.ingest(vf(b, 65));    // 80 ms < onsetMs
      for (var y = 720; y <= 1400; y += 20) k.t.ingest(sf(y));       // silence
      k.t.finalize(1400);
      assert(k.events.length === 1, "only the real note is recorded, got " + k.events.length);
      assert(k.events[0].midi === 64 && k.events[0].endT === 600, "real note ends at 600");
    });

    test("a transient blip does not create a ghost note", function () {
      var k = mkTracker();
      for (var x = 0; x <= 600; x += 20) k.t.ingest(vf(x, 64));
      k.t.ingest(vf(620, 67));      // single-frame blip only
      k.t.ingest(vf(640, 64));
      k.t.ingest(vf(660, 64));
      k.t.finalize(700);
      assert(k.events.length === 1 && k.events[0].midi === 64, "blip must not split the sustained note");
      assert(k.events[0].endT === 660, "note continues to the last matching frame, got " + k.events[0].endT);
    });

    test("repeated identical notes separated by a long silence are two events", function () {
      var k = mkTracker();
      for (var x = 0; x <= 500; x += 20) k.t.ingest(vf(x));
      for (var y = 520; y <= 900; y += 20) k.t.ingest(sf(y));      // > grace
      for (var z = 920; z <= 1400; z += 20) k.t.ingest(vf(z));
      k.t.finalize(1400);
      assert(k.events.length === 2, "expected two events, got " + k.events.length);
      assert(k.events[0].durationMs === 500, "first duration 500, got " + k.events[0].durationMs);
      assert(k.events[1].startT >= 920, "second starts after the silence, got " + k.events[1].startT);
      assert(k.events[1].startT > k.events[0].endT, "no overlap between repeated notes");
    });

    test("stale gap (tab hidden / CPU stall) ends the note at the last reliable frame", function () {
      var k = mkTracker();
      for (var x = 0; x <= 500; x += 20) k.t.ingest(vf(x));
      k.t.ingest(vf(5000));                 // giant gap → must close, not stretch
      assert(k.events.length === 1, "stale gap must close the event");
      assert(k.events[0].endT === 500, "closed at last reliable frame, got " + k.events[0].endT);
      k.t.ingest(vf(5120));                 // a new note begins afterwards
      assert(k.t.active !== null && k.t.active.startT === 5000,
        "new note starts at the post-gap frame, got " + (k.t.active && k.t.active.startT));
    });

    test("stopping the session finalizes the active event without losing duration", function () {
      var k = mkTracker();
      for (var x = 0; x <= 800; x += 20) k.t.ingest(vf(x));
      k.t.finalize(850);
      assert(k.events.length === 1, "assert finalized");
      assert(k.events[0].endT === 800 && k.events[0].durationMs === 800, "duration preserved on stop");
      assert(k.t.active === null, "no active note after finalize");
      assert(k.t.finalize(900) === null, "finalize is safe/idempotent when idle");
    });

    test("unrelated silence is never counted as note duration", function () {
      var k = mkTracker();
      for (var x = 0; x <= 3000; x += 20) k.t.ingest(sf(x));
      k.t.finalize(3000);
      assert(k.events.length === 0, "silence must produce no events");
    });

    test("representative pitch and stability are summarised per event", function () {
      var k = mkTracker();
      var i = 0;
      for (var x = 0; x <= 900; x += 20) k.t.ingest(vf(x, 64, (i++ % 2) ? 12 : -12));
      k.t.finalize(900);
      assert(k.events.length === 1, "event expected");
      var e = k.events[0];
      assertClose(centsBetween(e.medianFreq, FPA.Notes.midiToFreq(64)), 0, 12, "median near D4");
      assert(e.confidence > 0.9, "confidence tracked");
      assert(e.spreadCents > 20, "vibrato spread tracked, got " + e.spreadCents);
      assert(e.stabilityCents === e.spreadCents, "stability exposed");
    });

    /* ══════════════════ 5 · statistics ══════════════════ */
    section("Session statistics");

    var sampleEvents = [
      { durationMs: 1000, swara: { label: "Sa", short: "Sa", kind: "shuddha" }, confidence: 0.9, stabilityCents: 4 },
      { durationMs: 2000, swara: { label: "Sa", short: "Sa", kind: "shuddha" }, confidence: 0.95, stabilityCents: 6 },
      { durationMs: 500, swara: { label: "shuddha Ga", short: "Ga", kind: "shuddha" }, confidence: 0.8, stabilityCents: 3 },
      { durationMs: 3000, swara: null, confidence: 0.85, stabilityCents: 0 }
    ];

    test("totals, longest, average and median are consistent", function () {
      var s = FPA.Stats.compute(sampleEvents, 60000);
      assert(s.eventCount === 4, "count");
      assert(s.totalNoteMs === 6500, "total note time, got " + s.totalNoteMs);
      assert(s.longestMs === 3000, "longest");
      assertClose(s.avgMs, 1625, 0.01, "average");
      assertClose(s.medianMs, 1500, 0.01, "median");
      assert(s.sessionMs === 60000, "practice time kept separate from note time");
    });

    test("per-swara share uses detected note time as the denominator", function () {
      var s = FPA.Stats.compute(sampleEvents, 60000);
      var saRow = s.perSwara.filter(function (x) { return x.label === "Sa"; })[0];
      assert(saRow.count === 2 && saRow.ms === 3000, "Sa totals");
      assertClose(saRow.pct, 3000 / 6500 * 100, 0.01, "Sa share is of note time, not wall clock");
      var gaRow = s.perSwara.filter(function (x) { return x.label === "shuddha Ga"; })[0];
      assertClose(gaRow.pct, 500 / 6500 * 100, 0.01, "Ga share");
    });

    test("unmapped notes (Sa unknown at record time) are counted separately", function () {
      var s = FPA.Stats.compute(sampleEvents, 60000);
      assert(s.unmappedCount === 1, "unmapped count");
    });

    test("per-swara rows expose the Western note name and the max sustain", function () {
      var events = [
        { durationMs: 1500, noteLabel: "D4", midi: 62, swara: { label: "Sa", short: "Sa", kind: "shuddha" } },
        { durationMs: 4200, noteLabel: "D4", midi: 62, swara: { label: "Sa", short: "Sa", kind: "shuddha" } },
        { durationMs: 800, noteLabel: "D5", midi: 74, swara: { label: "Sa", short: "Sa", kind: "shuddha" } },
        { durationMs: 900, noteLabel: "F#4", midi: 66, swara: { label: "tivra Ma", short: "tMa", kind: "tivra" } }
      ];
      var s = FPA.Stats.compute(events, 30000);
      var saRow = s.perSwara.filter(function (x) { return x.label === "Sa"; })[0];
      assert(saRow.west === "D", "Sa is D, got " + saRow.west);
      assert(saRow.maxMs === 4200, "max sustain 4200, got " + saRow.maxMs);
      assert(saRow.noteList.join(",") === "D4,D5", "octave labels sorted, got " + saRow.noteList.join(","));
      var maRow = s.perSwara.filter(function (x) { return x.label === "tivra Ma"; })[0];
      assert(maRow.west === "F#", "tivra Ma is F#, got " + maRow.west);
      assert(maRow.maxMs === 900, "single note max");
    });

    test("Western column falls back honestly when the event has no note data", function () {
      var s = FPA.Stats.compute([
        { durationMs: 600, swara: { label: "Sa", short: "Sa", kind: "shuddha" } },
        { durationMs: 400, midi: null, noteLabel: null, swara: { label: "Sa", short: "Sa", kind: "shuddha" } }
      ], 1000);
      var saRow = s.perSwara[0];
      assert(saRow.west === "", "no invented note name, got '" + saRow.west + "'");
      assert(saRow.noteList.length === 0, "no invented labels");
      assert(saRow.maxMs === 600, "max sustain still measured");
    });

    test("midi alone is enough to name the Western note", function () {
      var s = FPA.Stats.compute([
        { durationMs: 700, midi: 64, swara: { label: "Sa", short: "Sa", kind: "shuddha" } }
      ], 1000);
      assert(s.perSwara[0].west === "E", "MIDI 64 is E, got " + s.perSwara[0].west);
      assert(s.perSwara[0].noteList.join(",") === "E4", "label derived from midi, got " + s.perSwara[0].noteList.join(","));
    });

    test("per-swara rows follow the sargam pattern, not the time ranking", function () {
      /* Sa = D4. Ni gets by far the most time; the row order must still be
         the sung order Sa → kRe → … → Ni. */
      var saMidi = 62;
      function ev(midi, dur) {
        return { durationMs: dur, midi: midi, noteLabel: FPA.Notes.midiInfo(midi).label,
          swara: FPA.Sargam.fromMidi(midi, saMidi, 0) };
      }
      var s = FPA.Stats.compute([
        ev(73, 5000),   // Ni   (semitone 11) — longest
        ev(69, 2500),   // Pa   (7)
        ev(65, 1200),   // komal Ga (3)
        ev(62, 300)     // Sa   (0) — shortest
      ], 20000);
      var order = s.perSwara.map(function (x) { return x.label; });
      assert(order.join(" | ") === "Sa | komal Ga | Pa | Ni",
        "sargam order expected, got " + order.join(" | "));
      assert(s.perSwara[0].ms === 300 && s.perSwara[3].ms === 5000,
        "time ranking is deliberately NOT the sort key");
    });

    test("sargam ordering also works from short codes and never fails on junk", function () {
      /* Events without the semitone field (e.g. hand-built/legacy records)
         fall back to the sargam table by short code; unknown rows go last. */
      function row(short, label, kind, dur) {
        return { durationMs: dur, swara: { short: short, label: label, kind: kind } };
      }
      var s = FPA.Stats.compute([
        row("Ni", "Ni", "shuddha", 900),
        row("??", "mystery", "shuddha", 4000),
        row("Sa", "Sa", "shuddha", 100),
        row("tMa", "tivra Ma", "tivra", 2000),
        row("kRe", "komal Re", "komal", 1500)
      ], 10000);
      var order = s.perSwara.map(function (x) { return x.short; });
      assert(order.join(",") === "Sa,kRe,tMa,Ni,??",
        "table order then unknown last, got " + order.join(","));
    });

    test("duration distribution buckets are correct", function () {
      var s = FPA.Stats.compute(sampleEvents, 60000);
      var byLabel = {};
      s.distribution.forEach(function (d) { byLabel[d.label] = d.count; });
      /* durations 3000, 2000, 1000, 500 ms land in four distinct buckets */
      assert(byLabel["<0.5s"] === 0, "<0.5s bucket");
      assert(byLabel["0.5\u20131"] === 1, "0.5-1 bucket (500 ms)");
      assert(byLabel["1\u20132"] === 1, "1-2 bucket (1000 ms)");
      assert(byLabel["2\u20133"] === 1, "2-3 bucket (2000 ms)");
      assert(byLabel["3\u20135"] === 1, "3-5 bucket (3000 ms)");
      assert(byLabel["5s+"] === 0, "5s+ bucket");
    });

    test("empty session stats are all zero and safe", function () {
      var s = FPA.Stats.compute([], 0);
      assert(s.eventCount === 0 && s.totalNoteMs === 0 && s.avgMs === 0 && s.perSwara.length === 0, "empty stats");
    });

    /* ══════════════════ 6 · Sa discovery ══════════════════ */
    section("Sa discovery & confirmation");

    test("a single stable sustained note qualifies as a candidate", function () {
      var d = new FPA.SaDiscovery(FPA.DEFAULTS.sa);
      d.addEvent({ midi: 62, freq: 293.66, spreadCents: 12, durationMs: 1500, endT: 1500 });
      var c = d.candidate();
      assert(c !== null, "candidate expected");
      assert(c.noteLabel === "D4", "label " + c.noteLabel);
      assert(c.qualifies === true, "should qualify");
    });

    test("short unstable blips do not qualify", function () {
      var d = new FPA.SaDiscovery(FPA.DEFAULTS.sa);
      d.addEvent({ midi: 62, freq: 293.66, spreadCents: 120, durationMs: 300, endT: 300 });
      assert(d.candidate() === null, "unstable short note must not be proposed");
    });

    test("repeated detections aggregate and the most-played pitch wins", function () {
      var d = new FPA.SaDiscovery(FPA.DEFAULTS.sa);
      d.addEvent({ midi: 62, freq: 293.7, spreadCents: 8, durationMs: 500, endT: 500 });
      d.addEvent({ midi: 62, freq: 293.6, spreadCents: 6, durationMs: 900, endT: 1500 });
      d.addEvent({ midi: 65, freq: 349.2, spreadCents: 20, durationMs: 400, endT: 2000 });
      var c = d.candidate();
      assert(c.midi === 62, "expected D4 bucket to win, got " + c.noteLabel);
      assert(c.count === 2, "count " + c.count);
      assertClose(c.freq, 293.65, 0.2, "median representative");
    });

    test("manual pick from recent detections becomes the candidate", function () {
      var d = new FPA.SaDiscovery(FPA.DEFAULTS.sa);
      d.addEvent({ midi: 65, freq: 349.23, spreadCents: 30, durationMs: 400, endT: 400 });
      assert(d.candidate() === null, "not enough evidence alone");
      d.select(65);
      var c = d.candidate();
      assert(c !== null && c.manual === true, "manual candidate expected");
    });

    test("confirmation records midi, reference frequency, method and detector", function () {
      var d = new FPA.SaDiscovery(FPA.DEFAULTS.sa);
      var conf = d.confirm(62, 293.66, "candidate");
      assert(conf.midi === 62 && conf.noteLabel === "D4", "confirmed identity");
      assert(conf.method === "candidate" && conf.detector, "provenance recorded");
      assert(d.isConfirmed() === true, "isConfirmed");
    });

    test("restore keeps provenance as 'restored' and clear() works", function () {
      var d = new FPA.SaDiscovery(FPA.DEFAULTS.sa);
      d.restore({ midi: 60, freq: 261.63 });
      assert(d.confirmed.method === "restored", "restored method");
      assert(d.confirmed.noteLabel === "C4", "restored label");
      d.clear();
      assert(d.isConfirmed() === false, "cleared");
    });

    test("manual picker confirmation needs no evidence and records provenance", function () {
      var d = new FPA.SaDiscovery(FPA.DEFAULTS.sa);
      assert(d.candidate() === null, "nothing proposed before a pick");
      var conf = d.confirmFromPicker(67);           // G4
      assert(conf !== null, "picker confirmation should succeed");
      assert(conf.midi === 67 && conf.noteLabel === "G4", "label " + conf.noteLabel);
      assert(conf.method === "picked", "provenance method, got " + conf.method);
      assertClose(conf.freq, 391.995, 0.01, "equal-tempered reference frequency");
      assert(d.isConfirmed() === true, "isConfirmed");
    });

    test("manual picker honours the A4 reference and rejects junk input", function () {
      var d = new FPA.SaDiscovery(FPA.DEFAULTS.sa);
      d.setA4(432);
      assertClose(d.confirmFromPicker(69).freq, 432, 0.001, "A4 under a 432 Hz reference");
      assert(d.confirmFromPicker(NaN) === null, "NaN rejected");
      assert(d.confirmFromPicker(undefined) === null, "undefined rejected");
    });

    /* ══════════════════ 7 · simulation generator ══════════════════ */
    section("Simulation generator");

    test("phrases keep recurring over time (no one-shot silence bug)", function () {
      var sim = new FPA.Simulation();
      var frames = [];
      sim.onFrame = function (f) { frames.push(f); };
      var t = 1000;
      for (var i = 0; i < 600; i++) { t += 33; sim.step(t); }   // ~20 s

      var valid = frames.filter(function (f) { return f.valid; });
      var distinct = {};
      valid.forEach(function (f) { distinct[Math.round(f.freq)] = 1; });
      var gaps = frames.filter(function (f) { return !f.valid; }).length;
      var lastValidIdx = -1;
      frames.forEach(function (f, i) { if (f.valid) lastValidIdx = i; });

      assert(valid.length > 200, "expected many sounding frames, got " + valid.length);
      assert(Object.keys(distinct).length >= 2, "expected several distinct notes, got " + Object.keys(distinct).length);
      assert(gaps > 0, "expected silence gaps between phrases");
      assert(lastValidIdx > frames.length * 0.7, "notes must keep resuming (last sounding frame " + lastValidIdx + "/" + frames.length + ")");
    });

    test("every simulated frame is tagged source='simulation' and stays in range", function () {
      var sim = new FPA.Simulation();
      var frames = [];
      sim.onFrame = function (f) { frames.push(f); };
      var t = 0;
      for (var i = 0; i < 300; i++) { t += 33; sim.step(t); }
      assert(frames.length === 300, "one frame per step");
      assert(frames.every(function (f) { return f.source === "simulation"; }), "all frames tagged simulation");
      var lo = FPA.Notes.midiToFreq(FPA.Simulation.SA_MIDI);
      var hi = FPA.Notes.midiToFreq(FPA.Simulation.SA_MIDI + 11);
      frames.filter(function (f) { return f.valid; }).forEach(function (f) {
        assert(f.freq >= lo * 0.9 && f.freq <= hi * 1.1, "sim frequency out of expected range: " + f.freq);
      });
    });

    /* ══════════════════ 8 · export formats ══════════════════ */
    section("Export formats");

    var sampleSession = function () {
      return {
        id: "ses_test_1",
        startedAt: Date.parse("2026-01-02T03:04:05Z"),
        endedAt: Date.parse("2026-01-02T03:05:05Z"),
        durationMs: 60000,
        audioMode: "live",
        sa: { midi: 64, freq: 329.63, noteLabel: "E4" },
        events: [
          { startT: 0, endT: 1500, durationMs: 1500, noteLabel: "E4", freq: 329.63, cents: 1.2,
            swara: FPA.Sargam.fromMidi(64, 64, 1), confidence: 0.95, stabilityCents: 8, source: "live" },
          { startT: 2000, endT: 2400, durationMs: 400, noteLabel: "G4", freq: 392.0, cents: -2,
            swara: FPA.Sargam.fromMidi(67, 64, -2), confidence: 0.9, stabilityCents: 6, source: "live" },
          { startT: 2600, endT: 2800, durationMs: 200, noteLabel: "", freq: NaN, cents: NaN,
            swara: null, confidence: 0.7, stabilityCents: 0, source: "live" }
        ]
      };
    };

    test("CSV export includes the Sa reference, a header row and one row per event", function () {
      var H = FPA.History;
      var captured = [];
      var real = H.download;
      H.download = function (filename, mime, text) { captured.push({ filename: filename, mime: mime, text: text }); };
      try {
        H.exportSessionCSV(sampleSession());
        assert(captured.length === 1, "exactly one download");
        assert(/\.csv$/.test(captured[0].filename), "csv filename, got " + captured[0].filename);
        var csv = captured[0].text;
        assert(csv.indexOf("fpa-session-events/v1") >= 0, "format marker present");
        assert(csv.indexOf("E4 @ 329.63 Hz") >= 0, "Sa reference recorded in the file");
        assert(csv.indexOf("western_note") >= 0, "column header present");
        var lines = csv.split("\n");
        assert(lines.length === 11, "9 metadata/header lines + 3 event rows, got " + lines.length);
        assert(csv.indexOf(",E4,") >= 0, "event note present");
        assert(/komal Ga/.test(csv), "sargam label present in row");
      } finally { H.download = real; }
    });

    test("JSON export is labelled and preserves audioMode (no false 'live' claim)", function () {
      var H = FPA.History;
      var captured = [];
      var real = H.download;
      H.download = function (filename, mime, text) { captured.push({ filename: filename, text: text }); };
      try {
        var s = sampleSession();
        s.audioMode = "simulation";
        H.exportSessionJSON(s);
        var doc = JSON.parse(captured[0].text);
        assert(doc.exportFormat === "fpa-session/v1", "session format marker");
        assert(doc.session.audioMode === "simulation", "audioMode preserved");
        assert(/simulation/i.test(doc.note), "honesty note explains the labelling");
        assert(Array.isArray(doc.session.events) && doc.session.events.length === 3, "events exported");
      } finally { H.download = real; }
    });

    test("CSV export never writes NaN for missing numbers", function () {
      var H = FPA.History;
      var captured = [];
      var real = H.download;
      H.download = function (filename, mime, text) { captured.push(text); };
      try {
        H.exportSessionCSV(sampleSession());
        assert(captured[0].indexOf("NaN") < 0, "no NaN in the CSV output");
      } finally { H.download = real; }
    });

    /* ══════════════════ 9 · hostile / missing values ══════════════════ */
    section("Null & missing-value safety");

    test("null/undefined numbers never produce bogus notes or crash", function () {
      assert(FPA.Notes.describe(null) === null, "null frequency must be rejected, not turned into a note");
      assert(FPA.Notes.describe(undefined) === null, "undefined frequency must be rejected");
      assert(FPA.Notes.describe(NaN) === null, "NaN frequency must be rejected");
      assert(FPA.Notes.formatSeconds(null) === FPA.Notes.formatSeconds(0), "null seconds render safely");
    });

    test("stats tolerate null fields without inflating totals", function () {
      var s = FPA.Stats.compute([{ durationMs: null, confidence: null, stabilityCents: null, swara: null }], 1000);
      assert(s.eventCount === 1, "count");
      assert(s.totalNoteMs === 0, "null duration contributes 0, got " + s.totalNoteMs);
      assert(s.unmappedCount === 1, "unmapped counted");
    });

    /* ══════════════════ 11 · DOM / visual contract (browser only) ══════════════════ */
    /*
     * Regression guard for a bug that property checks cannot see:
     * `.modal { display: flex }` overrode the browser's `[hidden]{display:none}`,
     * so dialogs were painted on page load and could not be closed — while
     * `modal.hidden === true` still read back as "correct". Only computed style
     * reveals it.
     */
    if (typeof document !== "undefined" && document.body && typeof getComputedStyle === "function") {
      section("DOM / visual contract (browser only)");

      test("the app stylesheet is actually loaded on this page", function () {
        var hrefs = Array.prototype.map.call(document.styleSheets, function (ss) {
          return ss.href || "";
        }).join(" ");
        assert(/styles\.css/.test(hrefs),
          "app stylesheet must be linked, otherwise the visual checks below are meaningless");
      });

      test("a hidden element computes to display:none even when its class sets display", function () {
        var probe = document.createElement("div");
        probe.className = "modal";       // the exact class that used to break `hidden`
        probe.hidden = true;
        document.body.appendChild(probe);
        var display = getComputedStyle(probe).display;
        document.body.removeChild(probe);
        assert(display === "none", "hidden must beat class display, got '" + display + "'");
      });

      test("a hidden dialog is not painted until it is opened", function () {
        var modal = document.getElementById("sessionModal");
        if (!modal) return;              // harness page without app markup
        assert(modal.hidden === true, "session dialog must start hidden");
        assert(getComputedStyle(modal).display === "none", "hidden session dialog must not be painted");
      });

      /*
       * The practice layout relies on folding the one-time setup panels down to
       * their header. Same bug class as the modal above: a class that reads back
       * correctly while the CSS still paints the content.
       */
      test("a folded panel really hides its own body (the class alone would not)", function () {
        var card = document.createElement("div");
        card.className = "card is-collapsed";
        card.innerHTML = '<div class="card-head"><h2>Probe</h2></div><div class="card-body">visible?</div>';
        document.body.appendChild(card);
        var body = card.querySelector(".card-body");
        var folded = getComputedStyle(body).display;
        card.classList.remove("is-collapsed");
        var open = getComputedStyle(body).display;
        document.body.removeChild(card);
        assert(folded === "none", "a folded card must not paint its body, got '" + folded + "'");
        assert(open !== "none", "an open card must show its body, got '" + open + "'");
      });

      test("the fold button toggles one panel and keeps aria-expanded honest", function () {
        if (!FPA.UI || !FPA.UI.initCollapsibles) return;   // ui.js not loaded here
        var card = document.createElement("div");
        card.className = "card";
        card.innerHTML = '<div class="card-head"><h2>My Sa (tonic)</h2>' +
          '<button data-collapse="1" type="button" aria-expanded="true">^</button></div>' +
          '<div class="card-body"><span>controls</span></div>';
        document.body.appendChild(card);
        FPA.UI.initCollapsibles(card);
        var btn = card.querySelector("[data-collapse]");
        btn.click();
        assert(card.classList.contains("is-collapsed"), "clicking folds the panel");
        assert(btn.getAttribute("aria-expanded") === "false", "aria-expanded follows the fold");
        assert(getComputedStyle(card.querySelector(".card-body")).display === "none",
          "folded body must not be painted");
        assert(/expand/i.test(btn.title), "the button then offers to expand, got '" + btn.title + "'");
        btn.click();
        assert(!card.classList.contains("is-collapsed"), "clicking again unfolds the panel");
        assert(btn.getAttribute("aria-expanded") === "true", "aria-expanded returns to true");
        document.body.removeChild(card);
      });
    }

    /* ══════════════════ 12 · settings ══════════════════ */
    section("Settings & sensitivity");

    test("saving detector settings preserves the remembered Sa preference", function () {
      if (!FPA.History.available) return;                 // no persistence in this runtime
      var before = FPA.History.loadSaPreference();
      FPA.History.saveSaPreference({ midi: 67, freq: 392, noteLabel: "G4" });
      FPA.History.saveSettings(FPA.cloneDefaults());
      var after = FPA.History.loadSaPreference();
      assert(after && after.midi === 67, "Sa preference must survive a settings save");
      FPA.History.saveSaPreference(before);
    });

    test("sensitivity slider round-trips through the RMS gate mapping", function () {
      [1, 25, 50, 75, 100].forEach(function (s) {
        var back = FPA.minRmsToSensitivity(FPA.sensitivityToMinRms(s));
        assert(Math.abs(back - s) <= 1, "round trip " + s + " \u2192 " + back);
      });
      assert(FPA.sensitivityToMinRms(100) < FPA.sensitivityToMinRms(1), "higher slider = lower gate (more sensitive)");
    });

    test("mergeSettings clamps out-of-range values and repairs inverted ranges", function () {
      var s = FPA.mergeSettings({
        a4: 999,
        detector: { minFreq: 800, maxFreq: 200, confidenceMin: 5, minRms: 9 },
        note: { onsetMs: 5, releaseGraceMs: 99999 },
        timeline: { windowSeconds: 9999 }
      });
      assert(s.a4 === 466, "a4 clamped, got " + s.a4);
      assert(s.detector.confidenceMin === 0.99, "confidence clamped");
      assert(s.detector.minRms <= 0.09, "minRms clamped");
      assert(s.note.onsetMs === 40, "onset clamped");
      assert(s.note.releaseGraceMs === 1500, "grace clamped");
      assert(s.timeline.windowSeconds === 120, "window clamped");
      assert(s.detector.minFreq < s.detector.maxFreq, "inverted range repaired");
    });

    test("malformed persisted settings fall back to defaults", function () {
      var s = FPA.mergeSettings({ detector: "nonsense", note: null, a4: "abc" });
      assert(s.detector.minFreq === FPA.DEFAULTS.detector.minFreq, "default minFreq");
      assert(s.a4 === FPA.DEFAULTS.a4, "default a4");
    });

    return { passed: passed, failed: failed, failures: failures, lines: lines, total: passed + failed };
  }

  global.FPA_TEST_SUITE = { run: runSuite };
})(typeof window !== "undefined" ? window : globalThis);
