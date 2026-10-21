/* ═══════════════════════════════════════════════════════════════════
   ui.js — all DOM rendering & wiring.

   Strict separation: this module never computes musical values; it only
   displays the state handed to it by app.js. Every audio-derived value
   shown here can be traced to a detector measurement (live) or is
   explicitly labelled SIMULATION.
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";
  var FPA = (global.FPA = global.FPA || {});
  var Notes = FPA.Notes;

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  /* Stored sessions are user data: a missing/!numeric frequency must never
     break the renderer (it degrades to a dash instead). */
  function fmtHz(v, digits) {
    return Number.isFinite(v) ? v.toFixed(digits) + " Hz" : "unknown Hz";
  }

  var el = {};
  var handlers = {};
  var settingsRef = null;
  /* Tracks the confirmed→unconfirmed transition of Sa, so the Sa panel folds
     itself away once (and reopens if you go back to change it). */
  var saWasConfirmed = false;

  /*
   * Fold a panel down to its header (or back open). Display only: no control
   * is removed, and the button's aria-expanded mirrors what is visible.
   */
  function setCardCollapsed(card, collapsed) {
    if (!card) return;
    var isCollapsed = !!collapsed;
    card.classList.toggle("is-collapsed", isCollapsed);
    var btn = card.querySelector("[data-collapse]");
    if (!btn) return;
    var head = card.querySelector("h2");
    var name = head && head.textContent ? head.textContent.trim() : "panel";
    btn.textContent = isCollapsed ? "\u25BE" : "\u25B4";     /* ▾ expand · ▴ collapse */
    btn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    btn.title = (isCollapsed ? "Expand " : "Collapse ") + name;
  }

  var UI = {
    /* ─────────────────────── init / wiring ─────────────────────── */
    init: function (h) {
      handlers = h || {};
      [
        "modeBadge", "settingsBtn", "banners", "statusDot", "statusText", "statusDetail",
        "sessionBadge", "clockBadge", "pitchQuality", "noteName", "noteFreq", "noteRef",
        "swaraName", "swaraRegister", "swaraOffset", "centsNeedle", "centsValue",
        "sustainTime", "stabilityValue", "levelValue", "pitchHint",
        "saCard", "saStateChip", "saFinding", "saFindingText", "saCandidateBox", "saCandNote",
        "saCandFreq", "saCandMeta", "confirmSaBtn", "dismissCandBtn",
        "saRecentWrap", "saRecentList", "saConfirmed", "saConfirmedNote", "saConfirmedFreq",
        "saConfirmedMeta", "changeSaBtn", "clearSaBtn", "rememberSaChk",
        "saManualWrap", "saManualSelect", "setManualSaBtn",
        "startMicBtn", "stopMicBtn", "micHelp", "startSessionBtn", "pauseSessionBtn",
        "stopSessionBtn", "qsNotes", "qsNoteTime", "qsLongest", "simStartBtn", "simStopBtn",
        "statsScope", "stSession", "stNoteTime", "stCount", "stLongest", "stAvg", "stMedian",
        "distBars", "swaraTableBody", "swaraDenom",
        "timelineCanvas", "timelineEmpty", "timelineTooltip", "timelineWindowLabel",
        "exportAllBtn", "clearHistoryBtn", "historyList", "storageNote",
        "settingsModal", "setMinFreq", "setMaxFreq", "setSensitivity", "setSensitivityVal",
        "setConfidence", "setConfidenceVal", "setOnset", "setGrace", "setA4", "setWindow",
        "settingsResetBtn", "settingsSaveBtn",
        "sessionModal", "sessionTitle", "sessionDetail", "sessionExportJsonBtn",
        "sessionExportCsvBtn", "sessionDeleteBtn"
      ].forEach(function (id) { el[id] = $(id); });

      /* controls */
      bind(el.startMicBtn, h.onStartMic);
      bind(el.stopMicBtn, h.onStopMic);
      bind(el.startSessionBtn, h.onStartSession);
      bind(el.pauseSessionBtn, h.onPauseSession);
      bind(el.stopSessionBtn, h.onStopSession);
      bind(el.simStartBtn, h.onSimStart);
      bind(el.simStopBtn, h.onSimStop);
      bind(el.confirmSaBtn, h.onConfirmSa);
      bind(el.dismissCandBtn, h.onDismissCandidate);
      bind(el.changeSaBtn, h.onChangeSa);
      bind(el.clearSaBtn, h.onClearSa);
      bind(el.exportAllBtn, h.onExportAll);
      bind(el.clearHistoryBtn, h.onClearHistory);
      bind(el.sessionExportJsonBtn, h.onExportSessionJSON);
      bind(el.sessionExportCsvBtn, h.onExportSessionCSV);
      bind(el.sessionDeleteBtn, h.onDeleteSession);
      bind(el.settingsBtn, h.onOpenSettings);
      bind(el.settingsSaveBtn, function () { saveSettings(); });
      bind(el.settingsResetBtn, h.onResetSettings);

      if (el.rememberSaChk && h.onRememberToggle) {
        el.rememberSaChk.addEventListener("change", function () { h.onRememberToggle(el.rememberSaChk.checked); });
      }
      if (el.saRecentList && h.onSelectRecent) {
        el.saRecentList.addEventListener("click", function (ev) {
          var pill = ev.target.closest("[data-midi]");
          if (!pill) return;
          h.onSelectRecent(Number(pill.getAttribute("data-midi")));
        });
      }
      /*
       * Manual Sa picker. The value only enables the button; confirmation happens
       * on an explicit click, so a stray scroll-wheel over the focused <select>
       * can never silently change the tonic.
       */
      if (el.saManualSelect && el.setManualSaBtn) {
        el.saManualSelect.addEventListener("change", function () {
          el.setManualSaBtn.disabled = !isPickedMidi(el.saManualSelect.value);
        });
        el.setManualSaBtn.addEventListener("click", function () {
          if (!isPickedMidi(el.saManualSelect.value)) return;
          if (handlers.onSetManualSa) handlers.onSetManualSa(Number(el.saManualSelect.value));
        });
      }

      /* modal close buttons */
      Array.prototype.forEach.call(document.querySelectorAll("[data-close]"), function (node) {
        node.addEventListener("click", function () {
          node.closest(".modal").hidden = true;
        });
      });

      /* foldable panels — one-time setup can shrink to its header */
      UI.initCollapsibles();

      document.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") {
          el.settingsModal.hidden = true;
          el.sessionModal.hidden = true;
        }
      });
    },

    /* ─────────────────── foldable panels ─────────────────── */
    /*
     * Wire every [data-collapse] button in `root` (default: the document) to
     * the .card it lives in. Used for the one-time setup panels, so the
     * timeline, the current note and the statistics can share one screen.
     */
    initCollapsibles: function (root) {
      var scope = root || document;
      Array.prototype.forEach.call(scope.querySelectorAll("[data-collapse]"), function (btn) {
        var card = btn.closest(".card");
        if (!card) return;
        btn.addEventListener("click", function () {
          setCardCollapsed(card, !card.classList.contains("is-collapsed"));
        });
      });
    },

    /* ─────────────────────── mode / status ─────────────────────── */
    setMode: function (mode) {
      var badge = el.modeBadge;
      badge.classList.remove("badge-none", "badge-live", "badge-sim");
      if (mode === "live") { badge.classList.add("badge-live"); badge.textContent = "LIVE MICROPHONE"; }
      else if (mode === "simulation") { badge.classList.add("badge-sim"); badge.textContent = "SIMULATION"; }
      else { badge.classList.add("badge-none"); badge.textContent = "NO INPUT"; }
      document.body.setAttribute("data-mode", mode || "none");
    },

    setStatus: function (kind, text, detail) {
      el.statusDot.className = "status-dot state-" + (kind || "idle");
      el.statusText.textContent = text;
      if (detail != null) el.statusDetail.innerHTML = detail;
    },

    setSessionBadge: function (text, cls) {
      el.sessionBadge.className = "badge badge-sm " + cls;
      el.sessionBadge.textContent = text;
    },

    setClock: function (ms) {
      el.clockBadge.textContent = Notes.formatClock(ms);
    },

    banner: function (kind, html, opts) {
      opts = opts || {};
      var node = document.createElement("div");
      node.className = "banner banner-" + (kind || "info");
      node.innerHTML = '<span class="banner-msg">' + html + "</span>" +
        '<button class="banner-close" type="button" aria-label="Dismiss">✕</button>';
      node.querySelector(".banner-close").addEventListener("click", function () { node.remove(); });
      el.banners.appendChild(node);
      var ttl = opts.sticky ? 0 : (opts.ttl || 8000);
      if (ttl) setTimeout(function () { if (node.parentNode) node.remove(); }, ttl);
      return node;
    },

    clearBanners: function () { el.banners.innerHTML = ""; },

    setMicHelp: function (text) {
      if (!el.micHelp) return;
      if (!text) { el.micHelp.hidden = true; el.micHelp.innerHTML = ""; return; }
      el.micHelp.hidden = false;
      el.micHelp.innerHTML = text;
    },

    /* ─────────────────────── controls ─────────────────────── */
    setControls: function (s) {
      /* mic */
      el.startMicBtn.hidden = s.mic === "on";
      el.stopMicBtn.hidden = s.mic !== "on";
      el.startMicBtn.disabled = s.simRunning || s.mic === "requesting";
      el.startMicBtn.textContent = s.mic === "requesting" ? "\u23F3 Waiting for permission…" : "\u25CF Start microphone";
      el.simStartBtn.hidden = !!s.simRunning;
      el.simStopBtn.hidden = !s.simRunning;
      el.simStartBtn.disabled = s.mic === "on";

      /* session */
      var rec = s.session === "recording";
      var paused = s.session === "paused";
      el.startSessionBtn.hidden = rec || paused;
      el.pauseSessionBtn.hidden = !(rec || paused);
      el.stopSessionBtn.hidden = !(rec || paused);
      el.pauseSessionBtn.textContent = paused ? "\u25B6 Resume" : "\u23F8 Pause";
      el.startSessionBtn.disabled = !(s.mic === "on" || s.simRunning);
    },

    /* ─────────────────────── pitch card ─────────────────────── */
    renderPitch: function (p) {
      var has = p && p.hasData;

      if (!has) {
        el.noteName.textContent = "—";
        el.noteFreq.textContent = "— Hz";
        el.noteRef.textContent = "ref — Hz";
        el.centsValue.textContent = "—";
        el.centsNeedle.hidden = true;
        el.sustainTime.textContent = "0.0\u2009s";
        el.stabilityValue.textContent = "—";
        if (p && Number.isFinite(p.rms) && p.rms > 0) {
          el.levelValue.textContent = dBFS(p.rms);
        } else {
          el.levelValue.textContent = "—";
        }
      } else {
        el.noteName.textContent = p.noteLabel;
        el.noteFreq.textContent = p.freq.toFixed(1) + " Hz";
        el.noteRef.textContent = "ref " + p.refFreq.toFixed(1) + " Hz";
        var c = p.cents;
        el.centsValue.textContent = (c >= 0 ? "+" : "") + c.toFixed(0) + " \u00A2";
        el.centsNeedle.hidden = false;
        var pct = Math.max(0, Math.min(100, (c + 50) / 100 * 100));
        el.centsNeedle.style.left = pct + "%";
        el.centsNeedle.style.background = Math.abs(c) < 12 ? "var(--green)" : Math.abs(c) < 30 ? "var(--teal)" : "var(--amber)";
        el.sustainTime.textContent = Notes.formatSeconds(p.sustainMs || 0);
        el.stabilityValue.textContent = Number.isFinite(p.spreadCents)
          ? "±" + (p.spreadCents / 2).toFixed(1) + " \u00A2" : "—";
        el.levelValue.textContent = Number.isFinite(p.rms) ? dBFS(p.rms) : "—";
      }

      /* confidence dots */
      var q = has ? Math.max(1, Math.min(5, Math.round((p.confidence || 0) * 5))) : 0;
      el.pitchQuality.className = "quality q-" + q;
      el.pitchQuality.innerHTML = q ? "\u25CF".repeat(q) + "\u25CB".repeat(5 - q) : "\u25CB\u25CB\u25CB\u25CB\u25CB";

      /* sargam */
      if (has && p.swara) {
        el.swaraName.className = "swara-name";
        el.swaraName.textContent = p.swara.label + (p.swara.ambiguous ? " ?" : "");
        el.swaraRegister.textContent = p.swara.registerLabel;
        el.swaraOffset.textContent =
          (p.swara.semitones === 0 ? "same pitch as Sa" : (p.swara.semitones > 0 ? "+" : "") + p.swara.semitones + " semitones from Sa") +
          " · octave " + (p.swara.octave >= 0 ? "+" : "") + p.swara.octave +
          (p.swara.ambiguous ? " · near semitone boundary" : "");
      } else if (has) {
        el.swaraName.className = "swara-name pending";
        el.swaraName.textContent = "Sargam pending";
        el.swaraRegister.textContent = p.saConfirmed ? "mapping unavailable" : "confirm your Sa to map swaras";
        el.swaraOffset.innerHTML = "&nbsp;";
      } else {
        el.swaraName.className = "swara-name pending";
        el.swaraName.textContent = p && p.saConfirmed ? "Waiting for a note" : "Sargam pending";
        el.swaraRegister.textContent = p && p.saConfirmed ? "play any note" : "set Sa first";
        el.swaraOffset.innerHTML = "&nbsp;";
      }

      el.pitchHint.textContent = p && p.hint ? p.hint : "";
      el.pitchHint.hidden = !(p && p.hint);
    },

    /* ─────────────────────── Sa card ─────────────────────── */
    /*
     * Fill the manual Sa picker from the detector's accepted range and the A4
     * reference. Called on boot and whenever settings change — never during the
     * high-frequency render loop, so a user's in-progress choice is never reset.
     */
    buildSaPicker: function (settings) {
      if (!el.saManualSelect) return;
      var det = (settings && settings.detector) || FPA.DEFAULTS.detector;
      var a4 = settings && Number.isFinite(settings.a4) ? settings.a4 : FPA.DEFAULTS.a4;
      var notes = FPA.Notes.midiRange(det.minFreq, det.maxFreq, a4);
      var previous = el.saManualSelect.value;

      var html = '<option value="">Choose a pitch\u2026</option>';
      var octave = null;
      notes.forEach(function (n) {
        if (n.octave !== octave) {
          if (octave !== null) html += "</optgroup>";
          html += '<optgroup label="Octave ' + n.octave + '">';
          octave = n.octave;
        }
        html += '<option value="' + n.midi + '">' + esc(n.label) + " \u2014 " +
          FPA.Notes.midiToFreq(n.midi, a4).toFixed(2) + " Hz</option>";
      });
      if (octave !== null) html += "</optgroup>";

      el.saManualSelect.innerHTML = html;
      /* Keep the previous choice when it is still in range. */
      el.saManualSelect.value = previous || "";
      if (el.saManualSelect.value !== previous) el.saManualSelect.value = "";
      el.setManualSaBtn.disabled = !isPickedMidi(el.saManualSelect.value);
    },

    renderSa: function (s) {
      el.rememberSaChk.checked = !!s.remember;

      if (s.confirmed) {
        el.saStateChip.textContent = "confirmed";
        el.saStateChip.className = "chip chip-ok";
        el.saFinding.hidden = true;
        el.saConfirmed.hidden = false;
        el.saConfirmedNote.textContent = s.confirmed.noteLabel;
        el.saConfirmedFreq.textContent = s.confirmed.freq.toFixed(2) + " Hz";
        var methodText = s.confirmed.method === "restored" ? "restored from saved preference"
          : s.confirmed.method === "picked" ? "chosen manually from the note list"
          : s.confirmed.method === "manual" ? "chosen from recent detections"
          : "confirmed from your playing";
        el.saConfirmedMeta.textContent = methodText +
          " · " + new Date(s.confirmed.confirmedAt).toLocaleTimeString() +
          " · detected with " + (s.confirmed.detector || "yin") + " · A4=" + (s.confirmed.a4 || 440) + " Hz";
        /*
         * Sa is a one-time decision: once it is set, fold the panel away so the
         * timeline, the current note and the statistics share the screen. The
         * header keeps showing the confirmed pitch, and one click reopens it.
         */
        if (!saWasConfirmed) setCardCollapsed(el.saCard, true);
        saWasConfirmed = true;
        return;
      }

      if (saWasConfirmed) setCardCollapsed(el.saCard, false);   /* went back to change Sa */
      saWasConfirmed = false;
      el.saConfirmed.hidden = true;
      el.saFinding.hidden = false;
      el.saStateChip.textContent = s.candidate ? "candidate found" : "not set";
      el.saStateChip.className = "chip " + (s.candidate ? "chip-warn" : "chip-idle");

      if (s.candidate) {
        el.saCandidateBox.hidden = false;
        el.saCandNote.textContent = s.candidate.noteLabel;
        el.saCandFreq.textContent = s.candidate.freq.toFixed(2) + " Hz";
        el.saCandMeta.textContent =
          (s.candidate.manual ? "you selected this · " : "heard ") +
          s.candidate.count + "× · pitch spread ±" + (s.candidate.spreadCents / 2).toFixed(1) + " \u00A2 · " +
          (s.candidate.totalMs / 1000).toFixed(1) + " s of tone" +
          (s.candidate.qualifies ? "" : " · low evidence so far");
        el.saFindingText.innerHTML = s.candidate.manual
          ? "Confirm this detection as your <strong>Sa</strong>?"
          : "Hold that note a little longer, or confirm it now if this is your <strong>Sa</strong>.";
      } else {
        el.saCandidateBox.hidden = true;
        el.saFindingText.innerHTML = s.listening
          ? "Listening for your <strong>Sa</strong> — play the tonic note you use and hold it steady."
          : "Play the pitch you use as <strong>Sa</strong> and hold it steady. The app will propose it — you decide.";
      }

      /* recent detections */
      if (s.recent && s.recent.length) {
        el.saRecentWrap.hidden = false;
        el.saRecentList.innerHTML = s.recent.map(function (r) {
          return '<button type="button" class="recent-pill' + (r.selected ? " selected" : "") + '" data-midi="' + r.midi + '">' +
            esc(r.noteLabel) + "<small>" + r.freq.toFixed(1) + " Hz</small></button>";
        }).join("");
      } else {
        el.saRecentWrap.hidden = true;
        el.saRecentList.innerHTML = "";
      }
    },

    /* ─────────────────────── session + stats ─────────────────────── */
    renderSession: function (s) {
      el.qsNotes.textContent = String(s.stats.eventCount);
      el.qsNoteTime.textContent = Notes.formatSeconds(s.stats.totalNoteMs);
      el.qsLongest.textContent = Notes.formatSeconds(s.stats.longestMs);
      this.renderStats(s.stats, s.scope);
    },

    renderStats: function (stats, scope) {
      el.stSession.textContent = Notes.formatClock(stats.sessionMs);
      el.stNoteTime.textContent = Notes.formatSeconds(stats.totalNoteMs);
      el.stCount.textContent = String(stats.eventCount);
      el.stLongest.textContent = Notes.formatSeconds(stats.longestMs);
      el.stAvg.textContent = Notes.formatSeconds(stats.avgMs);
      el.stMedian.textContent = Notes.formatSeconds(stats.medianMs);

      el.statsScope.textContent = scope || "no session";
      el.statsScope.className = "chip " + (
        (scope === "recording" || scope === "paused") ? "chip-warn" :
        (scope === "completed" || scope === "live preview") ? "chip-ok" : "chip-idle");

      /* duration distribution */
      var max = 0;
      stats.distribution.forEach(function (d) { if (d.count > max) max = d.count; });
      el.distBars.innerHTML = stats.distribution.map(function (d) {
        var w = max ? Math.round((d.count / max) * 100) : 0;
        return '<div class="dist-row"><span class="dist-label">' + esc(d.label) + '</span>' +
          '<span class="dist-track"><span class="dist-fill" style="width:' + w + '%"></span></span>' +
          '<span class="dist-count">' + d.count + "</span></div>";
      }).join("");

      /* per-swara table */
      if (!stats.perSwara.length) {
        el.swaraTableBody.innerHTML = '<tr><td colspan="6" class="muted center">' +
          (stats.unmappedCount ? stats.unmappedCount + " note(s) recorded before Sa was set" : "No notes recorded yet") +
          "</td></tr>";
        el.swaraDenom.textContent = "";
      } else {
        el.swaraDenom.textContent = "(share of " + Notes.formatSeconds(stats.totalNoteMs) + " detected note time)";
        el.swaraTableBody.innerHTML = stats.perSwara.map(function (s) {
          var west = s.west || "—";
          var title = (s.noteList && s.noteList.length)
            ? ' title="' + esc(s.noteList.join(", ")) + '"' : "";
          return "<tr><td>" + esc(s.short) + " <span class='muted'>" + esc(s.label) + "</span></td>" +
            "<td class='swara-west'" + title + ">" + esc(west) + "</td>" +
            "<td>" + s.count + "</td>" +
            "<td>" + Notes.formatSeconds(s.ms) + "</td>" +
            "<td>" + Notes.formatSeconds(s.maxMs) + "</td>" +
            "<td>" + s.pct.toFixed(1) + "%</td></tr>";
        }).join("");
      }
    },

    setTimelineEmpty: function (show) {
      el.timelineEmpty.hidden = !show;
    },

    updateWindowLabel: function (sec) {
      if (sec) el.timelineWindowLabel.textContent = "last " + sec + "\u2009s";
    },

    /* ─────────────────────── history ─────────────────────── */
    renderHistory: function (list) {
      el.exportAllBtn.disabled = !list.length;
      el.clearHistoryBtn.disabled = !list.length;
      if (!list.length) {
        el.historyList.innerHTML = '<p class="muted center">No saved sessions yet. Stop a session to save it here.</p>';
        return;
      }
      var self = this;
      el.historyList.innerHTML = list.map(function (s) {
        var st = s.stats || {};
        var date = new Date(s.startedAt).toLocaleString();
        var saText = s.sa ? esc(s.sa.noteLabel) + " @ " + fmtHz(s.sa.freq, 1) : "Sa not set";
        var modeBadge = s.audioMode === "simulation"
          ? '<span class="badge badge-sim badge-sm">SIMULATION</span>'
          : '<span class="badge badge-live badge-sm">MIC</span>';
        return '<div class="history-item" data-session="' + esc(s.id) + '">' +
          '<span class="hi-date">' + esc(date) + "</span>" +
          '<span class="hi-meta">' +
            "<span>Sa: " + saText + "</span>" +
            "<span>" + (st.eventCount || 0) + " notes</span>" +
            "<span>" + Notes.formatSeconds(st.totalNoteMs || 0) + " note time</span>" +
            "<span>longest " + Notes.formatSeconds(st.longestMs || 0) + "</span>" +
          "</span>" +
          '<span class="hi-badges">' + modeBadge + "</span>" +
        "</div>";
      }).join("");
      Array.prototype.forEach.call(el.historyList.querySelectorAll("[data-session]"), function (node) {
        node.addEventListener("click", function () {
          if (handlers.onOpenSession) handlers.onOpenSession(node.getAttribute("data-session"));
        });
      });
    },

    setStorageNote: function (text) {
      if (!text) { el.storageNote.hidden = true; return; }
      el.storageNote.hidden = false;
      el.storageNote.textContent = text;
    },

    /* ─────────────────────── settings modal ─────────────────────── */
    openSettings: function (settings) {
      settingsRef = settings;
      el.setMinFreq.value = settings.detector.minFreq;
      el.setMaxFreq.value = settings.detector.maxFreq;
      el.setSensitivity.value = FPA.minRmsToSensitivity(settings.detector.minRms);
      el.setConfidence.value = Math.round(settings.detector.confidenceMin * 100);
      el.setOnset.value = settings.note.onsetMs;
      el.setGrace.value = settings.note.releaseGraceMs;
      el.setA4.value = settings.a4;
      el.setWindow.value = settings.timeline.windowSeconds;
      updateSensitivityLabel();
      el.settingsModal.hidden = false;
    },

    closeSettings: function () { el.settingsModal.hidden = true; },

    applySettingsForm: function (currentSettings) {
      /* Returns a merged settings object from the form values. */
      return FPA.mergeSettings({
        a4: Number(el.setA4.value),
        detector: {
          minFreq: Number(el.setMinFreq.value),
          maxFreq: Number(el.setMaxFreq.value),
          minRms: FPA.sensitivityToMinRms(Number(el.setSensitivity.value)),
          confidenceMin: Number(el.setConfidence.value) / 100
        },
        note: {
          onsetMs: Number(el.setOnset.value),
          releaseGraceMs: Number(el.setGrace.value)
        },
        timeline: { windowSeconds: Number(el.setWindow.value) }
      });
    },

    /* ─────────────────────── session detail modal ─────────────────────── */
    openSessionDetail: function (session) {
      var st = session.stats || FPA.Stats.compute(session.events, session.durationMs || 0);
      el.sessionTitle.textContent = "Session — " + new Date(session.startedAt).toLocaleString();

      var saHtml = session.sa
        ? "<strong>" + esc(session.sa.noteLabel) + "</strong> @ " + fmtHz(session.sa.freq, 2) + " (" +
          esc(session.sa.method || "confirmed") + ")"
        : "<em>not set</em>";
      var saChanges = (session.saHistory && session.saHistory.length > 1)
        ? "<div class='fineprint'>Sa changed during this session: " +
          session.saHistory.map(function (h) {
            return esc(h.noteLabel) + " (" + new Date(h.at).toLocaleTimeString() + ")";
          }).join(" → ") + "</div>"
        : "";

      var events = (session.events || []);
      var shown = events.slice(0, 400);

      el.sessionDetail.innerHTML =
        '<div class="detail-head">' +
          "<span>" + (session.audioMode === "simulation"
            ? '<span class="badge badge-sim badge-sm">SIMULATION DATA</span>'
            : '<span class="badge badge-live badge-sm">LIVE MICROPHONE</span>') + "</span>" +
          "<span>Sa: " + saHtml + "</span>" +
          "<span>" + new Date(session.startedAt).toLocaleString() + " → " + new Date(session.endedAt || session.startedAt).toLocaleTimeString() + "</span>" +
        "</div>" + saChanges +
        '<div class="detail-grid">' +
          detailStat("Practice time", Notes.formatClock(st.sessionMs || session.durationMs || 0)) +
          detailStat("Note time", Notes.formatSeconds(st.totalNoteMs)) +
          detailStat("Note events", String(st.eventCount)) +
          detailStat("Longest note", Notes.formatSeconds(st.longestMs)) +
          detailStat("Average", Notes.formatSeconds(st.avgMs)) +
          detailStat("Median", Notes.formatSeconds(st.medianMs)) +
          detailStat("With stability data", String(st.stabilityCount)) +
          detailStat("Avg confidence", st.eventCount ? Math.round(st.avgConfidence * 100) + "%" : "—") +
        "</div>" +
        '<div class="mini-label">Swara usage' + (st.perSwara && st.perSwara.length ? " (share of detected note time)" : "") + "</div>" +
        (st.perSwara && st.perSwara.length
          ? '<div class="swara-table-wrap"><table class="swara-table"><thead><tr>' +
              "<th>Swara</th><th>Western</th><th>Notes</th><th>Time</th><th>Max</th><th>Share</th>" +
            "</tr></thead><tbody>" +
            st.perSwara.map(function (s) {
              var title = (s.noteList && s.noteList.length) ? ' title="' + esc(s.noteList.join(", ")) + '"' : "";
              return "<tr><td>" + esc(s.short) + " <span class='muted'>" + esc(s.label) + "</span></td>" +
                "<td class='swara-west'" + title + ">" + esc(s.west || "—") + "</td>" +
                "<td>" + s.count + "</td>" +
                "<td>" + Notes.formatSeconds(s.ms) + "</td>" +
                "<td>" + (Number.isFinite(s.maxMs) ? Notes.formatSeconds(s.maxMs) : "—") + "</td>" +
                "<td>" + s.pct.toFixed(1) + "%</td></tr>";
            }).join("") + "</tbody></table></div>"
          : (st.perSwara
              ? '<p class="muted">' + (st.unmappedCount ? st.unmappedCount + " note(s) recorded before Sa was set." : "No notes.") + "</p>"
              : '<p class="muted">Swara breakdown not stored for this session.</p>')) +
        '<div class="mini-label">Note events' + (events.length > shown.length ? " (first " + shown.length + " of " + events.length + ")" : "") + "</div>" +
        '<div class="detail-events"><table><thead><tr>' +
          "<th>#</th><th>Western</th><th>Swara</th><th>Start</th><th>Duration</th><th>Freq</th><th>¢</th><th>Conf</th>" +
        "</tr></thead><tbody>" +
        (shown.length ? shown.map(function (e, i) {
          return "<tr><td>" + (i + 1) + "</td>" +
            "<td>" + esc(e.noteLabel || "?") + "</td>" +
            "<td>" + (e.swara ? esc(e.swara.compact) : "—") + "</td>" +
            "<td>" + (e.startT / 1000).toFixed(2) + "s</td>" +
            "<td>" + (e.durationMs / 1000).toFixed(2) + "s</td>" +
            "<td>" + (Number.isFinite(e.freq) ? e.freq.toFixed(1) : "—") + "</td>" +
            "<td>" + (Number.isFinite(e.cents) ? e.cents.toFixed(0) : "—") + "</td>" +
            "<td>" + (Number.isFinite(e.confidence) ? Math.round(e.confidence * 100) + "%" : "—") + "</td></tr>";
        }).join("") : '<tr><td colspan="8" class="muted">No events</td></tr>') +
        "</tbody></table></div>" +
        '<p class="fineprint">Durations are estimates derived from audio note events, not breath measurements. ' +
        "Each event keeps the Sa reference that was active when it was recorded.</p>";

      el.sessionModal.hidden = false;
    },

    closeSessionDetail: function () { el.sessionModal.hidden = true; },

    elements: el
  };

  function detailStat(label, value) {
    return '<div class="stat"><span class="stat-value">' + esc(value) + '</span><span class="stat-label">' + esc(label) + "</span></div>";
  }

  function bind(node, fn) {
    if (node && typeof fn === "function") node.addEventListener("click", fn);
  }

  /* A real pitch is selected in the picker ("" is the placeholder option). */
  function isPickedMidi(value) {
    return value !== "" && value != null && Number.isFinite(Number(value));
  }

  function saveSettings() {
    if (handlers.onSaveSettings) handlers.onSaveSettings(UI.applySettingsForm(settingsRef));
  }

  function updateSensitivityLabel() {
    var v = Number(el.setSensitivity.value);
    var rms = FPA.sensitivityToMinRms(v);
    el.setSensitivityVal.textContent = "gate ≈ " + rms.toFixed(3) + " RMS (" + (v <= 33 ? "sensitive" : v >= 66 ? "strict" : "balanced") + ")";
  }

  function dBFS(rms) {
    if (!(rms > 0)) return "—";
    var db = 20 * Math.log10(rms);
    return (db > -6 ? "-6" : db.toFixed(0)) + " dBFS";
  }

  if (typeof document !== "undefined") {
    document.addEventListener("input", function (ev) {
      if (ev.target && ev.target.id === "setSensitivity") updateSensitivityLabel();
      if (ev.target && ev.target.id === "setConfidence") {
        el.setConfidenceVal.textContent = ev.target.value + "%";
      }
    });
  }

  FPA.UI = UI;
})(typeof window !== "undefined" ? window : globalThis);
