/**
 * Oculus configuration.
 *
 * All tunable thresholds live here. Change these, reload, test.
 *
 * These defaults are an educated guess. The whole point of this beta is that
 * you use the product and the session exports tell you whether these numbers
 * are right for real readers. Expect to tune them.
 */
window.OCULUS_CONFIG = {

  // --- Sample smoothing (legacy name; now applies to classifier predictions) ---
  // The gaze pipeline keeps a rolling window of the last N per-frame
  // predictions and emits a brick id only if ≥ MIN_AGREE of them agree.
  // Bigger N = more stable but laggier.
  SAMPLE_SMOOTHING: 5,
  PREDICTION_SMOOTHING_WINDOW: 7,
  PREDICTION_SMOOTHING_MIN_AGREE: 4,

  // --- Dwell / stall detection ---
  // Minimum ms in a brick before it counts as "visited" (filters flyover).
  DWELL_MS_MIN: 400,

  // A brick is "stalled" when actual dwell exceeds expected dwell by this
  // multiplier. E.g. expected=6000ms, multiplier=1.6 → stall at 9600ms.
  STALL_MULTIPLIER: 1.6,

  // --- Regression detection ---
  // When the reader returns to a previously-visited brick, count it as a
  // regression — but only if they've been away for at least this long.
  // Without the cooldown, every eye-jitter near a boundary fires false
  // regressions.
  REGRESSION_COOLDOWN_MS: 2000,

  // --- Hint triggering ---
  // A brick is considered "confusing" if either condition fires.
  CONFUSION_THRESHOLD: {
    stallsRequired: 1,
    regressionsRequired: 1,
  },

  // Once a hint fires, wait at least this long before firing another.
  // Otherwise an overwhelmed reader gets carpet-bombed with help.
  HINT_COOLDOWN_MS: 8000,

  // --- UI ---
  // Show the gaze cursor by default? User can toggle at runtime.
  SHOW_CURSOR_DEFAULT: true,

  // --- Telemetry ---
  // Update the right-pane telemetry every N ms. Lower = smoother, higher = cheaper.
  TELEMETRY_TICK_MS: 100,

  // Max event log entries to keep in DOM. Older entries scroll off.
  EVENT_LOG_MAX: 100,

  // =====================================================================
  //   v0.2 — MediaPipe + TensorFlow.js gaze pipeline
  // =====================================================================

  // --- MediaPipe Face Landmarker ---
  // Model is ~3-4MB, float16 quantized. Apache 2.0.
  FACE_LANDMARKER_MODEL_URL:
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  // WASM/JS binaries served alongside @mediapipe/tasks-vision from jsDelivr.
  MEDIAPIPE_WASM_URL:
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm',

  // --- Classifier ---
  // GAZE_MODE: backwards-compat default for GAZE_HEADS (see below).
  //   'regression':     predict (x, y) viewport coords, hit-test at read
  //                     time. Scroll-invariant, layout-agnostic.
  //   'classification': predict brick-id distribution directly. Requires
  //                     scroll lock; retrains on layout change.
  GAZE_MODE: 'regression',

  // GAZE_HEADS: optional multi-head ensemble. When set, Classifier trains
  // every head in the array on the same calibration data and reports
  // per-head predictions at inference. The FIRST head is primary (drives
  // events + cursor); remaining heads are monitored in telemetry and
  // logged to session export.
  //
  // When null/undefined (default), a single head is built from GAZE_MODE.
  //
  // Examples (uncomment to try):
  //   [{ tag: 'R', mode: 'regression' },
  //    { tag: 'C', mode: 'classification' }]
  //   [{ tag: 'R1', mode: 'regression' },
  //    { tag: 'R2', mode: 'regression', hiddenUnits: 32, lr: 0.005 }]
  GAZE_HEADS: null,

  FEATURE_VECTOR_DIM: 24,
  CLASSIFIER_HIDDEN_UNITS: 16,
  CLASSIFIER_EPOCHS: 50,
  CLASSIFIER_BATCH_SIZE: 16,
  CLASSIFIER_LEARNING_RATE: 0.01,

  // Calibration dot motion.
  //
  // The dot traces a smooth spiral: its radius follows a bell envelope
  // sin²(πt), which is 0 at t=0 and t=1 and peaks at t=0.5, while its
  // angular position advances continuously at FOLLOW_REVOLUTIONS per
  // total duration. No hold → move → return phase transitions — the
  // dot starts stationary-at-center (radius 0), eases outward, revolves,
  // and eases back to center. User's eyes follow naturally.
  FOLLOW_DURATION_MS: 2600,
  FOLLOW_REVOLUTIONS: 1.25,
  FOLLOW_RADIUS_RATIO: 0.35,
  // Classification mode only: if argmax probability < threshold, emit null.
  CONFIDENCE_THRESHOLD: 0.55,
  // Regression mode only: blink gate — if average EAR < this, emit null
  // so blink frames don't generate garbage coord predictions.
  REGRESSION_EAR_GATE: 0.16,

  // --- Calibration UX ---
  //   'grid'  — N×M dots at viewport-fixed positions on a blank overlay;
  //             user clicks each in sequence. No scroll, lesson-agnostic,
  //             dense uniform coverage of the regression output space.
  //             Default and recommended.
  //   'brick' — one dot per content brick placed at the brick's center;
  //             user clicks each. Auto-scrolls long lessons so each
  //             brick is in view. Scroll can corrupt samples if the
  //             user's eyes track the moving content.
  CALIBRATION_METHOD: 'grid',

  // Grid parameters (used when CALIBRATION_METHOD = 'grid')
  GRID_ROWS: 3,
  GRID_COLS: 3,
  // Edge margin as fraction of viewport (how close to the screen edge
  // the outermost dots get). 0.1 = 10% inset from each edge.
  GRID_EDGE_MARGIN_PCT: 0.1,

  // Per-dot sample collection (applies to both methods)
  SAMPLES_PER_BRICK: 50,
  SAMPLE_COLLECTION_DURATION_MS: 1500,
  // Face-detection prewarm: show the preview, wait for a stable face
  PREWARM_FACE_DETECTION_MS: 1500,
  PREWARM_MAX_WAIT_MS: 15000,
  // Count samples as "stable" when EAR > open-eye threshold for this long
  EAR_OPEN_THRESHOLD: 0.18,
  // "Elsewhere" collection during calibration
  ELSEWHERE_SAMPLE_DURATION_MS: 3000,
  // Minimum post-training validation accuracy before we leave calibration.
  // Below this, offer the user a recalibrate option.
  VALIDATION_ACCURACY_THRESHOLD: 0.7,

  // --- Blink detection ---
  EAR_BLINK_THRESHOLD: 0.22,
  EAR_CONSECUTIVE_FRAMES: 3,

  // --- v0.2 session-export ---
  // If true, include the full per-frame confidence stream in exports
  // (can be large; off by default).
  EXPORT_CONFIDENCE_STREAM: false,
};
