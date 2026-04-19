# mnehmos.oculus.webapp - Knowledge Base Document

## Quick Reference

| Property | Value |
|----------|-------|
| **Repository** | https://github.com/Mnehmos/mnehmos.oculus.webapp |
| **Primary Language** | JavaScript (Vanilla) |
| **Project Type** | Web Application |
| **Status** | Beta |
| **Last Updated** | 2026-04-19 |

## Overview

Oculus is a browser-based gaze-tracking pedagogy instrument. As of v0.2, it uses webcam gaze tracking via MediaPipe Face Landmarker (Apache 2.0) plus an in-browser TensorFlow.js MLP classifier (Apache 2.0) trained per-session on a per-brick calibration. The classifier emits a brick-probability distribution directly from geometric face features — no continuous (x,y) gaze, no hit-testing. Oculus decodes reading behavior into a stream of typed pedagogical events and offers context-specific hints in response to detected confusion signals (stalls, regressions). The entire system runs client-side with no backend, no accounts, and no data transmission beyond the initial load of static assets and libraries from CDNs. Oculus is designed as the attention-instrument counterpart to the Mnehmos ecosystem's other "LLM proposes, engine validates" systems: the engine decodes reader behavior into typed events, and (in future extensions) an LLM generates interventions in response.

**v0.1 → v0.2 migration:** v0.1 shipped with WebGazer.js, which was deprecated (maintenance ended February 2026) and carried a GPLv3 license incompatible with this repo's MIT. v0.2 is a full replacement of the gaze layer. Everything downstream of brick-id resolution (Events, Controller, Telemetry, Export) is unchanged.

## Architecture

### System Design

The application follows a client-side pipeline architecture organized around an animation-frame loop. MediaPipe Face Landmarker runs per-frame (~30Hz) on the webcam stream, returning 478 3D landmarks + 52 blendshape coefficients + a 4×4 facial transformation matrix. A feature extractor reduces this to a 24-dim vector invariant to face position/scale but sensitive to gaze direction and head pose. The per-session classifier maps that vector directly to a brick-probability distribution; argmax + confidence threshold yields a brick id (or null). A temporal majority vote over the last N predictions smooths the per-frame signal. Downstream, transitions between brick ids generate typed events (first_read, stall, regression) that feed the hint controller and the telemetry pane. The architecture is deliberately modular — each stage is a separate JavaScript module with a narrow responsibility and a minimal global interface — so individual stages can be tuned or replaced without touching the others. All tunable thresholds are centralized in `js/config.js`.

### Key Components

| Component | Purpose | Location |
|-----------|---------|----------|
| Config | Centralized tunable thresholds | `js/config.js` |
| Content | Lesson JSON loader and brick grid renderer | `js/content.js` |
| FaceLandmarker | MediaPipe wrapper; webcam + per-frame detection | `js/face_landmarker.js` |
| Features | 24-dim geometric feature vector + normalization | `js/features.js` |
| Classifier | TF.js MLP, per-session training + inference | `js/classifier.js` |
| Calibration | Per-brick calibration flow (7 phases) | `js/calibration.js` |
| Gaze | Per-frame pipeline tick + temporal majority vote | `js/gaze.js` |
| Events | Typed event detector — transitions to first_read/stall/regression | `js/events.js` |
| Controller | Hint-fire policy (when to show a hint based on event state) | `js/controller.js` |
| Telemetry | Live right-pane updates, heatmap, event log, confidence, head pose | `js/telemetry.js` |
| ExportSession | Session state → JSON blob download (includes classifier metadata) | `js/export.js` |
| App | Main entry, wires modules, owns the requestAnimationFrame loop | `js/app.js` |
| Landing | Lesson selector, browser capability check, consent note, start handoff | `index.html` |
| Reader | Calibration overlay + brick grid + telemetry pane | `app.html` |
| Lesson Data | JSON files defining lesson structure, bricks, and pre-authored hints | `content/lessons/*.json` |
| Tests | Synthetic fixtures + 3 unit/integration suites | `tests/` |

### Data Flow

```
Webcam
  ↓
FaceLandmarker.detectFrame(ts)     ← MediaPipe, ~30Hz, VIDEO mode, GPU delegate
  ↓
  ├── 478 3D face landmarks        ← 468 face-mesh + 10 iris
  ├── 52 blendshape coefficients   ← pre-computed eye/look signals
  └── facialTransformationMatrix   ← 4×4, canonical face → camera, in cm
  ↓
Features.extract(result)           ← 24-dim vector; see Appendix for layout
  ↓
Features.normalize(features)       ← z-score against calibration statistics
  ↓
Classifier.predict(normalized)     ← MLP softmax → { brickId: prob }
  ↓
Classifier.argmax(distribution)    ← apply CONFIDENCE_THRESHOLD (default 0.4)
                                     'elsewhere' → null so it doesn't propagate
  ↓
Gaze._majorityVote()               ← last N predictions;
                                     emit id if ≥ MIN_AGREE agree
  ↓
Events.processBrick(brickId)       ← transition logic (unchanged from v0.1):
                                      same brick  → accumulate dwell
                                      exit brick  → maybe emit 'stall'
                                      enter brick → emit 'first_read' or 'regression'
  ↓
  ├── Telemetry.tick()             ← every 100ms; updates metrics + heatmap +
  │                                   event log + confidence + head pose
  └── Controller.maybeFireHint(id) ← if stalls≥threshold or regressions≥threshold
        ↓                             and outside cooldown → fill hint slot
      DOM update (hint renders)

Session end:
  ExportSession.downloadAsFile()   ← packages full event log + per-brick stats +
                                     classifier metadata + normalization stats
                                     → JSON blob (schema: oculus/v0.2)
```

### The Brick Model

Lessons are authored as JSON files and rendered into a CSS Grid with 6 columns. Each brick declares:

- `id`: stable identifier (e.g. "B03", "H03")
- `type`: one of `opening | setup | equation | reveal | diagram | aside | synthesis | hint`
- `span`: grid span — `full` (6 cols) | `two-thirds` (4 cols) | `half` (3 cols) | `third` (2 cols)
- `expectedDwellMs`: for stall detection; a brick stalls when actual dwell exceeds this × STALL_MULTIPLIER
- `heading` (optional): rendered as h2
- `html`: brick body, raw HTML allowed

Hint bricks add:
- `hintFor`: the content brick ID this hint attaches to
- `label`: short display label (e.g. "Notice the algebra move")
- `html`: hidden at render time; revealed when the controller fires the hint

## API Surface

### Public Interfaces

All modules attach to `window` for easy access. There is no bundler or module system — scripts are loaded in order from `app.html`.

#### Module: `Content`

##### Method: `loadLesson(lessonId)`
- **Purpose**: Fetch and parse a lesson JSON file
- **Parameters**:
  - `lessonId` (string): filename stem, e.g. "gravity"
- **Returns**: Promise resolving to lesson object
- **Throws**: Error if lesson file not found

##### Method: `renderLesson(lesson, container, headerEls)`
- **Purpose**: Render a lesson into the brick grid DOM
- **Parameters**:
  - `lesson` (Object): lesson JSON as returned by loadLesson
  - `container` (Element): the `.brick-grid` element
  - `headerEls` (Object): `{ kicker, title, meta }` references
- **Returns**: void (DOM side effects)

##### Property: `availableLessons`
- Array of `{ id, title, subject }` describing lessons offered on the landing page

#### Module: `FaceLandmarker`

##### Method: `init()` (async)
- **Purpose**: Get webcam permission, open the stream into `#oculus-video`, load MediaPipe from jsDelivr, build the landmarker with GPU delegate (auto-falls-back to CPU).
- **Returns**: `{ ok: true }` on success; `{ ok: false, error, kind }` with `kind` ∈ `'camera' | 'mediapipe' | 'gpu'`.

##### Method: `detectFrame(timestampMs)`
- Runs one detection pass; returns the MediaPipe result or null.

##### Method: `destroy()`
- Closes the landmarker, stops the camera stream.

##### Method: `attachPreview(videoEl)`
- Pipes the current stream to an additional video element (used during calibration prewarm).

#### Module: `Features`

##### Method: `extract(result)`
- Returns a Float32Array(24) feature vector from a MediaPipe result, or null if no face.

##### Method: `computeNormalization(samples)`
- Computes per-dim mean + std from an array of feature vectors (called once at end of calibration).

##### Method: `normalize(features)`
- Applies z-score normalization using the stored statistics; identity if unset.

##### Method: `exportNormalization()` / `reset()`

#### Module: `Classifier`

##### Method: `build(brickIds)`
- Constructs a fresh MLP with input dim = `FEATURE_VECTOR_DIM`, one hidden layer of 16 units, and an output for each class label (including 'elsewhere').

##### Method: `train(featureRows, labels, onEpochEnd)` (async)
- Fits the model with validation split, Adam(0.01), categorical cross-entropy. Stores trainedAt, sample count, and a history summary on the module.

##### Method: `predict(normalizedFeatures)`
- Returns `{ brickId: prob }` distribution. Wrapped in `tf.tidy` to avoid tensor leaks in the 30Hz loop.

##### Method: `argmax(distribution)`
- Picks the top id if max-prob ≥ `CONFIDENCE_THRESHOLD`; returns null on low-confidence or when 'elsewhere' wins.

##### Method: `validate(featureRows, labels)` / `exportMetadata()` / `reset()`

#### Module: `Calibration`

##### Method: `run({ introEl, dotsEl, progressEl, gridEl })` (async)
- **Purpose**: Run the full per-brick calibration sequence (7 phases: prewarm, per-brick samples, elsewhere, training, validation).
- **Parameters**: options bag of DOM elements.
- **Returns**: `{ ok: true, accuracy: number }`. Rejects with a descriptive error on failure; rejects with `'User requested recalibration'` if validation was below threshold and the user chose to recalibrate.

#### Module: `Gaze`

##### Method: `tick(cursorEl, showCursor)`
- **Purpose**: Run the full per-frame pipeline (FaceLandmarker → Features → Classifier → majority vote).
- **Returns**: resolved brick id (string) or null.
- **Side effects**: updates `Gaze.lastPrediction` (read by Telemetry); positions the gaze cursor at the predicted brick's center if `showCursor`.

##### Property: `lastPrediction`
- `{ brickId, rawBrickId, confidence, distribution, headPose, features, earAvg, tsMs, faceDetected }` — the latest state of the pipeline for telemetry to read.

##### Method: `reset()`
- Clears the temporal-smoothing window.

#### Module: `Events`

##### Method: `init(brickElements)`
- **Purpose**: Initialize event state from the rendered brick DOM
- **Parameters**:
  - `brickElements` (NodeList): all `.brick` elements in the grid
- **Returns**: void

##### Method: `processBrick(newBrickId, onEvent)`
- **Purpose**: Process a gaze → brick resolution, detect transitions, fire events
- **Parameters**:
  - `newBrickId` (string | null): brick currently under gaze
  - `onEvent` (function): callback `(eventType, brickId, brickState) => void`
- **Returns**: void

##### Property: `state`
- `{ sessionStart, gazeSamples, currentBrick, currentBrickEnteredAt, visited, bricks, events }`
- Read by Telemetry and Controller

#### Module: `Controller`

##### Method: `maybeFireHint(brickId)`
- **Purpose**: Decide whether a brick's confusion signal is strong enough to fire its hint
- **Parameters**:
  - `brickId` (string): the brick to evaluate
- **Returns**: void (fills DOM hint slot on fire)

##### Method: `reset()`
- Resets hint fire count and last-fire timestamp

#### Module: `Telemetry`

##### Method: `init(els)`
- **Purpose**: Bind DOM element references
- **Parameters**:
  - `els` (Object): `{ elapsed, samples, current, dwell, visited, hints, confidence, headPose, heatmap, eventLog }`

##### Method: `tick()`
- Called every `TELEMETRY_TICK_MS`. Reads from Events.state and Controller.state, updates the DOM.

#### Module: `ExportSession`

##### Method: `toJSON(lessonId)`
- **Purpose**: Package current session state into a JSON-serializable object
- **Parameters**:
  - `lessonId` (string): the lesson the session was run against
- **Returns**: session data object

##### Method: `downloadAsFile(lessonId)`
- Triggers a browser download of the session JSON

### Configuration

All in `js/config.js` under `window.OCULUS_CONFIG`:

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PREDICTION_SMOOTHING_WINDOW` | number | 5 | Frames in the majority-vote window |
| `PREDICTION_SMOOTHING_MIN_AGREE` | number | 3 | Agreeing frames required to emit a brick id |
| `DWELL_MS_MIN` | number | 400 | Minimum ms to count as a visit |
| `STALL_MULTIPLIER` | number | 1.6 | Stall threshold vs expected dwell |
| `REGRESSION_COOLDOWN_MS` | number | 2000 | Grace period before re-entry counts as regression |
| `CONFUSION_THRESHOLD.stallsRequired` | number | 1 | Stalls to trigger hint |
| `CONFUSION_THRESHOLD.regressionsRequired` | number | 1 | Regressions to trigger hint |
| `HINT_COOLDOWN_MS` | number | 8000 | Minimum gap between hint fires |
| `FACE_LANDMARKER_MODEL_URL` | string | see file | MediaPipe `.task` model URL |
| `MEDIAPIPE_WASM_URL` | string | see file | MediaPipe WASM assets URL |
| `FEATURE_VECTOR_DIM` | number | 24 | Input dimension for the classifier |
| `CLASSIFIER_HIDDEN_UNITS` | number | 16 | Hidden layer width |
| `CLASSIFIER_EPOCHS` | number | 100 | Training epochs |
| `CLASSIFIER_BATCH_SIZE` | number | 16 | Training batch size |
| `CLASSIFIER_LEARNING_RATE` | number | 0.01 | Adam learning rate |
| `CONFIDENCE_THRESHOLD` | number | 0.4 | Min max-prob to trust a prediction |
| `SAMPLES_PER_BRICK` | number | 50 | Safety cap on per-brick calibration samples |
| `SAMPLE_COLLECTION_DURATION_MS` | number | 1500 | Time window for per-brick sample collection |
| `PREWARM_FACE_DETECTION_MS` | number | 3000 | Stable-face requirement before calibration proceeds |
| `PREWARM_MAX_WAIT_MS` | number | 15000 | Prewarm timeout |
| `EAR_OPEN_THRESHOLD` | number | 0.18 | EAR above which eyes count as open (prewarm gate) |
| `ELSEWHERE_SAMPLE_DURATION_MS` | number | 3000 | Elsewhere-phase collection duration |
| `VALIDATION_ACCURACY_THRESHOLD` | number | 0.7 | Min post-training accuracy; below it, offer recalibrate |
| `EAR_BLINK_THRESHOLD` | number | 0.22 | EAR below which a frame is a blink |
| `EAR_CONSECUTIVE_FRAMES` | number | 3 | Consecutive frames to confirm a blink |
| `EXPORT_CONFIDENCE_STREAM` | boolean | false | Include per-frame confidence in exports |
| `SHOW_CURSOR_DEFAULT` | boolean | true | Initial state of gaze cursor visibility |
| `TELEMETRY_TICK_MS` | number | 100 | Right-pane update frequency |
| `EVENT_LOG_MAX` | number | 100 | Max event log entries in DOM |

No environment variables. Fully client-side.

## Usage Examples

### Opening a Specific Lesson

The reader page accepts a `?lesson=...` query parameter. To link directly to the recursion lesson:

```
app.html?lesson=recursion
```

The landing page generates these links automatically from `Content.availableLessons`.

### Exporting and Analyzing a Session

After a session, click **Export Session**. You get a JSON file like:

```json
{
  "schema": "oculus/v0.1",
  "lessonId": "gravity",
  "exportedAt": "2026-04-19T12:34:56.789Z",
  "durationMs": 284500,
  "gazeSamples": 8532,
  "bricks": {
    "B01": { "type": "opening", "expectedDwell": 9000, "dwellTotal": 10200, "visits": 1, "regressions": 0, "stalls": 0 },
    "B02": { "type": "setup",   "expectedDwell": 7000, "dwellTotal": 14300, "visits": 2, "regressions": 1, "stalls": 1 },
    ...
  },
  "events": [
    { "t": 2.1, "type": "first_read", "brickId": "B01", "detail": "type=opening" },
    { "t": 12.4, "type": "first_read", "brickId": "B02", "detail": "type=setup" },
    { "t": 26.7, "type": "stall", "brickId": "B02", "detail": "dwell 14300ms (expected ~7000ms)" },
    { "t": 26.7, "type": "hint_fill", "brickId": "H02", "detail": "for B02" },
    ...
  ],
  "hintsFired": 2
}
```

This is the raw pedagogy dataset: per-brick dwell, typed event log, hint fires. Usable for offline analysis (which bricks cause the most trouble, does firing a hint reduce subsequent regressions, etc.).

### Adding a New Lesson

Create `content/lessons/mylesson.json` following the brick schema, then edit `js/content.js`:

```javascript
availableLessons: [
  { id: 'gravity',   title: '...', subject: 'Physics' },
  { id: 'recursion', title: '...', subject: 'Computer Science' },
  { id: 'mylesson',  title: 'My Lesson Title', subject: 'Topic' },
]
```

Reload the landing page. New lesson appears in the selector.

## Dependencies

### Runtime Dependencies

| Dependency | Source | License | Purpose |
|------------|--------|---------|---------|
| @mediapipe/tasks-vision@0.10.22 | jsDelivr (ES module, dynamic import) | Apache 2.0 | Face Landmarker — 478 landmarks + blendshapes + transform matrix |
| face_landmarker.task (float16) | Google Cloud Storage (mediapipe-models) | Apache 2.0 | The landmarker model, ~4MB, loaded once |
| @tensorflow/tfjs@4.22.0 | jsDelivr | Apache 2.0 | In-browser MLP training + inference |
| JetBrains Mono | Google Fonts | OFL-1.1 | UI font |
| Fraunces | Google Fonts | SIL | Display/prose font |

All runtime dependencies are permissively licensed (Apache 2.0 / OFL / SIL) and compatible with this repo's MIT license. **No GPLv3** — WebGazer was removed in v0.2 for exactly this reason.

No npm dependencies. No build step. No bundler. All assets loaded via `<script>` tag or dynamic `import()` at runtime.

### Development Dependencies

None. A simple HTTP server is sufficient.

| Tool | Purpose |
|------|---------|
| `npx serve` | Optional local dev server |
| Modern browser | Chrome, Firefox, Edge, or Safari with webcam |

## Integration Points

### Works With

Standalone. Oculus does not integrate directly with other Mnehmos projects at runtime, but shares design lineage with:

- **mnehmos.rpg.mcp** — the "LLM proposes, engine validates" architecture. Oculus is that architecture applied to reading attention instead of RPG mechanics.
- **mnehmos.worksheet.app (ProveCalc)** — also uses a typed-signal-in, typed-response-out pipeline with a deterministic validator layer.
- **mnehmos.sight.mcp** / **mnehmos.vision.cortex** / **mnehmos.screen.vision.webapp** — Oculus joins the "sight" family as the component that watches *the reader* rather than the screen or world.

A future extension could pipe Oculus session exports into an LLM-powered analysis tool for pedagogy research, or replace pre-authored hints with runtime LLM generation.

### External Services

No external services required for core function.

WebGazer.js and Google Fonts load from public CDNs on first visit. After that, the application runs offline.

## Development Guide

### Prerequisites

- Modern web browser with webcam (Chrome, Firefox, Edge, or Safari)
- Text editor for code modifications
- Optional: Node.js for local dev server

### Setup

```bash
git clone https://github.com/Mnehmos/mnehmos.oculus.webapp
cd mnehmos.oculus.webapp
# No dependencies to install
```

### Running Locally

```bash
# Option 1: serve (recommended)
npx serve .
# Open http://localhost:3000

# Option 2: Python
python -m http.server 8000
# Open http://localhost:8000

# Option 3: Open index.html directly
# Note: some browsers restrict webcam access on file:// URLs
```

### Testing

Automated unit + integration tests land in `tests/`. To run them:

```bash
python -m http.server 8765
# Open http://localhost:8765/tests/run_tests.html in Chrome
```

Test suites:
- `tests/unit/test_features.js` — feature-extraction math, normalization
- `tests/unit/test_classifier.js` — MLP build/train/predict/argmax
- `tests/unit/test_gaze_pipeline.js` — end-to-end with stubbed FaceLandmarker

Fixtures are synthesized programmatically in `tests/fixtures/generate_synthetic.js` — no webcam or real MediaPipe data needed.

Manual verification with a webcam:

1. Open in a browser with a webcam
2. Landing page should show two lessons. Both links should work.
3. Clicking a lesson → Reader page loads with brick grid visible behind the calibration overlay
4. Calibration phases:
   a. Prewarm: camera preview shows, "face detected — Xs stable" countdown
   b. Per-brick: each content brick highlights, click the amber dot, ~1.5s progress bar
   c. Elsewhere: "look away" 3s countdown
   d. Training: epoch/loss readout
   e. Validation: "Ready" or "Calibration a bit shaky" with accept/recalibrate
5. Gaze cursor snaps to predicted brick center; confidence reads in telemetry pane
6. As you read, bricks highlight as `gaze-active`, heatmap fills, confidence updates
7. Dwell on a single brick for much longer than its expected time. Stall event should fire, brick border turns orange, and (if a hint slot exists nearby) the hint fills.
8. Look ahead, then look back. Regression event should fire, brick border turns pink, hint fills if eligible.
9. Event log in right pane should show all events with timestamps.
10. Export Session button produces a JSON file with the full event record, classifier metadata, and normalization stats.

### Building

No build step. All files in the repo root and subdirectories are production-ready as-is.

```bash
# GitHub Pages deployment
# Enable GitHub Pages in repo settings, serving from main branch root.
# The site will be available at https://mnehmos.github.io/mnehmos.oculus.webapp/

# Other static hosts (Netlify, Vercel, Cloudflare Pages)
# Upload the repo contents. No build configuration needed.
```

## Maintenance Notes

### Known Issues

1. Webcam gaze accuracy degrades with head movement. A recalibrate button is provided but there's no automatic drift detection.
2. Gaze cursor occasionally jitters across brick boundaries near the edge, producing spurious transitions. `REGRESSION_COOLDOWN_MS` mitigates this for regressions but not for entries.
3. Session state is in-memory only. Reload loses everything except exported data.
4. Hint bricks are pre-authored per lesson. No LLM-generated hints yet.
5. Default thresholds are educated guesses. They likely need tuning per-lesson or per-reader-population based on real session data.
6. Mobile browsers generally don't work — webcam access is restricted and mobile gaze accuracy is poor.

### Future Considerations

1. **LLM-generated hints**: replace pre-authored hints with runtime generation given the reader's current brick and recent trace. Swap `_fillHint()` in `controller.js` for an API call.
2. **Session persistence**: optional localStorage write of event stream so reload can resume. Would require careful consent UX.
3. **Drift detection and auto-recalibration**: detect systematic bias in gaze sample → brick mapping, prompt recalibration or re-weight in flight.
4. **Word-level hit testing**: for readers on better hardware (or with calibration holding well), subdivide bricks into word spans for finer-grained attention.
5. **Hint effectiveness tracking**: did firing a hint reduce subsequent regressions/stalls on the same brick? This is measurable from the exported event stream; add it as a metric.
6. **Multi-lesson sessions**: stitch multiple lessons together with the event stream persisting across them.
7. **Teacher dashboard**: upload session exports, aggregate across a class, identify bricks that reliably produce confusion across readers.
8. **Integration with LLM tutor**: wire session events as the signal stream feeding a full LLM tutor with the same "engine validates, LLM proposes" architecture as mnehmos.rpg.mcp.

### Code Quality

| Metric | Status |
|--------|--------|
| Tests | Browser-run unit + integration suites in `tests/`; 26+ cases |
| Linting | None — vanilla JS without tooling |
| Type Safety | None — plain JS with JSDoc comments on each module |
| Documentation | JSDoc comments in every module + README + this document |

---

## Appendix: File Structure

```
mnehmos.oculus.webapp/
├── index.html                         # Landing page
├── app.html                           # Reader page
├── css/
│   ├── style.css                      # Shared theme variables
│   ├── landing.css                    # Landing-specific styles
│   └── app.css                        # Reader-specific styles
├── js/
│   ├── config.js                      # All tunable thresholds
│   ├── content.js                     # Lesson loader / renderer
│   ├── face_landmarker.js             # MediaPipe wrapper (v0.2)
│   ├── features.js                    # 24-dim feature extraction (v0.2)
│   ├── classifier.js                  # TF.js MLP (v0.2)
│   ├── calibration.js                 # Per-brick calibration flow
│   ├── gaze.js                        # Per-frame pipeline + temporal smoothing
│   ├── events.js                      # Typed event detector
│   ├── controller.js                  # Hint-fire policy
│   ├── telemetry.js                   # Live pane updates
│   ├── export.js                      # Session → JSON download
│   └── app.js                         # Main entry / wire-up
├── content/
│   └── lessons/
│       ├── gravity.json               # Physics lesson
│       └── recursion.json             # CS lesson
├── tests/
│   ├── run_tests.html                 # In-browser test runner
│   ├── fixtures/
│   │   └── generate_synthetic.js      # Synthetic MediaPipe fixture generator
│   └── unit/
│       ├── test_features.js
│       ├── test_classifier.js
│       └── test_gaze_pipeline.js
├── .gitignore
├── LICENSE                            # MIT
├── README.md                          # User-facing documentation
└── PROJECT_KNOWLEDGE.md               # This document

Lesson JSON Schema:
{
  id: string,                         // matches filename stem
  title: string,
  kicker: string,                     // shown above title (e.g. "Physics · Concept 4 of 12")
  prerequisites: string,
  estimatedMinutes: number,
  bricks: [
    {
      id: string,                     // e.g. "B01"
      type: "opening" | "setup" | "equation" | "reveal" | "diagram" | "aside" | "synthesis" | "hint",
      span: "full" | "two-thirds" | "half" | "third",
      expectedDwellMs?: number,       // required for non-hint bricks
      heading?: string,               // optional h2
      html?: string,                  // brick body HTML
      hintFor?: string,               // required for hint type — references a content brick ID
      label?: string                  // required for hint type — displayed when fired
    }
  ]
}

Feature Vector (24 dims, index → meaning):
  [0,1]   right iris relative x/y within the right eye rect
  [2,3]   left iris relative x/y within the left eye rect
  [4,5]   EAR right / left (Soukupová & Čech formula)
  [6,7,8] head yaw / pitch / roll (radians) from transform matrix
  [9]     head distance (cm)
  [10,11] face center x/y (nose-tip, normalized [0,1])
  [12,13] face width / height
  [14,15] blendshape eyeBlinkLeft / Right
  [16-23] blendshape eyeLookDown/In/Out/Up × Left/Right

Session Export Schema (v0.2):
{
  schema: "oculus/v0.2",
  lessonId: string,
  exportedAt: ISO8601,
  durationMs: number,
  gazeSamples: number,
  gazeArchitecture: "classifier_direct_v0.2",
  classifier: {
    featureDim: number,
    architecture: string,        // e.g. "24-16-16-8"
    classes: [string, ...],      // brick ids + 'elsewhere'
    trainedOn: number,           // sample count
    trainedAt: ISO8601,
    history: { finalLoss, finalAccuracy, finalValLoss, finalValAccuracy, epochs },
    validationAccuracy: number
  },
  featureNormalization: {
    mean: [number, ...24],
    std:  [number, ...24]
  },
  bricks: {
    [brickId]: { type, expectedDwell, dwellTotal, visits, regressions, stalls }
  },
  events: [
    { t: seconds, type: string, brickId: string, detail: string }
  ],
  hintsFired: number,
  confidenceStream: [...] | null   // when EXPORT_CONFIDENCE_STREAM = true
}
```

---

*Last updated: 2026-04-19*
*Repository: https://github.com/Mnehmos/mnehmos.oculus.webapp*
