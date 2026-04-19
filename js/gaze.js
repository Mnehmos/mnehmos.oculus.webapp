/**
 * Gaze pipeline (v0.2, multi-head).
 *
 * Each animation frame:
 *   FaceLandmarker.detectFrame
 *     → Features.extract + normalize
 *     → Classifier.predict       (returns an array of per-head raw outputs)
 *     → Classifier.resolve       (returns { perHead, primary, ensemble })
 *     → majority-vote over last N resolved-primary brick ids
 *     → emit smoothed brick id to the event layer
 *
 * The primary head drives events, cursor, and stall/regression logic.
 * Secondary heads ride along for telemetry and session-export analysis.
 *
 * Depends on window.FaceLandmarker, window.Features, window.Classifier.
 */

window.Gaze = {

  _recentPredictions: [],
  _smoothedCoords: null,   // { x, y } — EMA-smoothed viewport coords

  lastPrediction: {
    brickId: null,             // smoothed primary-head id
    rawBrickId: null,          // unsmoothed primary-head id
    ensembleBrickId: null,     // majority vote across all heads
    perHead: {},               // { tag: brickId | null }
    coords: null,              // primary-head coords if it's a regression head
    confidence: 0,             // primary-head confidence proxy
    headPose: { yaw: 0, pitch: 0, roll: 0, distance: 0 },
    features: null,
    earAvg: 0,
    tsMs: 0,
    faceDetected: false,
  },

  _lastTs: 0,

  reset() {
    this._recentPredictions = [];
    this._smoothedCoords = null;
    this._lastTs = 0;
    this.lastPrediction = {
      brickId: null,
      rawBrickId: null,
      ensembleBrickId: null,
      perHead: {},
      coords: null,
      confidence: 0,
      headPose: { yaw: 0, pitch: 0, roll: 0, distance: 0 },
      features: null,
      earAvg: 0,
      tsMs: 0,
      faceDetected: false,
    };
  },

  tick(cursorEl, showCursor) {
    const now = performance.now();
    const ts = Math.max(this._lastTs + 1, Math.floor(now));
    this._lastTs = ts;

    const result = window.FaceLandmarker.detectFrame(ts);
    const features = window.Features.extract(result);

    if (!features) {
      this._pushPrediction(null);
      this.lastPrediction.brickId = this._majorityVote();
      this.lastPrediction.rawBrickId = null;
      this.lastPrediction.ensembleBrickId = null;
      this.lastPrediction.perHead = {};
      this.lastPrediction.coords = null;
      this.lastPrediction.confidence = 0;
      this.lastPrediction.features = null;
      this.lastPrediction.earAvg = 0;
      this.lastPrediction.tsMs = ts;
      this.lastPrediction.faceDetected = false;
      if (cursorEl) cursorEl.classList.add('hidden');
      return this.lastPrediction.brickId;
    }

    const cfg = window.OCULUS_CONFIG;
    const normalized = window.Features.normalize(features);
    const rawPerHead = window.Classifier.predict(normalized);

    // EMA-smooth the primary regression head's coords before hit-test.
    // Raw per-frame regression output jitters a lot (typical for a small
    // MLP on noisy webcam features); an exponential moving average tames
    // the visible cursor swing AND stabilizes which brick elementsFromPoint
    // lands on, both of which Vario reported as "jittery as hell".
    const primaryIdx = window.Classifier.primaryIdx || 0;
    const primaryHead = window.Classifier.heads[primaryIdx];
    if (primaryHead && primaryHead.mode === 'regression' && rawPerHead[primaryIdx]) {
      const alpha = cfg.REGRESSION_EMA_ALPHA ?? 0.25;
      const raw = rawPerHead[primaryIdx].raw;
      if (!this._smoothedCoords) {
        this._smoothedCoords = { x: raw.x, y: raw.y };
      } else {
        this._smoothedCoords.x = alpha * raw.x + (1 - alpha) * this._smoothedCoords.x;
        this._smoothedCoords.y = alpha * raw.y + (1 - alpha) * this._smoothedCoords.y;
      }
      rawPerHead[primaryIdx].raw = {
        x: this._smoothedCoords.x,
        y: this._smoothedCoords.y,
      };
    }

    const resolved = window.Classifier.resolve(rawPerHead, features);

    this._pushPrediction(resolved.primary);
    const smoothed = this._majorityVote();

    // Primary-head confidence + coords (reuse primaryHead from above)
    const primaryRaw = rawPerHead[window.Classifier.primaryIdx || 0]?.raw;
    let coords = null;
    let confidence = 0;
    if (primaryHead && primaryRaw) {
      if (primaryHead.mode === 'regression') {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        coords = {
          x: Math.max(0, Math.min(vw, primaryRaw.x * vw)),
          y: Math.max(0, Math.min(vh, primaryRaw.y * vh)),
        };
        confidence = resolved.primary ? 1.0 : 0.3;
      } else {
        for (const p of Object.values(primaryRaw)) {
          if (p > confidence) confidence = p;
        }
      }
    }

    const headPose = {
      yaw:      features[6],
      pitch:    features[7],
      roll:     features[8],
      distance: features[9],
    };

    this.lastPrediction.brickId         = smoothed;
    this.lastPrediction.rawBrickId      = resolved.primary;
    this.lastPrediction.ensembleBrickId = resolved.ensemble;
    this.lastPrediction.perHead         = resolved.perHead;
    this.lastPrediction.coords          = coords;
    this.lastPrediction.confidence      = confidence;
    this.lastPrediction.headPose        = headPose;
    this.lastPrediction.features        = features;
    this.lastPrediction.earAvg          = (features[4] + features[5]) / 2;
    this.lastPrediction.tsMs            = ts;
    this.lastPrediction.faceDetected    = true;

    // Cursor placement: show primary head's (x, y) if it's regression;
    // otherwise snap to smoothed brick center.
    if (cursorEl) {
      if (showCursor && coords) {
        cursorEl.style.left = coords.x + 'px';
        cursorEl.style.top  = coords.y + 'px';
        cursorEl.classList.remove('hidden');
      } else if (showCursor && smoothed) {
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
