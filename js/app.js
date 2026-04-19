/**
 * Oculus — main entry.
 *
 * Responsibilities:
 *   1. Parse lesson ID from URL (?lesson=gravity, default: gravity)
 *   2. Load lesson JSON, render into the brick grid
 *   3. Run calibration
 *   4. Start the gaze listener; wire it to Events → Controller → Telemetry
 *   5. Bind footer controls (recalibrate, export, toggle cursor)
 */

const App = {

  state: {
    showCursor: true,
    lessonId: 'gravity',
    cursorEl: null,
    webgazerReady: false,
  },

  async start() {
    this.state.showCursor = window.OCULUS_CONFIG.SHOW_CURSOR_DEFAULT;
    this.state.cursorEl = document.getElementById('gaze-cursor');

    // Get lesson ID from URL
    const params = new URLSearchParams(window.location.search);
    this.state.lessonId = params.get('lesson') || 'gravity';

    // Load + render lesson
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

    // Bind UI
    this._bindControls();

    // Start-button begins calibration
    const startBtn = document.getElementById('cal-start-btn');
    startBtn.addEventListener('click', () => this._runCalibrationThenPlay());
  },

  async _runCalibrationThenPlay() {
    const startBtn = document.getElementById('cal-start-btn');
    const introEl = document.getElementById('cal-intro');
    const dotsEl = document.getElementById('cal-dots');
    const progressEl = document.getElementById('cal-progress');

    startBtn.disabled = true;
    startBtn.textContent = 'Starting camera...';

    try {
      await Calibration.run(webgazer, introEl, dotsEl, progressEl);
    } catch (err) {
      startBtn.textContent = 'Camera unavailable';
      alert(err.message);
      return;
    }

    // Fade overlay
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
    // Init state
    const bricks = document.querySelectorAll('.brick');
    Events.init(bricks);
    Controller.reset();
    Gaze.reset();

    // Init telemetry AFTER Events.init so heatmap sees the bricks
    Telemetry.init({
      elapsed:  document.getElementById('m-elapsed'),
      samples:  document.getElementById('m-samples'),
      current:  document.getElementById('m-current'),
      dwell:    document.getElementById('m-dwell'),
      visited:  document.getElementById('m-visited'),
      hints:    document.getElementById('m-hints'),
      heatmap:  document.getElementById('heatmap'),
      eventLog: document.getElementById('event-log'),
    });

    // Wire WebGazer to our pipeline
    webgazer.setGazeListener((data, _elapsedTime) => {
      if (!data) return;
      Events.recordSample();
      const brickId = Gaze.processSample(data.x, data.y, this.state.cursorEl, this.state.showCursor);
      Events.processBrick(brickId, (eventType, bId, _brickState) => {
        if (eventType === 'stall' || eventType === 'regression') {
          Controller.maybeFireHint(bId);
        }
      });
    });

    this.state.webgazerReady = true;

    // Telemetry tick
    const cfg = window.OCULUS_CONFIG;
    setInterval(() => Telemetry.tick(), cfg.TELEMETRY_TICK_MS);
  },

  _bindControls() {
    const recal = document.getElementById('btn-recalibrate');
    const exp = document.getElementById('btn-export');
    const tog = document.getElementById('btn-toggle-cursor');
    const back = document.getElementById('btn-home');

    if (recal) recal.addEventListener('click', () => location.reload());
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
        window.location.href = 'index.html';
      }
    });
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

// Kickoff on DOM ready
document.addEventListener('DOMContentLoaded', () => App.start());
