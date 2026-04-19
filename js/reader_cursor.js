/**
 * Mouse-driven reader cursor.
 *
 * Tracks the mouse as the user reads with it and feeds brick/word-level
 * events into the Events pipeline. Serves two purposes:
 *
 *   1. UX: a visible cursor that highlights the word/brick under the mouse
 *      so the user is in the loop and guiding the system rather than
 *      being judged by it.
 *
 *   2. Training: the mouse position is reliable ground truth. When the
 *      user dwells the cursor on a word for > ACTIVE_DWELL_MS, we capture
 *      (current MediaPipe feature vector, mouse viewport coords) as a
 *      sample for later regression-classifier fine-tuning. This turns
 *      every reading session into continuous calibration.
 *
 * Mouse-active vs gaze-active:
 *   - When the mouse has moved within MOUSE_ACTIVE_WINDOW_MS, mouse is
 *     considered "active" — ReaderCursor drives Events.processBrick and
 *     Gaze.tick stops firing events (but still updates lastPrediction for
 *     telemetry + training data collection).
 *   - After MOUSE_ACTIVE_WINDOW_MS of no movement, gaze takes over again.
 *
 * Sample queue: samples accumulate in ReaderCursor.sampleQueue for later
 * retraining. An explicit "Fine-tune from mouse samples" button (TBD)
 * would drain the queue into Classifier.train().
 */

window.ReaderCursor = {

  state: {
    currentWord: null,          // span.word under cursor
    currentBrick: null,         // .brick under cursor
    wordEnteredAt: null,
    brickEnteredAt: null,
    lastMoveAt: 0,
    mouseX: 0,
    mouseY: 0,
    active: false,
  },

  // Training samples captured while the mouse is dwelling on a word.
  // Each entry: { features: Float32Array(24), x: normalized, y: normalized,
  //              mouseX: px, mouseY: px, wordText: string, brickId, tsMs }
  sampleQueue: [],

  // Per-word dwell accounting for the session — exported alongside
  // per-brick stats so authors can see which words drew the most attention.
  wordDwell: new Map(),   // key: `${brickId}::${wordIndex}` → ms

  config: {
    ACTIVE_DWELL_MS: 300,         // word dwell before we capture a sample
    MOUSE_ACTIVE_WINDOW_MS: 2000, // mouse "active" if moved in this window
    SAMPLE_MIN_INTERVAL_MS: 200,  // rate-limit sample captures per word
  },

  _lastSampleAt: 0,
  _cursorEl: null,
  _initialized: false,

  init() {
    if (this._initialized) return;
    this._initialized = true;

    // Build the visual reader cursor. Positioned at mouse, styled via CSS.
    const cur = document.createElement('div');
    cur.id = 'reader-cursor';
    cur.className = 'reader-cursor hidden';
    document.body.appendChild(cur);
    this._cursorEl = cur;

    document.addEventListener('mousemove', e => this._onMove(e));
    document.addEventListener('mouseleave', () => this._clearActive());
  },

  isActive() {
    return this.state.active;
  },

  _onMove(e) {
    const now = performance.now();
    this.state.mouseX = e.clientX;
    this.state.mouseY = e.clientY;
    this.state.lastMoveAt = now;
    this.state.active = true;

    if (this._cursorEl) {
      this._cursorEl.style.left = e.clientX + 'px';
      this._cursorEl.style.top  = e.clientY + 'px';
      this._cursorEl.classList.remove('hidden');
    }

    // Hit-test for the word + brick under the cursor.
    const els = document.elementsFromPoint(e.clientX, e.clientY);
    let word = null, brick = null;
    for (const el of els) {
      if (!word && el.classList && el.classList.contains('word')) {
        word = el;
      }
      if (!brick && el.closest) {
        const b = el.closest('.brick');
        if (b && !b.classList.contains('page-hidden')) brick = b;
      }
      if (word && brick) break;
    }

    // Word change → paint
    if (word !== this.state.currentWord) {
      this._commitWordDwell(now);
      if (this.state.currentWord) this.state.currentWord.classList.remove('reading');
      if (word) word.classList.add('reading');
      this.state.currentWord = word;
      this.state.wordEnteredAt = now;
    }

    // Brick change → fire pedagogical events through the existing pipe
    const newBrickId = brick ? brick.dataset.brickId : null;
    const currentBrickId = this.state.currentBrick
      ? this.state.currentBrick.dataset.brickId
      : null;
    if (newBrickId !== currentBrickId) {
      this.state.currentBrick = brick;
      this.state.brickEnteredAt = now;
      if (window.Events) {
        window.Events.processBrick(newBrickId, (eventType, bId) => {
          if ((eventType === 'stall' || eventType === 'regression')
              && window.Controller) {
            window.Controller.maybeFireHint(bId);
          }
        });
      }
    }

    // Capture a training sample if the mouse has been dwelling on the
    // same word for ACTIVE_DWELL_MS and we haven't sampled recently.
    if (word && this.state.wordEnteredAt
        && (now - this.state.wordEnteredAt) >= this.config.ACTIVE_DWELL_MS
        && (now - this._lastSampleAt) >= this.config.SAMPLE_MIN_INTERVAL_MS) {
      this._captureSample(now);
      this._lastSampleAt = now;
    }
  },

  _commitWordDwell(now) {
    if (!this.state.currentWord || !this.state.wordEnteredAt) return;
    const ms = now - this.state.wordEnteredAt;
    if (ms < 50) return; // ignore flyovers
    const brickEl = this.state.currentWord.closest('.brick');
    if (!brickEl) return;
    const brickId = brickEl.dataset.brickId;
    // Use the word's ordinal position within the brick as its stable id
    const words = Array.from(brickEl.querySelectorAll('.word'));
    const idx = words.indexOf(this.state.currentWord);
    const key = `${brickId}::${idx}`;
    this.wordDwell.set(key, (this.wordDwell.get(key) || 0) + ms);
  },

  _captureSample(now) {
    // Pull current feature vector from Gaze's last prediction — it runs
    // every frame independent of mouse activity.
    const gp = window.Gaze && window.Gaze.lastPrediction;
    if (!gp || !gp.features || !gp.faceDetected) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this.sampleQueue.push({
      features: gp.features,
      x: this.state.mouseX / vw,
      y: this.state.mouseY / vh,
      mouseX: this.state.mouseX,
      mouseY: this.state.mouseY,
      wordText: this.state.currentWord ? this.state.currentWord.textContent : null,
      brickId: this.state.currentBrick ? this.state.currentBrick.dataset.brickId : null,
      tsMs: now,
    });
  },

  _clearActive() {
    this._commitWordDwell(performance.now());
    if (this.state.currentWord) this.state.currentWord.classList.remove('reading');
    this.state.currentWord = null;
    this.state.active = false;
    if (this._cursorEl) this._cursorEl.classList.add('hidden');
  },

  /**
   * Polled by app.js each frame to decide whether mouse should be
   * considered "currently driving" (so gaze defers). Deactivates
   * after MOUSE_ACTIVE_WINDOW_MS without movement.
   */
  tickActivity() {
    const now = performance.now();
    if (this.state.active
        && (now - this.state.lastMoveAt) > this.config.MOUSE_ACTIVE_WINDOW_MS) {
      this._clearActive();
    }
    return this.state.active;
  },

  /**
   * Clear everything. Called on recalibrate / navigation.
   */
  reset() {
    if (this.state.currentWord) this.state.currentWord.classList.remove('reading');
    this.state.currentWord = null;
    this.state.currentBrick = null;
    this.state.wordEnteredAt = null;
    this.state.brickEnteredAt = null;
    this.state.active = false;
    this.sampleQueue = [];
    this.wordDwell.clear();
  },

  /**
   * Export-friendly snapshot for ExportSession.
   */
  exportStats() {
    return {
      samplesCollected: this.sampleQueue.length,
      wordsRead: this.wordDwell.size,
      wordDwell: Array.from(this.wordDwell.entries()).map(([key, ms]) => {
        const [brickId, idx] = key.split('::');
        return { brickId, wordIndex: parseInt(idx, 10), dwellMs: Math.round(ms) };
      }),
    };
  },
};
