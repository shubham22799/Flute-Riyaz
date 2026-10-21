/* ═══════════════════════════════════════════════════════════════════
   app.js — application state machine, data flow and wiring.

   Live data flow (spec §12.2):
     capture → level gate → f0 estimate → confidence + temporal
     stability → Western pitch → (Sa candidate if unknown) →
     (Sargam if Sa confirmed) → note-event update → dashboard/timeline →
     persist at session boundaries.

   Responsibilities are deliberately separate:
     audio.js    microphone lifecycle
     pitch.js    f0 estimation + smoothing
     notes.js    Western pitch
     sa.js       Sa discovery/confirmation (musical role comes from the player)
     sargam.js   root-relative mapping
     tracker.js  note-event lifecycle + durations
     stats.js    session statistics
     history.js  local persistence + export
     timeline.js / ui.js  rendering
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";
  var FPA = global.FPA;
  var Notes = FPA.Notes;
  var Sargam = FPA.Sargam;
  var UI = FPA.UI;
  var Stats = FPA.Stats;
  var History = FPA.History;

  /* ───────────────────────── state ───────────────────────── */

  var settings = History.loadSettings();

  var state = {
    audioStatus: "idle",       // idle | requesting | active | unavailable | error
    practiceStatus: "idle",    // idle | recording | paused | completed
    audioMode: null,           // null | 'live' | 'simulation'
    detected: null,            // Notes.describe() of the smoothed estimate
    confidence: 0,
    rms: 0,
    noiseFloor: 0,
    spreadCents: NaN,
    lastValid: false,
    lastRejectReason: null,
    hint: "",
    previewEvents: [],         // live detections not yet inside a saved session
    session: null,
    activeEvent: null,
    viewingSessionId: null
  };

  var audio = new FPA.AudioInput();
  var sa = new FPA.SaDiscovery(settings.sa);
  var sim = new FPA.Simulation();
  var smoother = new FPA.Pitch.Smoother(settings.note.medianWindow);
  var noiseFloorHolder = { value: 0 };
  var tracker = new FPA.NoteTracker({
    note: settings.note,
    onEvent: onNoteEvent,
    onActive: function (ev) { state.activeEvent = ev; }
  });
  var timeline = null;

  /* ───────────────────── monotonic session clock ─────────────────────
     performance.now()-based; pauses exclude time. All note durations and
     timeline positions use this clock, never wall-clock or frame counts. */
  var clock = {
    running: false,
    base: 0,
    acc: 0,
    now: function () { return this.running ? performance.now() - this.base : this.acc; },
    resume: function () {
      if (this.running) return;
      this.base = performance.now() - this.acc;
      this.running = true;
    },
    pause: function () {
      if (!this.running) return;
      this.acc = performance.now() - this.base;
      this.running = false;
    },
    reset: function () { this.acc = 0; this.base = performance.now(); this.running = false; }
  };

  /* ───────────────────── detector plumbing ───────────────────── */

  function detectorOpts() {
    var d = settings.detector;
    return {
      minFreq: d.minFreq,
      maxFreq: d.maxFreq,
      yinThreshold: d.yinThreshold,
      confidenceMin: d.confidenceMin,
      minRms: d.minRms,
      noiseFloorRatio: d.noiseFloorRatio,
      noiseFloorEma: d.noiseFloorEma,
      octaveHalfTolerance: d.octaveHalfTolerance,
      _noiseFloor: noiseFloorHolder.value,
      _noiseFloorHolder: noiseFloorHolder
    };
  }

  /* Live frame → smoothed Western pitch → tracker. */
  function handleLiveFrame(result) {
    var nowT = clock.now();
    state.rms = result.rms;
    state.noiseFloor = noiseFloorHolder.value;

    if (!result.ok) {
      state.lastValid = false;
      state.confidence = 0;
      state.lastRejectReason = result.reason;
      state.detected = null;
      feedTracker({ t: nowT, valid: false, freq: NaN, confidence: result.confidence || 0, rms: result.rms });
      return;
    }

    var sm = smoother.push(result.freq);
    if (!sm) return;
    var desc = Notes.describe(sm.freq, settings.a4);
    if (!desc) return;

    state.detected = desc;
    state.confidence = result.confidence;
    state.spreadCents = sm.spreadCents;
    state.lastValid = true;
    state.lastRejectReason = null;

    feedTracker({
      t: nowT, valid: true,
      freq: sm.freq, midi: desc.midi, cents: desc.cents,
      noteLabel: desc.label, confidence: result.confidence,
      rms: result.rms, spreadCents: sm.spreadCents
    });
  }

  /* Simulation frames funnel through the same path (identical pipeline). */
  function handleSimFrame(f) {
    var nowT = clock.now();
    state.rms = f.rms || 0;
    if (!f.valid) {
      state.lastValid = false;
      state.confidence = f.confidence || 0;
      state.lastRejectReason = "simulated-gap";
      state.detected = null;
      feedTracker({ t: nowT, valid: false, freq: NaN, confidence: f.confidence || 0, rms: f.rms || 0 });
      return;
    }
    var sm = smoother.push(f.freq);
    if (!sm) return;
    var desc = Notes.describe(sm.freq, settings.a4);
    if (!desc) return;
    state.detected = desc;
    state.confidence = f.confidence;
    state.spreadCents = sm.spreadCents;
    state.lastValid = true;
    state.lastRejectReason = null;
    feedTracker({
      t: nowT, valid: true,
      freq: sm.freq, midi: desc.midi, cents: desc.cents,
      noteLabel: desc.label, confidence: f.confidence,
      rms: f.rms || 0, spreadCents: sm.spreadCents
    });
  }

  function feedTracker(frame) {
    if (!state.audioMode) return;
    if (state.practiceStatus === "paused") return;  // paused ⇒ not measuring
    tracker.ingest(frame);
  }

  /* ───────────────────── note events ───────────────────── */

  function onNoteEvent(ev) {
    ev.source = state.audioMode || "live";

    /* Representative Western pitch & tuning deviation. */
    var rep = Number.isFinite(ev.medianFreq) ? ev.medianFreq : ev.freq;
    var desc = Notes.describe(rep, settings.a4);
    if (desc) {
      ev.freq = rep;
      ev.cents = desc.cents;
      ev.noteLabel = desc.label;
      ev.midi = desc.midi;
    }
    ev.confidence = Number.isFinite(ev.confidence) ? ev.confidence : 0;
    ev.stabilityCents = Number.isFinite(ev.stabilityCents) ? ev.stabilityCents : ev.spreadCents;

    /* Sargam snapshot against the Sa active at recording time. */
    ev.saMidi = sa.confirmed ? sa.confirmed.midi : null;
    ev.swara = sa.confirmed ? Sargam.fromMidi(ev.midi, sa.confirmed.midi, ev.cents) : null;

    /* Sa discovery consumes stability evidence (also for preview notes). */
    if (!sa.isConfirmed()) {
      sa.addEvent({
        midi: ev.midi, freq: rep, spreadCents: ev.spreadCents,
        durationMs: ev.durationMs, endT: ev.endT
      });
    }

    if (state.practiceStatus === "recording" && state.session) {
      ev.insideSession = true;
      state.session.events.push(ev);
      ensureSaHistory(ev);
    } else {
      ev.preview = true;
      state.previewEvents.push(ev);
      if (state.previewEvents.length > 400) state.previewEvents.shift();
    }
  }

  /* Keep the session's Sa history honest when the root changes mid-session. */
  function ensureSaHistory() {
    var s = state.session;
    if (!s || !sa.confirmed) return;
    var last = s.saHistory[s.saHistory.length - 1];
    if (!last || last.midi !== sa.confirmed.midi) {
      s.saHistory.push(Object.assign({ at: Date.now() }, saSnapshot()));
      s.sa = saSnapshot();
    }
  }

  function saSnapshot() {
    if (!sa.confirmed) return null;
    return {
      midi: sa.confirmed.midi,
      freq: sa.confirmed.freq,
      noteLabel: sa.confirmed.noteLabel,
      method: sa.confirmed.method,
      confirmedAt: sa.confirmed.confirmedAt,
      detector: sa.confirmed.detector,
      a4: sa.confirmed.a4
    };
  }

  /* Re-map preview (unsaved) events when Sa changes — saved history never
     changes silently, preview notes are transient. */
  function remapPreview() {
    state.previewEvents.forEach(function (ev) {
      ev.saMidi = sa.confirmed ? sa.confirmed.midi : null;
      ev.swara = sa.confirmed ? Sargam.fromMidi(ev.midi, sa.confirmed.midi, ev.cents) : null;
    });
  }

  /* ───────────────────── formatting / derived UI state ───────────────────── */

  function timelineEvents() {
    if (state.session) return state.session.events;
    return state.previewEvents;
  }

  function activeAsEvent(nowT) {
    var a = state.activeEvent;
    if (!a) return null;
    var dur = tracker.activeDurationMs(nowT);
    return {
      startT: a.startT, endT: nowT, durationMs: dur, midi: a.midi,
      noteLabel: a.noteLabel, freq: a.medianFreq, confidence: a.confidence,
      stabilityCents: a.spreadCents, source: a.source,
      saMidi: sa.confirmed ? sa.confirmed.midi : null,
      swara: sa.confirmed ? Sargam.fromMidi(a.midi, sa.confirmed.midi, a.centsRef) : null
    };
  }

  function currentScope(nowT) {
    if (state.practiceStatus === "recording") return "recording";
    if (state.practiceStatus === "paused") return "paused";
    if (state.practiceStatus === "completed") return "completed";
    if (state.audioMode) return "live preview";
    return "no session";
  }

  function currentStats(nowT) {
    var evs = timelineEvents().slice();
    var act = activeAsEvent(nowT);
    if (act && act.durationMs > 0) evs.push(act);
    var sessionMs = state.session ? Math.max(0, clock.now() - state.session.startedAtClock) : clock.now();
    return Stats.compute(evs, sessionMs);
  }

  function pitchCardState(nowT) {
    if (state.audioMode === "simulation" && !state.lastValid) {
      return { hasData: false, rms: state.rms, saConfirmed: sa.isConfirmed(),
        hint: "Simulation: phrase gap — generated silence between notes." };
    }
    if (!state.lastValid || !state.detected) {
      var hint = "";
      if (state.audioMode === "live" && audio.state === "active") {
        hint = hintForReason(state.lastRejectReason);
      } else if (state.audioMode === "simulation") {
        hint = "Simulation running — generated values, not microphone measurements.";
      }
      return { hasData: false, rms: state.rms, saConfirmed: sa.isConfirmed(), hint: hint };
    }
    var d = state.detected;
    var swara = sa.confirmed ? Sargam.fromMidi(d.midi, sa.confirmed.midi, d.cents) : null;
    var hint;
    if (state.audioMode === "simulation") {
      hint = "Simulated note (generated) — identical processing path to live audio, but not your playing.";
    } else if (!sa.isConfirmed()) {
      hint = "Stable note detected. If this pitch is your Sa, confirm it on the left.";
    } else if (state.practiceStatus === "paused") {
      hint = "Paused — live pitch is shown, but nothing is being recorded.";
    } else {
      hint = "Hold the note to build a sustained-note duration.";
    }
    return {
      hasData: true,
      noteLabel: d.label,
      freq: d.freq,
      refFreq: d.refFreq,
      cents: d.cents,
      confidence: state.confidence,
      spreadCents: state.spreadCents,
      rms: state.rms,
      swara: swara,
      saConfirmed: sa.isConfirmed(),
      sustainMs: state.activeEvent ? tracker.activeDurationMs(nowT) : 0,
      hint: hint
    };
  }

  function hintForReason(reason) {
    switch (reason) {
      case "quiet": return "Listening — no flute sound detected. Play a note (or raise input sensitivity in Settings).";
      case "no-periodicity": return "Sound detected, but no clear pitch periodicity — this may be breath noise or room sound.";
      case "low-confidence": return "Sound detected but the pitch estimate is unstable — hold a steady note.";
      case "range": return "Pitch detected outside the configured range (" + settings.detector.minFreq + "–" + settings.detector.maxFreq + " Hz). Adjust in Settings if needed.";
      default: return "Listening for a stable note.";
    }
  }

  function statusView() {
    if (state.audioMode === "simulation") {
      return {
        kind: "sim",
        text: state.practiceStatus === "recording" ? "Simulation · recording (not saved to history)" : "Simulation running",
        detail: state.lastValid
          ? "Generated note " + state.detected.label + " at " + state.detected.freq.toFixed(1) + " Hz — demonstration data, not your microphone."
          : "Generating phrase gaps (silence) — demonstration data, not your microphone."
      };
    }
    if (audio.state === "requesting") return { kind: "warn", text: "Waiting for microphone permission…", detail: "A browser prompt should be visible." };
    if (audio.state === "denied") return { kind: "error", text: "Microphone permission denied", detail: "Allow microphone access in the address bar, then press Start microphone again." };
    if (audio.state === "unsupported") return { kind: "error", text: "Microphone APIs unavailable", detail: "This browser does not support Web Audio microphone capture." };
    if (audio.state === "error") return { kind: "error", text: "Audio input problem", detail: audio.lastError && audio.lastError.name ? "(" + audio.lastError.name + ") " : "" + "See the message above." };
    if (audio.state !== "active") return { kind: "idle", text: "Microphone not started", detail: "Press <em>Start microphone</em> to begin live analysis." };

    if (state.practiceStatus === "paused") {
      return { kind: "warn", text: "Paused — not measuring", detail: "Live pitch stays visible, but note events and durations are suspended." };
    }
    var prefix = state.practiceStatus === "recording" ? "Recording · " : "";
    if (!state.lastValid) {
      return {
        kind: "active",
        text: prefix + "Listening — no stable note detected",
        detail: state.rms > 0
          ? "Input level " + (20 * Math.log10(state.rms)).toFixed(0) + " dBFS (noise floor ≈ " + (20 * Math.log10(Math.max(state.noiseFloor, 1e-5))).toFixed(0) + " dBFS)."
          : "Waiting for audio."
      };
    }
    if (state.confidence < 0.87) {
      return { kind: "detecting", text: prefix + "Unstable pitch detected", detail: "Confidence " + Math.round(state.confidence * 100) + "% — hold the note steadily." };
    }
    return {
      kind: "detecting",
      text: prefix + "Detecting " + state.detected.label,
      detail: state.detected.freq.toFixed(1) + " Hz · " + state.detected.cents.toFixed(0) + " ¢ · confidence " + Math.round(state.confidence * 100) + "%"
    };
  }

  /* ───────────────────── render loop ───────────────────── */

  var lastAnalysisPerf = 0;
  var lastUiRender = 0;
  var lastStatsRender = 0;
  var lastStatusRender = 0;

  function loop() {
    global.requestAnimationFrame(loop);

    /* 1 · capture + analyse (live only, throttled; sim drives itself) */
    if (state.audioMode === "live" && audio.state === "active") {
      var perf = performance.now();
      if (perf - lastAnalysisPerf >= settings.detector.analysisIntervalMs) {
        lastAnalysisPerf = perf;
        if (audio.readFrame()) {
          var res = FPA.Pitch.detectFrame(audio.frame, audio.sampleRate, detectorOpts());
          handleLiveFrame(res);
        }
      }
    }

    var nowT = clock.now();
    var now = performance.now();

    /* 2 · pitch dashboard (~15 Hz is plenty for text) */
    if (now - lastUiRender > 66) {
      lastUiRender = now;
      UI.renderPitch(pitchCardState(nowT));
      UI.renderSa(saView());
    }

    /* 3 · status (~4 Hz) */
    if (now - lastStatusRender > 240) {
      lastStatusRender = now;
      var st = statusView();
      UI.setStatus(st.kind, st.text, st.detail);
    }

    /* 4 · stats (~4 Hz — never on every audio frame) */
    if (now - lastStatsRender > 250) {
      lastStatsRender = now;
      var scope = currentScope(nowT);
      UI.renderSession({ stats: currentStats(nowT), scope: scope });
      UI.setClock(state.session && scope !== "no session"
        ? Math.max(0, clock.now() - state.session.startedAtClock)
        : clock.now());
    }

    /* 5 · timeline (every frame; authoritative data is timestamps) */
    var evs = timelineEvents();
    timeline.render(evs, state.activeEvent, nowT, {
      paused: state.practiceStatus === "paused",
      saMidi: sa.confirmed ? sa.confirmed.midi : null
    });
    UI.setTimelineEmpty(evs.length === 0 && !state.activeEvent);

    /* 6 · session badge */
    var badge = badgeView();
    UI.setSessionBadge(badge.text, badge.cls);
  }

  function saView() {
    var cand = sa.candidate();
    var recent = sa.recent(4).map(function (r) {
      r.selected = sa.selectedMidi === r.midi;
      return r;
    });
    return {
      confirmed: sa.confirmed,
      candidate: cand,
      recent: recent,
      remember: sa.remember,
      listening: state.audioMode === "live" && audio.state === "active" && !sa.isConfirmed()
    };
  }

  function badgeView() {
    if (state.audioMode === "simulation") {
      return state.practiceStatus === "recording"
        ? { text: "SIM RECORDING", cls: "badge-sim" }
        : { text: "SIMULATION", cls: "badge-sim" };
    }
    switch (state.practiceStatus) {
      case "recording": return { text: "RECORDING", cls: "badge-rec" };
      case "paused": return { text: "PAUSED", cls: "badge-pause" };
      case "completed": return { text: "SESSION SAVED", cls: "badge-live" };
      default: return { text: "SESSION IDLE", cls: "badge-none" };
    }
  }

  /* ───────────────────── microphone / mode actions ───────────────────── */

  function controlState() {
    return {
      mic: state.audioMode === "live" && audio.state === "active" ? "on"
        : audio.state === "requesting" ? "requesting" : "off",
      session: state.practiceStatus === "recording" ? "recording"
        : state.practiceStatus === "paused" ? "paused" : "idle",
      simRunning: state.audioMode === "simulation"
    };
  }
  function syncControls() { UI.setControls(controlState()); }

  function resetLivePreview() {
    state.previewEvents = [];
    state.session = null;
    state.activeEvent = null;
    tracker.reset();
    smoother.clear();
    clock.reset();
  }

  function startMic() {
    if (state.audioMode === "simulation") {
      UI.banner("warn", "Stop the simulation before starting the microphone — live and simulated values are kept separate.");
      return Promise.resolve(false);
    }
    state.audioStatus = "requesting";
    UI.setMicHelp(null);
    syncControls();
    return audio.start(settings.detector.fftSize).then(function (res) {
      if (!res.ok) {
        state.audioStatus = res.state;
        UI.setMicHelp(res.message);
        UI.banner("error", esc(res.message), { sticky: true });
        syncControls();
        return false;
      }
      state.audioStatus = "active";
      state.audioMode = "live";
      resetLivePreview();
      clock.resume();
      UI.setMode("live");
      UI.setMicHelp(null);
      syncControls();
      UI.banner("success", "Microphone active (" + audio.sampleRate + " Hz). Play any note — no flute key needed.", { ttl: 6000 });
      restoreSaIfSaved(true);
      return true;
    });
  }

  function stopMic() {
    if (state.practiceStatus === "recording" || state.practiceStatus === "paused") {
      finishSession("microphone stopped");
    }
    audio.stop();
    state.audioMode = null;
    state.audioStatus = "idle";
    state.lastValid = false;
    state.detected = null;
    clock.pause();
    tracker.reset();
    smoother.clear();
    UI.setMode("none");
    UI.setStatus("idle", "Microphone stopped", "Audio input released. Press Start microphone to resume.");
    syncControls();
    UI.banner("info", "Microphone stopped and released.", { ttl: 4000 });
  }

  function startSimulation() {
    if (state.audioMode === "live") {
      UI.banner("warn", "Stop the microphone first — the app never mixes live and simulated values.");
      return;
    }
    state.audioMode = "simulation";
    resetLivePreview();
    clock.resume();
    sim.onFrame = handleSimFrame;
    sim.start();
    UI.setMode("simulation");
    syncControls();
    UI.banner("warn", "<strong>SIMULATION MODE</strong> — displayed values are generated for demonstration and are not microphone measurements. Simulated events are not saved as real practice history.", { sticky: false, ttl: 12000 });
  }

  function stopSimulation() {
    tracker.finalize(clock.now());
    sim.stop();
    sim.onFrame = null;
    state.audioMode = null;
    state.lastValid = false;
    state.detected = null;
    clock.pause();
    tracker.reset();
    smoother.clear();
    UI.setMode("none");
    syncControls();
    UI.banner("info", "Simulation stopped.", { ttl: 4000 });
  }

  /* ───────────────────── session lifecycle ───────────────────── */

  function startSession() {
    if (!state.audioMode) {
      /* Starting a session is an intentional user action: mic starts inside it. */
      startMic().then(function (ok) {
        if (ok) createSession();
      });
      return;
    }
    createSession();
  }

  function createSession() {
    var nowClock = clock.now();
    clock.resume();
    tracker.reset();
    smoother.clear();
    state.previewEvents = [];
    state.session = {
      id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      startedAt: Date.now(),
      endedAt: null,
      durationMs: 0,
      startedAtClock: nowClock,
      audioMode: state.audioMode,
      sa: saSnapshot(),
      saHistory: [],
      events: [],
      detectorConfig: Object.assign({ method: settings.detector.method, a4: settings.a4 }, settings.detector),
      noteSettings: {
        onsetMs: settings.note.onsetMs,
        releaseGraceMs: settings.note.releaseGraceMs
      }
    };
    if (sa.confirmed) state.session.saHistory.push(Object.assign({ at: Date.now() }, saSnapshot()));
    state.practiceStatus = "recording";
    syncControls();
    UI.banner("success",
      state.audioMode === "simulation"
        ? "Recording a <strong>simulated</strong> session — it will be labelled and not saved as real practice."
        : "Recording session — play freely in any order.", { ttl: 6000 });
  }

  function togglePause() {
    if (state.practiceStatus === "recording") {
      tracker.finalize(clock.now());
      clock.pause();
      state.practiceStatus = "paused";
      smoother.clear();
      UI.banner("info", "Session paused — live pitch display continues, recording is suspended.", { ttl: 5000 });
    } else if (state.practiceStatus === "paused") {
      clock.resume();
      state.practiceStatus = "recording";
      smoother.clear();
      tracker.reset();
      UI.banner("info", "Session resumed.", { ttl: 4000 });
    }
    syncControls();
  }

  /* Finalize + compute + store. Called by stop button, mic stop, unload. */
  function finishSession(reason) {
    var s = state.session;
    if (!s) return null;
    tracker.finalize(clock.now());
    s.endedAt = Date.now();
    s.durationMs = Math.max(0, clock.now() - s.startedAtClock);
    s.sa = saSnapshot() || s.sa;
    ensureSaHistory();
    s.stats = Stats.compute(s.events, s.durationMs);
    state.practiceStatus = "completed";
    clock.pause();
    smoother.clear();

    var saved = false;
    if (s.events.length > 0) {
      if (s.audioMode === "live") {
        saved = History.save(s);
        refreshHistory();
        if (saved) {
          UI.banner("success", "Session saved locally — " + s.events.length + " note events, " +
            Notes.formatSeconds(s.stats.totalNoteMs) + " detected note time.", { ttl: 7000 });
        } else {
          UI.banner("warn", "Session could not be saved (local storage unavailable). Live analysis still works.", { sticky: true });
        }
      } else {
        UI.banner("info", "Simulated session ended — not stored in real practice history (by design).", { ttl: 7000 });
      }
    } else {
      UI.banner("info", "Session ended with no detectable note events" + (reason ? " (" + esc(reason) + ")" : "") + " — nothing to save.", { ttl: 6000 });
    }
    syncControls();
    return { session: s, saved: saved };
  }

  /* ───────────────────── Sa actions ───────────────────── */

  function confirmSa() {
    var cand = sa.candidate();
    if (!cand) {
      UI.banner("warn", "No trustworthy Sa candidate yet — play and hold the pitch you use as Sa.");
      return;
    }
    sa.confirm(cand.midi, cand.freq, cand.manual ? "manual" : "candidate");
    onSaChanged();
    UI.banner("success", "Sa set to <strong>" + esc(sa.confirmed.noteLabel) + "</strong> (" +
      sa.confirmed.freq.toFixed(2) + " Hz). All detected notes now map to sargam relative to this root.", { ttl: 9000 });
    if (sa.remember) History.saveSaPreference(saSnapshot());
  }

  function selectRecent(midi) {
    sa.select(midi);
    UI.renderSa(saView());
  }

  /*
   * Explicit manual Sa from the note picker. The player is declaring the tonic,
   * so no measured evidence is required — but we say plainly what was used.
   */
  function setManualSa(midi) {
    var conf = sa.confirmFromPicker(midi);
    if (!conf) {
      UI.banner("warn", "That pitch could not be used as Sa. Pick a note from the list and try again.");
      return;
    }
    onSaChanged();
    UI.banner("success", "Sa set to <strong>" + esc(conf.noteLabel) + "</strong> (" +
      conf.freq.toFixed(2) + " Hz) — chosen from the note list. This is an equal-tempered " +
      "reference, not a measurement of your flute; play and hold the note if you want the app to measure your actual pitch.",
      { ttl: 11000 });
    if (sa.remember) History.saveSaPreference(saSnapshot());
  }

  function dismissCandidate() {
    sa.resetBuckets();
    UI.banner("info", "Cleared the current Sa evidence — play your tonic again and hold it.", { ttl: 5000 });
    UI.renderSa(saView());
  }

  function changeSa() {
    sa.clear();
    sa.resetBuckets();
    onSaChanged();
    UI.banner("info", "Sa cleared. Play your new Sa and confirm it — previous sessions keep their original Sa reference.", { ttl: 8000 });
  }

  function clearSa() {
    sa.clear();
    sa.resetBuckets();
    History.saveSaPreference(null);
    onSaChanged();
    UI.banner("info", "Sa removed. Sargam mapping is pending until you confirm a new root.", { ttl: 7000 });
  }

  function rememberToggle(checked) {
    sa.remember = checked;
    if (checked && sa.confirmed) {
      History.saveSaPreference(saSnapshot());
      UI.banner("success", "Your Sa will be restored automatically in this browser.", { ttl: 5000 });
    } else {
      History.saveSaPreference(null);
      UI.banner("info", "Sa will not be remembered after you close this page.", { ttl: 5000 });
    }
  }

  function restoreSaIfSaved(quiet) {
    if (sa.isConfirmed()) return;
    var pref = History.loadSaPreference();
    if (!pref || !Number.isFinite(pref.midi)) return;
    sa.remember = true;
    sa.restore({ midi: pref.midi, freq: pref.freq });
    onSaChanged();
    UI.banner("info", "Restored your saved Sa: <strong>" + esc(sa.confirmed.noteLabel) + "</strong> (" +
      sa.confirmed.freq.toFixed(2) + " Hz). Use “Change Sa” to pick a new one.", { ttl: quiet ? 8000 : 5000 });
  }

  function onSaChanged() {
    remapPreview();
    UI.renderSa(saView());
  }

  /* ───────────────────── settings ───────────────────── */

  function applySettings(next) {
    settings = next;
    History.saveSettings(settings);
    sa.setA4(settings.a4);
    if (smoother.windowLen !== settings.note.medianWindow) smoother = new FPA.Pitch.Smoother(settings.note.medianWindow);
    tracker.settings = Object.assign({}, tracker.settings, settings.note);
    timeline.setWindowSeconds(settings.timeline.windowSeconds);
    UI.updateWindowLabel(settings.timeline.windowSeconds);
    UI.buildSaPicker(settings);
  }

  function saveSettingsFromForm(next) {
    applySettings(next);
    UI.closeSettings();
    UI.banner("success", "Settings saved. Detector range " + settings.detector.minFreq + "–" + settings.detector.maxFreq +
      " Hz, onset " + settings.note.onsetMs + " ms, grace " + settings.note.releaseGraceMs + " ms.", { ttl: 6000 });
  }

  function resetSettings() {
    applySettings(FPA.cloneDefaults());
    UI.openSettings(settings);
    UI.banner("info", "Detector settings restored to defaults.", { ttl: 5000 });
  }

  /* ───────────────────── history ───────────────────── */

  function refreshHistory() {
    UI.renderHistory(History.list());
    UI.setStorageNote(History.available
      ? null
      : "Local storage is unavailable in this browser/context, so sessions cannot be saved. Live pitch analysis is unaffected.");
    UI.elements.historyList.classList.add("ready");
  }

  function openSession(id) {
    var s = History.get(id);
    if (!s) {
      UI.banner("error", "That session could not be read (storage may be corrupted). Other data is unaffected.");
      return;
    }
    state.viewingSessionId = id;
    UI.openSessionDetail(s);
  }

  function exportSession(format) {
    var s = History.get(state.viewingSessionId);
    if (!s) return;
    if (format === "csv") History.exportSessionCSV(s);
    else History.exportSessionJSON(s);
  }

  function deleteViewedSession() {
    var s = History.get(state.viewingSessionId);
    if (!s) return;
    if (!global.confirm("Delete this session permanently? This cannot be undone.")) return;
    History.remove(state.viewingSessionId);
    UI.closeSessionDetail();
    refreshHistory();
    UI.banner("info", "Session deleted.", { ttl: 4000 });
  }

  function clearHistory() {
    var list = History.list();
    if (!list.length) return;
    if (!global.confirm("Delete ALL " + list.length + " saved sessions? This cannot be undone.")) return;
    History.clearAll();
    refreshHistory();
    UI.banner("info", "All locally stored practice history cleared.", { ttl: 5000 });
  }

  /* ───────────────────── boot ───────────────────── */

  function boot() {
    UI.init({
      onStartMic: startMic,
      onStopMic: stopMic,
      onStartSession: startSession,
      onPauseSession: togglePause,
      onStopSession: function () { finishSession("user stopped"); },
      onSimStart: startSimulation,
      onSimStop: stopSimulation,
      onConfirmSa: confirmSa,
      onDismissCandidate: dismissCandidate,
      onChangeSa: changeSa,
      onClearSa: clearSa,
      onRememberToggle: rememberToggle,
      onSelectRecent: selectRecent,
      onSetManualSa: setManualSa,
      onSaveSettings: saveSettingsFromForm,
      onResetSettings: resetSettings,
      onOpenSettings: function () { UI.openSettings(settings); },
      onOpenSession: openSession,
      onExportAll: function () { History.exportAllJSON(); },
      onExportSessionJSON: function () { exportSession("json"); },
      onExportSessionCSV: function () { exportSession("csv"); },
      onDeleteSession: deleteViewedSession,
      onClearHistory: clearHistory
    });

    timeline = new FPA.Timeline(UI.elements.timelineCanvas, UI.elements.timelineTooltip, {
      windowSeconds: settings.timeline.windowSeconds
    });
    UI.updateWindowLabel(settings.timeline.windowSeconds);

    UI.setMode(null);
    syncControls();
    UI.buildSaPicker(settings);
    refreshHistory();
    onSaChanged();
    UI.renderPitch({ hasData: false, saConfirmed: false });
    UI.renderSession({ stats: Stats.compute([], 0), scope: "no session" });

    /* Honest environment checks — never fabricate readings when unsupported. */
    if (!FPA.AudioInput.isSupported()) {
      UI.banner("error", "This browser does not support microphone audio capture (Web Audio API). Live analysis and simulation-free operation need a modern browser.", { sticky: true });
      UI.setMicHelp("Microphone APIs unavailable. Try a recent Chrome, Edge, Firefox or Safari.");
    } else if (!global.isSecureContext) {
      UI.banner("warn", "This page is not a secure context, so browsers may block the microphone. Serve the folder over <code>http://localhost</code> (e.g. <code>python3 -m http.server</code>) or https.", { sticky: true });
    }
    if (!History.available) {
      UI.banner("warn", "Local storage is unavailable — you can still practise live, but sessions cannot be saved or restored.", { sticky: true });
      refreshHistory();
    }

    restoreSaIfSaved(false);

    /* Best-effort save if the tab is closed mid-session. */
    global.addEventListener("beforeunload", function () {
      if (state.practiceStatus === "recording" || state.practiceStatus === "paused") {
        finishSession("page closed");
      }
    });

    /* Mic track ending (device loss) must end note timing correctly. */
    audio.onStateChange = function (newState, info) {
      if (newState === "active") return;
      if (newState === "error" && state.audioMode === "live") {
        if (state.practiceStatus === "recording" || state.practiceStatus === "paused") {
          finishSession("audio input lost");
        }
        state.lastValid = false;
        UI.banner("error", esc(info && info.message ? info.message : "Audio input lost.") + " Note timing was finalized at the last reliable timestamp.", { sticky: true });
        UI.setMicHelp("Audio input ended. Press Start microphone to reconnect.");
        state.audioMode = null;
        UI.setMode("none");
        syncControls();
      }
    };

    global.requestAnimationFrame(loop);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }

  /* Exposed for tests / debugging. */
  FPA.app = {
    state: state,
    clock: clock,
    get settings() { return settings; },
    applySettings: applySettings,
    _internal: { detectorOpts: detectorOpts, tracker: tracker, sa: sa, timelineEvents: timelineEvents, currentStats: currentStats }
  };
})(typeof window !== "undefined" ? window : globalThis);
