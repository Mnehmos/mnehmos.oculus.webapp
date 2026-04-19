/**
 * Gaze pipeline (v0.2).
 *
 * Called once per animation frame. Owns the full
 *   MediaPipe → Features → Classifier → brick-id
 * chain and emits a brick id (or null) to the event layer.
 *
 * The v0.1 module smoothed raw (x,y) samples and hit-tested against the
 * brick grid. In v0.2 the classifier emits brick probabilities directly —
 * the temporal-smoothing step now operates on predicted brick ids
 * (majority vote over the last N frames) rather than coordinates.
 *
 * The cursor, if enabled, is positioned at the center of the current
 * predicted brick. It's a hint of where the classifier thinks the reader
 * is looking, not a pixel-accurate gaze point.
 *
 * Depends on window.FaceLandmarker, window.Features, window.Classifier
 * and the #oculus-video element.
 */

window.Gaze = {

  // Rolling window of recent predicted brick ids for majority-vote smoothing.
  _recentPredictions: [],

  // Latest per-frame telemetry exposed for the right pane to render.
  lastPrediction: {
    brickId: null,            // post-smoothing id (or null if uncertain)
    rawBrickId: null,         // argmax of latest distribution (pre-smoothing)
    confidence: 0,            // max prob of latest distribution
    distribution: {},         // full {brickId: prob}
    headPose: { yaw: 0, pitch: 0, roll: 0, distance: 0 },
    features: null,
    earAvg: 0,
    tsMs: 0,
    faceDetected: false,
  },

  _lastTs: 0,

  reset() {
    this._recentPredictions = [];
    this._lastTs = 0;
    this.lastPrediction = {
      brickId: null,
      rawBrickId: null,
      confidence: 0,
      distribution: {},
      headPose: { yaw: 0, pitch: 0, roll: 0, distance: 0 },
      features: null,
      earAvg: 0,
      tsMs: 0,
      faceDetected: false,
    };
  },

  /**
   * Run one full pipeline tick.
   *
   * @returns the resolved brick id (string) or null.
   * Side effects:
   *   - updates this.lastPrediction for telemetry to read
   *   - positions the gaze cursor if showCursor
   */
  tick(cursorEl, showCursor) {
    const cfg = window.OCULUS_CONFIG;
    const now = performance.now();
    const ts = Math.max(this._lastTs + 1, Math.floor(now));
    this._lastTs = ts;

    const result = window.FaceLandmarker.detectFrame(ts);
    const features = window.Features.extract(result);

    if (!features) {
      // No face — push a 'null' vote into the smoothing window so that
      // sustained face-absence flushes any lingering brick prediction.
      this._pushPrediction(null);
      this.lastPrediction.brickId = this._majorityVote();
      this.lastPrediction.rawBrickId = null;
      this.lastPrediction.confidence = 0;
      this.lastPrediction.distribution = {};
      this.lastPrediction.features = null;
      this.lastPrediction.earAvg = 0;
      this.lastPrediction.tsMs = ts;
      this.lastPrediction.faceDetected = false;
      return this.lastPrediction.brickId;
    }

    const normalized = window.Features.normalize(features);
    const distribution = window.Classifier.predict(normalized);

    const raw = window.Classifier.argmax(distribution);   // null if low-conf
    this._pushPrediction(raw);
    const smoothed = this._majorityVote();

    // Compute max-prob for confidence display
    let maxProb = 0;
    for (const p of Object.values(distribution)) {
      if (p > maxProb) maxProb = p;
    }

    // Head pose is features[6..9]: yaw, pitch, roll, distance
    const headPose = {
      yaw:      features[6],
      pitch:    features[7],
      roll:     features[8],
      distance: features[9],
    };

    this.lastPrediction.brickId       = smoothed;
    this.lastPrediction.rawBrickId    = raw;
    this.lastPrediction.confidence    = maxProb;
    this.lastPrediction.distribution  = distribution;
    this.lastPrediction.headPose      = headPose;
    this.lastPrediction.features      = features;
    this.lastPrediction.earAvg        = (features[4] + features[5]) / 2;
    this.lastPrediction.tsMs          = ts;
    this.lastPrediction.faceDetected  = true;

    // Move cursor to the center of the predicted brick (if any)
    if (cursorEl) {
      if (showCursor && smoothed) {
        const brickEl = document.querySelector(`.brick[data-brick-id="${smoothed}"]`);
        if (brickEl) {
          const rect = brickEl.getBoundingClientRect();
          cursorEl.style.left = (rect.left + rect.width / 2) + 'px';
          cursorEl.style.top  = (rect.top  + rect.height / 2) + 'px';
          cursorEl.classList.remove('hidden');
        } else {
          cursorEl.classList.add('hidden');
        }
      } else {
        cursorEl.classList.add('hidden');
      }
    }

    return smoothed;
  },

  _pushPrediction(id) {
    const cfg = window.OCULUS_CONFIG;
    this._recentPredictions.push(id);
    while (this._recentPredictions.length > cfg.PREDICTION_SMOOTHING_WINDOW) {
      this._recentPredictions.shift();
    }
  },

  /**
   * Return the brick id that appears ≥ MIN_AGREE times in the window.
   * null if no id meets the threshold or the window is dominated by nulls.
   */
  _majorityVote() {
    const cfg = window.OCULUS_CONFIG;
    const counts = {};
    for (const id of this._recentPredictions) {
      // null votes count toward "no brick" — don't increment any id counter
      if (id === null) continue;
      counts[id] = (counts[id] || 0) + 1;
    }
    let bestId = null, bestCount = 0;
    for (const id of Object.keys(counts)) {
      if (counts[id] > bestCount) { bestCount = counts[id]; bestId = id; }
    }
    return bestCount >= cfg.PREDICTION_SMOOTHING_MIN_AGREE ? bestId : null;
  },
};
