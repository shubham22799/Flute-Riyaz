# Flute Practice Analyzer

A browser-based riyaz companion for the Indian bamboo flute (bansuri).

It listens through your microphone, shows the **Western note** you are playing
(note + octave + frequency + how far off it is in cents), maps it to **Sargam**
relative to *your own* Sa, and measures how long each **sustained note** lasts.

There is **no backend, no build step, no package install and no frameworks**. It
is a folder of static files. Everything runs locally in your browser and nothing
is ever uploaded anywhere.

> **New here?** Read **[GUIDE.md](GUIDE.md)** — a step-by-step first-time
> walkthrough: what to do before your first note, how to set your Sa, and what you
> can actually practise with this.

> **Online version:** **<https://shubham22799.github.io/Flute-Riyaz/>** — the same
> static files, published with GitHub Pages. It is served over **https**, so the
> microphone works there (which `file://` pages usually do not). Open it on your
> phone, press **Start microphone**, and practise.

---

## 1. Quick start

Microphone access (`getUserMedia`) is only granted in a *secure context*. Opening
the page as a `file://` file may be blocked by the browser, so serve the folder
over localhost:

```bash
cd "Basuri Practice"
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open:

```
http://127.0.0.1:8765/
```

That is it. Python 3 is the only requirement (it ships with macOS). Any static
file server works.

> **If you edit a file while the page is open**, bump the `?v=` number on the
> `<script>` tags in `index.html` (or hard-reload with `Cmd/Ctrl + Shift + R`).
> Static servers send `Last-Modified`, and browsers happily reuse a cached script
> until its URL changes.

### Use it on your phone

The app is a static page, so it runs from any web server — including GitHub
Pages. Serve it over **https://** (or `http://localhost`): browsers only allow
microphone access in a secure context, which is why opening `index.html` from
disk usually fails with a permission error.

On a phone: open the page, press **Start microphone** (the browser asks for
permission once), then **Start session** to record. iOS Safari keeps the audio
engine paused unless the microphone is started from that button press, which is
why the app wakes the audio context inside the click handler and resumes it
when you come back to the tab. The app can also be added to the home screen
(it ships a web manifest and an icon) and then opens fullscreen.

There is **no demo mode**: every value on screen is measured from your
microphone. If the mic is blocked or silent, the app says so instead of
showing something invented.

---

## 2. What it does

| Capability | Detail |
|---|---|
| Pitch detection | YIN-style (CMND) fundamental estimation with parabolic refinement, ~33 analyses/second |
| Western display | Note name + octave, frequency in Hz, deviation in cents from equal temperament |
| Sa discovery | Watches for a stable note, *proposes* it as Sa, and lets **you** confirm, change, clear — or **pick the pitch manually from a note list** (equal-tempered reference, no playing required) |
| Sargam display | 12-semitone Sargam including komal/tivra, with mandra / madhya / taar register markers |
| Sustain analysis | Per-note duration, the longest sustain, and the distribution of note lengths. Wrong-pitch flickers and dropouts shorter than the release grace are absorbed, so one sustained note is recorded as **one** event |
| Session statistics | Practice time, note time, event count, longest / average / median note, a duration distribution, and a per-swara table (swara, **Western note name**, note count, total time, **max sustain**, share of note time) listed in **sargam order** (Sa → Ni) |
| Stability | Within-note pitch spread in cents and average detector confidence |
| Timeline | A 10–120 s scrolling swara map of your notes: position = start, width = sustained duration, row = swara degree counted up from your Sa (top row = Sa) |
| Session history | Saved locally in `localStorage`; browse, inspect, export (JSON / CSV) or delete |
| Exports | A single session or your entire history, as JSON or CSV |
| One-screen practice layout | The one-time setup panels (**My Sa**, **Live practice**) fold down to a single header line once Sa is set, so the **Riyaz timeline**, **Current note** and **Session statistics** (side by side) stay visible while you play |

### The important design rule

**You never pre-select a flute key, a scale, or a root note before playing.**

You just play. The app watches what you actually sustain, proposes the pitch that
behaves like a tonic, and asks you to confirm it. Changing your Sa later never
rewrites the notes you already recorded — every stored session keeps the Sa that
was active when it was played.

---

## 3. Using it

1. **Serve the folder** (section 1) and open the page.
2. Press **Start microphone** and allow access. The status bar tells you exactly
   what is happening at every step (requesting, active, denied, stopped).
3. Play a comfortable long note — the one you naturally rest on. Hold it steady
   for about a second.
4. The app proposes a **Sa candidate** with its evidence
   (*"heard 4× · pitch spread ±11.2 ¢ · 8.5 s of tone"*).
   Press **Set this pitch as my Sa** to confirm, or keep playing to collect more
   evidence. You can also pick a recent stable detection, **choose the pitch
   yourself from the note list** (an equal-tempered reference, no playing needed),
   or **Change Sa** / **Clear Sa** at any time.
5. Once Sa is confirmed, every note is shown as a Sargam swara as well.
6. Press **Start session** to begin recording. Play freely, in any order.
   **Pause** suspends recording while the live display keeps working.
   **Stop session** ends it and saves it (if it contains notes).
7. Review the stats, the swara table, and the timeline. Open **History** to
   revisit, export or delete past sessions.

### Reading the Sargam notation

Swara names (shuddha and vikrit):

| Semitone | Swara | Short |
|---:|---|---|
| 0 | Sa | `Sa` |
| 1 | komal Re | `kRe` |
| 2 | Re | `Re` |
| 3 | komal Ga | `kGa` |
| 4 | Ga | `Ga` |
| 5 | Ma | `Ma` |
| 6 | tivra Ma | `tMa` |
| 7 | Pa | `Pa` |
| 8 | komal Dha | `kDha` |
| 9 | Dha | `Dha` |
| 10 | komal Ni | `kNi` |
| 11 | Ni | `Ni` |

Register markers are written **positionally**, the way bansuri players say them:

* `'Sa` — **mandra** (lower octave), marker *before* the swara
* `Sa`  — **madhya** (middle octave)
* `Sa'` — **taar** (upper octave), marker *after* the swara

`k` = komal (flattened), `t` = tivra (raised, only used for Ma).

---

## 4. Honesty: what is measured and what is not

This matters for a practice tool, so the app is deliberately conservative.

**Measured from your microphone:**

* Fundamental frequency of the sounding note, and therefore the Western note,
  octave and cents deviation.
* When a sustained note starts and ends, and how long it was held.
* Within-note pitch spread (a measure of how steady the note was) and the
  detector's confidence in each estimate.

**Derived, and clearly labelled as such:**

* Sargam is a *mapping* of the measured pitch relative to the Sa **you**
  confirmed. It is not a separate measurement.
* The swara-usage percentages use *detected note time* as the denominator — the
  share of the time a note was sounding, not of the whole session. The table
  header states the denominator so the numbers can't be misread.

**NOT measured — the app will never claim otherwise:**

* **Breath, air pressure, embouchure or tone quality.** A microphone cannot see
  your breath. There is no "breath score" here.
* **Volume/loudness as musical feedback.** An input level in dBFS is shown only
  as a technical aid for setting the mic gain. It is not a musical judgement.
* **Rhythm, tempo or tala.** Only note durations are measured; there is no beat
  grid, and no claim about whether you were "in time".
* Absolute truth about intonation. Pitch detection on a flute is hard: the attack
  and release are noisy, harmonics can confuse a detector, and room noise
  interferes. The app reports what it measured, with a confidence value, and
  refuses low-confidence frames rather than guessing — so gaps in the timeline
  mean "the detector was not sure", not "you stopped playing".

Numbers are shown at a precision the detector can actually support (no
false-precision decimals), and every displayed value traces back to a real
measurement above.

---

## 5. Settings

Open the gear icon to tune the analysis. Defaults are sane for a bansuri in a
quiet room; they are starting points, not laws.

| Setting | Meaning |
|---|---|
| A4 reference | Tuning reference for the whole app (415–466 Hz) |
| Min / Max frequency | Accepted fundamental range (default 120–1100 Hz) |
| Sensitivity | Maps to the noise gate: low = rejects quiet/breathy frames, high = accepts softer notes |
| Confidence | Minimum periodicity clarity for a frame to be used |
| Note onset | How long a pitch must hold before a note is considered started |
| Release grace | Dropout **and wrong-pitch flicker** window: within it, brief disturbances are ignored and the sustained note stays connected |
| Timeline window | How many seconds the timeline shows (10–120 s) |

**Reset to defaults** restores everything. Settings are saved locally and restored
on the next visit.

---

## 6. Running the tests

The musical logic lives in pure, framework-free modules, and there is an
automated test suite for it (50 tests: pitch maths, the YIN detector, note-event
lifecycle and durations, Sargam mapping, Sa discovery, session statistics,
export formats, settings clamping, the simulation generator, and
null/missing-value safety).

**In the browser** (recommended — it exercises the real runtime):

```
http://127.0.0.1:8765/tests/index.html
```

**In Node** (no browser, same suite):

```bash
node tests/run.js
```

Both harnesses load the *same* `tests/suite.js`, which is runtime-agnostic. The
browser page also publishes the result on `window.__FPA_TEST_RESULTS__` so it can
be checked by automation.

---

## 7. Project layout

```
index.html            DOM contract (all element IDs) + script order
css/styles.css        dark, desktop-first theme
js/config.js          defaults, settings merge/clamp, sensitivity mapping
js/notes.js           MIDI / frequency / cents maths and formatters
js/sargam.js          semitone → swara table, registers, labels
js/pitch.js           YIN detector (CMND, parabolic refinement, octave guard) + smoother
js/audio.js           microphone lifecycle & teardown
js/sa.js              Sa candidate scoring, confirm / change / restore
js/tracker.js         note-event lifecycle: onset, sustain, grace-period dropout & flicker absorption
js/stats.js           pure statistics (explicit denominators)
js/history.js         localStorage persistence, session list, JSON/CSV export
js/timeline.js        canvas timeline renderer + hover tooltip
js/simulation.js      test-only frame generator (not reachable from the page)
js/ui.js              all DOM rendering & wiring (never computes musical values)
js/app.js             orchestrator: state machine, session clock, render loop
tests/index.html      browser test runner
tests/run.js          Node test runner
tests/suite.js        the shared test suite
```

### How a frame flows

```
mic frames (audio.js) ──► pitch.js (YIN detection + smoother) ─┐
                                                               ├─► tracker.js (note events)
                                                               │            │
                                                               │            ├─► app.js state
                                                               │            ├─► ui.js display
                                                               │            ├─► timeline.js canvas
                                                               │            └─► stats.js ─► history.js (export)
```

Modules attach to a single `FPA` namespace and are loaded as plain scripts (no
ES modules), so the page also works when opened directly from disk. `ui.js`
renders state and never computes musical values; `app.js` owns the pipeline.

Exposed for debugging/automation: `FPA.app._internal` gives access to the
detector options, the tracker, the Sa engine, the timeline events and the current
stats.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| "Microphone permission denied" | Allow mic access via the padlock icon in the address bar, then press **Start microphone** again |
| Mic does nothing | Make sure you opened `http://127.0.0.1:8765/`, not a `file://` path — secure context is required |
| Nothing appears while playing | Lower the **Sensitivity** threshold in settings, play a sustained note, and keep the room quiet |
| Values look like they lag | Detection runs ~33×/s; a short attack is intentionally ignored until the note stabilises |
| Edits don't show up | Bump `?v=` in `index.html`, or hard-reload |
| Timeline empty | The timeline only shows detected notes; raise sensitivity if your notes are being rejected |

---

## 9. Privacy

* Audio is analysed in memory, frame by frame. Nothing is recorded to a file and
  nothing is transmitted.
* There is no network activity after the page loads (no CDN, no fonts, no
  analytics).
* Saved sessions and settings live only in your browser's `localStorage`
  (`fpa.history.v1`, `fpa.settings.v1`). Deleting a session — or clearing
  history — removes it permanently. "Export" is the only way data leaves the
  browser, and it is a file you download yourself.

---

## 10. Build phases

The app was built in deliberate phases so each layer could be verified before the
next was added.

1. **Phase 1 — wireframe & DOM contract.** Complete, styled interface with every
   element ID defined, so the rendering layer and the logic layer could be
   developed independently against a fixed contract.
2. **Phase 2 — pure logic.** Pitch maths, Sargam mapping, the YIN detector, the
   note tracker, Sa discovery and statistics, all as testable modules.
3. **Phase 3 — audio & orchestration.** Microphone lifecycle, the frame pipeline,
   session clock, state machine and render loop.
4. **Phase 4 — persistence & insight.** Local history, session browsing, stats
   tables, the timeline canvas, and JSON/CSV export.
5. **Phase 5 — harden & verify.** Simulation mode, null/edge-value safety, the
   automated test suite, and end-to-end browser verification of every user flow
   (mic, denied mic, simulation, Sa confirm, recording, save, export, delete,
   settings).

Each phase required the previous phase's tests to pass before it was considered
done, so the musical logic has had no regressions since it was written.
