/**
 * Unit tests for js/features.js.
 *
 * Uses the synthetic fixture generator. No webcam, no MediaPipe.
 */

window.runFeatureTests = async function runFeatureTests() {
  await Test.suite('features.js — extract()', async () => {

    await Test.test('returns null when no face detected', () => {
      const out = window.Features.extract(window.Fixtures.emptyFrame());
      Test.assert(out === null, 'expected null on empty result');
    });

    await Test.test('returns Float32Array of length DIM (24)', () => {
      const result = window.Fixtures.syntheticFrame();
      const features = window.Features.extract(result);
      Test.assert(features instanceof Float32Array, 'not a Float32Array');
      Test.assertEqual(features.length, window.Features.DIM, 'wrong length');
    });

    await Test.test('iris_relative_x ≈ 0.5 when irisX = 0 (centered)', () => {
      const result = window.Fixtures.syntheticFrame({ irisX: 0 });
      const f = window.Features.extract(result);
      // Right eye: inner=0.45, outer=0.30 → iris at 0.375 → (0.375-0.45)/(0.30-0.45) = 0.5
      Test.assertClose(f[0], 0.5, 0.05, 'right iris_relative_x not centered');
      Test.assertClose(f[2], 0.5, 0.05, 'left iris_relative_x not centered');
    });

    await Test.test('iris_relative_x shifts toward 1 as user looks outward (irisX=1)', () => {
      const centered = window.Features.extract(window.Fixtures.syntheticFrame({ irisX: 0 }));
      const looking  = window.Features.extract(window.Fixtures.syntheticFrame({ irisX: 1 }));
      // irisX=1 puts iris AT the outer canthus → ratio should jump from ~0.5 to ~1
      Test.assert(looking[0] > centered[0] + 0.3, `right iris didn't track (center=${centered[0]}, look=${looking[0]})`);
    });

    await Test.test('EAR is lower when eyes are closed', () => {
      const open   = window.Features.extract(window.Fixtures.syntheticFrame({ eyesOpen: true }));
      const closed = window.Features.extract(window.Fixtures.syntheticFrame({ eyesOpen: false }));
      Test.assert(open[4] > closed[4], `right EAR should drop on close (open=${open[4]}, closed=${closed[4]})`);
      Test.assert(open[5] > closed[5], `left EAR should drop on close (open=${open[5]}, closed=${closed[5]})`);
    });

    await Test.test('head yaw extracted from transformation matrix', () => {
      const yaw0  = window.Features.extract(window.Fixtures.syntheticFrame({ headYaw: 0 }));
      const yaw05 = window.Features.extract(window.Fixtures.syntheticFrame({ headYaw: 0.5 }));
      Test.assertClose(yaw0[6],  0.0, 0.02, 'yaw not zero at 0');
      Test.assertClose(yaw05[6], 0.5, 0.05, 'yaw not 0.5 at 0.5');
    });

    await Test.test('head distance ≈ 60cm from synthetic transform', () => {
      const f = window.Features.extract(window.Fixtures.syntheticFrame());
      Test.assertClose(f[9], 60, 1, 'distance not 60cm');
    });

    await Test.test('blendshape eyeBlinkLeft maps to feature[14]', () => {
      const open   = window.Features.extract(window.Fixtures.syntheticFrame({ eyesOpen: true }));
      const closed = window.Features.extract(window.Fixtures.syntheticFrame({ eyesOpen: false }));
      Test.assert(closed[14] > open[14] + 0.5, 'eyeBlinkLeft not surfaced');
    });
  });

  await Test.suite('features.js — normalization', async () => {

    await Test.test('computeNormalization sets mean & std arrays', () => {
      const samples = [];
      for (let i = 0; i < 20; i++) {
        samples.push(window.Features.extract(window.Fixtures.syntheticFrame({
          irisX: (i / 19) * 2 - 1,
        })));
      }
      window.Features.computeNormalization(samples);
      Test.assert(window.Features.mean instanceof Float32Array, 'mean not set');
      Test.assert(window.Features.std  instanceof Float32Array, 'std not set');
      Test.assertEqual(window.Features.mean.length, 24, 'wrong mean length');
    });

    await Test.test('normalize() produces z-scored vectors (mean ≈ 0)', () => {
      const samples = [];
      for (let i = 0; i < 50; i++) {
        samples.push(window.Features.extract(window.Fixtures.syntheticFrame({
          irisX: (Math.random() * 2) - 1,
          irisY: (Math.random() * 2) - 1,
        })));
      }
      window.Features.computeNormalization(samples);
      const normalized = samples.map(s => window.Features.normalize(s));

      // Compute mean of dim 0 across normalized vectors — should be near 0
      let sum = 0;
      for (const n of normalized) sum += n[0];
      const mean = sum / normalized.length;
      Test.assertClose(mean, 0, 0.1, `normalized dim-0 mean=${mean}, expected ≈ 0`);
    });

    await Test.test('normalize() returns input unchanged if stats unset', () => {
      window.Features.reset();
      const f = window.Features.extract(window.Fixtures.syntheticFrame());
      const n = window.Features.normalize(f);
      Test.assertEqual(n[0], f[0], 'should be identity when stats not computed');
    });

    await Test.test('exportNormalization round-trips', () => {
      window.Features.reset();
      const samples = [
        window.Features.extract(window.Fixtures.syntheticFrame({ irisX: -0.5 })),
        window.Features.extract(window.Fixtures.syntheticFrame({ irisX:  0.5 })),
      ];
      window.Features.computeNormalization(samples);
      const exp = window.Features.exportNormalization();
      Test.assert(Array.isArray(exp.mean) && Array.isArray(exp.std), 'export arrays missing');
      Test.assertEqual(exp.mean.length, 24, 'mean length wrong');
    });
  });

  await Test.suite('features.js — feature profiles', async () => {

    await Test.test('resolveFeatureIndices returns eyes_pose profile', () => {
      const idx = window.Features.resolveFeatureIndices('eyes_pose');
      Test.assertEqual(idx.length, 20, 'eyes_pose should expose 20 dims');
      Test.assertEqual(idx[0], 0, 'eyes_pose should start with iris features');
      Test.assertEqual(idx[idx.length - 1], 23, 'eyes_pose should include eyeLookUpRight');
    });

    await Test.test('project() slices the requested features', () => {
      const f = new Float32Array(24);
      for (let i = 0; i < 24; i++) f[i] = i;
      const projected = window.Features.project(f, [0, 6, 9, 23]);
      Test.assertEqual(projected.length, 4, 'projected length wrong');
      Test.assertEqual(projected[0], 0, 'dim 0 wrong');
      Test.assertEqual(projected[1], 6, 'dim 6 wrong');
      Test.assertEqual(projected[2], 9, 'dim 9 wrong');
      Test.assertEqual(projected[3], 23, 'dim 23 wrong');
    });
  });
};
