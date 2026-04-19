/**
 * Live telemetry pane.
 *
 * Reads from Events.state and Controller.state. Updates the right-hand pane
 * every TELEMETRY_TICK_MS. Also owns the event log DOM.
 *
 * This module is pure read-from-state → render. All the real reasoning
 * lives in Events and Controller.
 */

const Telemetry = {

  els: {}, // bound at init

  init(els) {
    this.els = els;
    this._buildHeatmap();
  },

  _buildHeatmap() {
    const container = this.els.heatmap;
    if (!container) return;
    container.innerHTML = '';
    const contentBrickIds = Object.keys(Events.state.bricks)
      .filter(id => Events.state.bricks[id].type !== 'hint');

    for (const brickId of contentBrickIds) {
      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      cell.dataset.brickId = brickId;
      cell.dataset.dwell = '0';
      cell.textContent = brickId;
      container.appendChild(cell);
    }
  },

  tick() {
    if (!Events.state.sessionStart) return;
    const now = performance.now();
    const elapsed = (now - Events.state.sessionStart) / 1000;

    this._set('elapsed', elapsed.toFixed(1) + 's');
    this._set('samples', Events.state.gazeSamples);
    this._set('current', Events.state.currentBrick || '—');
    this._set('dwell', Events.state.currentBrickEnteredAt
      ? ((now - Events.state.currentBrickEnteredAt) / 1000).toFixed(1) + 's'
      : '0.0s');

    const contentBrickIds = Object.keys(Events.state.bricks)
      .filter(id => Events.state.bricks[id].type !== 'hint');
    const visitedContent = contentBrickIds.filter(id => Events.state.visited.has(id));
    this._set('visited', `${visitedContent.length} / ${contentBrickIds.length}`);
    this._set('hints', Controller.state.hintsFired);

    // --- v0.2: classifier confidence + head pose ---
    this._renderGazeDiagnostics();

    this._updateHeatmap(contentBrickIds, now);
    this._syncEventLog();
  },

  _renderGazeDiagnostics() {
    const cfg = window.OCULUS_CONFIG;
    const gp = window.Gaze && window.Gaze.lastPrediction;
    if (!gp) return;

    // confidence: mark accent if above threshold
    const confEl = this.els.confidence;
    if (confEl) {
      if (!gp.faceDetected) {
        confEl.textContent = 'no face';
        confEl.classList.remove('accent');
      } else {
        confEl.textContent = gp.confidence.toFixed(2);
        confEl.classList.toggle('accent', gp.confidence >= cfg.CONFIDENCE_THRESHOLD);
      }
    }

    const hpEl = this.els.headPose;
    if (hpEl) {
      if (!gp.faceDetected) {
        hpEl.textContent = '—';
      } else {
        const rad2deg = 180 / Math.PI;
        const yawDeg = (gp.headPose.yaw * rad2deg).toFixed(1);
        const pitchDeg = (gp.headPose.pitch * rad2deg).toFixed(1);
        hpEl.textContent = `y${yawDeg}° p${pitchDeg}°`;
      }
    }

    // Multi-head: show each head's current brick id. Primary is marked
    // with a star; ensemble (majority across heads) is shown last.
    const headsEl = this.els.headsRow;
    if (headsEl && gp.perHead) {
      const primaryTag = window.Classifier?.heads?.[window.Classifier.primaryIdx || 0]?.tag;
      const parts = Object.entries(gp.perHead).map(([tag, id]) => {
        const marker = tag === primaryTag ? '★' : '·';
        return `${marker}${tag}=${id || '—'}`;
      });
      if (gp.ensembleBrickId !== undefined) {
        parts.push(`Σ=${gp.ensembleBrickId || '—'}`);
      }
      headsEl.textContent = parts.join(' ');
    }
  },

  _set(key, value) {
    const el = this.els[key];
    if (el) el.textContent = value;
  },

  _updateHeatmap(contentBrickIds, now) {
    const maxDwell = Math.max(1, ...contentBrickIds.map(id => Events.state.bricks[id].dwellTotal));
    for (const id of contentBrickIds) {
      const cell = document.querySelector(`.heatmap-cell[data-brick-id="${id}"]`);
      if (!cell) continue;
      const b = Events.state.bricks[id];
      const liveDwell = (id === Events.state.currentBrick && Events.state.currentBrickEnteredAt)
        ? b.dwellTotal + (now - Events.state.currentBrickEnteredAt)
        : b.dwellTotal;
      const pct = liveDwell / maxDwell;
      cell.dataset.dwell = Math.round(liveDwell);
      cell.style.setProperty('--dwell-pct', pct.toFixed(3));
    }
  },

  /**
   * Sync the event log DOM with the most recent events. Insert newer-first
   * so the most recent event is always visible at top.
   */
  _syncEventLog() {
    const logEl = this.els.eventLog;
    if (!logEl) return;
    const cfg = window.OCULUS_CONFIG;
    const events = Events.state.events;

    // Only render the last N events to keep DOM bounded.
    const renderCount = Math.min(events.length, cfg.EVENT_LOG_MAX);
    const slice = events.slice(-renderCount).reverse();

    // Clear and re-render the tail. Simple, cheap, reliable for small N.
    if (logEl.children.length !== slice.length) {
      logEl.innerHTML = '';
      for (const ev of slice) {
        const row = document.createElement('div');
        row.className = `event-row ev-${ev.type}`;
        row.innerHTML = `
          <span class="ev-time">${ev.t.toFixed(1)}s</span>
          <span class="ev-type">${ev.type}</span>
          <span class="ev-body">${ev.brickId} &mdash; ${ev.detail}</span>
        `;
        logEl.appendChild(row);
      }
    } else if (slice.length > 0) {
      // If counts match, likely unchanged; but still check the newest.
      const newest = slice[0];
      const firstRow = logEl.firstChild;
      if (firstRow && !firstRow.dataset.t) {
        firstRow.dataset.t = newest.t;
      }
    }
  },
};

window.Telemetry = Telemetry;
