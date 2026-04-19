/**
 * Gaze sample handler.
 *
 * WebGazer fires ~30 raw samples per second. They're noisy. We:
 *   1. Rolling-average the last N samples to smooth the cursor.
 *   2. Hit-test the smoothed position against the brick grid.
 *   3. Move the gaze cursor to the smoothed position (if enabled).
 *   4. Return the resolved brick ID (or null) for the event layer.
 */

const Gaze = {

  recentSamples: [],

  reset() {
    this.recentSamples = [];
  },

  /**
   * Process one raw gaze sample. Returns the resolved brick ID or null.
   *
   * Side effects: updates the gaze cursor position on screen.
   */
  processSample(rawX, rawY, cursorEl, showCursor) {
    const cfg = window.OCULUS_CONFIG;

    this.recentSamples.push({ x: rawX, y: rawY });
    if (this.recentSamples.length > cfg.SAMPLE_SMOOTHING) {
      this.recentSamples.shift();
    }

    const n = this.recentSamples.length;
    const avgX = this.recentSamples.reduce((s, p) => s + p.x, 0) / n;
    const avgY = this.recentSamples.reduce((s, p) => s + p.y, 0) / n;

    if (showCursor && cursorEl) {
      cursorEl.style.left = avgX + 'px';
      cursorEl.style.top = avgY + 'px';
      cursorEl.classList.remove('hidden');
    }

    return this._brickAt(avgX, avgY);
  },

  /**
   * Hit-test: which brick, if any, is under (x, y)?
   *
   * Uses elementsFromPoint so overlapping elements are handled naturally;
   * we walk the stack until we find something with a .brick ancestor.
   */
  _brickAt(x, y) {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      const brickEl = el.closest('.brick');
      if (brickEl) return brickEl.dataset.brickId;
    }
    return null;
  },
};

window.Gaze = Gaze;
