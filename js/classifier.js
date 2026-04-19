/**
 * Per-session gaze model (v0.2).
 *
 * Supports two architectures, toggled by OCULUS_CONFIG.GAZE_MODE:
 *
 * 1. 'regression' (default)
 *    Maps features → (x, y) viewport coordinates, normalized to [0, 1].
 *    Architecture: Dense(24→16 relu) → Dense(16→16 relu) → Dense(16→2 linear)
 *    Loss: meanSquaredError.
 *    At inference, predict() returns {x, y} in normalized viewport coords;
 *    resolve() denormalizes to pixels and hit-tests with elementsFromPoint
 *    against the current DOM — so page scroll and layout changes work
 *    naturally without retraining.
 *
 * 2. 'classification'
 *    Maps features → brick-probability distribution over a fixed class set.
 *    Architecture: Dense(24→16 relu) → Dense(16→16 relu) → Dense(16→N softmax).
 *    Loss: categoricalCrossentropy.
 *    At inference, predict() returns {brickId: prob}; resolve() is
 *    argmax with confidence threshold. Requires scroll lock and retrains
 *    on layout change.
 *
 * The module name stayed "Classifier" for backwards compatibility with
 * existing imports and telemetry wiring even though it's more general now.
 *
 * Depends on global `tf` (window.tf) from the TensorFlow.js CDN tag in
 * app.html.
 */

window.Classifier = {

  mode: 'regression',
  model: null,
  brickIds: [],         // used in 'classification' mode
  trainedAt: null,
  trainingHistory: null,
  trainedSampleCount: 0,
  validationAccuracy: null,   // classification: top-1 accuracy
  validationError: null,      // regression: mean pixel error across held-out

  /**
   * Build (but don't yet train) a fresh model.
   *
   * Classification call:  build({ mode: 'classification', brickIds: [...] })
   * Regression call:      build({ mode: 'regression' })
   */
  build(opts) {
    const cfg = window.OCULUS_CONFIG;
    this.mode = opts.mode || cfg.GAZE_MODE || 'regression';

    if (this.model) {
      try { this.model.dispose(); } catch (_) { /* noop */ }
      this.model = null;
    }

    const m = tf.sequential();
    m.add(tf.layers.dense({
      inputShape: [cfg.FEATURE_VECTOR_DIM],
      units: cfg.CLASSIFIER_HIDDEN_UNITS,
      activation: 'relu',
      kernelInitializer: 'heNormal',
    }));
    m.add(tf.layers.dense({
      units: cfg.CLASSIFIER_HIDDEN_UNITS,
      activation: 'relu',
      kernelInitializer: 'heNormal',
    }));

    if (this.mode === 'regression') {
      // 2-neuron linear output for (x, y) normalized viewport coords.
      // sigmoid would clamp to [0,1] but sigmoid gradients vanish at
      // extremes; linear lets the model extrapolate slightly beyond the
      // training range, which helps at screen edges.
      m.add(tf.layers.dense({ units: 2, activation: 'linear' }));
      m.compile({
        optimizer: tf.train.adam(cfg.CLASSIFIER_LEARNING_RATE),
        loss: 'meanSquaredError',
        metrics: ['mse'],
      });
      this.brickIds = [];
    } else {
      // classification
      if (!opts.brickIds || opts.brickIds.length === 0) {
        throw new Error("classification mode requires brickIds");
      }
      this.brickIds = opts.brickIds.slice();
      m.add(tf.layers.dense({
        units: this.brickIds.length,
        activation: 'softmax',
      }));
      m.compile({
        optimizer: tf.train.adam(cfg.CLASSIFIER_LEARNING_RATE),
        loss: 'categoricalCrossentropy',
        metrics: ['accuracy'],
      });
    }

    this.model = m;
    return m;
  },

  /**
   * Train on calibration data.
   *
   * @param features Array<Float32Array(24)>  already normalized
   * @param labels
   *   Classification: Array<string>                  — brick ids
   *   Regression:     Array<{x: number, y: number}>  — viewport coords,
   *                                                    already normalized [0, 1]
   * @param onEpochEnd optional (epoch, logs) => void for UI progress
   */
  async train(features, labels, onEpochEnd) {
    const cfg = window.OCULUS_CONFIG;
    if (!this.model) throw new Error('Classifier.train: build first');
    if (features.length === 0) throw new Error('Classifier.train: no samples');
    if (features.length !== labels.length) {
      throw new Error('Classifier.train: features/labels length mismatch');
    }

    const n = features.length;
    const dim = cfg.FEATURE_VECTOR_DIM;

    const xs = new Float32Array(n * dim);
    for (let i = 0; i < n; i++) xs.set(features[i], i * dim);
    const xTensor = tf.tensor2d(xs, [n, dim]);

    let yTensor;
    if (this.mode === 'regression') {
      const ys = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        ys[i * 2]     = labels[i].x;
        ys[i * 2 + 1] = labels[i].y;
      }
      yTensor = tf.tensor2d(ys, [n, 2]);
    } else {
      const numClasses = this.brickIds.length;
      const ys = new Float32Array(n * numClasses);
      for (let i = 0; i < n; i++) {
        const classIdx = this.brickIds.indexOf(labels[i]);
        if (classIdx < 0) throw new Error(`unknown label "${labels[i]}"`);
        ys[i * numClasses + classIdx] = 1;
      }
      yTensor = tf.tensor2d(ys, [n, numClasses]);
    }

    let history;
    try {
      history = await this.model.fit(xTensor, yTensor, {
        epochs: cfg.CLASSIFIER_EPOCHS,
        batchSize: cfg.CLASSIFIER_BATCH_SIZE,
        shuffle: true,
        validationSplit: 0.1,
        callbacks: onEpochEnd ? { onEpochEnd } : undefined,
      });
    } finally {
      xTensor.dispose();
      yTensor.dispose();
    }

    this.trainedAt = new Date().toISOString();
    this.trainedSampleCount = n;
    this.trainingHistory = {
      finalLoss:        history.history.loss?.slice(-1)[0] ?? null,
      finalValLoss:     history.history.val_loss?.slice(-1)[0] ?? null,
      finalAccuracy:    history.history.acc?.slice(-1)[0]
                      ?? history.history.accuracy?.slice(-1)[0]
                      ?? null,
      finalValAccuracy: history.history.val_acc?.slice(-1)[0]
                      ?? history.history.val_accuracy?.slice(-1)[0]
                      ?? null,
      epochs: cfg.CLASSIFIER_EPOCHS,
    };
    if (this.mode === 'classification') {
      this.validationAccuracy = this.trainingHistory.finalValAccuracy;
    }

    return history;
  },

  /**
   * Raw model prediction.
   *
   * @returns Classification: { brickId: prob } distribution
   *          Regression:     { x, y } normalized viewport coords
   */
  predict(normalizedFeatures) {
    if (!this.model) return null;
    return tf.tidy(() => {
      const input = tf.tensor2d(normalizedFeatures, [1, normalizedFeatures.length]);
      const output = this.model.predict(input);
      const vals = output.dataSync();
      if (this.mode === 'regression') {
        return { x: vals[0], y: vals[1] };
      }
      const distribution = {};
      for (let i = 0; i < this.brickIds.length; i++) {
        distribution[this.brickIds[i]] = vals[i];
      }
      return distribution;
    });
  },

  /**
   * Resolve a raw prediction into a brick id (or null for "no brick").
   *
   * Classification: argmax with CONFIDENCE_THRESHOLD; 'elsewhere' → null.
   * Regression: denormalize to pixels, hit-test with elementsFromPoint
   *             against the current DOM.
   */
  resolve(prediction, featureVector) {
    if (!prediction) return null;
    const cfg = window.OCULUS_CONFIG;

    if (this.mode === 'regression') {
      // Blink gate: if eyes look closed, reject the frame. Features[4]/[5]
      // are EAR per eye; average.
      if (featureVector) {
        const earAvg = (featureVector[4] + featureVector[5]) / 2;
        if (earAvg < cfg.REGRESSION_EAR_GATE) return null;
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const px = prediction.x * vw;
      const py = prediction.y * vh;
      // Clamp to viewport so elementsFromPoint doesn't get negative args
      const cx = Math.max(0, Math.min(vw - 1, px));
      const cy = Math.max(0, Math.min(vh - 1, py));
      const els = document.elementsFromPoint(cx, cy);
      for (const el of els) {
        const brickEl = el.closest && el.closest('.brick');
        if (brickEl && !brickEl.classList.contains('page-hidden')) {
          return brickEl.dataset.brickId;
        }
      }
      return null;
    }

    // classification
    let bestId = null, bestProb = -1;
    for (const id of Object.keys(prediction)) {
      if (prediction[id] > bestProb) { bestProb = prediction[id]; bestId = id; }
    }
    if (bestProb < cfg.CONFIDENCE_THRESHOLD) return null;
    if (bestId === 'elsewhere') return null;
    return bestId;
  },

  /**
   * Simpler name alias used by legacy call sites.
   */
  argmax(distribution) {
    return this.resolve(distribution, null);
  },

  /**
   * Held-out validation for calibration quality gate.
   *
   * Classification: top-1 accuracy.
   * Regression: mean Euclidean pixel error (approx; uses a reference
   *             viewport of 1920x1080 so the number is stable across
   *             monitors during the session report).
   */
  validate(features, labels) {
    if (!this.model || features.length === 0) return 0;

    if (this.mode === 'regression') {
      // Return 1 - (error / normalizer) so telemetry can treat "higher is
      // better" consistently. Normalizer: 200 pixels (≈one brick). A mean
      // error of 0px → 1.0; ≥ 200px → 0.
      let sumSq = 0;
      const refW = 1920, refH = 1080;
      for (let i = 0; i < features.length; i++) {
        const pred = this.predict(features[i]);
        const dx = (pred.x - labels[i].x) * refW;
        const dy = (pred.y - labels[i].y) * refH;
        sumSq += dx * dx + dy * dy;
      }
      const meanErr = Math.sqrt(sumSq / features.length);
      this.validationError = meanErr;
      return Math.max(0, 1 - meanErr / 200);
    }

    let correct = 0;
    for (let i = 0; i < features.length; i++) {
      const dist = this.predict(features[i]);
      let bestId = null, bestProb = -1;
      for (const id of Object.keys(dist)) {
        if (dist[id] > bestProb) { bestProb = dist[id]; bestId = id; }
      }
      if (bestId === labels[i]) correct++;
    }
    return correct / features.length;
  },

  exportMetadata() {
    const cfg = window.OCULUS_CONFIG;
    const outputDim = this.mode === 'regression' ? 2 : this.brickIds.length;
    return {
      mode: this.mode,
      featureDim: cfg.FEATURE_VECTOR_DIM,
      architecture:
        `${cfg.FEATURE_VECTOR_DIM}-${cfg.CLASSIFIER_HIDDEN_UNITS}-${cfg.CLASSIFIER_HIDDEN_UNITS}-${outputDim}`,
      classes: this.mode === 'classification' ? this.brickIds.slice() : null,
      trainedOn: this.trainedSampleCount,
      trainedAt: this.trainedAt,
      history: this.trainingHistory,
      validationAccuracy: this.validationAccuracy,
      validationError:    this.validationError,
    };
  },

  reset() {
    if (this.model) {
      try { this.model.dispose(); } catch (_) { /* noop */ }
      this.model = null;
    }
    this.brickIds = [];
    this.trainedAt = null;
    this.trainingHistory = null;
    this.trainedSampleCount = 0;
    this.validationAccuracy = null;
    this.validationError = null;
  },
};
