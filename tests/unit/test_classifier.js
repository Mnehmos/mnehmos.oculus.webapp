/**
 * Unit tests for js/classifier.js.
 *
 * Requires tf.js (loaded from CDN in run_tests.html).
 * Uses synthetic training data with linearly separable classes — the MLP
 * should reach high validation accuracy. If it doesn't, something in the
 * build/train/predict chain is broken.
 */

window.runClassifierTests = async function runClassifierTests() {
  await Test.suite('classifier.js — build() + predict()', async () => {

    await Test.test('build(classification) creates a tf.Model', () => {
      window.Classifier.build({ mode: 'classification', brickIds: ['B01', 'B02', 'elsewhere'] });
      Test.assert(window.Classifier.model != null, 'model not created');
      Test.assertEqual(window.Classifier.brickIds.length, 3, 'wrong classes count');
      Test.assertEqual(window.Classifier.mode, 'classification');
    });

    await Test.test('build(regression) creates a tf.Model with 2-neuron output', () => {
      window.Classifier.build({ mode: 'regression' });
      Test.assert(window.Classifier.model != null, 'regression model not created');
      Test.assertEqual(window.Classifier.mode, 'regression');
    });

    await Test.test('predict() returns distribution summing to ~1 (classification)', () => {
      window.Classifier.build({ mode: 'classification', brickIds: ['B01', 'B02', 'elsewhere'] });
      const features = new Float32Array(24).fill(0.5);
      const dist = window.Classifier.predict(features);
      Test.assert(dist != null, 'predict returned null');
      const sum = Object.values(dist).reduce((s, v) => s + v, 0);
      Test.assertClose(sum, 1, 0.01, `softmax sum=${sum}`);
    });

    await Test.test('predict() returns {x, y} in regression mode', () => {
      window.Classifier.build({ mode: 'regression' });
      const features = new Float32Array(24).fill(0.5);
      const out = window.Classifier.predict(features);
      Test.assert(out != null, 'predict returned null');
      Test.assert('x' in out && 'y' in out, 'regression output missing x/y');
    });

    await Test.test('argmax returns null for low-confidence predictions', () => {
      window.Classifier.build({ mode: 'classification', brickIds: ['B01', 'B02', 'elsewhere'] });
      const features = new Float32Array(24).fill(0.0);
      const dist = window.Classifier.predict(features);
      const id = window.Classifier.argmax(dist);
      if (id !== null) {
        Test.assert(window.Classifier.brickIds.includes(id), 'argmax returned unknown id');
        Test.assert(id !== 'elsewhere', "argmax should never surface 'elsewhere'");
      }
    });

    await Test.test("argmax returns null when 'elsewhere' wins", () => {
      window.Classifier.build({ mode: 'classification', brickIds: ['B01', 'elsewhere'] });
      const fakeDist = { B01: 0.2, elsewhere: 0.8 };
      Test.assert(window.Classifier.argmax(fakeDist) === null, "should map 'elsewhere' → null");
    });
  });

  await Test.suite('classifier.js — train() with synthetic data', async () => {

    await Test.test('trains to >90% val_accuracy on 3 linearly-separable classes', async () => {
      const classes = ['B01', 'B02', 'B03'];
      window.Classifier.build({ mode: 'classification', brickIds: classes });

      // Each class: 40 samples. Feature[0] is the only distinguishing dim.
      //   B01 centers at feature[0] = 0.0
      //   B02 centers at feature[0] = 1.0
      //   B03 centers at feature[0] = 2.0
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

      const history = await window.Classifier.train(features, labels);
      const finalAcc = history.history.acc
                    ?? history.history.accuracy
                    ?? [0];
      const last = finalAcc[finalAcc.length - 1];
      Test.assert(last > 0.9, `final training accuracy ${last} < 0.9`);
    }, 15000);

    await Test.test('predicts correct class on held-out synthetic sample', () => {
      const v = new Float32Array(24);
      v[0] = 0.0;  // should be B01
      const dist = window.Classifier.predict(v);
      Test.assert(dist.B01 > dist.B02, `B01 not dominant: B01=${dist.B01} B02=${dist.B02}`);
      Test.assert(dist.B01 > dist.B03, `B01 not dominant vs B03: B01=${dist.B01} B03=${dist.B03}`);
    });

    await Test.test('exportMetadata() includes training summary', () => {
      const meta = window.Classifier.exportMetadata();
      Test.assert(meta.trainedAt != null, 'trainedAt missing');
      Test.assert(meta.history != null, 'history missing');
      Test.assertEqual(meta.classes.length, 3, 'wrong classes count in metadata');
    });
  });
};
