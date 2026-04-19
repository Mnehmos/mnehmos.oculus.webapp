/**
 * Pedagogical controller.
 *
 * Subscribes to typed events. Decides when a brick's reader is confused enough
 * to warrant showing a hint. Fires the hint by filling an adjacent hint slot.
 *
 * Current policy (v1 beta):
 *   - A hint is eligible when the associated content brick has at least
 *     CONFUSION_THRESHOLD.stallsRequired stalls OR .regressionsRequired regressions.
 *   - Hints respect HINT_COOLDOWN_MS between fires so a reader isn't spammed.
 *   - Each hint slot fires at most once per session.
 *
 * In the full version (Quest Keeper / RPG MCP-tier), this module would be
 * the place that calls out to an LLM with the reader's recent trace and asks
 * for a context-specific hint rather than reading pre-authored ones from the
 * lesson JSON. For the beta, pre-authored hints let us validate trigger logic
 * without the cost and variance of live LLM calls.
 */

const Controller = {

  state: {
    hintsFired: 0,
    lastHintAt: 0,
  },

  reset() {
    this.state.hintsFired = 0;
    this.state.lastHintAt = 0;
  },

  /**
   * Called by the event loop when a stall or regression event fires.
   * Decides whether the brick is now eligible for a hint, and fills the
   * adjacent hint slot if so.
   */
  maybeFireHint(brickId) {
    const cfg = window.OCULUS_CONFIG;
    const brick = Events.state.bricks[brickId];
    if (!brick) return;

    const now = performance.now();
    if (now - this.state.lastHintAt < cfg.HINT_COOLDOWN_MS) return;

    const eligible =
      brick.stalls >= cfg.CONFUSION_THRESHOLD.stallsRequired ||
      brick.regressions >= cfg.CONFUSION_THRESHOLD.regressionsRequired;
    if (!eligible) return;

    // Find the matching hint slot.
    const hintSlot = document.querySelector(`.hint-slot[data-hint-for="${brickId}"]`);
    if (!hintSlot || hintSlot.classList.contains('filled')) return;

    this._fillHint(hintSlot, brickId);
    this.state.lastHintAt = now;
    this.state.hintsFired++;
  },

  _fillHint(slotEl, forBrickId) {
    const label = slotEl.dataset.hintLabel || 'Hint';
    const html = slotEl.dataset.hintHtml || '';

    slotEl.innerHTML = `
      <div class="hint-label">${label}</div>
      ${html}
    `;
    slotEl.classList.add('filled');

    Events.logMeta('hint_fill', slotEl.dataset.brickId, `for ${forBrickId}`);
  },
};

window.Controller = Controller;
