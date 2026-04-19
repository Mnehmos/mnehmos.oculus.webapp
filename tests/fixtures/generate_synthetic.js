/**
 * Synthetic MediaPipe-result fixture generator.
 *
 * The test suite can't run real MediaPipe without a webcam, so we build
 * minimal valid "results" with controlled iris positions, EAR values, and
 * head-pose matrices. Features.extract should behave identically on these
 * as on real landmarker output.
 *
 * A result object matches what FaceLandmarker.detectForVideo returns:
 *   {
 *     faceLandmarks:                [[{x,y,z}, ...478]],
 *     faceBlendshapes:              [{ categories: [{score, categoryName}, ...52] }],
 *     facialTransformationMatrixes: [{ data: Float32Array(16) }],
 *   }
 *
 * Only the landmarks Features.extract actually reads are populated; the
 * rest are {x:0,y:0,z:0} placeholders.
 */

window.Fixtures = {

  /**
   * Build a synthetic result for a face with given iris position and head yaw.
   *
   * @param irisX   in [-1, 1] — -1 means both irises at inner canthus
   *                (looking strongly nose-ward), +1 at outer canthus
   *                (looking strongly temple-ward). 0 = centered.
   * @param irisY   in [-1, 1] — -1 = looking up, +1 = looking down
   * @param headYaw radians
   * @param eyesOpen true = normal EAR, false = crushed eyelids (blink)
   */
  syntheticFrame({ irisX = 0, irisY = 0, headYaw = 0, eyesOpen = true } = {}) {
    const landmarks = new Array(478);
    for (let i = 0; i < 478; i++) landmarks[i] = { x: 0, y: 0, z: 0 };

    // Right eye corners (user's right = image left)
    landmarks[33]  = { x: 0.30, y: 0.40, z: 0 };
    landmarks[133] = { x: 0.45, y: 0.40, z: 0 };
    // Left eye corners
    landmarks[362] = { x: 0.55, y: 0.40, z: 0 };
    landmarks[263] = { x: 0.70, y: 0.40, z: 0 };

    // Iris centers: map irisX∈[-1,1] to position between inner/outer canthus
    const rInner = 0.45, rOuter = 0.30;
    const lInner = 0.55, lOuter = 0.70;
    const t = (irisX + 1) / 2;  // [0,1]
    landmarks[468] = { x: rInner + (rOuter - rInner) * t, y: 0.40 + irisY * 0.01, z: 0 };
    landmarks[473] = { x: lInner + (lOuter - lInner) * t, y: 0.40 + irisY * 0.01, z: 0 };

    // Upper/lower lids (for EAR). Vertical separation controls openness.
    const open = eyesOpen ? 0.015 : 0.002;
    // Right EAR: [33, 160, 158, 133, 153, 144]
    // We already set 33 and 133; now the upper (160,158) and lower (153,144) lids
    landmarks[160] = { x: 0.35, y: 0.40 - open, z: 0 };
    landmarks[158] = { x: 0.40, y: 0.40 - open, z: 0 };
    landmarks[153] = { x: 0.40, y: 0.40 + open, z: 0 };
    landmarks[144] = { x: 0.35, y: 0.40 + open, z: 0 };
    // Left EAR: [362, 385, 387, 263, 373, 380]
    landmarks[385] = { x: 0.60, y: 0.40 - open, z: 0 };
    landmarks[387] = { x: 0.65, y: 0.40 - open, z: 0 };
    landmarks[373] = { x: 0.65, y: 0.40 + open, z: 0 };
    landmarks[380] = { x: 0.60, y: 0.40 + open, z: 0 };

    // Head reference points
    landmarks[1]   = { x: 0.50, y: 0.50, z: 0 };  // nose tip
    landmarks[10]  = { x: 0.50, y: 0.28, z: 0 };  // forehead
    landmarks[152] = { x: 0.50, y: 0.72, z: 0 };  // chin
    landmarks[234] = { x: 0.22, y: 0.50, z: 0 };  // right cheek
    landmarks[454] = { x: 0.78, y: 0.50, z: 0 };  // left cheek

    // Blendshapes — 52 categories; only a subset is meaningful for Features
    const categoryNames = [
      '_neutral', 'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft',
      'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
      'eyeBlinkLeft', 'eyeBlinkRight',
      'eyeLookDownLeft', 'eyeLookDownRight',
      'eyeLookInLeft', 'eyeLookInRight',
      'eyeLookOutLeft', 'eyeLookOutRight',
      'eyeLookUpLeft', 'eyeLookUpRight',
      // remaining names don't affect Features.extract; filler suffices
    ];
    while (categoryNames.length < 52) {
      categoryNames.push(`blendshape${categoryNames.length}`);
    }
    const blendshapes = categoryNames.map(name => ({
      categoryName: name,
      score: 0,
    }));
    // Encode eye-closed and directional gaze roughly
    const blinkScore = eyesOpen ? 0.02 : 0.85;
    const lookRight = Math.max(0, irisX);
    const lookLeft  = Math.max(0, -irisX);
    const lookDown  = Math.max(0, irisY);
    const lookUp    = Math.max(0, -irisY);
    blendshapes[9].score  = blinkScore;              // eyeBlinkLeft
    blendshapes[10].score = blinkScore;              // eyeBlinkRight
    blendshapes[11].score = lookDown;                // eyeLookDownLeft
    blendshapes[12].score = lookDown;                // eyeLookDownRight
    // In/Out indices: treat 'right iris moves outward when user looks right'
    blendshapes[13].score = lookLeft;                // eyeLookInLeft  (left eye looks nose-ward when user looks right)
    blendshapes[14].score = lookLeft;                // eyeLookInRight
    blendshapes[15].score = lookRight;               // eyeLookOutLeft
    blendshapes[16].score = lookRight;               // eyeLookOutRight
    blendshapes[17].score = lookUp;                  // eyeLookUpLeft
    blendshapes[18].score = lookUp;                  // eyeLookUpRight

    // 4x4 transformation matrix with yaw rotation about Y, distance 60cm
    const cos = Math.cos(headYaw), sin = Math.sin(headYaw);
    const transform = new Float32Array([
       cos,  0,   sin,  0,
       0,    1,   0,    0,
      -sin,  0,   cos,  -60,
       0,    0,   0,    1,
    ]);

    return {
      faceLandmarks: [landmarks],
      faceBlendshapes: [{ categories: blendshapes }],
      facialTransformationMatrixes: [{ data: transform }],
    };
  },

  /**
   * Build a "no face" result — what MediaPipe returns when it sees
   * no face in the frame.
   */
  emptyFrame() {
    return {
      faceLandmarks: [],
      faceBlendshapes: [],
      facialTransformationMatrixes: [],
    };
  },

  /**
   * Cluster of N similar fixtures with small jitter, representing ~N/30 seconds
   * of steady gaze at a brick position. Used for training-data synthesis in
   * classifier tests.
   */
  clusterForPosition(centerX, centerY, count, headYaw = 0) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const jx = (Math.random() - 0.5) * 0.08;
      const jy = (Math.random() - 0.5) * 0.08;
      const jyaw = (Math.random() - 0.5) * 0.05;
      out.push(this.syntheticFrame({
        irisX: centerX + jx,
        irisY: centerY + jy,
        headYaw: headYaw + jyaw,
        eyesOpen: true,
      }));
    }
    return out;
  },
};
