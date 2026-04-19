/**
 * Geometric feature extraction from a MediaPipe Face Landmarker result.
 *
 * Emits a ~24-float vector per frame that's invariant to face position
 * and scale, but sensitive to gaze direction and head pose. The classifier
 * consumes these directly — we skip the continuous (x,y) + hit-test step
 * that WebGazer used in v0.1.
 *
 * See V02_HANDOFF_CLAUDE_CODE.md §4 for landmark index documentation
 * and §5 for the feature vector design.
 *
 * The feature layout is:
 *
 *   [0]  right_iris_relative_x          -- iris x between inner/outer canthus
 *   [1]  right_iris_relative_y          -- iris y between upper/lower lid
 *   [2]  left_iris_relative_x
 *   [3]  left_iris_relative_y
 *   [4]  ear_right                      -- eye aspect ratio (EAR)
 *   [5]  ear_left
 *   [6]  head_yaw                       -- radians, from transform matrix
 *   [7]  head_pitch
 *   [8]  head_roll
 *   [9]  head_distance_cm               -- ||translation||
 *   [10] face_center_x                  -- normalized [0,1], nose-tip x
 *   [11] face_center_y                  -- normalized [0,1], nose-tip y
 *   [12] face_width                     -- |cheek-to-cheek| normalized
 *   [13] face_height                    -- |forehead-to-chin| normalized
 *   [14] eyeBlinkLeft                   -- blendshape 9
 *   [15] eyeBlinkRight                  -- blendshape 10
 *   [16] eyeLookDownLeft                -- 11
 *   [17] eyeLookDownRight               -- 12
 *   [18] eyeLookInLeft                  -- 13
 *   [19] eyeLookInRight                 -- 14
 *   [20] eyeLookOutLeft                 -- 15
 *   [21] eyeLookOutRight                -- 16
 *   [22] eyeLookUpLeft                  -- 17
 *   [23] eyeLookUpRight                 -- 18
 *
 * All 24 dimensions are fed to the classifier. The classifier learns which
 * dimensions matter for *this* user's calibration; we don't hand-engineer
 * that weighting.
 */

window.Features = {

  DIM: 24,

  // Normalization state (set during calibration by computeNormalization)
  mean: null,
  std: null,

  // Landmark indices (see §4 of handoff)
  IDX: {
    // Iris centers
    RIGHT_IRIS: 468,
    LEFT_IRIS:  473,

    // Eye corners
    RIGHT_OUTER_CANTHUS: 33,
    RIGHT_INNER_CANTHUS: 133,
    LEFT_INNER_CANTHUS:  362,
    LEFT_OUTER_CANTHUS:  263,

    // EAR constellations (Soukupová & Čech 2016): [p1, p2, p3, p4, p5, p6]
    // p1, p4 are horizontal corners; p2-p3 are upper lid; p5-p6 are lower lid
    RIGHT_EAR: [33, 160, 158, 133, 153, 144],
    LEFT_EAR:  [362, 385, 387, 263, 373, 380],

    // Head reference points (fallback for head pose if matrix missing)
    NOSE_TIP:    1,
    FOREHEAD:    10,
    CHIN:        152,
    RIGHT_CHEEK: 234,
    LEFT_CHEEK:  454,
  },

  // Blendshape categoryName → result-array index is not stable across
  // versions, so we look up by name rather than position.
  BLENDSHAPE_KEYS: [
    'eyeBlinkLeft',      'eyeBlinkRight',
    'eyeLookDownLeft',   'eyeLookDownRight',
    'eyeLookInLeft',     'eyeLookInRight',
    'eyeLookOutLeft',    'eyeLookOutRight',
    'eyeLookUpLeft',     'eyeLookUpRight',
  ],

  /**
   * Extract the feature vector from a MediaPipe result.
   *
   * @returns Float32Array(24)  on success
   *          null               if no face detected (caller treats as 'elsewhere')
   */
  extract(result) {
    if (!result || !result.faceLandmarks || result.faceLandmarks.length === 0) {
      return null;
    }
    const lm = result.faceLandmarks[0];  // [{x,y,z}, ...478], normalized [0,1]
    if (!lm || lm.length < 478) {
      // Iris landmarks are 468-477 — without them the whole pipeline degrades.
      return null;
    }

    const bs = (result.faceBlendshapes && result.faceBlendshapes[0])
      ? result.faceBlendshapes[0].categories
      : [];
    const transform = (result.facialTransformationMatrixes
      && result.facialTransformationMatrixes[0])
      ? result.facialTransformationMatrixes[0].data
      : null;

    const out = new Float32Array(this.DIM);
    const I = this.IDX;

    // --- Iris-relative coordinates within each eye ---
    // For the right eye: inner canthus (133) is nose-side, outer (33) is temple-side.
    // As the user looks RIGHT, the right iris moves toward outer (33).
    // iris_relative_x = 0 at inner, 1 at outer.
    const rInnerX = lm[I.RIGHT_INNER_CANTHUS].x;
    const rOuterX = lm[I.RIGHT_OUTER_CANTHUS].x;
    const rIrisX  = lm[I.RIGHT_IRIS].x;
    const rDenomX = rOuterX - rInnerX;
    out[0] = Math.abs(rDenomX) > 1e-6 ? (rIrisX - rInnerX) / rDenomX : 0.5;

    const lInnerX = lm[I.LEFT_INNER_CANTHUS].x;
    const lOuterX = lm[I.LEFT_OUTER_CANTHUS].x;
    const lIrisX  = lm[I.LEFT_IRIS].x;
    const lDenomX = lOuterX - lInnerX;
    out[2] = Math.abs(lDenomX) > 1e-6 ? (lIrisX - lInnerX) / lDenomX : 0.5;

    // For iris-relative-y, use the upper and lower lid landmarks from the
    // EAR constellation (indices 1,2 ≈ upper; 4,5 ≈ lower on each side).
    // Average top/bottom pairs so we're robust to a single noisy landmark.
    const rUpY = (lm[I.RIGHT_EAR[1]].y + lm[I.RIGHT_EAR[2]].y) / 2;
    const rLoY = (lm[I.RIGHT_EAR[4]].y + lm[I.RIGHT_EAR[5]].y) / 2;
    const rIrisY = lm[I.RIGHT_IRIS].y;
    const rDenomY = rLoY - rUpY;
    out[1] = Math.abs(rDenomY) > 1e-6 ? (rIrisY - rUpY) / rDenomY : 0.5;

    const lUpY = (lm[I.LEFT_EAR[1]].y + lm[I.LEFT_EAR[2]].y) / 2;
    const lLoY = (lm[I.LEFT_EAR[4]].y + lm[I.LEFT_EAR[5]].y) / 2;
    const lIrisY = lm[I.LEFT_IRIS].y;
    const lDenomY = lLoY - lUpY;
    out[3] = Math.abs(lDenomY) > 1e-6 ? (lIrisY - lUpY) / lDenomY : 0.5;

    // --- Eye Aspect Ratio (EAR) for blink detection ---
    out[4] = this._ear(lm, I.RIGHT_EAR);
    out[5] = this._ear(lm, I.LEFT_EAR);

    // --- Head pose from 4x4 transformation matrix ---
    if (transform) {
      const pose = this._extractHeadPose(transform);
      out[6]  = pose.yaw;
      out[7]  = pose.pitch;
      out[8]  = pose.roll;
      out[9]  = pose.distance;
    } else {
      // Fallback: estimate yaw from nose-tip x offset relative to cheek midpoint
      const noseX = lm[I.NOSE_TIP].x;
      const midX  = (lm[I.RIGHT_CHEEK].x + lm[I.LEFT_CHEEK].x) / 2;
      const width = Math.max(1e-6, lm[I.LEFT_CHEEK].x - lm[I.RIGHT_CHEEK].x);
      out[6] = (noseX - midX) / width;   // crude yaw proxy
      out[7] = 0;
      out[8] = 0;
      out[9] = 60;  // assume typical laptop distance
    }

    // --- Face center + size (helps classifier handle off-center users) ---
    out[10] = lm[I.NOSE_TIP].x;
    out[11] = lm[I.NOSE_TIP].y;
    out[12] = Math.abs(lm[I.LEFT_CHEEK].x - lm[I.RIGHT_CHEEK].x);
    out[13] = Math.abs(lm[I.CHIN].y - lm[I.FOREHEAD].y);

    // --- Blendshape passthroughs ---
    for (let i = 0; i < this.BLENDSHAPE_KEYS.length; i++) {
      out[14 + i] = this._blendshape(bs, this.BLENDSHAPE_KEYS[i]);
    }

    return out;
  },

  /**
   * Eye Aspect Ratio: (|p2-p6| + |p3-p5|) / (2 * |p1-p4|).
   * Low values (< ~0.22) → eye closed.
   */
  _ear(lm, idx) {
    const p1 = lm[idx[0]], p2 = lm[idx[1]], p3 = lm[idx[2]];
    const p4 = lm[idx[3]], p5 = lm[idx[4]], p6 = lm[idx[5]];
    const vertical = this._dist(p2, p6) + this._dist(p3, p5);
    const horizontal = this._dist(p1, p4);
    return horizontal > 1e-6 ? vertical / (2 * horizontal) : 0.25;
  },

  _dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    // z is normalized relative to face size; include for 3D robustness
    const dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  },

  /**
   * Decompose a 4x4 row-major transformation matrix into Euler angles
   * (YXZ convention: yaw/pitch/roll in radians) plus translation magnitude.
   *
   * Matrix layout per MediaPipe docs — 16 floats, row-major:
   *   m00 m01 m02 tx
   *   m10 m11 m12 ty
   *   m20 m21 m22 tz
   *   0   0   0   1
   */
  _extractHeadPose(m) {
    const m00 = m[0],  m01 = m[1],  m02 = m[2],  tx  = m[3];
    const m10 = m[4],  m11 = m[5],  m12 = m[6],  ty  = m[7];
    const m20 = m[8],  m21 = m[9],  m22 = m[10], tz  = m[11];
    // Clamp asin input to avoid NaN on near-gimbal-lock matrices.
    const pitch = Math.asin(Math.max(-1, Math.min(1, -m12)));
    const yaw   = Math.atan2(m02, m22);
    const roll  = Math.atan2(m10, m11);
    const distance = Math.sqrt(tx*tx + ty*ty + tz*tz);
    return { pitch, yaw, roll, distance };
  },

  _blendshape(categories, name) {
    for (const c of categories) {
      if (c.categoryName === name) return c.score;
    }
    return 0;
  },

  /**
   * Compute per-dimension mean + std from a batch of feature vectors
   * collected during calibration. Call once at end of calibration so
   * normalize() can apply (x - mean) / std during inference.
   *
   * @param samples Array<Float32Array(24)>  at least 50 recommended
   */
  computeNormalization(samples) {
    if (!samples || samples.length === 0) {
      this.mean = new Float32Array(this.DIM);
      this.std  = new Float32Array(this.DIM).fill(1);
      return;
    }
    const n = samples.length;
    const mean = new Float32Array(this.DIM);
    for (const s of samples) {
      for (let i = 0; i < this.DIM; i++) mean[i] += s[i];
    }
    for (let i = 0; i < this.DIM; i++) mean[i] /= n;

    const variance = new Float32Array(this.DIM);
    for (const s of samples) {
      for (let i = 0; i < this.DIM; i++) {
        const d = s[i] - mean[i];
        variance[i] += d * d;
      }
    }
    const std = new Float32Array(this.DIM);
    for (let i = 0; i < this.DIM; i++) {
      // Floor std at a small epsilon — dimensions that are constant during
      // calibration (e.g. face hasn't moved much) would divide by zero.
      std[i] = Math.max(1e-3, Math.sqrt(variance[i] / n));
    }

    this.mean = mean;
    this.std = std;
  },

  /**
   * Apply z-score normalization with the statistics captured during
   * calibration. If computeNormalization hasn't been called, returns
   * the input unchanged (safe degrade).
   */
  normalize(features) {
    if (!this.mean || !this.std) return features;
    const out = new Float32Array(this.DIM);
    for (let i = 0; i < this.DIM; i++) {
      out[i] = (features[i] - this.mean[i]) / this.std[i];
    }
    return out;
  },

  /**
   * Serialize normalization state for inclusion in session export.
   * Lets downstream analysis reproduce the classifier's input space.
   */
  exportNormalization() {
    return {
      mean: this.mean ? Array.from(this.mean) : null,
      std:  this.std  ? Array.from(this.std)  : null,
    };
  },

  reset() {
    this.mean = null;
    this.std = null;
  },
};
