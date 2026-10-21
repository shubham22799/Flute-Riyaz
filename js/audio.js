/* ═══════════════════════════════════════════════════════════════════
   audio.js — microphone lifecycle manager.

   States: idle | requesting | active | denied | unsupported | error | stopped

   • getUserMedia only after an explicit user action.
   • Audio processing hints disabled for analysis fidelity.
   • Full teardown (tracks stopped, nodes disconnected, context closed).
   • Reads time-domain frames via AnalyserNode.getFloatTimeDomainData.
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";
  var FPA = (global.FPA = global.FPA || {});

  function AudioInput() {
    this.state = "idle";
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.source = null;
    this.frame = null;
    this.sink = null;             // muted <audio> element (iOS keeps the mic flowing)
    this.sampleRate = 0;
    this.onStateChange = null;   // callback(state, info)
    this.lastError = null;
  }

  AudioInput.isSupported = function () {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
              (global.AudioContext || global.webkitAudioContext));
  };

  AudioInput.prototype._setState = function (state, info) {
    this.state = state;
    if (typeof this.onStateChange === "function") this.onStateChange(state, info || {});
  };

  /*
   * Request permission and build the analysis pipeline.
   * Resolves { ok, state, message } — never throws to callers.
   */
  AudioInput.prototype.start = async function (fftSize) {
    if (!AudioInput.isSupported()) {
      this._setState("unsupported");
      return { ok: false, state: "unsupported",
        message: "This browser does not support the Web Audio API / microphone capture. Try an up-to-date Chrome, Edge, Firefox or Safari." };
    }
    if (this.state === "active") return { ok: true, state: "active" };

    this._setState("requesting");

    /*
     * The AudioContext is created and resumed SYNCHRONOUSLY, before the
     * permission await — iOS Safari only allows that inside the user gesture
     * that pressed the button, and a context created after the await usually
     * stays suspended (the analyser then reads silence).
     */
    if (this.ctx && this.ctx.state !== "closed") {
      try { this.ctx.close(); } catch (e) { /* already closed */ }
      this.ctx = null;
    }
    var Ctx = global.AudioContext || global.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === "suspended") {
      try { this.ctx.resume(); } catch (e) { /* resumed on a later gesture */ }
    }
    this.sampleRate = this.ctx.sampleRate;

    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        },
        video: false
      });
      this.stream = stream;

      /* One more resume attempt: the gesture is over, but the page is live. */
      if (this.ctx.state === "suspended") {
        try { await this.ctx.resume(); } catch (e) { /* reported below */ }
      }
      if (this.ctx.state === "suspended") {
        /* Honest failure: a paused engine would only ever deliver silence. */
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        this.stream = null;
        this._setState("error");
        return { ok: false, state: "error",
          message: "The browser kept the audio engine paused. Press Stop microphone, then press Start microphone again to wake it up." };
      }

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = fftSize || FPA.DEFAULTS.detector.fftSize;
      this.analyser.smoothingTimeConstant = 0;   // we do our own smoothing
      this.source = this.ctx.createMediaStreamSource(stream);
      this.source.connect(this.analyser);        // NOT connected to speakers → no feedback

      this.frame = new Float32Array(this.analyser.fftSize);

      /* iOS quirk: a captured track only keeps flowing when it is attached to
         a media element as well. It stays muted, so nothing is played back. */
      this._attachSink(stream);

      /* iOS suspends the context when the app is backgrounded; wake it up. */
      this._bindVisibility();

      /* Honest surface for tracks ending externally (device unplugged etc.). */
      var self = this;
      stream.getAudioTracks().forEach(function (t) {
        t.addEventListener("ended", function () {
          if (self.state === "active") {
            self._setState("error", { message: "The audio input ended unexpectedly (device unplugged or claimed by another app)." });
          }
        });
      });

      this._setState("active", { sampleRate: this.sampleRate });
      return { ok: true, state: "active", sampleRate: this.sampleRate };
    } catch (err) {
      this.lastError = err;
      var name = err && err.name ? err.name : "Error";
      if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
        this._setState("denied", { error: err });
        return { ok: false, state: "denied",
          message: "Microphone permission was denied. Click the padlock/camera icon in the address bar, allow the microphone, then press Start microphone again." };
      }
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        this._setState("error", { error: err });
        return { ok: false, state: "error", message: "No microphone was found on this device. Connect a microphone (or enable the built-in one) and try again." };
      }
      if (name === "NotReadableError" || name === "TrackStartError") {
        this._setState("error", { error: err });
        return { ok: false, state: "error", message: "The microphone is already in use by another application. Close other audio apps and try again." };
      }
      this._setState("error", { error: err });
      return { ok: false, state: "error",
        message: "Could not start the microphone (" + name + "). Serve this page over https:// or http://localhost — browsers block microphone access on ordinary file:// pages." };
    }
  };

  /*
   * iOS Safari: a captured microphone track can stop feeding the Web Audio
   * graph unless it is attached to a media element as well. The element stays
   * muted, so nothing is ever played back.
   */
  AudioInput.prototype._attachSink = function (stream) {
    if (typeof document === "undefined" || !stream) return;
    try {
      var sink = document.createElement("audio");
      sink.muted = true;
      sink.setAttribute("playsinline", "");
      sink.srcObject = stream;
      var p = sink.play();
      if (p && typeof p.catch === "function") p.catch(function () { /* autoplay blocked */ });
      this.sink = sink;
    } catch (e) { /* not supported here — harmless */ }
  };

  /*
   * Mobile browsers suspend the audio context while the app is in the
   * background; resume it when the page becomes visible again.
   */
  AudioInput.prototype._bindVisibility = function () {
    if (typeof document === "undefined" || this._visibilityBound) return;
    this._visibilityBound = true;
    var self = this;
    document.addEventListener("visibilitychange", function () {
      if (self.state === "active" && self.ctx && self.ctx.state === "suspended") {
        try { self.ctx.resume(); } catch (e) { /* needs a user gesture */ }
      }
    });
  };

  /*
   * Copy the newest time-domain frame. Returns false when no audio is flowing.
   * Caller owns throttle timing; this only reads the current analyser window.
   */
  AudioInput.prototype.readFrame = function () {
    if (this.state !== "active" || !this.analyser || !this.frame) return false;
    this.analyser.getFloatTimeDomainData(this.frame);
    return true;
  };

  /* Full teardown. Note: stop() must be safe to call repeatedly. */
  AudioInput.prototype.stop = function () {
    try {
      if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
    } catch (e) { /* already stopped */ }
    try {
      if (this.sink) { this.sink.pause(); this.sink.srcObject = null; this.sink = null; }
    } catch (e) { /* already detached */ }
    try { if (this.source) this.source.disconnect(); } catch (e) {}
    try { if (this.analyser) this.analyser.disconnect(); } catch (e) {}
    try { if (this.ctx && this.ctx.state !== "closed") this.ctx.close(); } catch (e) {}
    this.stream = null; this.source = null; this.analyser = null; this.ctx = null; this.frame = null;
    if (this.state !== "unsupported") this._setState("stopped");
  };

  FPA.AudioInput = AudioInput;
})(typeof window !== "undefined" ? window : globalThis);
