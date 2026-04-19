/**
 * Typed event detector.
 *
 * Input: a stream of "current brick" ids (one per gaze sample).
 * Output: a stream of typed pedagogical events.
 *
 * Event types:
 *   first_read    — reader enters a brick they haven't seen before
 *   regression    — reader returns to a brick after leaving it (not an immediate bounce)
 *   stall         — reader dwells in a brick much longer than expected
 *   resolution    — reader moves forward after a stall (inferred, see notes below)
 *
 * The detector maintains per-brick state: visit count, total dwell, stalls,
 * regressions, last exit time, etc. The controller reads this state to decide
 * when to fire hints.
 *
 * v0.2 behavior: all "committed" events (first_read, regression, visit count,
 * adding to the visited set) happen on EXIT from a brick, gated on
 * DWELL_MS_MIN. This filters classifier flyover noise — when a noisy
 * classifier briefly predicts a brick for a few frames, we don't count
 * it as a real visit. A global regression cooldown also prevents a
 * B03↔B04 oscillation from flooding the event log.
 */

const Events = {

  state: {
    sessionStart: null,
    gazeSamples: 0,
    currentBrick: null,
    currentBrickEnteredAt: null,
    visited: new Set(),
    bricks: {},            // brickId -> { dwellTotal, visits, regressions, stalls, lastExitAt, ... }
    events: [],            // full typed event log for session export
    lastRegressionAt: 0,   // global cooldown timestamp for regression events
  },

  init(brickElements) {
    this.state.sessionStart = performance.now();
    this.state.bricks = {};
    this.state.events = [];
    this.state.visited = new Set();
    this.state.currentBrick = null;
    this.state.currentBrickEnteredAt = null;
    this.state.lastRegressionAt = 0;

    for (const el of brickElements) {
      const id = el.dataset.brickId;
      const type = el.dataset.brickType || 'unknown';
      const expectedDwell = parseInt(el.dataset.expectedDwellMs || '5000', 10);
      this.state.bricks[id] = {
        el, type, expectedDwell,
        dwellTotal: 0,
        visits: 0,
        regressions: 0,
        stalls: 0,
        lastExitAt: null,
        _pendingEntryIsRegression: false, // set on entry, resolved on exit
      };
    }
  },

  /**
   * Process a brick-id resolved from the current gaze sample. Fires events
   * via the provided callback when transitions occur.
   *
   * Callback signature: onEvent(eventType, brickId, detail)
   *
   * `source` tags every log entry with whether it came from mouse ground
   * truth or gaze prediction — downstream LLM reasoning can weight them.
   * Defaults to 'gaze' for back-compat.
   */
  processBrick(newBrickId, onEvent, source) {
    source = source || 'gaze';
    const cfg = window.OCULUS_CONFIG;
    const now = performance.now();
    const prevBrickId = this.state.currentBrick;

    if (newBrickId === prevBrickId) {
      return; // Same brick, nothing to do
    }

    // --- Leaving prev brick: commit events if dwell was substantial ---
    if (prevBrickId) {
      const prev = this.state.bricks[prevBrickId];
      if (prev) {
        const dwell = now - this.state.currentBrickEnteredAt;
        prev.dwellTotal += dwell;
        prev.lastExitAt = now;

        // Gate on DWELL_MS_MIN: short "visits" are classifier noise,
        // not real attention. Don't commit them as visits/events.
        if (dwell >= cfg.DWELL_MS_MIN) {
          const wasFirstVisit = !this.state.visited.has(prevBrickId);

          if (wasFirstVisit) {
            this.state.visited.add(prevBrickId);
            prev.visits++;
            this._log('first_read', prevBrickId,
              `type=${prev.type}, dwell=${Math.round(dwell)}ms`, source);
            onEvent && onEvent('first_read', prevBrickId, prev);

          } else if (prev._pendingEntryIsRegression) {
            // Global cooldown: even if a single brick cooled down per se,
            // rapid-fire regressions across multiple bricks indicate the
            // classifier is bouncing. Gate globally.
            if (now - this.state.lastRegressionAt >= cfg.REGRESSION_COOLDOWN_MS) {
              prev.visits++;
              prev.regressions++;
              prev.el.classList.add('regressed');
              this._log('regression', prevBrickId,
                `visit #${prev.visits}, dwell=${Math.round(dwell)}ms`, source);
              onEvent && onEvent('regression', prevBrickId, prev);
              this.state.lastRegressionAt = now;
            } else {
              // Bump visit count quietly but don't fire the event
              prev.visits++;
            }

          } else {
            // Non-regression non-first visit (within cooldown window) — count it
            prev.visits++;
          }

          // Stall detection stays on exit (v0.1 behavior)
          if (dwell > prev.expectedDwell * cfg.STALL_MULTIPLIER) {
            prev.stalls++;
            prev.el.classList.add('stalled');
            this._log('stall', prevBrickId,
              `dwell ${Math.round(dwell)}ms (expected ~${prev.expectedDwell}ms)`, source);
            onEvent && onEvent('stall', prevBrickId, prev);
          }
        }

        prev._pendingEntryIsRegression = false;
      }
    }

    // --- Entering a new brick (or none) ---
    if (newBrickId) {
      const next = this.state.bricks[newBrickId];
      if (!next) {
        // Gaze on a non-instrumented element (e.g. hint slot before fill, or off-content area)
        return;
      }

      // Mark whether this entry, if it produces enough dwell, will count
      // as a regression. Evaluated here because lastExitAt is frozen at
      // time of previous exit.
      next._pendingEntryIsRegression =
        this.state.visited.has(newBrickId) &&
        next.lastExitAt !== null &&
        now - next.lastExitAt > cfg.REGRESSION_COOLDOWN_MS;

      // Update gaze-active class (visual feedback) — fine to do per-prediction
      // so user sees the cursor snapping. This is distinct from the
      // committed 'visited' set.
      document.querySelectorAll('.brick.gaze-active').forEach(el => el.classList.remove('gaze-active'));
      next.el.classList.add('gaze-active');

      this.state.currentBrick = newBrickId;
      this.state.currentBrickEnteredAt = now;
    } else {
      // Gaze off-content (telemetry pane, margins, etc.)
      document.querySelectorAll('.brick.gaze-active').forEach(el => el.classList.remove('gaze-active'));
      this.state.currentBrick = null;
      this.state.currentBrickEnteredAt = null;
    }
  },

  recordSample() {
    this.state.gazeSamples++;
  },

  _log(type, brickId, detail, source) {
    const t = ((performance.now() - this.state.sessionStart) / 1000).toFixed(1);
    this.state.events.push({
      t: parseFloat(t),
      type,
      brickId,
      detail,
      source: source || 'system',
    });
  },

  /**
   * Manually log a non-brick event (e.g. hint fill, calibration end).
   */
  logMeta(type, brickId, detail, source) {
    this._log(type, brickId || 'meta', detail, source || 'system');
  },
};

window.Events = Events;
