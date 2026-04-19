/**
 * Gaze pipeline (v0.2).
 *
 * Called once per animation frame. Owns the full
 *   MediaPipe → Features → Classifier.predict → Classifier.resolve → brick-id
 * chain and emits a brick id (or null) to the event layer.
 *
 * Two modes are supported, transparently via Classifier.resolve():
 *   - regression: Classifier.predict returns {x, y} normalized viewport
 *     coords; Classifier.resolve denormalizes and hit-tests with
 *     elementsFromPoint against the live DOM. Scroll-invariant,
 *     layout-agnostic.
 *   - classification: Classifier.predict returns a {brickId: prob}
 *     distribution; Classifier.resolve applies the confidence threshold
 *     and returns argmax (or null for 'elsewhere' / low-confidence).
 *
 * Temporal smoothing is a majority vote over the last N resolved brick
 * ids, applied in both modes to reject single-frame outliers.
 *
 * Depends on window.FaceLandmarker, window.Features, window.Classifier,
 * and #oculus-video.
 */

window.Gaze = {

  _recentPredictions: [],

  lastPrediction: {
    brickId: null,             // post-smoothing id (or null)
    rawBrickId: null,          // pre-smoothing resolved id
    confidence: 0,             // max softmax prob (classification) or 1-err (regression proxy)
    distribution: {},          // full classification distribution, or {} in regression
    coords: null,              // regression only: { x, y } viewport pixels
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
      coords: null,
      headPose: { yaw: 0, pitch: 0, roll: 0, distance: 0 },
      features: null,
      earAvg: 0,
      tsMs: 0,
      faceDetected: false,
    };
  },

  /**
   * Run one full pipeline tick. Returns the resolved brick id (string) or null.
   */
  tick(cursorEl, showCursor) {
    const cfg = window.OCULUS_CONFIG;
    const now = performance.now();
    const ts = Math.max(this._lastTs + 1, Math.floor(now));
    this._lastTs = ts;

    const result = window.FaceLandmarker.detectFrame(ts);
    const features = window.Features.extract(result);

    if (!features) {
      this._pushPrediction(null);
      this.lastPrediction.brickId = this._majorityVote();
      this.lastPrediction.rawBrickId = null;
      this.lastPrediction.confidence = 0;
      this.lastPrediction.distribution = {};
      this.lastPrediction.coords = null;
      this.lastPrediction.features = null;
      this.lastPrediction.earAvg = 0;
      this.lastPrediction.tsMs = ts;
      this.lastPrediction.faceDetected = false;
      if (cursorEl) cursorEl.classList.add('hidden');
      return this.lastPrediction.brickId;
    }

    const normalized = window.Features.normalize(features);
    const prediction = window.Classifier.predict(normalized);
    const raw = window.Classifier.resolve(prediction, features);
    this._pushPrediction(raw);
    const smoothed = this._majorityVote();

    // Derive confidence + optional coords depending on mode.
    let confidence = 0;
    let coords = null;
    if (window.Classifier.mode === 'regression' && prediction) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      coords = {
        x: Math.max(0, Math.min(vw, prediction.x * vw)),
        y: Math.max(0, Math.min(vh, prediction.y * vh)),
      };
      // Confidence proxy: inverse distance to nearest brick center
      // (bounded at 0..1). Lets the telemetry pane display a stability
      // signal even though the model doesn't emit probabilities.
      confidence = raw ? 1.0 : 0.3;
    } else if (prediction) {
      for (const p of Object.values(prediction)) {
        if (p > confidence) confidence = p;
      }
    }

    const headPose = {
      yaw:      features[6],
      pitch:    features[7],
      roll:     features[8],
      distance: features[9],
    };

    this.lastPrediction.brickId      = smoothed;
    this.lastPrediction.rawBrickId   = raw;
    this.lastPrediction.confidence   = confidence;
    this.lastPrediction.distribution = (window.Classifier.mode === 'classification') ? prediction : {};
    this.lastPrediction.coords       = coords;
    this.lastPrediction.headPose     = headPose;
    this.lastPrediction.features     = features;
    this.lastPrediction.earAvg       = (features[4] + features[5]) / 2;
    this.lastPrediction.tsMs         = ts;
    this.lastPrediction.faceDetected = true;

    // Cursor placement:
    //   regression → actual predicted pixel
    //   classification → center of smoothed brick
    if (cursorEl) {
      if (showCursor && coords && window.Classifier.mode === 'regression') {
        cursorEl.style.left = coords.x + 'px';
        cursorEl.style.top  = coords.y + 'px';
        cursorEl.classList.remove('hidden');
      } else if (showCursor && smoothed && window.Classifier.mode !== 'regression') {
        const brickEl = document.querySelector(`.brick[data-brick-id="${smoothed}"]`);
        if (brickEl) {
          const rect = brickEl.getBoundingClientRect();
          cursorEl.style.left = (rect.left + rect.width / 2) + 'px';
          cursorEl.style.top  = (rect.top + rect.height / 2) + 'px';
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

  _majorityVote() {
    const cfg = window.OCULUS_CONFIG;
    const counts = {};
    for (const id of this._recentPredictions) {
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
