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

      var Ctx = global.AudioContext || global.webkitAudioContext;
      this.ctx = new Ctx();
      this.sampleRate = this.ctx.sampleRate;

      /* Autoplay/energy policies can leave a fresh context suspended. */
      if (this.ctx.state === "suspended") {
        try { await this.ctx.resume(); } catch (e) { /* resumed on next gesture */ }
      }

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = fftSize || FPA.DEFAULTS.detector.fftSize;
      this.analyser.smoothingTimeConstant = 0;   // we do our own smoothing
      this.source = this.ctx.createMediaStreamSource(stream);
      this.source.connect(this.analyser);        // NOT connected to speakers → no feedback

      this.frame = new Float32Array(this.analyser.fftSize);

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
    try { if (this.source) this.source.disconnect(); } catch (e) {}
    try { if (this.analyser) this.analyser.disconnect(); } catch (e) {}
    try { if (this.ctx && this.ctx.state !== "closed") this.ctx.close(); } catch (e) {}
    this.stream = null; this.source = null; this.analyser = null; this.ctx = null; this.frame = null;
    if (this.state !== "unsupported") this._setState("stopped");
  };

  FPA.AudioInput = AudioInput;
})(typeof window !== "undefined" ? window : globalThis);
