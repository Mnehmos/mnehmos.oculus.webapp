/**
 * Unit tests for js/classifier.js (multi-head).
 *
 * Uses TF.js loaded from the CDN in run_tests.html. Synthetic training
 * data with linearly separable classes — the MLPs should reach high
 * accuracy.
 */

window.runClassifierTests = async function runClassifierTests() {
  await Test.suite('classifier.js — build() + predict()', async () => {

    await Test.test('build({mode:classification}) creates a head', () => {
      window.Classifier.build({ mode: 'classification', brickIds: ['B01', 'B02', 'elsewhere'] });
      Test.assertEqual(window.Classifier.heads.length, 1);
      Test.assertEqual(window.Classifier.heads[0].mode, 'classification');
      Test.assertEqual(window.Classifier.heads[0].brickIds.length, 3);
      Test.assert(window.Classifier.model != null, 'primary model accessor broken');
    });

    await Test.test('build() honors featureProfile on a head', () => {
      window.Classifier.build({
        mode: 'classification',
        brickIds: ['B01', 'elsewhere'],
        featureProfile: 'eyes_pose',
      });
      Test.assertEqual(window.Classifier.heads[0].featureProfile, 'eyes_pose');
      Test.assertEqual(window.Classifier.heads[0].featureIndices.length, 20);
    });

    await Test.test('build({mode:regression}) creates a 2-output head', () => {
      window.Classifier.build({ mode: 'regression' });
      Test.assertEqual(window.Classifier.heads.length, 1);
      Test.assertEqual(window.Classifier.heads[0].mode, 'regression');
    });

    await Test.test('build([R, C]) creates multi-head ensemble', () => {
      window.Classifier.build([
        { tag: 'R', mode: 'regression' },
        { tag: 'C', mode: 'classification', brickIds: ['B01', 'B02'] },
      ]);
      Test.assertEqual(window.Classifier.heads.length, 2);
      Test.assertEqual(window.Classifier.heads[0].tag, 'R');
      Test.assertEqual(window.Classifier.heads[1].tag, 'C');
    });

    await Test.test('predict() returns per-head array', () => {
      window.Classifier.build([
        { tag: 'R', mode: 'regression' },
        { tag: 'C', mode: 'classification', brickIds: ['B01', 'B02', 'elsewhere'] },
      ]);
      const features = new Float32Array(24).fill(0.5);
      const preds = window.Classifier.predict(features);
      Test.assertEqual(preds.length, 2);
      Test.assertEqual(preds[0].tag, 'R');
      Test.assert('x' in preds[0].raw && 'y' in preds[0].raw, 'regression missing xy');
      Test.assertEqual(preds[1].tag, 'C');
      const sum = Object.values(preds[1].raw).reduce((s, v) => s + v, 0);
      Test.assertClose(sum, 1, 0.01, 'softmax sum');
    });

    await Test.test('argmax legacy alias resolves primary head', () => {
      window.Classifier.build({ mode: 'classification', brickIds: ['B01', 'elsewhere'] });
      const fakeDist = { B01: 0.2, elsewhere: 0.8 };
      Test.assert(window.Classifier.argmax(fakeDist) === null, "'elsewhere' maps to null");
    });

    await Test.test('classification margin gate rejects ambiguous predictions', () => {
      window.Classifier.build({ mode: 'classification', brickIds: ['B01', 'B02', 'elsewhere'] });
      const raw = { B01: 0.64, B02: 0.58, elsewhere: 0.01 };
      const resolved = window.Classifier._resolveOne(window.Classifier.heads[0], raw, null);
      Test.assertEqual(resolved, null, 'ambiguous winner should resolve to null');
    });
  });

  await Test.suite('classifier.js — train() multi-head', async () => {

    await Test.test('trains a classification head to >90% val accuracy', async () => {
      const classes = ['B01', 'B02', 'B03'];
      window.Classifier.build({ mode: 'classification', brickIds: classes });

      const features = [];
      const labels = [];
      const anchors = { B01: 0.0, B02: 1.0, B03: 2.0 };
      for (const cls of classes) {
        for (let i = 0; i < 40; i++) {
          const v = new Float32Array(24);
          v[0] = anchors[cls] + (Math.random() - 0.5) * 0.1;
          features.push(v);
          labels.push(cls);
        }
      }

      await window.Classifier.train(features, { classification: labels });
      const head = window.Classifier.heads[0];
      const lastAcc = head.trainingHistory.finalAccuracy ?? 0;
      Test.assert(lastAcc > 0.9, `final training accuracy ${lastAcc} < 0.9`);
    }, 15000);

    await Test.test('trains a regression head with low MSE on linearly separable data', async () => {
      window.Classifier.build({ mode: 'regression' });
      const features = [];
      const labels = [];
      for (let i = 0; i < 120; i++) {
        const v = new Float32Array(24);
        v[0] = Math.random();
        features.push(v);
        labels.push({ x: v[0], y: 0.5 });
      }
      await window.Classifier.train(features, { regression: labels });
      const head = window.Classifier.heads[0];
      const finalLoss = head.trainingHistory.finalLoss ?? Infinity;
      Test.assert(finalLoss < 0.05, `regression MSE ${finalLoss} too high`);
    }, 15000);

    await Test.test('exportMetadata() lists every head', () => {
      window.Classifier.build([
        { tag: 'R', mode: 'regression' },
        { tag: 'C', mode: 'classification', brickIds: ['B01', 'B02'] },
      ]);
      const meta = window.Classifier.exportMetadata();
      Test.assertEqual(meta.heads.length, 2);
      Test.assertEqual(meta.primaryTag, 'R');
    });
  });
};
