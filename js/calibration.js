/**
 * Calibration flow.
 *
 * Shows 9 dots in sequence. User clicks each while looking at it. Each click
 * feeds WebGazer several samples at the click location. After 9 clicks, the
 * regression model has enough data to estimate gaze from webcam input.
 *
 * Returns a promise that resolves when calibration is complete.
 */

const Calibration = {

  async run(webgazer, introEl, dotsEl, progressEl) {
    const cfg = window.OCULUS_CONFIG;

    try {
      await webgazer
        .setGazeListener(null)
        .setRegression('ridge')
        .begin();
      webgazer.showVideoPreview(true);
      webgazer.showPredictionPoints(false);
      webgazer.showFaceOverlay(false);
      webgazer.showFaceFeedbackBox(false);
    } catch (err) {
      throw new Error('Camera unavailable: ' + err.message);
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
          webgazer.recordScreenPosition(x, y, 'click');
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
