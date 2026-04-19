/**
 * Session export.
 *
 * Packages everything Events has seen during a session into a JSON blob
 * and triggers a browser download. This is the raw pedagogy dataset:
 * per-brick dwell, visits, regressions, stalls; the full typed event log;
 * hint-fire record.
 *
 * v0.2: adds classifier metadata (architecture, training summary, validation
 * accuracy) so downstream analysis can reason about the quality of the
 * classifier that produced the gaze stream. Optionally includes a
 * per-frame confidence stream when EXPORT_CONFIDENCE_STREAM is true
 * (off by default — it balloons file size).
 */

const ExportSession = {

  schemaVersion: 'oculus/v0.2',

  toJSON(lessonId) {
    const cfg = window.OCULUS_CONFIG;
    const now = performance.now();
    return {
      schema: this.schemaVersion,
      lessonId: lessonId || null,
      exportedAt: new Date().toISOString(),
      durationMs: Events.state.sessionStart ? now - Events.state.sessionStart : 0,
      gazeSamples: Events.state.gazeSamples,
      gazeArchitecture: window.Classifier
        ? `gaze_mode_${window.Classifier.mode || 'regression'}_v0.2`
        : 'unknown',
      classifier: window.Classifier ? window.Classifier.exportMetadata() : null,
      featureNormalization: window.Features ? window.Features.exportNormalization() : null,
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
      readerCursor: window.ReaderCursor ? window.ReaderCursor.exportStats() : null,
      confidenceStream: cfg.EXPORT_CONFIDENCE_STREAM
        ? (window.Gaze && window.Gaze._confidenceStream) || []
        : null,
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
