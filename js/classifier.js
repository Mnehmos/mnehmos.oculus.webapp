/**
 * Per-session gaze model — multi-head (v0.2+).
 *
 * Trains a list of "heads" on the same calibration data and runs all of
 * them per frame at inference time. Each head is independently configured
 * (mode, hidden-units, learning rate). You get per-head predictions in
 * Gaze.lastPrediction.perHead for side-by-side comparison, plus an
 * aggregated ensemble brick id.
 *
 * The list of heads is driven by OCULUS_CONFIG.GAZE_HEADS, an array of
 * head configs:
 *
 *   [
 *     { tag: 'R', mode: 'regression' },                       // default
 *     { tag: 'C', mode: 'classification' },
 *     { tag: 'R2', mode: 'regression', hiddenUnits: 32 },
 *   ]
 *
 * Head modes:
 *   'regression'     → Dense(24→H relu) → Dense(H→H relu) → Dense(H→2 linear)
 *                      Loss: MSE. predict() → {x, y} normalized viewport.
 *                      resolve() → denormalize + elementsFromPoint hit-test.
 *   'classification' → Dense(24→H relu) → Dense(H→H relu) → Dense(H→N softmax)
 *                      Loss: categoricalCrossentropy. predict() → {brickId:prob}.
 *                      resolve() → argmax + CONFIDENCE_THRESHOLD.
 *
 * The first head in the array is "primary" — its brick id drives Events
 * and the gaze cursor. Remaining heads are monitored in telemetry and
 * stored in the session export so downstream analysis can see which
 * heads agreed with the primary when.
 *
 * Depends on global `tf` (window.tf).
 */

window.Classifier = {

  heads: [],            // array of Head objects (see _buildHead)
  primaryIdx: 0,
  trainedAt: null,

  // Alias accessors so any legacy code checking Classifier.mode / .model
  // still sees the primary head. Keep these read-only in spirit.
  get mode()     { return this.heads[this.primaryIdx]?.mode || null; },
  get model()    { return this.heads[this.primaryIdx]?.model || null; },
  get brickIds() { return this.heads[this.primaryIdx]?.brickIds || []; },
  get validationAccuracy() { return this.heads[this.primaryIdx]?.validationAccuracy ?? null; },
  get validationError()    { return this.heads[this.primaryIdx]?.validationError ?? null; },
  get trainingHistory()    { return this.heads[this.primaryIdx]?.trainingHistory ?? null; },
  get trainedSampleCount() { return this.heads[this.primaryIdx]?.trainedSampleCount ?? 0; },

  /**
   * Build heads from a list of configs (or a single config for convenience).
   *
   * Examples:
   *   Classifier.build({ mode: 'regression' })
   *   Classifier.build({ mode: 'classification', brickIds: [...] })
   *   Classifier.build([
   *     { tag: 'R', mode: 'regression' },
   *     { tag: 'C', mode: 'classification', brickIds: [...] },
   *   ])
   */
  build(configs) {
    const list = Array.isArray(configs) ? configs : [configs];

    // Dispose any prior heads so we don't leak tf.Models.
    for (const h of this.heads) {
      if (h.model) { try { h.model.dispose(); } catch (_) { /* noop */ } }
    }
    this.heads = list.map((c, i) => this._buildHead(c, i));
    this.primaryIdx = 0;
    return this.heads;
  },

  _buildHead(cfgHead, idx) {
    const cfg = window.OCULUS_CONFIG;
    const mode = cfgHead.mode || 'regression';
    const tag = cfgHead.tag || (mode === 'regression' ? `R${idx}` : `C${idx}`);
    const hidden = cfgHead.hiddenUnits || cfg.CLASSIFIER_HIDDEN_UNITS;
    const lr = cfgHead.lr || cfg.CLASSIFIER_LEARNING_RATE;

    const m = tf.sequential();
    m.add(tf.layers.dense({
      inputShape: [cfg.FEATURE_VECTOR_DIM],
      units: hidden,
      activation: 'relu',
      kernelInitializer: 'heNormal',
    }));
    m.add(tf.layers.dense({
      units: hidden,
      activation: 'relu',
      kernelInitializer: 'heNormal',
    }));

    let brickIds = [];
    if (mode === 'regression') {
      m.add(tf.layers.dense({ units: 2, activation: 'linear' }));
      m.compile({
        optimizer: tf.train.adam(lr),
        loss: 'meanSquaredError',
        metrics: ['mse'],
      });
    } else {
      if (!cfgHead.brickIds || cfgHead.brickIds.length === 0) {
        throw new Error(`classification head "${tag}" needs brickIds`);
      }
      brickIds = cfgHead.brickIds.slice();
      m.add(tf.layers.dense({
        units: brickIds.length,
        activation: 'softmax',
      }));
      m.compile({
        optimizer: tf.train.adam(lr),
        loss: 'categoricalCrossentropy',
        metrics: ['accuracy'],
      });
    }

    return {
      tag, mode, hidden, lr,
      model: m,
      brickIds,
      trainingHistory: null,
      trainedSampleCount: 0,
      validationAccuracy: null,
      validationError: null,
    };
  },

  /**
   * Train every head. `labelsByMode` is an object keyed by label mode:
   *   { regression: [{x,y}, ...], classification: ['B01', ...] }
   * Each head gets the labels matching its own mode.
   *
   * Pass a single progress callback (epoch, logs, headTag) for UI updates;
   * it fires once per epoch per head.
   */
  async train(features, labelsByMode, onEpochEnd) {
    const cfg = window.OCULUS_CONFIG;
    if (this.heads.length === 0) throw new Error('Classifier.train: no heads built');

    const n = features.length;
    const dim = cfg.FEATURE_VECTOR_DIM;
    const xs = new Float32Array(n * dim);
    for (let i = 0; i < n; i++) xs.set(features[i], i * dim);
    const xTensor = tf.tensor2d(xs, [n, dim]);

    try {
      for (const head of this.heads) {
        const labels = labelsByMode[head.mode];
        if (!labels || labels.length !== n) {
          throw new Error(`train: missing/mismatched labels for mode "${head.mode}"`);
        }

        let yTensor;
        if (head.mode === 'regression') {
          const ys = new Float32Array(n * 2);
          for (let i = 0; i < n; i++) {
            ys[i * 2]     = labels[i].x;
            ys[i * 2 + 1] = labels[i].y;
          }
          yTensor = tf.tensor2d(ys, [n, 2]);
        } else {
          const numClasses = head.brickIds.length;
          const ys = new Float32Array(n * numClasses);
          for (let i = 0; i < n; i++) {
            const classIdx = head.brickIds.indexOf(labels[i]);
            if (classIdx < 0) throw new Error(`unknown label "${labels[i]}"`);
            ys[i * numClasses + classIdx] = 1;
          }
          yTensor = tf.tensor2d(ys, [n, numClasses]);
        }

        let history;
        try {
          history = await head.model.fit(xTensor, yTensor, {
            epochs: cfg.CLASSIFIER_EPOCHS,
            batchSize: cfg.CLASSIFIER_BATCH_SIZE,
            shuffle: true,
            validationSplit: 0.1,
            callbacks: onEpochEnd
              ? { onEpochEnd: (epoch, logs) => onEpochEnd(epoch, logs, head.tag) }
              : undefined,
          });
        } finally {
          yTensor.dispose();
        }

        head.trainedSampleCount = n;
        head.trainingHistory = {
          finalLoss:        history.history.loss?.slice(-1)[0] ?? null,
          finalValLoss:     history.history.val_loss?.slice(-1)[0] ?? null,
          finalAccuracy:    history.history.acc?.slice(-1)[0]
                         ?? history.history.accuracy?.slice(-1)[0] ?? null,
          finalValAccuracy: history.history.val_acc?.slice(-1)[0]
                         ?? history.history.val_accuracy?.slice(-1)[0] ?? null,
          epochs: cfg.CLASSIFIER_EPOCHS,
        };
        if (head.mode === 'classification') {
          head.validationAccuracy = head.trainingHistory.finalValAccuracy;
        }
      }
    } finally {
      xTensor.dispose();
    }

    this.trainedAt = new Date().toISOString();
  },

  /**
   * Raw per-head predictions for one feature vector.
   *
   * @returns {Array<{tag, mode, raw}>}
   *   - raw.x / raw.y         for regression
   *   - raw = {brickId: prob} for classification
   */
  predict(normalizedFeatures) {
    if (this.heads.length === 0) return [];
    return tf.tidy(() => {
      const input = tf.tensor2d(normalizedFeatures, [1, normalizedFeatures.length]);
      return this.heads.map(head => {
        const output = head.model.predict(input);
        const vals = output.dataSync();
        if (head.mode === 'regression') {
          return { tag: head.tag, mode: head.mode, raw: { x: vals[0], y: vals[1] } };
        }
        const distribution = {};
        for (let i = 0; i < head.brickIds.length; i++) {
          distribution[head.brickIds[i]] = vals[i];
        }
        return { tag: head.tag, mode: head.mode, raw: distribution };
      });
    });
  },

  /**
   * Resolve every head's raw prediction to a brick id (or null).
   *
   * @returns {{
   *   perHead: { [tag]: string|null },
   *   primary: string|null,            // primary head's resolved id
   *   ensemble: string|null,           // majority vote across heads
   *   primaryTag: string,
   * }}
   */
  resolve(perHeadPredictions, featureVector) {
    const cfg = window.OCULUS_CONFIG;
    const perHead = {};
    for (let i = 0; i < perHeadPredictions.length; i++) {
      const p = perHeadPredictions[i];
      const head = this.heads[i];
      perHead[p.tag] = this._resolveOne(head, p.raw, featureVector);
    }

    const primaryHead = this.heads[this.primaryIdx];
    const primary = perHead[primaryHead.tag];

    // Ensemble: majority vote across all heads, null if no majority.
    // Ties broken by primary head.
    const counts = {};
    for (const id of Object.values(perHead)) {
      if (!id) continue;
      counts[id] = (counts[id] || 0) + 1;
    }
    let bestId = null, bestCount = 0;
    for (const id of Object.keys(counts)) {
      if (counts[id] > bestCount) { bestId = id; bestCount = counts[id]; }
    }
    const ensemble = bestCount > 0 ? bestId : null;

    return {
      perHead,
      primary,
      ensemble,
      primaryTag: primaryHead.tag,
    };
  },

  _resolveOne(head, raw, features) {
    const cfg = window.OCULUS_CONFIG;
    if (!raw) return null;

    if (head.mode === 'regression') {
      if (features) {
        const earAvg = (features[4] + features[5]) / 2;
        if (earAvg < cfg.REGRESSION_EAR_GATE) return null;
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const px = Math.max(0, Math.min(vw - 1, raw.x * vw));
      const py = Math.max(0, Math.min(vh - 1, raw.y * vh));
      const els = document.elementsFromPoint(px, py);
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
    for (const id of Object.keys(raw)) {
      if (raw[id] > bestProb) { bestProb = raw[id]; bestId = id; }
    }
    if (bestProb < cfg.CONFIDENCE_THRESHOLD) return null;
    if (bestId === 'elsewhere') return null;
    return bestId;
  },

  /**
   * Legacy single-argument alias: resolves only the primary head.
   */
  argmax(predictionOrDistribution) {
    // If caller passed a raw classification distribution (legacy), treat
    // the primary head's rules.
    const primary = this.heads[this.primaryIdx];
    if (!primary) return null;
    return this._resolveOne(primary, predictionOrDistribution, null);
  },

  /**
   * Held-out validation scored per-head.
   *
   * @returns { [tag]: number }  accuracy for classification (0..1), or
   *                             1 - pxErr/200 "health" for regression.
   */
  validate(features, labelsByMode) {
    const out = {};
    for (const head of this.heads) {
      const labels = labelsByMode[head.mode];
      if (!labels || labels.length === 0) { out[head.tag] = 0; continue; }
      out[head.tag] = this._validateHead(head, features, labels);
    }
    return out;
  },

  _validateHead(head, features, labels) {
    if (head.mode === 'regression') {
      let sumSq = 0;
      const refW = 1920, refH = 1080;
      for (let i = 0; i < features.length; i++) {
        const preds = this.predict(features[i]);
        // Find this head's raw output
        const raw = preds.find(p => p.tag === head.tag).raw;
        const dx = (raw.x - labels[i].x) * refW;
        const dy = (raw.y - labels[i].y) * refH;
        sumSq += dx * dx + dy * dy;
      }
      const meanErr = Math.sqrt(sumSq / features.length);
      head.validationError = meanErr;
      return Math.max(0, 1 - meanErr / 200);
    }

    let correct = 0;
    for (let i = 0; i < features.length; i++) {
      const preds = this.predict(features[i]);
      const raw = preds.find(p => p.tag === head.tag).raw;
      let bestId = null, bestProb = -1;
      for (const id of Object.keys(raw)) {
        if (raw[id] > bestProb) { bestProb = raw[id]; bestId = id; }
      }
      if (bestId === labels[i]) correct++;
    }
    const acc = correct / features.length;
    head.validationAccuracy = acc;
    return acc;
  },

  exportMetadata() {
    const cfg = window.OCULUS_CONFIG;
    return {
      trainedAt: this.trainedAt,
      primaryTag: this.heads[this.primaryIdx]?.tag ?? null,
      featureDim: cfg.FEATURE_VECTOR_DIM,
      heads: this.heads.map(h => ({
        tag: h.tag,
        mode: h.mode,
        hidden: h.hidden,
        lr: h.lr,
        classes: h.mode === 'classification' ? h.brickIds.slice() : null,
        trainedOn: h.trainedSampleCount,
        history: h.trainingHistory,
        validationAccuracy: h.validationAccuracy,
        validationError: h.validationError,
      })),
    };
  },

  reset() {
    for (const h of this.heads) {
      if (h.model) { try { h.model.dispose(); } catch (_) { /* noop */ } }
    }
    this.heads = [];
    this.primaryIdx = 0;
    this.trainedAt = null;
  },
};
