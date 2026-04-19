/**
 * Calibration flow.
 *
 * Shows 9 dots in sequence. User clicks each while looking at it. Each click
 * feeds WebGazer several samples at the click location. After 9 clicks, the
 * regression model has enough data to estimate gaze from webcam input.
 *
 * Returns a promise that resolves when calibration is complete.
 *
 * --- IMPORTANT: MediaPipe asset path ---
 * WebGazer internally uses MediaPipe Face Mesh for face landmark detection.
 * By default, WebGazer looks for MediaPipe's WASM and binary proto files at
 * `./mediapipe/face_mesh/` *relative to the page* — which 404s on any deployment
 * that doesn't vendor those files locally.
 *
 * The fix: set `webgazer.params.faceMeshSolutionPath` to the jsDelivr CDN
 * URL for @mediapipe/face_mesh BEFORE calling webgazer.begin(). The property
 * is exposed via `webgazer.params` which WebGazer assigns internally as
 * `_W.params = BP` (confirmed by inspecting the webgazer.js source).
 *
 * This avoids vendoring ~5MB of MediaPipe assets into the repo.
 */

const Calibration = {

  // Pin to a specific version to avoid CDN-drift breakage.
  MEDIAPIPE_FACE_MESH_CDN: 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619',

  async run(webgazer, introEl, dotsEl, progressEl) {
    const cfg = window.OCULUS_CONFIG;

    // --- Redirect MediaPipe asset loading to the CDN ---
    // This MUST happen before webgazer.begin() — the loader captures the
    // solutionPath at FaceMesh construction time.
    try {
      if (webgazer && webgazer.params) {
        webgazer.params.faceMeshSolutionPath = this.MEDIAPIPE_FACE_MESH_CDN;
      }
    } catch (e) {
      // Non-fatal — if this fails WebGazer will fall back to relative paths
      // and the user will see the MediaPipe 404s. But we shouldn't crash here.
      console.warn('Could not set MediaPipe CDN path:', e);
    }

    try {
      await webgazer
        .setGazeListener(null)
        .setRegression('ridge')
        .begin();

      // These visual-feedback calls are best-effort — if the WebGazer API
      // changed, don't crash the whole calibration over them.
      this._safeCall(webgazer, 'showVideoPreview', true);
      this._safeCall(webgazer, 'showPredictionPoints', false);
      this._safeCall(webgazer, 'showFaceOverlay', false);
      this._safeCall(webgazer, 'showFaceFeedbackBox', false);
    } catch (err) {
      throw new Error('Camera unavailable: ' + (err.message || err));
    }

    introEl.style.display = 'none';
    dotsEl.style.display = 'block';
    progressEl.style.display = 'block';

    const points = cfg.CALIBRATION_POINTS;
    for (let i = 0; i < points.length; i++) {
      const [xPct, yPct] = points[i];
      const x = window.innerWidth * xPct;
      const y = window.innerHeight * yPct;

      await this._runOnePoint(webgazer, x, y, i, points.length, dotsEl, progressEl);
    }
  },

  /**
   * Call a method on webgazer if it exists. Swallow errors. This protects
   * against API drift between WebGazer versions — if a method we expect is
   * missing or renamed, we degrade gracefully instead of crashing calibration.
   */
  _safeCall(webgazer, methodName, ...args) {
    try {
      if (typeof webgazer[methodName] === 'function') {
        webgazer[methodName](...args);
      }
    } catch (e) {
      console.warn(`webgazer.${methodName} failed:`, e);
    }
  },

  _runOnePoint(webgazer, x, y, index, total, dotsEl, progressEl) {
    const cfg = window.OCULUS_CONFIG;
    return new Promise(resolve => {
      const dot = document.createElement('div');
      dot.className = 'cal-dot';
      dot.style.left = x + 'px';
      dot.style.top = y + 'px';

      dot.addEventListener('click', async () => {
        // Feed WebGazer several samples at this click location.
        for (let k = 0; k < cfg.CALIBRATION_SAMPLES_PER_CLICK; k++) {
          try {
            webgazer.recordScreenPosition(x, y, 'click');
          } catch (e) {
            console.warn('recordScreenPosition failed:', e);
          }
          await new Promise(r => setTimeout(r, cfg.CALIBRATION_SAMPLE_INTERVAL_MS));
        }
        dot.classList.add('clicked');
        progressEl.textContent = `${index + 1} / ${total}`;
        setTimeout(() => {
          dot.remove();
          resolve();
        }, 280);
      });

      dotsEl.appendChild(dot);
    });
  },
};

window.Calibration = Calibration;
