/**
 * Per-session MLP classifier. Maps a 24-dim feature vector to a brick-id
 * probability distribution. TensorFlow.js trains in-browser at calibration
 * time; inference runs every animation frame thereafter.
 *
 * Architecture: Dense(24→16, ReLU) → Dense(16→16, ReLU) → Dense(16→N, softmax)
 * where N = number of content bricks + 1 for the "elsewhere" class.
 *
 * Training data comes from calibration: ~50 feature samples per brick over
 * 1.5s of steady gaze. This fits comfortably in memory
 * (400 × 24 × 4 bytes ≈ 38KB) and trains in under 3 seconds on a laptop GPU.
 *
 * The classifier is NOT persisted to IndexedDB in v0.2 — each session
 * recalibrates. Persistence is scheduled for v0.3 (handoff §11 item 5).
 *
 * Depends on global `tf` (window.tf) from the TensorFlow.js CDN tag
 * in app.html.
 */

window.Classifier = {

  model: null,
  brickIds: [],         // ['B01', 'B02', ..., 'elsewhere']
  trainedAt: null,      // ISO timestamp of last training
  trainingHistory: null,// last tf.fit return value (for export)
  trainedSampleCount: 0,
  validationAccuracy: null,

  /**
   * Build (but don't yet train) a fresh MLP for the given set of labels.
   *
   * @param brickIds  Array<string>  ordered class labels; 'elsewhere' must be last
   */
  build(brickIds) {
    const cfg = window.OCULUS_CONFIG;
    this.brickIds = brickIds.slice();

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
    m.add(tf.layers.dense({
      units: brickIds.length,
      activation: 'softmax',
    }));
    m.compile({
      optimizer: tf.train.adam(cfg.CLASSIFIER_LEARNING_RATE),
      loss: 'categoricalCrossentropy',
      metrics: ['accuracy'],
    });
    this.model = m;
    return m;
  },

  /**
   * Train the model on calibration data.
   *
   * @param featureRows Array<Float32Array(24)>  each already normalized
   * @param labels      Array<string>            brick id for each row
   * @param onEpochEnd  optional (epoch, logs) => void  for UI progress
   */
  async train(featureRows, labels, onEpochEnd) {
    const cfg = window.OCULUS_CONFIG;
    if (!this.model) {
      throw new Error('Classifier.train: must call build(brickIds) first');
    }
    if (featureRows.length === 0) {
      throw new Error('Classifier.train: no samples');
    }
    if (featureRows.length !== labels.length) {
      throw new Error('Classifier.train: features/labels length mismatch');
    }

    // Build tensors: features [N, 24], one-hot labels [N, numClasses]
    const n = featureRows.length;
    const dim = cfg.FEATURE_VECTOR_DIM;
    const numClasses = this.brickIds.length;

    const xs = new Float32Array(n * dim);
    for (let i = 0; i < n; i++) xs.set(featureRows[i], i * dim);
    const ys = new Float32Array(n * numClasses);
    for (let i = 0; i < n; i++) {
      const classIdx = this.brickIds.indexOf(labels[i]);
      if (classIdx < 0) {
        throw new Error(`Classifier.train: unknown label "${labels[i]}"`);
      }
      ys[i * numClasses + classIdx] = 1;
    }

    const xTensor = tf.tensor2d(xs, [n, dim]);
    const yTensor = tf.tensor2d(ys, [n, numClasses]);

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
      finalLoss:       history.history.loss?.slice(-1)[0] ?? null,
      finalAccuracy:   history.history.acc?.slice(-1)[0]
                     ?? history.history.accuracy?.slice(-1)[0]
                     ?? null,
      finalValLoss:    history.history.val_loss?.slice(-1)[0] ?? null,
      finalValAccuracy: history.history.val_acc?.slice(-1)[0]
                     ?? history.history.val_accuracy?.slice(-1)[0]
                     ?? null,
      epochs: cfg.CLASSIFIER_EPOCHS,
    };
    this.validationAccuracy = this.trainingHistory.finalValAccuracy;

    return history;
  },

  /**
   * Predict a brick-probability distribution for one feature vector.
   *
   * @param normalizedFeatures  Float32Array(24)  already z-scored
   * @returns Object<brickId, prob>
   */
  predict(normalizedFeatures) {
    if (!this.model) return null;
    return tf.tidy(() => {
      const input = tf.tensor2d(normalizedFeatures, [1, normalizedFeatures.length]);
      const output = this.model.predict(input);
      const probs = output.dataSync();
      const distribution = {};
      for (let i = 0; i < this.brickIds.length; i++) {
        distribution[this.brickIds[i]] = probs[i];
      }
      return distribution;
    });
  },

  /**
   * Utility: from a distribution, pick the argmax *if* above threshold.
   * Otherwise return null (caller treats as 'uncertain').
   */
  argmax(distribution) {
    const cfg = window.OCULUS_CONFIG;
    let bestId = null, bestProb = -1;
    for (const id of Object.keys(distribution)) {
      if (distribution[id] > bestProb) {
        bestProb = distribution[id];
        bestId = id;
      }
    }
    if (bestProb < cfg.CONFIDENCE_THRESHOLD) return null;
    // 'elsewhere' is a valid classifier output but shouldn't propagate as
    // a brick id to the event layer — surface it as null.
    if (bestId === 'elsewhere') return null;
    return bestId;
  },

  /**
   * Run the classifier against a held-out set and return top-1 accuracy.
   * Used by calibration to decide whether to prompt recalibration.
   */
  validate(featureRows, labels) {
    if (!this.model || featureRows.length === 0) return 0;
    let correct = 0;
    for (let i = 0; i < featureRows.length; i++) {
      const dist = this.predict(featureRows[i]);
      let bestId = null, bestProb = -1;
      for (const id of Object.keys(dist)) {
        if (dist[id] > bestProb) { bestProb = dist[id]; bestId = id; }
      }
      if (bestId === labels[i]) correct++;
    }
    return correct / featureRows.length;
  },

  /**
   * Snapshot of training metadata for session export.
   */
  exportMetadata() {
    const cfg = window.OCULUS_CONFIG;
    return {
      featureDim: cfg.FEATURE_VECTOR_DIM,
      architecture: `${cfg.FEATURE_VECTOR_DIM}-${cfg.CLASSIFIER_HIDDEN_UNITS}-${cfg.CLASSIFIER_HIDDEN_UNITS}-${this.brickIds.length}`,
      classes: this.brickIds.slice(),
      trainedOn: this.trainedSampleCount,
      trainedAt: this.trainedAt,
      history: this.trainingHistory,
      validationAccuracy: this.validationAccuracy,
    };
  },

  /**
   * Release the tf model. Call on page teardown.
   */
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
  },
};
