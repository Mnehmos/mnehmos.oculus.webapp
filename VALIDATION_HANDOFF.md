# Oculus v0.2 — Ready for Validation

**Date:** 2026-04-19
**Branch:** `main`
**Handoff to:** Vario

---

## What changed

v0.2 is a full replacement of the gaze-tracking layer. Everything
downstream of brick-id resolution (Events, Controller, Telemetry,
Export) is **unchanged**.

| Before (v0.1) | After (v0.2) |
|---------------|--------------|
| WebGazer.js (GPLv3) from brown.edu CDN | MediaPipe Face Landmarker (Apache 2.0) from jsDelivr |
| Ridge regression → raw (x,y) gaze | Per-session TensorFlow.js MLP → brick probability distribution |
| 9-point calibration dots | Per-brick calibration (click each brick in turn) |
| elementsFromPoint hit-test | Classifier-direct AOI — no hit-test |
| Coordinate smoothing | Temporal majority vote on predicted brick ids |
| No confidence signal | Confidence threshold + temporal smoothing |
| Export schema `oculus/v0.1` | Export schema `oculus/v0.2` with classifier metadata |

**License:** 100% Apache 2.0 + MIT. No GPL dependencies anywhere. See §13 of `V02_HANDOFF_CLAUDE_CODE.md` for the full audit.

---

## How to validate

### 1. Pull the code

```bash
cd f:/Github/mnehmos.oculus.webapp
git pull origin main
```

### 2. Serve locally

```bash
python -m http.server 8000
```

The app is at `http://localhost:8000/`. You need a real server because
`getUserMedia` is blocked on `file://` URLs.

### 3. Run the automated tests (optional, ~30s)

Open `http://localhost:8000/tests/run_tests.html`. You should see 26+
green test rows:

- `features.js — extract()` — 8 cases on the feature-extraction math
- `features.js — normalization` — 4 cases on z-scoring round-trips
- `classifier.js — build() + predict()` — 4 cases on MLP structure
- `classifier.js — train()` — 3 cases training on synthetic data
- `gaze.js — pipeline integration` — 6 cases with stubbed FaceLandmarker

No webcam needed; these use synthetic MediaPipe fixtures.

### 4. Walk through a real session

1. Open `http://localhost:8000/` in Chrome on the webcam laptop.
2. Select **Gravity** lesson.
3. Calibration flow:
   - **Prewarm**: camera preview appears. Sit steady, wait for
     "face detected — 3.0s stable". Target: ≤ 15s.
   - **Per-brick**: each content brick lights up. Look at the amber
     dot, click it, wait for the short progress bar. Repeat for all
     content bricks.
   - **Elsewhere**: when prompted, look away from the screen or close
     your eyes for 3 seconds.
   - **Training**: epoch/loss readout for about 1–3 seconds.
   - **Validation**: should say "Ready" with accuracy ≥ 70%. If below
     threshold, choose "Continue anyway" for a first-pass run and note
     the accuracy for the report below.
4. Read the lesson. Verify:
   - [ ] Gaze cursor tracks your attention (snaps to predicted brick)
   - [ ] `confidence` in the telemetry pane reads > 0.5 most of the time
         (highlighted accent color when above threshold)
   - [ ] `head pose` updates as you turn your head
   - [ ] Heatmap fills in as you read
   - [ ] Typed events fire (watch event log — `first_read`, `stall`,
         `regression`)
   - [ ] Dwell on a brick long enough → stall fires → hint fills
   - [ ] Look back at a previous brick → regression fires
   - [ ] **Export Session** produces a JSON file; open it and verify the
         `classifier` section has sane training history and
         `featureNormalization` has 24-length arrays
5. Click **Recalibrate** in the footer and confirm the flow restarts
   cleanly (camera LED goes off, then on again).
6. Click **Home** and confirm the camera LED goes off.

---

## Pre-handoff checks (already run by the agent)

- [x] `node --check` passes on all `js/*.js` modules
- [x] Unit tests are runnable in `tests/run_tests.html`
- [x] Git history is clean with atomic commits per §12 of the handoff
- [x] No GPLv3 dependencies anywhere — `grep -r 'webgazer'` returns only
      documentation references
- [x] MediaPipe asset URLs all point to Apache-2.0-licensed sources
- [x] `LICENSE` file remains MIT (unchanged)
- [x] No `package.json` introduced — still no build step

---

## Known limitations (not blockers)

1. **Head movement degrades accuracy.** The classifier trains on the
   head pose at calibration time. Watch the `head pose` telemetry:
   if yaw/pitch drift beyond ~10°, recalibrate using the footer button.
2. **No cross-session persistence.** The classifier lives in memory
   only. Each new session requires fresh calibration. (IndexedDB
   persistence is deferred to v0.3 per handoff §11 item 5.)
3. **"Elsewhere" detection may be noisy in unusual lighting.** If you
   find the classifier calls bricks during moments you're looking off-
   screen, collect a longer elsewhere sample (raise
   `ELSEWHERE_SAMPLE_DURATION_MS` in `js/config.js`).
4. **GPU delegate may fall back to CPU** on some driver combinations.
   Check the console — a "GPU delegate failed, running on CPU" warning
   is expected on some laptops and does not block the session.
5. **First-load download** is ~4 MB for the `face_landmarker.task` model.
   Subsequent sessions hit the browser cache.

---

## Open questions flagged for Vario

Per handoff §11 — I did not silently decide these. Before shipping to
GitHub Pages I'd like your call on:

1. **Webcam preview during reading.** v0.1 showed a small corner preview.
   v0.2 currently does **not** — the preview appears only during
   calibration prewarm. If you want it back during reading, the work is
   minor (just position the existing `<video id="oculus-video">` element
   somewhere visible instead of off-screen).
2. **Model asset caching via service worker.** Currently relying on
   browser cache for the 4 MB `.task` file. A service worker would make
   subsequent loads work fully offline. Defer to v0.3?
3. **Metric units in telemetry.** MediaPipe gives head distance in cm.
   I expose it in `Gaze.lastPrediction.headPose.distance` but don't
   currently render it in the pane. Add a "distance: 58 cm" row?
4. **Multi-face handling.** Currently `numFaces: 1`. If two faces appear
   in frame, MediaPipe picks whichever it detected first. Worth
   alerting the user?

---

## If it doesn't work

Report console errors + a screenshot. Common failures:

- **No face detected in prewarm**: improve lighting; face the camera
  directly; make sure no HDMI / external camera is overriding the
  built-in webcam.
- **Validation accuracy consistently < 70%**: you moved your head
  during per-brick sampling. Redo with head still.
- **Laggy video / frame drops**: GPU delegate fell back to CPU. Check
  console for the warning. On weak laptops this is expected and
  acceptable for a pedagogy session.
- **Camera LED stays on after leaving the page**: the `beforeunload`
  hook should release it; if it doesn't, file a bug.

---

## What Vario decides after real-session validation

Once you've run a full session and can tell me whether the pedagogy
event stream *feels right* (stalls fire at actual confusion points, not
at brick boundaries; regressions are signal, not noise), I'll:

- Tune the config defaults based on what you observed
- Address the open questions above
- Tag `v0.2-beta` and push to GitHub Pages

If the classifier output is not usable (accuracy consistently low,
too much jitter, etc.), we have levers to pull: more calibration
samples per brick, a larger hidden layer, per-brick thresholds,
or reintroducing a position-based smoothing at the classifier output.

Pinging you now.
