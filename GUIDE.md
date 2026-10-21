# First-Time User Guide

**Flute Practice Analyzer** — a practice companion for bansuri / Indian bamboo flute.

It listens while you play and shows you three things:

1. **What note you are playing** (Western name + frequency + how many cents off)
2. **Which swara that is** in Sargam, relative to *your* Sa
3. **How long you sustained each note**, and how steady it was

You do **not** pick a flute key or a scale before you start. You just play, and the
app proposes your Sa. You decide.

---

## Part 1 · Before your first note (2 minutes)

**1. Start the app.** In a terminal:

```bash
cd "/Users/shubham/Desktop/Drive/Shubham/Basuri Practice"
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open **http://127.0.0.1:8765/** in your browser.

> Don't double-click `index.html` and open it as a file — browsers block the
> microphone that way. The `127.0.0.1` address above is what makes it work.

**2. Set up your space.** Pitch detection is only as good as the sound it hears:

- A **quiet room** matters more than anything else.
- Sit roughly **30–60 cm** from the microphone.
- Play **across** the mic, slightly off-axis — not straight into it. That avoids
  wind noise from your breath, which the detector can mistake for a note.
- Don't play louder than you need. Aim for a comfortable *mezzo* volume.

**3. A very important tip about tanpura.** This app has **no sound output** and does
not play a drone. If you practise along with a **tanpura on speakers**, the
microphone will hear the drone and may report it as notes. Use **headphones** for
your tanpura, or keep it very low and to one side. The app will only ever measure
what actually reaches the microphone.

---

## Part 2 · Your first session, step by step

### Step 1 — Turn on listening

Click **● Start microphone** (in the *Live practice* panel) and allow access.

The status line tells you exactly what is happening: *waiting for permission*,
*listening*, *denied*, *stopped*. If you deny by accident, the app tells you how to
re-allow it — nothing is broken.

### Step 2 — Give the app your Sa

**Two ways to set your Sa — pick whichever suits you.**

**A. Let the app propose it** (best for your own flute). Play **a comfortable long
note** — the pitch you naturally rest on, the one you would tune to — and **hold it
steady for about a second**. A candidate appears with its evidence:

> **Proposed Sa candidate**
> E4 · 330.44 Hz
> heard 4× · pitch spread ±11.2 ¢ · 8.5 s of tone

Then either:

- Click **Set this pitch as my Sa** to confirm it, or
- Click **Keep listening** to clear that evidence and keep listening — play your
  tonic again (use this if it proposed the wrong note), or
- Choose from **…or pick a recent stable detection** if one of your recent notes
  was the right one.

**B. Choose the pitch yourself.** Under **…or choose the pitch yourself**, open the
dropdown, pick a note (`D4 — 293.66 Hz`), then press **Set as Sa**. No playing
needed — handy when you already know your tonic. The list always matches the range
the detector accepts, is grouped by octave, and follows your A4 reference.
Scroll-proof by design: moving through the list does nothing until you click
**Set as Sa**.

> **About the manual list:** it holds equal-tempered reference pitches for your A4
> setting — a pitch *you declare*, not a measurement of your flute. Bamboo flutes
> are often a little flat or sharp of equal temperament; if you use the list and
> every swara then reads consistently, say, 20 ¢ off, that is why. Play and hold
> the note instead when you want the app to measure your flute's actual pitch.

Once confirmed, the chip changes to **confirmed**, the panel says how your Sa was
chosen (from your playing, from a recent detection, from the note list, or restored
from a saved preference), and the *Current note* panel starts showing Sargam as
well as the Western note.

Leave **"Remember my Sa in this browser"** ticked and your Sa will be restored
automatically next time you open the app.

### Step 3 — Play and watch

Once your Sa is set, the app folds the **My Sa (tonic)** panel down to its header
(after all, it is a one-time decision) so that the screen you actually watch is:

**My Sa + Live practice** (folded, one line each) → **Riyaz timeline** (full width)
→ **Current note** and **Session statistics** side by side.

That way the timeline, the note you are playing *right now*, and the session
figures stay on one screen while you play. Click **▴ / ▾** on any panel header to
fold or unfold it: **Live practice** and **Practice history** can be folded the
same way. Nothing is hidden permanently — every control is one click away.

Play anything — long tones, aroha–avaroha, a phrase, a composition. Watch the
**Current note** card:

| What you see | What it means |
|---|---|
| **Note name** (e.g. `F#4`) | The detected Western note and octave |
| **Frequency** (e.g. `369.9 Hz`) | The measured fundamental |
| **ref 440 Hz** | Your A4 tuning reference (changeable in Settings) |
| **Swara** (e.g. `komal Ga`) | The Sargam degree relative to your Sa |
| **Register** (e.g. `madhya saptak`) | Which octave — mandra / madhya / taar |
| **The ¢ needle** | How far you are from the nearest equal-tempered note, ±50 ¢ |
| **Sustained** | How long the note you are playing right now has been held |
| **Stability** | How steady the pitch is within this note (± cents) |
| **Level** | Input loudness in dBFS — a technical gauge, **not** a musical score |

The **●●●●●** dots next to "Current note" show detection confidence. Fewer dots
means the app is less sure — usually a quiet, breathy or unsteady note.

Under **Riyaz timeline** you will see blocks appear: **position = when the note
started, width = how long you held it**. The twelve rows are swaras counted up
from your Sa, with the Sargam names written down the left edge (**top row = Sa**),
so an aroha climbs downward through the rows. Hover any block to see its details.

Notes from different octaves share a row, because the rows are *swaras* rather
than absolute pitches — the register (mandra / madhya / taar) is written on the
block and in the tooltip. Until you confirm a Sa, the rows are labelled with
plain note names instead.

### Step 3b — Not playing? Try it anyway

Click **▶ Run simulation** to generate fake notes and explore every part of the
interface without touching your flute. Everything is labelled **SIMULATION**, and
simulated notes are never saved as real practice. Click **Stop simulation** when
done.

### Step 4 — Record a session

When you are ready to keep a record, click **▶ Start session**.

> **▶ Start session** stays greyed out until the microphone (or the simulation) is
> running — the app never records without a live source.

- **Pause** suspends recording (the live display keeps working) — useful for
  talking, tuning, or a break.
- **Stop & save** ends the session. If it contains notes, it is saved to
  **Practice history** straight away.

### Step 5 — Review

Look at **Session statistics**:

| Field | What it means |
|---|---|
| **Practice time** | Wall-clock length of the session (excluding pauses) |
| **Note time** | Total time you were actually sounding notes |
| **Note events** | How many distinct notes were detected |
| **Longest note** | Your single longest sustained note |
| **Average / Median note** | Typical note length |
| **Note duration distribution** | How your notes fall into <0.5s, 0.5–1s, 1–2s, 2–3s, 3–5s, 5s+ |
| **Swara usage** | Which swaras you played, the Western note name, and each one's longest sustain and share of detected note time. Rows are listed in **sargam order** (Sa → kRe → … → Ni), the same order as the timeline, so the table reads like the scale rather than a ranking |

Then click any session in **Practice history** to open its details, **Export JSON**
or **Export CSV** to save it, or **Delete session**.

---

## Part 3 · What you can actually do with this

### Tuning and intonation
- **See exactly how far off each note is** in cents, note by note, instead of
  guessing. The needle is your tuner, but it also tells you the swara.
- **Check your komal and tivra placement.** komal Ga, komal Ni, tivra Ma are the
  usual suspects — put them under the needle for a few long notes.
- **Find which notes drift.** Play a long tone and watch *Stability*: a steady
  ±3 ¢ is solid; a wandering ±20 ¢ means your embouchure/air is moving.
- **Verify your Sa.** If your "Sa" reads consistently +25 ¢, that may be you — or
  it may be your reference. Adjust the A4 reference in Settings if you tune to
  something other than 440 Hz.
- **Compare registers.** Is your taar Sa as true as your madhya Sa? Play both and
  compare the cents.

### Sustain and breath control (time, not breath)
- **Build long tones.** Watch *Sustained* climb in real time, then check
  *Longest note* after a session. This is the honest way to see progress.
- **Trust the connected notes.** If the detector briefly wobbles onto a
  neighbouring pitch and you come back to the same note, the app treats it as a
  disturbance and keeps **one** connected note (no ghost note, no split sustain).
  That window is the *Release grace* setting in the app.
- **Track it over weeks.** Export sessions and watch your *Longest note* and the
  `5s+` bucket grow. The distribution chart makes plateaus obvious.
- **Practise evenness.** Aim to move your notes from the `<0.5s` column into the
  `2–3s` and `3–5s` columns.

> Note: the app measures **how long you sounded a note**. It cannot see your
> breath, air pressure or embouchure. It will never claim to.

### Sargam and practice balance
- **See which swaras you neglect.** *Swara usage* lists every swara you played
  in sargam order (Sa → Ni) and shows at a glance which rows are missing or thin.
  That is your practice list.
- **Play aroha and avaroha** and watch the pattern take shape on the timeline as
  ascending and descending blocks.
- **Watch everything at once.** With your Sa set, the setup panels fold away and
  the timeline, the current note and the session statistics share one screen —
  keep the *Current note* card beside *Session statistics* while you play.
- **Check phrase shape.** The timeline shows whether you are actually holding
  notes or rushing through them.

### Review and share
- **Keep a record of every practice.** Sessions are stored in your browser and
  listed by date, with Sa, note count, note time and longest note.
- **Export a session as CSV** to open it in a spreadsheet, or **JSON** for a
  complete record.
- **Send your teacher** an exported session to show exactly what you practised.
- **Open an old session** to see its Sa, its swaras, and every note's
  frequency/duration — even if you have since changed your Sa (history is never
  rewritten).
- **Clear history** whenever you want; it's your data, stored only on your machine.

---

## Part 4 · Reading the notation

Swara names and their short codes:

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

Registers are written the way they are spoken, with the marker **before** the
swara for the lower octave and **after** it for the upper:

- `'Sa` — **mandra** (lower octave)
- `Sa` — **madhya** (middle octave)
- `Sa'` — **taar** (upper octave)

---

## Part 5 · Settings — when to touch what

Click **⚙ Settings**. Every setting applies immediately and is remembered.

| Setting | Change it when… |
|---|---|
| **A4 reference** | You tune to something other than 440 Hz (e.g. 432, or a fixed pitch) |
| **Min / Max frequency** | You play a very small or very large flute outside the default 120–1100 Hz |
| **Sensitivity** | The app misses your quiet notes (raise it) or picks up room noise/breath (lower it) |
| **Confidence** | You get jumpy, unreliable readings on breathy notes (raise it) |
| **Note onset** | Short notes are being missed (lower) or breath attacks create phantom notes (raise) |
| **Release grace** | One note is split into several by dropouts/flickers (raise) or two genuinely distinct notes merge into one (lower). Within this window a brief wrong-pitch disturbance is ignored and the sustained note stays connected |
| **Timeline window** | You want to see more or less history on screen (10–120 s) |

**Restore defaults** puts everything back. If readings feel "off" after fiddling,
that's the button to press.

---

## Part 6 · Honest limits — so you read the numbers correctly

- **Gaps in the timeline are not silence.** They usually mean the detector was not
  confident enough to commit. Slow down or play more steadily and they fill in.
- **The Level (dBFS) meter is not a musical judgement.** It exists only to help you
  set the microphone distance. Louder is not better.
- **Confidence is not skill.** It reflects how clean the sound was to analyse.
- **The app does not measure breath, air support, volume, tone quality, rhythm or
  tala.** Only pitch, cents, note durations and pitch stability.
- **A sustained block is an estimate of sounding duration**, derived from note-event
  timestamps — not from animation frames.
- **Simulation is fake.** Always labelled, never saved as real practice.

---

## Part 7 · A 5-minute practice to try everything

1. **Start microphone**, play and hold your natural Sa for ~2 seconds.
2. Press **Set this pitch as my Sa**.
3. Press **▶ Start session**.
4. Play a **long tone on Sa** — hold it as long as is comfortable, watching
   *Sustained* climb. Rest. Repeat three times.
5. Play a **slow aroha and avaroha** (Sa Re Ga Ma Pa Dha Ni Sa') at a steady pace.
6. Hold **komal Ga** and **komal Ni** for ~2 seconds each and check the cents needle.
7. Press **Pause**, then **Stop & save**.
8. Read *Longest note*, the duration distribution, and *Swara usage*.
9. Click the session in **Practice history** and press **Export CSV**.
10. Come back tomorrow — your Sa is remembered, and the history is waiting.

---

## Quick reference — buttons

| Button | What it does |
|---|---|
| **● Start microphone** | Begins live listening (asks permission once) |
| **Stop microphone** | Releases the microphone completely |
| **▶ Start session** | Begins recording note events |
| **Pause** | Suspends recording; live display continues |
| **Stop & save** | Ends the session and saves it if it has notes |
| **▶ Run simulation** | Fake notes to explore the interface |
| **Set this pitch as my Sa** | Confirms the proposed tonic |
| **Keep listening** | Clears the current Sa evidence and keeps listening |
| **…or choose the pitch yourself** | Dropdown of equal-tempered reference pitches — pick one and press **Set as Sa** |
| **Change Sa / Clear** | Re-pick or remove your Sa (history is untouched) |
| **▴ / ▾** (panel header) | Folds that panel down to its header line, or opens it again — display only, nothing is lost |
| **⚙ Settings** | Detector and display options |
| **Export all (JSON)** | Downloads your entire session history |
| **Clear history** | Deletes all saved sessions (asks first) |

**Tip:** press **Escape** to close any dialog, or click the dark area behind it.
