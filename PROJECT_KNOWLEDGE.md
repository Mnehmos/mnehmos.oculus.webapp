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

Oculus is a browser-based gaze-tracking pedagogy instrument. It uses webcam gaze tracking (via WebGazer.js) to observe where a reader's attention falls across a structured lesson, decodes reading behavior into a stream of typed pedagogical events, and offers context-specific hints in response to detected confusion signals (stalls, regressions). The entire system runs client-side with no backend, no accounts, and no data transmission beyond the initial load of static assets and the WebGazer library from its CDN. Oculus is designed as the attention-instrument counterpart to the Mnehmos ecosystem's other "LLM proposes, engine validates" systems: the engine decodes reader behavior into typed events, and (in future extensions) an LLM generates interventions in response.

## Architecture

### System Design

The application follows a client-side pipeline architecture organized around a gaze-sample event loop. WebGazer.js provides raw 2D gaze samples at approximately 30Hz from the webcam. These samples flow through a multi-stage pipeline: smoothing (rolling average over the last N samples), hit-testing (mapping the smoothed position to a brick via `elementsFromPoint`), transition detection (distinguishing same-brick dwells from enter/exit events), typed event emission (first_read, stall, regression), controller policy (deciding when to fire hints), and telemetry rendering (updating the right-hand pane in real time). The architecture is deliberately modular — each stage is a separate JavaScript module with a narrow responsibility and a minimal global interface — so individual stages can be tuned or replaced without touching the others. All tunable thresholds are centralized in `js/config.js`.

### Key Components

| Component | Purpose | Location |
|-----------|---------|----------|
| Config | Centralized tunable thresholds (smoothing, stall multiplier, cooldowns, etc.) | `js/config.js` |
| Content | Lesson JSON loader and brick grid renderer | `js/content.js` |
| Calibration | Nine-point WebGazer calibration flow | `js/calibration.js` |
| Gaze | Sample smoothing and brick hit-testing | `js/gaze.js` |
| Events | Typed event detector — transitions to first_read/stall/regression | `js/events.js` |
| Controller | Hint-fire policy (when to show a hint based on event state) | `js/controller.js` |
| Telemetry | Live right-pane updates, heatmap, event log rendering | `js/telemetry.js` |
| ExportSession | Session state → JSON blob download | `js/export.js` |
| App | Main entry, wires modules together, binds UI controls | `js/app.js` |
| Landing | Lesson selector, browser capability check, consent note, start handoff | `index.html` |
| Reader | Calibration overlay + brick grid + telemetry pane | `app.html` |
| Lesson Data | JSON files defining lesson structure, bricks, and pre-authored hints | `content/lessons/*.json` |

### Data Flow

```
Webcam
  ↓
WebGazer.js (raw {x,y} gaze samples, ~30Hz)
  ↓
Gaze.processSample(x, y)           ← rolling average, returns smoothed position
  ↓
Gaze._brickAt(x, y)                ← elementsFromPoint → brick ID or null
  ↓
Events.processBrick(brickId)       ← transition logic:
                                      same brick  → accumulate dwell
                                      exit brick  → maybe emit 'stall'
                                      enter brick → emit 'first_read' or 'regression'
  ↓
  ├── Telemetry.tick()             ← every 100ms; updates metrics + heatmap + log
  └── Controller.maybeFireHint(id) ← if stalls≥threshold or regressions≥threshold
        ↓                             and outside cooldown → fill hint slot
      DOM update (hint renders)

Session end:
  ExportSession.downloadAsFile()   ← packages full event log + per-brick stats → JSON blob
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

#### Module: `Calibration`

##### Method: `run(webgazer, introEl, dotsEl, progressEl)`
- **Purpose**: Run the full 9-point calibration sequence
- **Parameters**: WebGazer instance + DOM elements for the calibration UI
- **Returns**: Promise resolving when all 9 points have been clicked

#### Module: `Gaze`

##### Method: `processSample(rawX, rawY, cursorEl, showCursor)`
- **Purpose**: Process one raw gaze sample
- **Parameters**:
  - `rawX, rawY` (number): raw sample from WebGazer
  - `cursorEl` (Element): gaze cursor DOM element to update
  - `showCursor` (boolean): whether to update cursor visibility
- **Returns**: Brick ID string or null (resolved from smoothed position)

##### Method: `reset()`
- Clears the sample smoothing buffer

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
  - `els` (Object): `{ elapsed, samples, current, dwell, visited, hints, heatmap, eventLog }`

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
| `SAMPLE_SMOOTHING` | number | 5 | Rolling-average window size |
| `DWELL_MS_MIN` | number | 400 | Minimum ms to count as a visit |
| `STALL_MULTIPLIER` | number | 1.6 | Stall threshold vs expected dwell |
| `REGRESSION_COOLDOWN_MS` | number | 2000 | Grace period before re-entry counts as regression |
| `CONFUSION_THRESHOLD.stallsRequired` | number | 1 | Stalls to trigger hint |
| `CONFUSION_THRESHOLD.regressionsRequired` | number | 1 | Regressions to trigger hint |
| `HINT_COOLDOWN_MS` | number | 8000 | Minimum gap between hint fires |
| `CALIBRATION_POINTS` | array | 9-point grid | Calibration dot positions as viewport fractions |
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

| Dependency | Source | Purpose |
|------------|--------|---------|
| WebGazer.js | `https://webgazer.cs.brown.edu/webgazer.js` | Webcam gaze tracking via ridge regression |
| JetBrains Mono | Google Fonts | UI font |
| Fraunces | Google Fonts | Display/prose font |

No npm dependencies. No build step. No bundler.

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

Automated tests are not currently implemented. Manual verification:

1. Open in a browser with a webcam
2. Landing page should show two lessons. Both links should work.
3. Clicking a lesson → Reader page loads with brick grid visible behind the calibration overlay
4. Calibration: click 9 dots in sequence. Progress updates. Overlay fades.
5. Gaze cursor appears, follows your eyes (with noise typical of webcam gaze)
6. As you read, bricks highlight as `gaze-active`, heatmap fills in the right pane
7. Dwell on a single brick for much longer than its expected time. Stall event should fire, brick border turns orange, and (if a hint slot exists nearby) the hint fills.
8. Look ahead, then look back. Regression event should fire, brick border turns pink, hint fills if eligible.
9. Event log in right pane should show all events with timestamps.
10. Export Session button produces a JSON file with the full event record.

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
| Tests | None — manual verification only |
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
│   ├── calibration.js                 # 9-point WebGazer calibration
│   ├── gaze.js                        # Smoothing + hit-testing
│   ├── events.js                      # Typed event detector
│   ├── controller.js                  # Hint-fire policy
│   ├── telemetry.js                   # Live pane updates
│   ├── export.js                      # Session → JSON download
│   └── app.js                         # Main entry / wire-up
├── content/
│   └── lessons/
│       ├── gravity.json               # Physics lesson
│       └── recursion.json             # CS lesson
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

Session Export Schema:
{
  schema: "oculus/v0.1",
  lessonId: string,
  exportedAt: ISO8601,
  durationMs: number,
  gazeSamples: number,
  bricks: {
    [brickId]: { type, expectedDwell, dwellTotal, visits, regressions, stalls }
  },
  events: [
    { t: seconds, type: string, brickId: string, detail: string }
  ],
  hintsFired: number
}
```

---

*Last updated: 2026-04-19*
*Repository: https://github.com/Mnehmos/mnehmos.oculus.webapp*
