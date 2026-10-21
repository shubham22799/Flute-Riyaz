/* ═══════════════════════════════════════════════════════════════════
   stats.js — session statistics (pure functions over stored events).

   Definitions made explicit (the spec requires unambiguous denominators):
   • "note time"  = sum of note-event durations — silence between notes
                    is NOT counted, session wall-clock time is NOT the base.
   • swara share  = swara duration / total detected note time × 100.
   • per-swara row = { count, ms, maxMs (longest single note), west (Western
                    pitch-class name), noteList (octave labels for the tooltip),
                    pct }. `west` is "" when no event carried a usable note
                    name — the UI then shows "—" instead of inventing one.
   • perSwara rows are ordered by the SARGAM PATTERN (Sa → Ni, ascending
     semitones from Sa) so the table reads like the scale, not like a ranking.
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";
  var FPA = (global.FPA = global.FPA || {});

  var DIST_BUCKETS = [
    { label: "<0.5s", max: 500 },
    { label: "0.5–1", max: 1000 },
    { label: "1–2", max: 2000 },
    { label: "2–3", max: 3000 },
    { label: "3–5", max: 5000 },
    { label: "5s+", max: Infinity }
  ];

  var Stats = {
    DIST_BUCKETS: DIST_BUCKETS,

    compute: function (events, sessionMs) {
      events = events || [];
      var out = {
        eventCount: events.length,
        sessionMs: sessionMs || 0,
        totalNoteMs: 0,
        longestMs: 0,
        avgMs: 0,
        medianMs: 0,
        perSwara: [],
        distribution: DIST_BUCKETS.map(function (b) { return { label: b.label, count: 0 }; }),
        stabilityCount: 0,
        avgConfidence: 0,
        avgStabilityCents: 0,
        unmappedCount: 0
      };
      if (!events.length) return out;

      var durations = [];
      var confSum = 0, stabSum = 0, stabCount = 0;
      var swaraMap = {};

      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        var dur = Number.isFinite(e.durationMs) ? e.durationMs : 0;
        out.totalNoteMs += dur;
        durations.push(dur);
        if (dur > out.longestMs) out.longestMs = dur;

        for (var b = 0; b < DIST_BUCKETS.length; b++) {
          if (dur < DIST_BUCKETS[b].max) { out.distribution[b].count++; break; }
        }

        if (Number.isFinite(e.confidence) && e.confidence > 0) confSum += e.confidence;
        if (Number.isFinite(e.stabilityCents) && e.stabilityCents > 0) { stabSum += e.stabilityCents; stabCount++; }

        if (e.swara) {
          var key = e.swara.label;
          if (!swaraMap[key]) {
            swaraMap[key] = {
              key: key, label: e.swara.label, short: e.swara.short, kind: e.swara.kind,
              order: sargamOrder(e.swara),
              count: 0, ms: 0, maxMs: 0, pct: 0,
              pcCounts: {}, noteSeen: {}, noteEntries: []
            };
          }
          var grp = swaraMap[key];
          grp.count += 1;
          grp.ms += dur;
          if (dur > grp.maxMs) grp.maxMs = dur;
          addWestern(grp, e);
        } else {
          out.unmappedCount += 1;
        }
      }

      out.avgMs = out.totalNoteMs / events.length;
      out.medianMs = medianOf(durations);
      out.avgConfidence = confSum / events.length;
      out.stabilityCount = stabCount;
      out.avgStabilityCents = stabCount ? stabSum / stabCount : 0;

      out.perSwara = Object.keys(swaraMap).map(function (k) { return swaraMap[k]; });
      out.perSwara.forEach(function (s) {
        /* Share of DETECTED NOTE TIME — not session wall-clock. */
        s.pct = out.totalNoteMs > 0 ? (s.ms / out.totalNoteMs) * 100 : 0;
        /* Western identity: one pitch class per swara (Sa is fixed per
           session); the octave-specific labels go in the row tooltip. */
        s.west = dominantKey(s.pcCounts);
        s.noteList = s.noteEntries.slice().sort(function (a, b) {
          var am = Number.isFinite(a.midi) ? a.midi : Infinity;
          var bm = Number.isFinite(b.midi) ? b.midi : Infinity;
          if (am !== bm) return am - bm;
          return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
        }).map(function (n) { return n.label; });
        delete s.pcCounts;
        delete s.noteSeen;
        delete s.noteEntries;
      });
      /* Rows follow the SARGAM PATTERN (Sa → Ni, ascending semitones from Sa),
         matching the timeline axis, so the table reads like the scale rather
         than a ranking. Same-degree ties break by time; unknown rows go last. */
      out.perSwara.sort(function (a, b) {
        if (a.order !== b.order) return a.order - b.order;
        return b.ms - a.ms;
      });
      out.perSwara.forEach(function (s) { delete s.order; });

      return out;
    }
  };

  /*
   * Western note label(s) seen for one event. Prefers the event's own label
   * (e.g. "C#4"); falls back to the MIDI number. Returns null when the event
   * carries neither, so a row can honestly show "—" instead of a made-up name.
   */
  function westernOf(e) {
    var label = (typeof e.noteLabel === "string" && e.noteLabel) ? e.noteLabel : "";
    var midi = Number.isFinite(e.midi) ? e.midi : null;
    if (!label && midi === null) return null;
    if (!label) label = FPA.Notes.midiInfo(midi).label;
    return { label: label, midi: midi, pc: label.replace(/[-0-9]/g, "") };
  }

  /*
   * Position of a swara in the sargam pattern (0 = Sa … 11 = Ni), used to order
   * the per-swara rows the way the swaras are sung — not by how much time they
   * happened to get. Uses the event's own semitone offset when present and
   * falls back to the sargam table by short code; unknown rows sort last.
   */
  function sargamOrder(swara) {
    if (!swara) return 99;
    if (Number.isFinite(swara.semitones)) return swara.semitones;
    var table = FPA.Sargam && FPA.Sargam.TABLE;
    if (table && swara.short) {
      for (var i = 0; i < table.length; i++) {
        if (table[i].short === swara.short) return i;
      }
    }
    return 99;
  }

  function addWestern(grp, e) {
    var w = westernOf(e);
    if (!w) return;
    grp.pcCounts[w.pc] = (grp.pcCounts[w.pc] || 0) + 1;
    if (!grp.noteSeen[w.label]) {
      grp.noteSeen[w.label] = true;
      grp.noteEntries.push({ label: w.label, midi: w.midi });
    }
  }

  function dominantKey(map) {
    var best = "", bestN = 0;
    Object.keys(map).forEach(function (k) {
      if (map[k] > bestN) { bestN = map[k]; best = k; }
    });
    return best;
  }

  function medianOf(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  FPA.Stats = Stats;
})(typeof window !== "undefined" ? window : globalThis);
