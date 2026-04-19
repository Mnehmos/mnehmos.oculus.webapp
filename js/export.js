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

  schemaVersion: 'oculus/v0.3',

  toJSON(lessonId) {
    const cfg = window.OCULUS_CONFIG;
    const now = performance.now();
    const durationMs = Events.state.sessionStart ? now - Events.state.sessionStart : 0;
    const rcStats = window.ReaderCursor ? window.ReaderCursor.exportStats() : null;

    // Derive session-wide reading metrics from the word-dwell map so LLMs
    // don't have to re-derive common aggregates.
    let totalUniqueWords = 0;
    let totalDwellMs = 0;
    let longestWord = null;
    if (rcStats && rcStats.wordDwell) {
      totalUniqueWords = rcStats.wordDwell.length;
      for (const w of rcStats.wordDwell) {
        totalDwellMs += w.dwellMs;
        if (!longestWord || w.dwellMs > longestWord.dwellMs) longestWord = w;
      }
    }
    const wordsPerMinute = durationMs > 0
      ? Math.round((totalUniqueWords / (durationMs / 60000)) * 10) / 10
      : 0;

    return {
      schema: this.schemaVersion,
      lessonId: lessonId || null,
      exportedAt: new Date().toISOString(),
      durationMs,
      gazeSamples: Events.state.gazeSamples,
      readingPace: {
        wordsPerMinute,
        totalUniqueWords,
        totalWordDwellMs: totalDwellMs,
        longestWord,   // { brickId, wordText, dwellMs, visits } or null
      },
      gazeArchitecture: window.Classifier
        ? `gaze_mode_${window.Classifier.mode || 'regression'}_v0.2`
        : 'unknown',
      classifier: window.Classifier ? window.Classifier.exportMetadata() : null,
      featureNormalization: window.Features ? window.Features.exportNormalization() : null,
      bricks: Object.fromEntries(
        Object.entries(Events.state.bricks).map(([id, b]) => {
          // Collect the word list + dwell per word for this brick so an
          // LLM can see exactly what was read and how long each word
          // held attention.
          const brickEl = document.querySelector(`.brick[data-brick-id="${id}"]`);
          const wordStats = [];
          let totalWords = 0;
          if (brickEl) {
            const words = brickEl.querySelectorAll('.word');
            totalWords = words.length;
            words.forEach((w, idx) => {
              const key = `${id}::${idx}`;
              const dwell = window.ReaderCursor
                ? (window.ReaderCursor.wordDwell.get(key) || 0)
                : 0;
              const visits = window.ReaderCursor
                ? (window.ReaderCursor.wordVisits.get(key) || 0)
                : 0;
              // Only emit words the reader actually touched to keep the
              // export compact; full word list is reconstructable from
              // the contentWords field below.
              if (dwell > 0 || visits > 0) {
                wordStats.push({
                  idx,
                  text: w.textContent,
                  dwellMs: Math.round(dwell),
                  visits,
                });
              }
            });
          }

          // Derived reading metrics per brick
          const uniqueWordsRead = wordStats.length;
          const meanWordDwell = wordStats.length > 0
            ? Math.round(wordStats.reduce((s, w) => s + w.dwellMs, 0) / wordStats.length)
            : 0;
          const longestWordDwell = wordStats.length > 0
            ? Math.max(...wordStats.map(w => w.dwellMs))
            : 0;

          // Full word sequence (LLM reconstructable context)
          const contentWords = brickEl
            ? Array.from(brickEl.querySelectorAll('.word')).map(w => w.textContent)
            : [];

          return [id, {
            type: b.type,
            expectedDwell: b.expectedDwell,
            dwellTotal: Math.round(b.dwellTotal),
            visits: b.visits,
            regressions: b.regressions,
            stalls: b.stalls,
            totalWords,
            uniqueWordsRead,
            meanWordDwell,
            longestWordDwell,
            contentWords,
            wordStats,
          }];
        })
      ),
      events: Events.state.events,
      hintsFired: Controller.state.hintsFired,
      readerCursor: rcStats,
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
