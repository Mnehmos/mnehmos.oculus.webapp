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
  PREDICTION_SMOOTHING_WINDOW: 5,
  PREDICTION_SMOOTHING_MIN_AGREE: 3,

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
  FEATURE_VECTOR_DIM: 24,
  CLASSIFIER_HIDDEN_UNITS: 16,
  CLASSIFIER_EPOCHS: 100,
  CLASSIFIER_BATCH_SIZE: 16,
  CLASSIFIER_LEARNING_RATE: 0.01,
  // If argmax probability < threshold, emit null ("uncertain") instead of
  // a brick id. Prevents spurious transitions during saccades / blinks.
  CONFIDENCE_THRESHOLD: 0.4,

  // --- Calibration UX ---
  // Per-brick sample collection
  SAMPLES_PER_BRICK: 50,
  SAMPLE_COLLECTION_DURATION_MS: 1500,
  // Face-detection prewarm: show the preview, wait for a stable face
  PREWARM_FACE_DETECTION_MS: 3000,
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
