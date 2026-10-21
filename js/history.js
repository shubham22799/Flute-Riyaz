/* ═══════════════════════════════════════════════════════════════════
   history.js — local persistence (localStorage) + export.

   Rules:
   • Storage failure must NEVER break live analysis → everything degrades
     gracefully and reports `available === false`.
   • Every stored session keeps the Sa reference that was active when the
     notes were recorded; changing the current Sa never rewrites history.
   • Exported data is clearly labelled with source + session metadata.
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";
  var FPA = (global.FPA = global.FPA || {});

  var storage = null;
  try {
    /* Probe availability (private mode / blocked cookies can throw). */
    var probe = "__fpa_probe__";
    global.localStorage.setItem(probe, "1");
    global.localStorage.removeItem(probe);
    storage = global.localStorage;
  } catch (e) {
    storage = null;
  }

  var History = {
    available: !!storage,
    lastError: null,

    _read: function (key) {
      if (!storage) return null;
      try {
        var raw = storage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        this.lastError = e;
        return null;
      }
    },
    _write: function (key, value) {
      if (!storage) return false;
      try {
        storage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        this.lastError = e;
        return false;
      }
    },

    /* ── settings ── */
    loadSettings: function () {
      var s = this._read(FPA.DEFAULTS.storage.settingsKey);
      return FPA.mergeSettings(s);
    },
    saveSettings: function (settings) {
      /* Saving detector settings must never silently forget the player's tonic,
         so preserve the Sa preference stored alongside them. */
      var existing = this._read(FPA.DEFAULTS.storage.settingsKey) || {};
      var merged = Object.assign({}, settings);
      if (existing.saPreference && !("saPreference" in merged)) merged.saPreference = existing.saPreference;
      return this._write(FPA.DEFAULTS.storage.settingsKey, merged);
    },

    /* ── saved Sa preference ── */
    loadSaPreference: function () {
      var s = this._read(FPA.DEFAULTS.storage.settingsKey);
      return (s && s.saPreference && Number.isFinite(s.saPreference.midi)) ? s.saPreference : null;
    },
    saveSaPreference: function (saObj) {
      var s = this._read(FPA.DEFAULTS.storage.settingsKey) || {};
      s.saPreference = saObj ? { midi: saObj.midi, freq: saObj.freq, noteLabel: saObj.noteLabel, savedAt: Date.now() } : null;
      return this._write(FPA.DEFAULTS.storage.settingsKey, s);
    },

    /* ── sessions ── */
    list: function () {
      var data = this._read(FPA.DEFAULTS.storage.historyKey);
      if (!data || !Array.isArray(data.sessions)) return [];
      return data.sessions.slice().sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); });
    },

    get: function (id) {
      return this.list().find(function (s) { return s.id === id; }) || null;
    },

    save: function (session) {
      if (!storage || !session) return false;
      var data = this._read(FPA.DEFAULTS.storage.historyKey) || { sessions: [] };
      if (!Array.isArray(data.sessions)) data.sessions = [];
      /* Replace with same id if re-saved. */
      data.sessions = data.sessions.filter(function (s) { return s.id !== session.id; });
      data.sessions.push(session);
      /* Bounded history: drop oldest beyond the cap. */
      var cap = FPA.DEFAULTS.storage.maxSessions;
      if (data.sessions.length > cap) {
        data.sessions.sort(function (a, b) { return (a.startedAt || 0) - (b.startedAt || 0); });
        data.sessions = data.sessions.slice(data.sessions.length - cap);
      }
      return this._write(FPA.DEFAULTS.storage.historyKey, data);
    },

    remove: function (id) {
      var data = this._read(FPA.DEFAULTS.storage.historyKey);
      if (!data || !Array.isArray(data.sessions)) return false;
      data.sessions = data.sessions.filter(function (s) { return s.id !== id; });
      return this._write(FPA.DEFAULTS.storage.historyKey, data);
    },

    clearAll: function () {
      if (!storage) return false;
      try {
        storage.removeItem(FPA.DEFAULTS.storage.historyKey);
        return true;
      } catch (e) { this.lastError = e; return false; }
    },

    /* ── export ── */
    download: function (filename, mime, text) {
      var blob = new Blob([text], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    },

    exportSessionJSON: function (session) {
      var doc = {
        app: "Flute Practice Analyzer",
        exportFormat: "fpa-session/v1",
        exportedAt: new Date().toISOString(),
        note: "Values labelled audioMode='live' derive from microphone measurements; audioMode='simulation' are generated demonstration data.",
        session: session
      };
      this.download("fpa-session-" + session.id + ".json", "application/json", JSON.stringify(doc, null, 2));
    },

    exportSessionCSV: function (session) {
      var rows = [
        ["app", "Flute Practice Analyzer"],
        ["exportFormat", "fpa-session-events/v1"],
        ["sessionId", session.id],
        ["startedAt", new Date(session.startedAt).toISOString()],
        ["audioMode", session.audioMode || "live"],
        ["sa", session.sa
          ? (session.sa.noteLabel || "Sa") + " @ " +
            (Number.isFinite(session.sa.freq) ? session.sa.freq.toFixed(2) + " Hz" : "unknown")
          : "not set"],
        [],
        ["#", "start_s", "end_s", "duration_s", "western_note", "freq_hz", "cents", "swara", "register", "confidence", "stability_cents", "source"]
      ];
      (session.events || []).forEach(function (e, i) {
        rows.push([
          i + 1,
          Number.isFinite(e.startT) ? (e.startT / 1000).toFixed(3) : "",
          Number.isFinite(e.endT) ? (e.endT / 1000).toFixed(3) : "",
          Number.isFinite(e.durationMs) ? (e.durationMs / 1000).toFixed(3) : "",
          e.noteLabel || "",
          Number.isFinite(e.freq) ? e.freq.toFixed(2) : "",
          Number.isFinite(e.cents) ? e.cents.toFixed(1) : "",
          e.swara ? e.swara.label : "",
          e.swara ? e.swara.registerLabel : "",
          Number.isFinite(e.confidence) ? e.confidence.toFixed(3) : "",
          Number.isFinite(e.stabilityCents) ? e.stabilityCents.toFixed(1) : "",
          e.source || session.audioMode || "live"
        ]);
      });
      var csv = rows.map(function (r) {
        return r.map(function (cell) {
          var s = String(cell == null ? "" : cell);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(",");
      }).join("\n");
      this.download("fpa-session-" + session.id + ".csv", "text/csv", csv);
    },

    exportAllJSON: function () {
      var doc = {
        app: "Flute Practice Analyzer",
        exportFormat: "fpa-history/v1",
        exportedAt: new Date().toISOString(),
        sessions: this.list()
      };
      this.download("fpa-history.json", "application/json", JSON.stringify(doc, null, 2));
    }
  };

  FPA.History = History;
})(typeof window !== "undefined" ? window : globalThis);
