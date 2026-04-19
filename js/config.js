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

  // --- Sample smoothing ---
  // Gaze samples arrive at ~30Hz and are noisy. We rolling-average over the
  // last N samples to get a stable cursor. Bigger N = smoother but laggier.
  SAMPLE_SMOOTHING: 5,

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

  // --- Calibration ---
  // 9-point grid as fractions of viewport (x, y).
  CALIBRATION_POINTS: [
    [0.1, 0.1], [0.5, 0.1], [0.9, 0.1],
    [0.1, 0.5], [0.5, 0.5], [0.9, 0.5],
    [0.1, 0.9], [0.5, 0.9], [0.9, 0.9],
  ],

  // How many gaze samples to feed WebGazer per calibration click.
  CALIBRATION_SAMPLES_PER_CLICK: 5,
  CALIBRATION_SAMPLE_INTERVAL_MS: 60,

  // --- UI ---
  // Show the gaze cursor by default? User can toggle at runtime.
  SHOW_CURSOR_DEFAULT: true,

  // --- Telemetry ---
  // Update the right-pane telemetry every N ms. Lower = smoother, higher = cheaper.
  TELEMETRY_TICK_MS: 100,

  // Max event log entries to keep in DOM. Older entries scroll off.
  EVENT_LOG_MAX: 100,
};
