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
 */

const Events = {

  state: {
    sessionStart: null,
    gazeSamples: 0,
    currentBrick: null,
    currentBrickEnteredAt: null,
    visited: new Set(),
    bricks: {},     // brickId -> { dwellTotal, visits, regressions, stalls, lastExitAt, ... }
    events: [],     // full typed event log for session export
  },

  init(brickElements) {
    const cfg = window.OCULUS_CONFIG;
    this.state.sessionStart = performance.now();
    this.state.bricks = {};
    this.state.events = [];
    this.state.visited = new Set();
    this.state.currentBrick = null;
    this.state.currentBrickEnteredAt = null;

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
      };
    }
  },

  /**
   * Process a brick-id resolved from the current gaze sample. Fires events
   * via the provided callback when transitions occur.
   *
   * Callback signature: onEvent(eventType, brickId, detail)
   */
  processBrick(newBrickId, onEvent) {
    const cfg = window.OCULUS_CONFIG;
    const now = performance.now();
    const prevBrickId = this.state.currentBrick;

    if (newBrickId === prevBrickId) {
      return; // Same brick, nothing to do
    }

    // --- Leaving a brick ---
    if (prevBrickId) {
      const prev = this.state.bricks[prevBrickId];
      if (prev) {
        const dwell = now - this.state.currentBrickEnteredAt;
        prev.dwellTotal += dwell;
        prev.lastExitAt = now;

        // Stall detection on exit
        if (dwell > prev.expectedDwell * cfg.STALL_MULTIPLIER) {
          prev.stalls++;
          prev.el.classList.add('stalled');
          this._log('stall', prevBrickId, `dwell ${Math.round(dwell)}ms (expected ~${prev.expectedDwell}ms)`);
          onEvent && onEvent('stall', prevBrickId, prev);
        }
      }
    }

    // --- Entering a new brick (or none) ---
    if (newBrickId) {
      const next = this.state.bricks[newBrickId];
      if (!next) {
        // Gaze on a non-instrumented element (e.g. hint slot before fill, or off-content area)
        return;
      }

      next.visits++;
      const wasVisited = this.state.visited.has(newBrickId);
      this.state.visited.add(newBrickId);

      if (!wasVisited) {
        this._log('first_read', newBrickId, `type=${next.type}`);
        onEvent && onEvent('first_read', newBrickId, next);
      } else if (
        next.lastExitAt !== null &&
        now - next.lastExitAt > cfg.REGRESSION_COOLDOWN_MS
      ) {
        next.regressions++;
        next.el.classList.add('regressed');
        this._log('regression', newBrickId, `visit #${next.visits}`);
        onEvent && onEvent('regression', newBrickId, next);
      }

      // Update gaze-active class (visual feedback)
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

  _log(type, brickId, detail) {
    const t = ((performance.now() - this.state.sessionStart) / 1000).toFixed(1);
    this.state.events.push({ t: parseFloat(t), type, brickId, detail });
  },

  /**
   * Manually log a non-brick event (e.g. hint fill, calibration end).
   */
  logMeta(type, brickId, detail) {
    this._log(type, brickId || 'meta', detail);
  },
};

window.Events = Events;
