/**
 * Oculus — main entry.
 *
 * Responsibilities:
 *   1. Parse lesson ID from URL (?lesson=gravity, default: gravity)
 *   2. Load lesson JSON, render into the brick grid
 *   3. Run per-brick calibration (v0.2)
 *   4. Drive the animation-frame loop that ticks the gaze pipeline
 *   5. Wire gaze → Events → Controller → Telemetry
 *   6. Bind footer controls (recalibrate, export, toggle cursor)
 *
 * v0.1 → v0.2 deltas:
 *   - WebGazer is gone; calibration + gaze use MediaPipe + TF.js classifier
 *   - We own the requestAnimationFrame loop (previously WebGazer owned it)
 *   - Calibration.run takes a plain options object, not the webgazer handle
 */

const App = {

  state: {
    showCursor: true,
    lessonId: 'gravity',
    cursorEl: null,
    tracking: false,
    rafHandle: null,
    currentPage: 1,
    totalPages: 1,
    gridEl: null,
  },

  async start() {
    this.state.showCursor = window.OCULUS_CONFIG.SHOW_CURSOR_DEFAULT;
    this.state.cursorEl = document.getElementById('gaze-cursor');

    const params = new URLSearchParams(window.location.search);
    this.state.lessonId = params.get('lesson') || 'gravity';

    let lesson;
    try {
      lesson = await Content.loadLesson(this.state.lessonId);
    } catch (err) {
      this._fail(`Could not load lesson "${this.state.lessonId}": ${err.message}`);
      return;
    }

    const grid = document.getElementById('brick-grid');
    Content.renderLesson(lesson, grid, {
      kicker: document.querySelector('.doc-kicker'),
      title:  document.querySelector('.doc-title'),
      meta:   document.querySelector('.doc-meta'),
    });

    this.state.gridEl = grid;

    // Pagination behavior depends on the primary head's mode:
    //   regression        → one-page-everything, user scrolls (scroll-
    //                       invariant hit-test handles layout shifts).
    //   classification    → paginate, no scroll.
    // We can't know the primary mode until after Classifier.build, which
    // happens inside Calibration.run. Read GAZE_HEADS[0] if present;
    // otherwise fall back to GAZE_MODE.
    const cfg = window.OCULUS_CONFIG;
    const primaryMode =
      (cfg.GAZE_HEADS && cfg.GAZE_HEADS[0] && cfg.GAZE_HEADS[0].mode) ||
      cfg.GAZE_MODE ||
      'regression';

    if (primaryMode === 'regression') {
      this.state.totalPages = 1;
      this.state.currentPage = 1;
      grid.querySelectorAll('.brick').forEach(el => el.classList.remove('page-hidden'));
    } else {
      this.state.totalPages = Content.totalPages(lesson);
      this.state.currentPage = 1;
      Content.showPage(grid, 1);
    }
    this._updatePageIndicator();

    this._bindControls();

    const startBtn = document.getElementById('cal-start-btn');
    startBtn.addEventListener('click', () => this._runCalibrationThenPlay());
  },

  async _runCalibrationThenPlay() {
    const startBtn = document.getElementById('cal-start-btn');
    const introEl = document.getElementById('cal-intro');
    const dotsEl = document.getElementById('cal-dots');
    const progressEl = document.getElementById('cal-progress');
    const gridEl = document.getElementById('brick-grid');

    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = 'Starting camera…';
    }

    try {
      await Calibration.run({ introEl, dotsEl, progressEl, gridEl });
    } catch (err) {
      if (String(err.message).includes('recalibration')) {
        // User rejected low-accuracy result; reload triggers a fresh session
        location.reload();
        return;
      }
      // Hard failure — error UI already rendered by Calibration; just stop
      console.error('Calibration failed:', err);
      return;
    }

    // Fade overlay, reveal main content, show footer
    document.getElementById('calibration-overlay').classList.add('hidden');
    document.getElementById('main-layout').style.visibility = 'visible';
    document.getElementById('footer-controls').style.display = 'flex';
    setTimeout(() => {
      const overlay = document.getElementById('calibration-overlay');
      if (overlay) overlay.remove();
    }, 500);

    this._startTracking();
  },

  _startTracking() {
    const cfg = window.OCULUS_CONFIG;
    const bricks = document.querySelectorAll('.brick');
    Events.init(bricks);
    Controller.reset();
    Gaze.reset();

    Telemetry.init({
      elapsed:    document.getElementById('m-elapsed'),
      samples:    document.getElementById('m-samples'),
      current:    document.getElementById('m-current'),
      dwell:      document.getElementById('m-dwell'),
      visited:    document.getElementById('m-visited'),
      hints:      document.getElementById('m-hints'),
      confidence: document.getElementById('m-confidence'),
      headPose:   document.getElementById('m-head-pose'),
      headsRow:   document.getElementById('m-heads'),
      heatmap:    document.getElementById('heatmap'),
      eventLog:   document.getElementById('event-log'),
    });

    this.state.tracking = true;
    this._updatePageIndicator();

    // Boot the mouse-driven reader cursor. It runs in parallel with gaze
    // and takes over Events when the mouse is moving; gaze falls back in
    // during periods of mouse idle.
    if (window.ReaderCursor) window.ReaderCursor.init();

    // Main loop: MediaPipe → features → classifier → brick id → Events
    const frame = () => {
      if (!this.state.tracking) return;
      Events.recordSample();
      const brickId = Gaze.tick(this.state.cursorEl, this.state.showCursor);

      // Gaze fires events only when the mouse isn't currently driving.
      // ReaderCursor already calls Events.processBrick from its mousemove
      // handler, so during active reading with mouse the brick events
      // come from the more reliable source.
      const mouseActive = window.ReaderCursor && window.ReaderCursor.tickActivity();
      if (!mouseActive) {
        Events.processBrick(brickId, (eventType, bId) => {
          if (eventType === 'stall' || eventType === 'regression') {
            Controller.maybeFireHint(bId);
          }
        });
      }

      this.state.rafHandle = requestAnimationFrame(frame);
    };
    this.state.rafHandle = requestAnimationFrame(frame);

    // Telemetry tick decoupled from animation frames (same as v0.1)
    setInterval(() => Telemetry.tick(), cfg.TELEMETRY_TICK_MS);
  },

  _bindControls() {
    const recal = document.getElementById('btn-recalibrate');
    const exp = document.getElementById('btn-export');
    const tog = document.getElementById('btn-toggle-cursor');
    const back = document.getElementById('btn-home');

    if (recal) recal.addEventListener('click', () => {
      this.state.tracking = false;
      if (this.state.rafHandle) cancelAnimationFrame(this.state.rafHandle);
      // Full reset: FaceLandmarker + classifier both disposed
      try { window.FaceLandmarker.destroy(); } catch (_) {}
      try { window.Classifier.reset(); } catch (_) {}
      try { window.Features.reset(); } catch (_) {}
      location.reload();
    });

    if (exp) exp.addEventListener('click', () => {
      ExportSession.downloadAsFile(this.state.lessonId);
    });

    if (tog) tog.addEventListener('click', () => {
      this.state.showCursor = !this.state.showCursor;
      if (this.state.cursorEl) {
        this.state.cursorEl.classList.toggle('hidden', !this.state.showCursor);
      }
    });

    if (back) back.addEventListener('click', () => {
      if (confirm('Leave this session? Your gaze data will be lost unless you export first.')) {
        this.state.tracking = false;
        try { window.FaceLandmarker.destroy(); } catch (_) {}
        window.location.href = 'index.html';
      }
    });

    const prevBtn = document.getElementById('btn-prev-page');
    const nextBtn = document.getElementById('btn-next-page');
    if (prevBtn) prevBtn.addEventListener('click', () => this._changePage(-1));
    if (nextBtn) nextBtn.addEventListener('click', () => this._changePage(1));
  },

  _changePage(delta) {
    const next = this.state.currentPage + delta;
    if (next < 1 || next > this.state.totalPages) return;
    this.state.currentPage = next;
    Content.showPage(this.state.gridEl, next);
    // Reset per-page gaze state so regressions don't fire the moment the
    // page turns (classifier takes a frame or two to re-lock).
    if (window.Gaze) window.Gaze.reset();
    this._updatePageIndicator();
    // Log the page change to the event stream so the session export
    // captures when pages turned.
    if (window.Events && window.Events.logMeta) {
      window.Events.logMeta('page_change', 'meta', `page ${next}`);
    }
  },

  _updatePageIndicator() {
    const indicator = document.getElementById('page-indicator');
    const prevBtn = document.getElementById('btn-prev-page');
    const nextBtn = document.getElementById('btn-next-page');
    if (indicator) {
      indicator.textContent = `${this.state.currentPage} / ${this.state.totalPages}`;
    }
    // Only enable buttons when they'd do something AND tracking is active
    // (buttons stay disabled during calibration)
    const canNavigate = this.state.tracking && this.state.totalPages > 1;
    if (prevBtn) prevBtn.disabled = !canNavigate || this.state.currentPage <= 1;
    if (nextBtn) nextBtn.disabled = !canNavigate || this.state.currentPage >= this.state.totalPages;
  },

  _fail(msg) {
    document.body.innerHTML = `
      <div style="padding: 40px; font-family: monospace; color: #dde1e7; background: #0e0f12; min-height: 100vh;">
        <h1 style="font-family: Fraunces, serif; color: #f4b860; margin-bottom: 12px;">Oculus failed to start</h1>
        <p style="color: #8a92a0;">${msg}</p>
        <p style="margin-top: 20px;"><a href="index.html" style="color: #f4b860;">Back to start</a></p>
      </div>
    `;
  },
};

// Release camera when user navigates away
window.addEventListener('beforeunload', () => {
  try { window.FaceLandmarker && window.FaceLandmarker.destroy(); } catch (_) {}
});

document.addEventListener('DOMContentLoaded', () => App.start());
