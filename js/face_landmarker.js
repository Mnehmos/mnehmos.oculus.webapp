/**
 * MediaPipe Face Landmarker wrapper.
 *
 * Loads @mediapipe/tasks-vision from jsDelivr via dynamic import (it ships
 * as an ES module). Configures:
 *   - 478 3D face landmarks (468 face-mesh + 10 iris)
 *   - 52 blendshape coefficients (eye blink + look-direction categories)
 *   - 4x4 facial transformation matrices (head pose in cm)
 *
 * Exposes a per-frame detection function that js/gaze.js calls once per
 * requestAnimationFrame with the webcam <video> element and a monotonically
 * increasing timestamp (MediaPipe requires strictly increasing timestamps
 * in VIDEO running mode).
 *
 * License: @mediapipe/tasks-vision and the face_landmarker.task model
 * are both Apache 2.0, compatible with this repo's MIT. See §13 of
 * V02_HANDOFF_CLAUDE_CODE.md for the full license audit.
 */

window.FaceLandmarker = {

  _landmarker: null,
  _ready: false,
  _stream: null,
  _video: null,
  _initError: null,

  /**
   * Initialize the webcam stream and the MediaPipe FaceLandmarker.
   * Must be called once, typically at calibration start.
   *
   * Returns:
   *   { ok: true }                        on success
   *   { ok: false, error: string, kind }  on failure
   *     kind ∈ 'camera' | 'mediapipe' | 'gpu'
   */
  async init() {
    if (this._ready) return { ok: true };

    const cfg = window.OCULUS_CONFIG;

    // --- Webcam ---
    try {
      this._video = document.getElementById('oculus-video');
      if (!this._video) {
        return { ok: false, error: 'No #oculus-video element in DOM', kind: 'camera' };
      }
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      });
      this._video.srcObject = this._stream;
      await new Promise((resolve, reject) => {
        this._video.onloadedmetadata = resolve;
        this._video.onerror = () => reject(new Error('video element failed to load'));
      });
      await this._video.play();
    } catch (err) {
      this._initError = err;
      return {
        ok: false,
        error: 'Camera unavailable: ' + (err.message || err),
        kind: 'camera',
      };
    }

    // --- MediaPipe FaceLandmarker ---
    let MPFaceLandmarker, FilesetResolver;
    try {
      const mod = await import(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/vision_bundle.mjs'
      );
      MPFaceLandmarker = mod.FaceLandmarker;
      FilesetResolver = mod.FilesetResolver;
    } catch (err) {
      this._initError = err;
      return {
        ok: false,
        error: 'MediaPipe module load failed: ' + (err.message || err),
        kind: 'mediapipe',
      };
    }

    try {
      const vision = await FilesetResolver.forVisionTasks(cfg.MEDIAPIPE_WASM_URL);
      this._landmarker = await MPFaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: cfg.FACE_LANDMARKER_MODEL_URL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
    } catch (err) {
      // Attempt CPU fallback before giving up. GPU delegate fails on some
      // laptops/drivers — pedagogy session still works on CPU, just slower.
      try {
        const vision = await FilesetResolver.forVisionTasks(cfg.MEDIAPIPE_WASM_URL);
        this._landmarker = await MPFaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: cfg.FACE_LANDMARKER_MODEL_URL,
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
        console.warn('FaceLandmarker: GPU delegate failed, running on CPU:', err);
      } catch (err2) {
        this._initError = err2;
        return {
          ok: false,
          error: 'FaceLandmarker creation failed (GPU+CPU): ' + (err2.message || err2),
          kind: 'gpu',
        };
      }
    }

    this._ready = true;
    return { ok: true };
  },

  isReady() {
    return this._ready;
  },

  getVideoElement() {
    return this._video;
  },

  /**
   * Run detection on the current webcam frame.
   *
   * @param timestampMs must be strictly > previous timestamp. Typically pass
   *                    `performance.now()` — MediaPipe validates monotonicity
   *                    and will throw if violated.
   * @returns MediaPipe result object, or null if not ready.
   *   result.faceLandmarks:                [[{x,y,z}, ... 478]]  or  []
   *   result.faceBlendshapes:              [{ categories: [{score,categoryName}, ...52]}]
   *   result.facialTransformationMatrixes: [{ data: Float32Array(16) }]
   */
  detectFrame(timestampMs) {
    if (!this._ready || !this._video) return null;
    // readyState < 2 means HAVE_CURRENT_DATA not yet reached — skip this frame
    if (this._video.readyState < 2) return null;
    try {
      return this._landmarker.detectForVideo(this._video, timestampMs);
    } catch (err) {
      // Monotonic-timestamp violations and transient GPU hiccups shouldn't
      // crash the loop. Log once and move on — next frame will retry.
      if (!this._warnedOnce) {
        console.warn('detectForVideo error (will swallow further):', err);
        this._warnedOnce = true;
      }
      return null;
    }
  },

  /**
   * Stop the webcam stream and release MediaPipe resources. Call on page
   * teardown — MediaPipe's WASM holds a GPU context that should be closed.
   */
  destroy() {
    if (this._landmarker) {
      try { this._landmarker.close(); } catch (_) { /* noop */ }
      this._landmarker = null;
    }
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
    this._ready = false;
  },

  /**
   * Attach preview: pipe the webcam stream to a second <video> element.
   * Used by calibration to show the user a mirrored self-view while we
   * wait for face detection to stabilize.
   */
  attachPreview(videoEl) {
    if (this._stream && videoEl) {
      videoEl.srcObject = this._stream;
      videoEl.play().catch(() => { /* autoplay-blocked; user-gesture required */ });
    }
  },
};
