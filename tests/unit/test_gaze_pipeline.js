/**
 * Integration test: Features → Classifier → Gaze pipeline.
 *
 * Stubs FaceLandmarker.detectFrame to return synthetic fixtures so we can
 * walk the full chain without a webcam. Training a fresh classifier each
 * test, so these are slow-ish — run them last.
 */

window.runPipelineTests = async function runPipelineTests() {

  // Build a mock FaceLandmarker that returns whatever fixture is currently
  // programmed into _next.
  const mockFL = {
    _next: null,
    isReady: () => true,
    detectFrame() { return this._next; },
    getVideoElement: () => null,
    init: async () => ({ ok: true }),
    destroy() {},
    attachPreview() {},
  };

  await Test.suite('gaze.tick — integration with stubbed landmarker', async () => {

    // Swap in the mock for the whole suite, restore at end.
    const real = window.FaceLandmarker;
    window.FaceLandmarker = mockFL;

    try {

      await Test.test('sets up: train classifier on 3 brick fixtures', async () => {
        const classes = ['B01', 'B02', 'B03', 'elsewhere'];
        window.Classifier.build({ mode: 'classification', brickIds: classes });

        // Build training sets per class using irisX as distinguisher
        // B01 = gaze left   (irisX = -0.6)
        // B02 = gaze center (irisX =  0.0)
        // B03 = gaze right  (irisX =  0.6)
        // elsewhere = eyes closed
        const rawFixtures = [];
        const labels = [];
        const configs = [
          { cls: 'B01', irisX: -0.6, eyesOpen: true },
          { cls: 'B02', irisX:  0.0, eyesOpen: true },
          { cls: 'B03', irisX:  0.6, eyesOpen: true },
          { cls: 'elsewhere', irisX: 0, eyesOpen: false },
        ];
        for (const c of configs) {
          for (let i = 0; i < 40; i++) {
            const jx = (Math.random() - 0.5) * 0.15;
            const fixture = window.Fixtures.syntheticFrame({
              irisX: c.irisX + jx,
              eyesOpen: c.eyesOpen,
            });
            rawFixtures.push(fixture);
            labels.push(c.cls);
          }
        }
        const featureRows = rawFixtures.map(f => window.Features.extract(f));
        window.Features.computeNormalization(featureRows);
        const normalized = featureRows.map(f => window.Features.normalize(f));
        await window.Classifier.train(normalized, labels);

        const acc = window.Classifier.validate(normalized, labels);
        Test.assert(acc > 0.85, `training accuracy ${acc} too low (check features?)`);
      }, 20000);

      await Test.test('Gaze.tick returns correct brick id after majority-vote window fills', () => {
        window.Gaze.reset();
        mockFL._next = window.Fixtures.syntheticFrame({ irisX: 0.6, eyesOpen: true });

        // Need PREDICTION_SMOOTHING_MIN_AGREE consecutive B03 predictions
        // before Gaze.tick emits 'B03'. Pump enough frames.
        let result;
        for (let i = 0; i < 10; i++) {
          result = window.Gaze.tick(null, false);
        }
        Test.assertEqual(result, 'B03', `expected B03 after pump, got ${result}`);
      });

      await Test.test('Gaze.tick returns null when eyes are closed (elsewhere)', () => {
        window.Gaze.reset();
        mockFL._next = window.Fixtures.syntheticFrame({ irisX: 0, eyesOpen: false });

        let result;
        for (let i = 0; i < 10; i++) {
          result = window.Gaze.tick(null, false);
        }
        // elsewhere should map to null via Classifier.argmax
        Test.assertEqual(result, null, `expected null on closed-eyes, got ${result}`);
      });

      await Test.test('Gaze.tick returns null when FaceLandmarker returns empty', () => {
        window.Gaze.reset();
        mockFL._next = window.Fixtures.emptyFrame();
        let result;
        for (let i = 0; i < 10; i++) {
          result = window.Gaze.tick(null, false);
        }
        Test.assertEqual(result, null, 'no-face should emit null');
        Test.assert(!window.Gaze.lastPrediction.faceDetected, 'faceDetected should be false');
      });

      await Test.test('temporal smoothing rejects single-frame outliers', () => {
        window.Gaze.reset();

        // Flood the smoothing window with B03
        mockFL._next = window.Fixtures.syntheticFrame({ irisX: 0.6, eyesOpen: true });
        for (let i = 0; i < 10; i++) window.Gaze.tick(null, false);
        Test.assertEqual(window.Gaze._majorityVote(), 'B03');

        // One outlier shouldn't flip majority
        mockFL._next = window.Fixtures.syntheticFrame({ irisX: -0.6, eyesOpen: true });
        window.Gaze.tick(null, false);
        Test.assertEqual(window.Gaze._majorityVote(), 'B03', 'one outlier shouldn\'t flip');
      });

      await Test.test('lastPrediction exposes confidence and head pose', () => {
        window.Gaze.reset();
        mockFL._next = window.Fixtures.syntheticFrame({ irisX: 0.6, headYaw: 0.3 });
        window.Gaze.tick(null, false);

        Test.assert(window.Gaze.lastPrediction.faceDetected, 'faceDetected false');
        Test.assert(window.Gaze.lastPrediction.confidence >= 0
                 && window.Gaze.lastPrediction.confidence <= 1,
                 'confidence not in [0,1]');
        Test.assertClose(window.Gaze.lastPrediction.headPose.yaw, 0.3, 0.05,
                         'head yaw not surfaced');
      });

    } finally {
      window.FaceLandmarker = real;
    }
  });
};
