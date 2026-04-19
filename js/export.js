/**
 * Session export.
 *
 * Packages everything Events has seen during a session into a JSON blob
 * and triggers a browser download. This is the raw pedagogy dataset:
 * per-brick dwell, visits, regressions, stalls; the full typed event log;
 * hint-fire record.
 *
 * Schema version is included so future consumers can evolve without breaking
 * old exports.
 */

const ExportSession = {

  schemaVersion: 'oculus/v0.1',

  toJSON(lessonId) {
    const now = performance.now();
    return {
      schema: this.schemaVersion,
      lessonId: lessonId || null,
      exportedAt: new Date().toISOString(),
      durationMs: Events.state.sessionStart ? now - Events.state.sessionStart : 0,
      gazeSamples: Events.state.gazeSamples,
      bricks: Object.fromEntries(
        Object.entries(Events.state.bricks).map(([id, b]) => [id, {
          type: b.type,
          expectedDwell: b.expectedDwell,
          dwellTotal: Math.round(b.dwellTotal),
          visits: b.visits,
          regressions: b.regressions,
          stalls: b.stalls,
        }])
      ),
      events: Events.state.events,
      hintsFired: Controller.state.hintsFired,
    };
  },

  downloadAsFile(lessonId) {
    const data = this.toJSON(lessonId);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `oculus-${lessonId || 'session'}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
};

window.ExportSession = ExportSession;
