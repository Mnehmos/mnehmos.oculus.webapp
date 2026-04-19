# Oculus

A gaze-tracking pedagogy instrument. Webcam-only. Local processing. No servers, no accounts, no API calls.

Oculus watches where your eyes move across a lesson and offers context-specific hints at the moments it detects you're stuck — a stall, a regression, a dwell that exceeds what the content should take. The goal is the move a great 1:1 tutor makes: observe, adapt, intervene when it helps, stay quiet when it doesn't.

🔬 **[Use Now](https://mnehmos.github.io/mnehmos.oculus.webapp/)**

---

## Features

- **100% Client-Side**: Webcam processing happens in your browser via [WebGazer.js](https://webgazer.cs.brown.edu/). No data leaves your device.
- **Brick-Based Content Model**: Lessons are structured as paragraph-sized bricks. Webcam gaze resolves reliably at that granularity.
- **Typed Attention Events**: Reading behavior is decoded into a stream of typed events — `first_read`, `stall`, `regression`, `hint_fill`.
- **Contextual Hint Slots**: Every content brick can have an adjacent hint brick. Hints fill with pre-authored help when confusion is detected on the associated content.
- **Live Telemetry Pane**: See the system's model of your reading in real time — current brick, dwell time, heatmap, event log.
- **Session Export**: Every session can be exported as a JSON blob with the full typed-event record. This is the raw data for pedagogy research.
- **Two Starter Lessons**: Physics (gravity & equivalence principle) and Computer Science (recursion) ship by default. New lessons are JSON files — no code changes needed.

---

## Quick Start

1. Open the app in a desktop browser with a webcam (Chrome/Firefox/Edge/Safari, recent).
2. Pick a lesson from the landing page.
3. Click **Begin Calibration**. Look at each of nine dots and click them.
4. Read the lesson normally. Watch the telemetry pane fill up as the system builds its model of your attention.
5. If you stall or regress, an adjacent hint slot will fill.
6. Export the session at the end if you want the data.

---

## Architecture

```
oculus.webapp/
├── index.html                 # Landing page — lesson selector, consent, start
├── app.html                   # Reader — calibration overlay + brick grid + telemetry pane
├── css/
│   ├── style.css              # Shared theme variables
│   ├── landing.css            # Landing styles
│   └── app.css                # Reader styles
├── js/
│   ├── config.js              # Tunable thresholds (one place to edit)
│   ├── content.js             # Lesson loader + brick renderer
│   ├── calibration.js         # 9-point WebGazer calibration flow
│   ├── gaze.js                # Sample smoothing + brick hit-testing
│   ├── events.js              # Typed event detector
│   ├── controller.js          # Hint-fire policy
│   ├── telemetry.js           # Live pane updates, heatmap
│   ├── export.js              # Session → JSON download
│   └── app.js                 # Main entry, module wire-up
└── content/
    └── lessons/
        ├── gravity.json       # Physics lesson
        └── recursion.json     # CS lesson
```

### Data Flow

```
Webcam
  ↓
WebGazer (raw gaze sample, ~30Hz)
  ↓
Gaze.processSample()         ← smooths with rolling average
  ↓
Brick hit-test (elementsFromPoint)
  ↓
Events.processBrick()        ← transitions → typed events
  ↓
  ├── Telemetry.tick()       ← live pane + heatmap
  └── Controller.maybeFireHint()  ← policy decision
        ↓
      (fills hint slot if eligible)
```

### The Brick Model

Lessons are JSON files with an ordered list of **bricks**. Each brick has:

```javascript
{
  id: "B03",                  // stable identifier, shown in corner
  type: "equation",           // opening | setup | equation | reveal | diagram | aside | synthesis | hint
  span: "two-thirds",         // full | two-thirds | half | third (inside a 6-col grid)
  expectedDwellMs: 8000,      // stall detection threshold
  heading: "...",             // optional
  html: "..."                 // brick body content
}
```

Hint bricks are different — they declare `hintFor: "B03"` to attach to a content brick, and their `html` stays hidden until the system fires them.

### Typed Events

Reader behavior is decoded into events the controller can reason over:

| Event          | Fires when                                                       |
|----------------|------------------------------------------------------------------|
| `first_read`   | Reader enters a brick they haven't seen before                   |
| `regression`   | Reader returns to a brick after ≥2s away                         |
| `stall`        | Reader dwells on a brick ≥1.6× the expected dwell time           |
| `hint_fill`    | Controller fires a hint in response to confusion signal          |

---

## Tuning

All thresholds live in `js/config.js`. Expect to adjust them as you collect real-session data:

| Variable                          | Default | Controls                                          |
|-----------------------------------|---------|---------------------------------------------------|
| `SAMPLE_SMOOTHING`                | 5       | Rolling-average window for gaze cursor            |
| `DWELL_MS_MIN`                    | 400     | Minimum ms in a brick to count as "visited"       |
| `STALL_MULTIPLIER`                | 1.6     | Stall = dwell > expected × this                   |
| `REGRESSION_COOLDOWN_MS`          | 2000    | Grace period before re-entry counts as regression |
| `CONFUSION_THRESHOLD.stallsRequired` | 1    | Stalls needed on a brick to fire its hint         |
| `CONFUSION_THRESHOLD.regressionsRequired` | 1 | Regressions needed on a brick to fire its hint   |
| `HINT_COOLDOWN_MS`                | 8000    | Minimum gap between hint fires                    |

---

## Privacy

- **No backend.** The server serves static files only; everything reactive runs in your browser.
- **No external requests after first load.** WebGazer.js is fetched from a CDN on first visit; Google Fonts loads too. After that, the tab runs offline.
- **No gaze data is transmitted.** The webcam feed is processed in your browser's JS context and never sent anywhere.
- **Session data is ephemeral.** Closing the tab discards everything. The Export Session button downloads a JSON blob to your machine only.

---

## Development

No build step. Pure vanilla JS + CSS + HTML.

```bash
# Local development
npx serve .
# Open http://localhost:3000

# Or Python
python -m http.server 8000
# Open http://localhost:8000

# Or just open index.html in a browser — most features work, but some browsers
# restrict webcam access for file:// URLs. Use a real server for full function.
```

### Adding a Lesson

1. Create `content/lessons/{id}.json` following the schema in the existing lessons.
2. Add an entry to `Content.availableLessons` in `js/content.js`:
   ```javascript
   { id: '{id}', title: '...', subject: '...' }
   ```
3. Reload the landing page — your new lesson appears in the selector.

### Adding a Hint to a Brick

Inside a lesson JSON, add a brick with `type: "hint"` and `hintFor: "<content_brick_id>"`:

```json
{
  "id": "H03",
  "type": "hint",
  "span": "third",
  "hintFor": "B03",
  "label": "Notice the algebra move",
  "html": "<p>...</p>"
}
```

Place it immediately after the content brick it's paired with. The grid will render them side-by-side.

---

## Known Limitations

1. **Webcam gaze accuracy caps out around paragraph-scale bricks.** Word-level gaze tracking requires dedicated hardware (Tobii, EyeLink). Oculus is designed around the accuracy webcam gaze actually delivers.
2. **Calibration drift with head movement.** WebGazer's regression model assumes your head stays roughly still. Significant movement degrades accuracy. A recalibrate button is provided.
3. **No persistence across sessions.** Session data lives in memory and is lost on reload. Exports are the only mechanism to keep data.
4. **Pre-authored hints, not LLM-generated.** The beta ships with hand-written hints per brick. An LLM-generated variant is a natural next step once trigger policy is validated.

---

## The Bigger Picture

Oculus is part of a thesis the Mnehmos ecosystem has been testing across domains:

> **The LLM proposes, the engine validates, the database is the source of truth.**

In [mnehmos.rpg.mcp](https://github.com/Mnehmos/mnehmos.rpg.mcp), the engine enforces D&D rules while the LLM plays DM. In [mnehmos.worksheet.app (ProveCalc)](https://github.com/Mnehmos/mnehmos.worksheet.app), a SymPy/Pint sidecar validates engineering math while the LLM proposes equations. In Oculus, the engine decodes your gaze into typed events while the (future) LLM tutor generates the response.

Different domain, same architecture: typed signal in, typed response out, transparent state, no hallucination permitted at the layers where truth matters.

---

## Part of the Mnehmos Ecosystem

| Project | Description |
|---------|-------------|
| [mnehmos.rpg.mcp](https://github.com/Mnehmos/mnehmos.rpg.mcp) | Agentic embodied simulation kernel — the AI DM |
| [mnehmos.worksheet.app](https://github.com/Mnehmos/mnehmos.worksheet.app) | ProveCalc — engineering worksheet with validated math |
| [mnehmos.ooda.mcp](https://github.com/Mnehmos/mnehmos.ooda.mcp) | Full computer control MCP server |
| [mnehmos.multi-agent.framework](https://github.com/Mnehmos/mnehmos.multi-agent.framework) | Multi-agent coordination framework |
| [mnehmos.sight.mcp](https://github.com/Mnehmos/mnehmos.sight.mcp) | Computer vision MCP |
| [mnehmos.screen.vision.webapp](https://github.com/Mnehmos/mnehmos.screen.vision.webapp) | Screen-region vision for coding agents |

See [github.com/Mnehmos](https://github.com/Mnehmos) for the full set.

---

## License

MIT

---

*Built by [Mnehmos](https://github.com/Mnehmos) · [The Mnemosyne Research Institute](https://themnemosyneresearchinstitute.com)*
