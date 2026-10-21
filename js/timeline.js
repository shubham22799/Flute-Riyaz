/* ═══════════════════════════════════════════════════════════════════
   timeline.js — canvas riyaz timeline.

   Accuracy rule: rendering uses ONLY the timestamps recorded by the
   note-event tracker. The animation loop never determines duration.
   The scrolling window (default 30 s) is a display choice; stored
   history is inspected through the history views, not this canvas.

   Visual language:
   • completed events → filled block, colour by pitch class
   • active (live)    → bright block with glow, width follows clock
   • simulation       → dashed outline + "SIM" tag (never looks live)
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";
  var FPA = (global.FPA = global.FPA || {});

  var PITCH_COLORS = [
    "#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399", "#2dd4bf",
    "#38bdf8", "#60a5fa", "#818cf8", "#a78bfa", "#c084fc", "#f472b6"
  ];

  /* Swara-axis geometry: one row per degree from Sa (or per pitch class
     before a Sa is confirmed), with a labelled gutter on the left edge. */
  var LANES = 12;
  var AXIS_W = 46;   // left gutter reserved for the swara labels
  var AXIS_H = 18;   // bottom strip for the time labels

  function Timeline(canvas, tooltipEl, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.tooltip = tooltipEl;
    this.windowMs = ((opts && opts.windowSeconds) || FPA.DEFAULTS.timeline.windowSeconds) * 1000;
    this.minBlockPx = FPA.DEFAULTS.timeline.minBlockPx;
    this.dpr = Math.max(1, Math.min(2.5, global.devicePixelRatio || 1));
    this._blocks = [];   // last rendered hit-test boxes
    this._resize();
    var self = this;
    this._onResize = function () { self.dpr = Math.max(1, Math.min(2.5, global.devicePixelRatio || 1)); self._resize(); };
    global.addEventListener("resize", this._onResize);
    if (canvas.parentElement) {
      new ResizeObserver(function () { self._resize(); }).observe(canvas.parentElement);
    }
    this._bindTooltip();
  }

  Timeline.prototype.setWindowSeconds = function (s) {
    this.windowMs = Math.max(10, Math.min(120, Number(s) || 30)) * 1000;
  };

  /*
   * Row index (0..11) for a detected note. With a confirmed Sa the row is the
   * swara degree counted up from Sa; the register is deliberately ignored
   * because this is a twelve-row *swara* axis, not a full pitch grid (the block
   * label and tooltip still show the register). Before Sa is set the row falls
   * back to the pitch class from C, so notes are still placed honestly.
   */
  Timeline.laneOf = function (midi, saMidi) {
    if (!Number.isFinite(midi)) return null;
    var root = Number.isFinite(saMidi) ? Math.round(saMidi) : 0;
    return (((Math.round(midi) - root) % LANES) + LANES) % LANES;
  };

  /* The twelve row labels, top (row 0) to bottom: sargam once Sa is known. */
  Timeline.axisLabels = function (saMidi) {
    var out = [];
    for (var i = 0; i < LANES; i++) {
      out.push(Number.isFinite(saMidi) ? FPA.Sargam.TABLE[i].short : FPA.Notes.NAMES[i]);
    }
    return out;
  };
  Timeline.LANES = LANES;

  Timeline.prototype._resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var w = Math.max(100, rect.width);
    var h = Math.max(60, rect.height || 150);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.w = w;
    this.h = h;
  };

  /*
   * Render one frame.
   * @param events      completed events of the current session
   * @param activeEvent live event (or null)
   * @param nowT        current session-clock ms
   * @param opts        { paused, emptyHintVisible }
   */
  Timeline.prototype.render = function (events, activeEvent, nowT, opts) {
    opts = opts || {};
    var ctx = this.ctx;
    var w = this.w, h = this.h, dpr = this.dpr;
    var saMidi = Number.isFinite(opts.saMidi) ? opts.saMidi : null;
    var labels = Timeline.axisLabels(saMidi);

    /* The plot sits right of the swara gutter and above the time strip. */
    var plotX = AXIS_W;
    var plotW = Math.max(20, w - AXIS_W);
    var plotH = Math.max(AXIS_H + 6, h - AXIS_H);
    var laneH = plotH / LANES;
    var windowMs = this.windowMs;
    var winStart = Math.max(0, nowT - windowMs);
    var winEnd = winStart + windowMs;
    var toX = function (t) { return plotX + ((t - winStart) / windowMs) * plotW; };
    var clipPlot = function () { ctx.beginPath(); ctx.rect(plotX, 0, plotW, plotH); ctx.clip(); };

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    /* ── swara rows: one per degree, top row = Sa ── */
    ctx.save();
    clipPlot();
    for (var row = 0; row < LANES; row++) {
      if (row % 2 === 1) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.02)";
        ctx.fillRect(plotX, row * laneH, plotW, laneH);
      }
      if (row > 0) {
        ctx.strokeStyle = "rgba(100, 116, 139, 0.13)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(plotX, Math.round(row * laneH) + 0.5);
        ctx.lineTo(plotX + plotW, Math.round(row * laneH) + 0.5);
        ctx.stroke();
      }
    }
    ctx.restore();

    /* ── background grid: second ticks (plot area only) ── */
    var stepSec = this.windowMs > 60000 ? 10 : this.windowMs > 24000 ? 5 : 2;
    var firstTick = Math.ceil(winStart / (stepSec * 1000)) * stepSec * 1000;
    ctx.save();
    clipPlot();
    ctx.strokeStyle = "rgba(100, 116, 139, 0.16)";
    ctx.lineWidth = 1;
    for (var tick = firstTick; tick <= winEnd; tick += stepSec * 1000) {
      var gx = Math.round(toX(tick)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, plotH);
      ctx.stroke();
    }
    ctx.restore();

    /* ── playhead ── */
    var px = Math.round(toX(nowT)) + 0.5;
    ctx.save();
    clipPlot();
    ctx.strokeStyle = opts.paused ? "rgba(251, 191, 36, 0.55)" : "rgba(45, 212, 191, 0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, plotH);
    ctx.stroke();
    ctx.restore();

    /* ── note blocks ── */
    this._blocks = [];
    var self = this;

    function drawBlock(ev, live) {
      var lane = Timeline.laneOf(ev.midi, saMidi);
      if (lane === null) return;
      var x0 = toX(ev.startT);
      var x1 = toX(live ? Math.max(ev.lastValidT, ev.startT) : ev.endT);
      if (x1 < plotX - 4 || x0 > w + 4) return;
      var bw = Math.max(self.minBlockPx, x1 - x0);
      var bh = Math.max(4, laneH - 4);
      var y = lane * laneH + (laneH - bh) / 2;
      var radius = Math.min(3, bh / 2);
      var color = PITCH_COLORS[((ev.midi % 12) + 12) % 12];
      var isSim = ev.source === "simulation";

      ctx.save();
      if (isSim) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "#f472b6";
        ctx.lineWidth = live ? 2 : 1.5;
        ctx.fillStyle = "rgba(244, 114, 182, 0.13)";
        roundRect(ctx, x0, y, bw, bh, radius);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (live) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.92;
        roundRect(ctx, x0, y, bw, bh, radius);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "rgba(255,255,255,0.75)";
        ctx.lineWidth = 1;
        roundRect(ctx, x0, y, bw, bh, radius);
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.62;
        roundRect(ctx, x0, y, bw, bh, radius);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      /* Label when there's room. */
      var fontPx = Math.min(11, Math.max(8, bh - 3));
      ctx.fillStyle = live ? "#06110f" : (isSim ? "#f9a8d4" : "#0b1220");
      ctx.font = "600 " + fontPx + "px -apple-system, 'Segoe UI', Roboto, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      var swara = ev.swara;
      if (!swara && Number.isFinite(saMidi)) swara = FPA.Sargam.fromMidi(ev.midi, saMidi, ev.cents || 0);
      var label = (swara ? swara.compact : ev.noteLabel) || "";
      if (isSim) label += "·SIM";
      var labelW = ctx.measureText(label).width;
      if (bw > labelW + 10) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 + 3, y, bw - 6, bh);
        ctx.clip();
        ctx.fillText(label, x0 + 6, y + bh / 2 + 0.5);
        ctx.restore();
      }
      ctx.restore();

      self._blocks.push({
        x0: x0, x1: x0 + bw, y0: y, y1: y + bh,
        event: ev, live: !!live
      });
    }

    ctx.save();
    clipPlot();
    for (var i = 0; i < events.length; i++) drawBlock(events[i], false);
    if (activeEvent) drawBlock(activeEvent, true);
    ctx.restore();

    /* ── swara axis: gutter + row labels, drawn last so they stay readable ── */
    var activeLane = activeEvent ? Timeline.laneOf(activeEvent.midi, saMidi) : null;
    ctx.save();
    ctx.fillStyle = "rgba(7, 11, 15, 0.62)";
    ctx.fillRect(0, 0, AXIS_W, plotH);
    ctx.strokeStyle = "rgba(100, 116, 139, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(AXIS_W + 0.5, 0);
    ctx.lineTo(AXIS_W + 0.5, plotH);
    ctx.stroke();
    ctx.font = "600 10px ui-monospace, Menlo, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (var li = 0; li < LANES; li++) {
      if (activeLane === li) ctx.fillStyle = "#2dd4bf";
      else if (li === 0) ctx.fillStyle = "rgba(226, 232, 240, 0.82)";
      else ctx.fillStyle = "rgba(148, 163, 184, 0.72)";
      ctx.fillText(labels[li], AXIS_W - 6, li * laneH + laneH / 2 + 0.5);
    }
    ctx.restore();

    /* ── time labels in the bottom strip ── */
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(148, 163, 184, 0.5)";
    ctx.font = "10px ui-monospace, Menlo, monospace";
    for (var lt = firstTick; lt <= winEnd; lt += stepSec * 1000) {
      var lx = Math.round(toX(lt)) + 3;
      if (lx > w - 12) continue;
      ctx.fillText((lt / 1000) + "s", lx, h - 5);
    }
    ctx.restore();
  };

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ── hover tooltip ── */
  Timeline.prototype._bindTooltip = function () {
    var self = this;
    this.canvas.addEventListener("mousemove", function (ev) {
      if (!self.tooltip) return;
      var rect = self.canvas.getBoundingClientRect();
      var mx = ev.clientX - rect.left;
      var my = ev.clientY - rect.top;
      var hit = null;
      for (var i = self._blocks.length - 1; i >= 0; i--) {
        var b = self._blocks[i];
        if (mx >= b.x0 - 1 && mx <= b.x1 + 1 && my >= b.y0 && my <= b.y1) { hit = b; break; }
      }
      if (!hit) { self.tooltip.hidden = true; return; }
      var e = hit.event;
      var swaraText = e.swara ? e.swara.label + " (" + e.swara.registerLabel + ")" : "sargam pending";
      self.tooltip.innerHTML =
        (e.source === "simulation" ? '<div class="tt-sim">SIMULATED DATA</div>' : "") +
        "<strong>" + esc(e.noteLabel || "?") + "</strong> · " + esc(swaraText) + "<br>" +
        (Number.isFinite(e.freq) ? e.freq.toFixed(1) + " Hz · " + (Number.isFinite(e.cents) ? (e.cents >= 0 ? "+" : "") + e.cents.toFixed(0) + " ¢" : "") + "<br>" : "") +
        (hit.live
          ? "sustained " + ((e.lastValidT - e.startT) / 1000).toFixed(1) + " s (ongoing)"
          : "duration " + (e.durationMs / 1000).toFixed(2) + " s") +
        (Number.isFinite(e.confidence) && e.confidence ? "<br>confidence " + Math.round(e.confidence * 100) + "%" : "") +
        (Number.isFinite(e.stabilityCents) && e.stabilityCents ? "<br>pitch spread ±" + (e.stabilityCents / 2).toFixed(0) + " ¢" : "");
      self.tooltip.hidden = false;
      var tw = self.tooltip.offsetWidth, th = self.tooltip.offsetHeight;
      var tx = Math.min(rect.width - tw - 6, Math.max(4, mx + 14));
      var ty = Math.max(4, my - th - 10);
      self.tooltip.style.left = tx + "px";
      self.tooltip.style.top = ty + "px";
    });
    this.canvas.addEventListener("mouseleave", function () {
      if (self.tooltip) self.tooltip.hidden = true;
    });
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  Timeline.prototype.destroy = function () {
    global.removeEventListener("resize", this._onResize);
  };

  FPA.Timeline = Timeline;
  FPA.PITCH_COLORS = PITCH_COLORS;
})(typeof window !== "undefined" ? window : globalThis);
