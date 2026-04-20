/**
 * Per-brick calibration (v0.2).
 *
 * Replaces the v0.1 9-point WebGazer calibration with a classifier-oriented
 * flow: the user looks at each content brick in turn, clicks to confirm
 * their gaze is steady, and Oculus records ~50 feature samples at that
 * position labeled with that brick's id. Those samples train the MLP.
 *
 * Phases (handoff §7):
 *   1. Intro               — reuses the existing #cal-intro DOM
 *   2. Face-detect prewarm — show mirrored preview, wait for stable face
 *   3. Per-brick samples   — for each content brick: fade others, pulse
 *                            amber dot on brick center, collect on click
 *   4. Elsewhere samples   — look away / close eyes
 *   5. Train classifier
 *   6. Validate — if accuracy < threshold, offer recalibrate
 *   7. Resolve promise; caller removes overlay and starts the reader loop
 *
 * Returns a promise that resolves with { ok, accuracy } or rejects on
 * hard failure (camera denied, MediaPipe module failed, etc.).
 */

window.Calibration = {

  /**
   * @param opts.introEl     the #cal-intro container (will be rewritten
   *                         phase-by-phase)
   * @param opts.dotsEl      the #cal-dots container (legacy; hidden in v0.2)
   * @param opts.progressEl  the #cal-progress container (repurposed as
   *                         phase label: "phase 2 / 7 · detecting face")
   * @param opts.gridEl      the brick-grid, so we can overlay dots on bricks
   */
  async run(opts) {
    const cfg = window.OCULUS_CONFIG;
    const { introEl, dotsEl, progressEl, gridEl } = opts;

    // Hide legacy dot container — we overlay dots directly on bricks now.
    if (dotsEl) dotsEl.style.display = 'none';
    if (progressEl) progressEl.style.display = 'block';

    // ---------- Phase 2: face-detect prewarm ----------
    this._renderPhase(introEl, progressEl, 'prewarm', {});

    const initResult = await window.FaceLandmarker.init();
    if (!initResult.ok) {
      this._renderPhase(introEl, progressEl, 'error', { message: initResult.error });
      throw new Error(initResult.error);
    }

    // Reveal the persistent preview and pipe the camera stream into it.
    // This element lives outside #cal-intro so it survives phase transitions.
    const persistentPreview = document.getElementById('cal-persistent-preview');
    if (persistentPreview) {
      persistentPreview.classList.remove('hidden');
      window.FaceLandmarker.attachPreview(persistentPreview);
    }

    const prewarmOk = await this._prewarmFaceDetection(introEl);
    if (!prewarmOk) {
      this._renderPhase(introEl, progressEl, 'error', {
        message: 'Could not get a stable face read. Check lighting and sit so your face is centered in the preview.',
      });
      throw new Error('Face detection prewarm timed out');
    }

    // ---------- Phase 3: sample collection ----------
    // Grid method: viewport-fixed dots on the blank calibration overlay.
    //   No lesson visible, no scroll — calibration only depends on
    //   gaze-to-viewport mapping, which is exactly what regression needs.
    // Brick method: amber dot at each content brick's center. Auto-
    //   scrolls if bricks don't fit. Legacy path; useful when training
    //   a classification head that needs per-brick labels.
    const mode = cfg.GAZE_MODE || 'regression';
    const method = cfg.CALIBRATION_METHOD || 'grid';

    // Only reveal the main layout when we actually need bricks visible
    // (brick method). Grid method keeps the overlay opaque.
    const mainLayout = document.getElementById('main-layout');
    if (method === 'brick' && mainLayout) mainLayout.style.visibility = 'visible';

    // In regression mode, show EVERY brick simultaneously — the model
    // learns viewport-coord targets and scrolling is expected at read
    // time, so we scroll to bring each brick into view when its turn
    // comes. In classification mode, we isolate one page at a time
    // (brick-to-screen mapping has to stay stable).
    const allBricks = Array.from(gridEl.querySelectorAll('.brick'));
    const allPages = Array.from(
      new Set(allBricks.map(el => parseInt(el.dataset.page, 10)))
    ).sort((a, b) => a - b);
    const contentBricksAll = allBricks.filter(el => el.dataset.brickType !== 'hint');

    if (contentBricksAll.length === 0) {
      throw new Error('No content bricks to calibrate against');
    }

    const allSamples = [];
    const allRegLabels = [];
    const allClsLabels = [];

    if (method === 'grid') {
      // ---- GRID CALIBRATION ----
      // Viewport-fixed dots on the calibration overlay. No scroll, no
      // visible content. Classification labels are not produced (grid
      // points aren't bricks); if any classification heads are configured
      // they'll be skipped in _resolveHeadConfigs below.
      const gridPoints = this._buildGridPoints(cfg);
      for (let i = 0; i < gridPoints.length; i++) {
        const pt = gridPoints[i];
        this._renderPhase(introEl, progressEl, 'grid', {
          idx: i + 1,
          total: gridPoints.length,
          xPct: Math.round(pt.xFrac * 100),
          yPct: Math.round(pt.yFrac * 100),
        });
        const { samples, regLabels } = await this._collectForGridPoint(pt);
        allSamples.push(...samples);
        allRegLabels.push(...regLabels);
      }

    } else if (mode === 'regression') {
      for (const p of allPages) window.Content.showPage(gridEl, p);
      for (const el of allBricks) el.classList.remove('page-hidden');
      await new Promise(r => requestAnimationFrame(r));

      for (const b of contentBricksAll) b.classList.add('cal-dim');

      let calibIdx = 0;
      for (const brickEl of contentBricksAll) {
        calibIdx++;
        this._renderPhase(introEl, progressEl, 'brick', {
          idx: calibIdx,
          total: contentBricksAll.length,
          brickId: brickEl.dataset.brickId,
          page: parseInt(brickEl.dataset.page, 10),
          totalPages: allPages.length,
        });
        const { samples, regLabels, clsLabels } = await this._collectForBrick(brickEl);
        allSamples.push(...samples);
        allRegLabels.push(...regLabels);
        allClsLabels.push(...clsLabels);
      }

      for (const b of contentBricksAll) b.classList.remove('cal-dim', 'cal-active');

    } else {
      // Classification mode: page-by-page isolation.
      let calibIdx = 0;
      for (const page of allPages) {
        window.Content.showPage(gridEl, page);
        await new Promise(r => requestAnimationFrame(r));

        const pageContentBricks = Array.from(gridEl.querySelectorAll('.brick:not(.page-hidden)'))
          .filter(el => el.dataset.brickType !== 'hint');
        for (const b of pageContentBricks) b.classList.add('cal-dim');

        for (const brickEl of pageContentBricks) {
          calibIdx++;
          this._renderPhase(introEl, progressEl, 'brick', {
            idx: calibIdx,
            total: contentBricksAll.length,
            brickId: brickEl.dataset.brickId,
            page,
            totalPages: allPages.length,
          });
          const { samples, regLabels, clsLabels } = await this._collectForBrick(brickEl);
          allSamples.push(...samples);
          allRegLabels.push(...regLabels);
          allClsLabels.push(...clsLabels);
        }

        for (const b of pageContentBricks) b.classList.remove('cal-dim', 'cal-active');
      }
      // Restore first page for reading
      window.Content.showPage(gridEl, allPages[0]);
    }

    // ---------- Phase 4: 'elsewhere' samples ----------
    // Only needed when at least one head is classification (gives the MLP
    // a real negative class). Regression heads don't use it.
    const headConfigs = this._resolveHeadConfigs(cfg, contentBricksAll);
    const anyClassification = headConfigs.some(h => h.mode === 'classification');

    if (anyClassification) {
      this._renderPhase(introEl, progressEl, 'elsewhere', {});
      const elsewhere = await this._collectElsewhere();
      // Elsewhere samples have a meaningful cls label but no real
      // regression target — push the viewport center so the MSE loss
      // doesn't drag regression heads during those frames. Regression
      // heads won't suffer because elsewhere frames are ~15% of total.
      for (const f of elsewhere) {
        allSamples.push(f);
        allRegLabels.push({ x: 0.5, y: 0.5 });
        allClsLabels.push('elsewhere');
      }
    }

    // ---------- Phase 5: train every head ----------
    this._renderPhase(introEl, progressEl, 'training', {});

    window.Features.computeNormalization(allSamples);
    const normalizedSamples = allSamples.map(s => window.Features.normalize(s));

    window.Classifier.build(headConfigs);

    await window.Classifier.train(
      normalizedSamples,
      { regression: allRegLabels, classification: allClsLabels },
      (epoch, logs, headTag) => {
        const lossEl = introEl.querySelector('#cal-train-loss');
        if (lossEl && logs) {
          lossEl.textContent =
            `[${headTag}] epoch ${epoch + 1}/${cfg.CLASSIFIER_EPOCHS} · loss ${logs.loss.toFixed(4)}`;
        }
      }
    );

    // ---------- Phase 6: validate every head ----------
    const headScores = this._holdoutValidateMulti(
      normalizedSamples,
      { regression: allRegLabels, classification: allClsLabels },
      0.2
    );
    const primaryTag = window.Classifier.heads[0].tag;
    const primaryScore = headScores[primaryTag] ?? 0;
    this._renderPhase(introEl, progressEl, 'validation', {
      accuracy: primaryScore,
      threshold: cfg.VALIDATION_ACCURACY_THRESHOLD,
      headScores,
      primaryTag,
      primaryMode: window.Classifier.heads[0].mode,
      meanError: window.Classifier.heads[0].validationError,
    });

    if (primaryScore < cfg.VALIDATION_ACCURACY_THRESHOLD) {
      const accepted = await this._confirmLowAccuracy(introEl);
      if (!accepted) {
        throw new Error('User requested recalibration');
      }
    }

    if (progressEl) progressEl.textContent = 'ready';

    // Hide the persistent preview — calibration is done. (app.js can
    // unhide it again if we decide to show a preview during reading.)
    const preview = document.getElementById('cal-persistent-preview');
    if (preview) preview.classList.add('hidden');

    return { ok: true, accuracy: primaryScore, headScores };
  },

  // ============================================================
  //   Phase renderers
  // ============================================================

  _renderPhase(introEl, progressEl, phase, detail) {
    if (phase === 'prewarm') {
      introEl.innerHTML = `
        <div class="cal-title">Look straight at the camera</div>
        <div id="cal-prewarm-status">detecting face…</div>
        <div class="cal-subtitle">
          Sit comfortably. The preview in the top-right shows what Oculus
          sees. Wait for "face detected" before we move on.
        </div>
      `;
      if (progressEl) progressEl.textContent = 'phase 2 / 7 · detecting face';

    } else if (phase === 'grid') {
      introEl.innerHTML = `
        <div class="cal-title">Look at the dot &mdash; click when steady</div>
        <div class="cal-subtitle">
          Stare at the glowing dot. Click it when your gaze is locked.
          Hold still for about a second while Oculus records a sample,
          then the next dot will appear. Keep your head in roughly the
          same position throughout.
        </div>
      `;
      if (progressEl) {
        progressEl.textContent =
          `phase 3 / 7 · point ${detail.idx} of ${detail.total}`;
      }
      // Grid calibration never uses the passthrough — the overlay stays
      // opaque so nothing on the page distracts the eye.
      const overlay = document.getElementById('calibration-overlay');
      if (overlay) overlay.classList.remove('cal-passthrough');

    } else if (phase === 'brick') {
      introEl.innerHTML = `
        <div class="cal-title">Look at the highlighted panel</div>
        <div class="cal-subtitle">
          When your gaze is steady on the glowing dot, click it. A short
          sample is collected. Keep your head still between clicks.
        </div>
      `;
      if (progressEl) {
        const pagePart = detail.totalPages > 1
          ? ` · page ${detail.page}/${detail.totalPages}`
          : '';
        progressEl.textContent =
          `phase 3 / 7 · brick ${detail.idx} of ${detail.total} (${detail.brickId})${pagePart}`;
      }
      // Hide the overlay's background so the user can see the page content.
      // The amber dot and active brick are on top of the page; overlay
      // becomes a transparent click-passthrough for this phase.
      const overlay = document.getElementById('calibration-overlay');
      if (overlay) overlay.classList.add('cal-passthrough');

    } else if (phase === 'elsewhere') {
      // Restore overlay opacity
      const overlay = document.getElementById('calibration-overlay');
      if (overlay) overlay.classList.remove('cal-passthrough');

      introEl.innerHTML = `
        <div class="cal-title">Look away, or close your eyes</div>
        <div class="cal-subtitle">
          For the next few seconds, look somewhere off the page — a window,
          the ceiling, or just close your eyes. This teaches Oculus what
          "not reading" looks like.
        </div>
        <div class="cal-countdown" id="cal-elsewhere-countdown">3.0 s</div>
      `;
      if (progressEl) progressEl.textContent = 'phase 4 / 7 · elsewhere samples';

    } else if (phase === 'training') {
      introEl.innerHTML = `
        <div class="cal-title">Training…</div>
        <div class="cal-subtitle">
          Oculus is learning your gaze-to-brick mapping. This takes a second.
        </div>
        <div class="cal-countdown" id="cal-train-loss">starting…</div>
      `;
      if (progressEl) progressEl.textContent = 'phase 5 / 7 · training classifier';

    } else if (phase === 'validation') {
      const pct = Math.round(detail.accuracy * 100);
      const ok = detail.accuracy >= detail.threshold;
      const headScoresRows = Object.entries(detail.headScores || {}).map(([tag, score]) => {
        const pctH = Math.round(score * 100);
        const isPrimary = tag === detail.primaryTag;
        return `<div class="cal-head-row">${isPrimary ? '★ ' : '&nbsp; '}${tag}: <strong>${pctH}%</strong></div>`;
      }).join('');
      const primaryErrText = detail.primaryMode === 'regression' && detail.meanError != null
        ? ` · mean error ${Math.round(detail.meanError)}px`
        : '';
      introEl.innerHTML = `
        <div class="cal-title">${ok ? 'Ready.' : 'Calibration a bit shaky.'}</div>
        <div class="cal-subtitle">
          Primary head: <strong>${pct}%</strong>${primaryErrText}.
          ${ok
            ? ' Starting the lesson in a moment…'
            : ' Below threshold &mdash; continue or recalibrate.'}
        </div>
        <div class="cal-head-scores">${headScoresRows}</div>
      `;
      if (progressEl) progressEl.textContent = 'phase 6 / 7 · validation';

    } else if (phase === 'error') {
      introEl.innerHTML = `
        <div class="cal-title" style="color: var(--warn, #e08656);">Calibration failed</div>
        <div class="cal-subtitle">${detail.message}</div>
        <button class="cal-start-btn" onclick="location.reload()">Try again</button>
      `;
      if (progressEl) progressEl.textContent = 'error';
    }
  },

  // ============================================================
  //   Phase 2: face detection prewarm
  // ============================================================

  async _prewarmFaceDetection(introEl) {
    const cfg = window.OCULUS_CONFIG;
    const startedAt = performance.now();
    let stableSince = null;

    return new Promise(resolve => {
      let lastTs = 0;
      const tick = () => {
        const now = performance.now();
        // Monotonic timestamp (MediaPipe requires strictly increasing)
        const ts = Math.max(lastTs + 1, Math.floor(now));
        lastTs = ts;

        const result = window.FaceLandmarker.detectFrame(ts);
        const features = window.Features.extract(result);

        const statusEl = introEl.querySelector('#cal-prewarm-status');

        if (!features) {
          if (statusEl) {
            statusEl.textContent = 'no face detected — check lighting';
            statusEl.className = 'warn';
          }
          stableSince = null;
        } else {
          // Average EAR across both eyes — single-eye winks shouldn't gate
          const earAvg = (features[4] + features[5]) / 2;
          if (earAvg >= cfg.EAR_OPEN_THRESHOLD) {
            if (stableSince === null) stableSince = now;
            const stableFor = now - stableSince;
            if (statusEl) {
              statusEl.textContent = `face detected — ${(stableFor / 1000).toFixed(1)}s stable`;
              statusEl.className = 'ok';
            }
            if (stableFor >= cfg.PREWARM_FACE_DETECTION_MS) {
              resolve(true);
              return;
            }
          } else {
            if (statusEl) {
              statusEl.textContent = 'eyes closed — open your eyes';
              statusEl.className = 'warn';
            }
            stableSince = null;
          }
        }

        if (now - startedAt > cfg.PREWARM_MAX_WAIT_MS) {
          resolve(false);
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  },

  // ============================================================
  //   Phase 3: per-brick sample collection
  // ============================================================

  async _collectForBrick(brickEl) {
    const cfg = window.OCULUS_CONFIG;
    const brickId = brickEl.dataset.brickId;
    // The multi-head system needs BOTH label kinds always, because we
    // don't yet know which heads are enabled. Collect both; the trainer
    // will only feed each head the matching kind.
    const mode = cfg.GAZE_MODE || 'regression';

    // Spotlight this brick
    document.querySelectorAll('.brick.cal-active').forEach(el => el.classList.remove('cal-active'));
    brickEl.classList.remove('cal-dim');
    brickEl.classList.add('cal-active');

    // In regression mode we permit scroll-into-view so long lessons work
    // (target = viewport coords at click time, so the classifier learns
    // "looking at *this* viewport position" regardless of what brick it
    // was). In classification mode we keep the no-scroll policy since
    // scroll changes which iris-position maps to which brick.
    if (mode === 'regression') {
      // Smooth scroll is fine here because we read the rect AFTER the
      // click (user clicks when steady), not before.
      brickEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 350));
    } else {
      await new Promise(r => requestAnimationFrame(r));
    }

    // The dot and progress bar are position: fixed — viewport coords.
    const rect = brickEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const dot = document.createElement('div');
    dot.className = 'cal-brick-dot';
    dot.style.left = cx + 'px';
    dot.style.top = cy + 'px';

    const progress = document.createElement('div');
    progress.className = 'cal-brick-progress';
    progress.style.left = cx + 'px';
    progress.style.top  = cy + 'px';
    progress.innerHTML = '<div class="bar"></div>';

    document.body.appendChild(dot);
    document.body.appendChild(progress);

    // Each per-frame entry holds both label kinds so downstream we can
    // feed regression heads and classification heads from the same data.
    const samples = [];
    const regLabels = [];
    const clsLabels = [];

    // Wait for click on the dot
    await new Promise(resolve => {
      const onClick = () => {
        dot.removeEventListener('click', onClick);
        resolve();
      };
      dot.addEventListener('click', onClick);
    });

    // Re-measure AFTER the click — user may have scrolled slightly.
    const rectNow = brickEl.getBoundingClientRect();
    const cxView = rectNow.left + rectNow.width / 2;
    const cyView = rectNow.top  + rectNow.height / 2;

    const normX = cxView / window.innerWidth;
    const normY = cyView / window.innerHeight;
    const bar = progress.querySelector('.bar');
    await this._collectAcceptedCalibrationFrames(bar, features => {
      samples.push(features);
      regLabels.push({ x: normX, y: normY });
      clsLabels.push(brickId);
    });

    // Tear down UI
    dot.remove();
    progress.remove();
    brickEl.classList.remove('cal-active');
    brickEl.classList.add('cal-dim');

    return { samples, regLabels, clsLabels };
  },

  // ============================================================
  //   Phase 4: 'elsewhere' sample collection
  // ============================================================

  async _collectElsewhere() {
    const cfg = window.OCULUS_CONFIG;
    const samples = [];
    const start = performance.now();
    const countdownEl = document.querySelector('#cal-elsewhere-countdown');
    let lastTs = 0;

    while (performance.now() - start < cfg.ELSEWHERE_SAMPLE_DURATION_MS) {
      await new Promise(r => requestAnimationFrame(r));
      const ts = Math.max(lastTs + 1, Math.floor(performance.now()));
      lastTs = ts;
      const result = window.FaceLandmarker.detectFrame(ts);
      const features = window.Features.extract(result);
      // Face-present-but-looking-away and eyes-closed frames both count;
      // face-absent returns null and we just skip those for training (in
      // production, no-face frames will emit null via Features.extract).
      if (features) samples.push(features);

      const remaining = cfg.ELSEWHERE_SAMPLE_DURATION_MS - (performance.now() - start);
      if (countdownEl) countdownEl.textContent = (remaining / 1000).toFixed(1) + ' s';
    }
    return samples;
  },

  // ============================================================
  //   Validation
  // ============================================================

  /**
   * Determine the head-config array to build. Reads OCULUS_CONFIG.GAZE_HEADS
   * (explicit), otherwise falls back to a single head built from GAZE_MODE.
   * Fills in classification brickIds from the visible content bricks so
   * authors don't have to maintain that list in two places.
   */
  _resolveHeadConfigs(cfg, contentBricksAll) {
    const brickIds = contentBricksAll.map(b => b.dataset.brickId);
    const brickIdsWithElsewhere = brickIds.concat(['elsewhere']);
    const method = cfg.CALIBRATION_METHOD || 'grid';

    const raw = cfg.GAZE_HEADS && cfg.GAZE_HEADS.length > 0
      ? cfg.GAZE_HEADS
      : [{ tag: 'primary', mode: cfg.GAZE_MODE || 'regression' }];

    // Classification heads need per-brick labels; grid calibration doesn't
    // produce those. Filter them out (with a console warning) when the
    // user has opted into grid.
    const filtered = raw.filter(h => {
      if (method === 'grid' && h.mode === 'classification') {
        console.warn(`Dropping classification head "${h.tag || '?'}" — grid calibration does not emit per-brick labels.`);
        return false;
      }
      return true;
    });
    const resolved = filtered.length > 0
      ? filtered
      : [{ tag: 'primary', mode: 'regression' }];

    return resolved.map(h => {
      if (h.mode === 'classification' && (!h.brickIds || h.brickIds.length === 0)) {
        return { ...h, brickIds: brickIdsWithElsewhere };
      }
      return h;
    });
  },

  /**
   * Build the N×M grid of calibration points as normalized viewport
   * fractions [0, 1]. Dots are spread across the viewport with
   * GRID_EDGE_MARGIN_PCT inset from each edge, so none hug the browser
   * chrome. Returned top-to-bottom, left-to-right.
   */
  _buildGridPoints(cfg) {
    const rows = Math.max(2, cfg.GRID_ROWS || 3);
    const cols = Math.max(2, cfg.GRID_COLS || 3);
    const margin = cfg.GRID_EDGE_MARGIN_PCT ?? 0.1;
    const pts = [];
    for (let r = 0; r < rows; r++) {
      const yFrac = margin + (1 - 2 * margin) * (r / (rows - 1));
      for (let c = 0; c < cols; c++) {
        const xFrac = margin + (1 - 2 * margin) * (c / (cols - 1));
        pts.push({ xFrac, yFrac, row: r, col: c });
      }
    }
    return pts;
  },

  /**
   * Grid-point equivalent of _collectForBrick. Places a viewport-fixed
   * dot at (xFrac, yFrac), waits for click, animates a scan circle,
   * records (features, normalized-dot-position) per frame.
   */
  async _collectForGridPoint(point) {
    const cfg = window.OCULUS_CONFIG;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cxView = point.xFrac * vw;
    const cyView = point.yFrac * vh;

    const dot = document.createElement('div');
    dot.className = 'cal-brick-dot';
    dot.style.left = cxView + 'px';
    dot.style.top = cyView + 'px';
    const progress = document.createElement('div');
    progress.className = 'cal-brick-progress';
    progress.style.left = cxView + 'px';
    progress.style.top  = cyView + 'px';
    progress.innerHTML = '<div class="bar"></div>';
    document.body.appendChild(dot);
    document.body.appendChild(progress);

    const samples = [];
    const regLabels = [];

    await new Promise(resolve => {
      const onClick = () => {
        dot.removeEventListener('click', onClick);
        resolve();
      };
      dot.addEventListener('click', onClick);
    });

    const bar = progress.querySelector('.bar');
    await this._collectAcceptedCalibrationFrames(bar, features => {
      samples.push(features);
      regLabels.push({ x: point.xFrac, y: point.yFrac });
    });

    dot.remove();
    progress.remove();
    return { samples, regLabels };
  },

  async _collectAcceptedCalibrationFrames(barEl, onAccept) {
    const cfg = window.OCULUS_CONFIG;
    const settleMs = Math.max(0, cfg.CALIBRATION_SETTLE_MS || 0);
    const hardLimitMs = Math.max(
      cfg.SAMPLE_COLLECTION_DURATION_MS || 0,
      cfg.SAMPLE_COLLECTION_MAX_DURATION_MS || 0
    );
    const targetSamples = Math.max(1, cfg.SAMPLES_PER_BRICK || 1);
    const startedAt = performance.now();
    const usableAt = startedAt + settleMs;
    const qualityState = { baseline: null };
    let lastTs = 0;
    let accepted = 0;

    while ((performance.now() - startedAt) < hardLimitMs) {
      await new Promise(r => requestAnimationFrame(r));
      const now = performance.now();
      if (now < usableAt) continue;

      const ts = Math.max(lastTs + 1, Math.floor(now));
      lastTs = ts;
      const result = window.FaceLandmarker.detectFrame(ts);
      const features = window.Features.extract(result);
      if (features && this._acceptCalibrationFrame(features, qualityState)) {
        onAccept(features);
        accepted++;
        if (barEl) barEl.style.width = Math.min(100, (accepted / targetSamples) * 100) + '%';
        if (accepted >= targetSamples) break;
      }
    }

    if (accepted === 0) {
      for (let i = 0; i < 8; i++) {
        await new Promise(r => requestAnimationFrame(r));
        const now = performance.now();
        const ts = Math.max(lastTs + 1, Math.floor(now));
        lastTs = ts;
        const result = window.FaceLandmarker.detectFrame(ts);
        const features = window.Features.extract(result);
        const earAvg = features ? (features[4] + features[5]) / 2 : 0;
        if (features && earAvg >= (cfg.CALIBRATION_EAR_GATE ?? cfg.EAR_OPEN_THRESHOLD)) {
          onAccept(features);
          accepted = 1;
          break;
        }
      }
    }

    if (barEl) barEl.style.width = accepted > 0 ? '100%' : '0';
    return accepted;
  },

  _acceptCalibrationFrame(features, qualityState) {
    const cfg = window.OCULUS_CONFIG;
    const earAvg = (features[4] + features[5]) / 2;
    if (earAvg < (cfg.CALIBRATION_EAR_GATE ?? cfg.EAR_OPEN_THRESHOLD)) return false;
    if (features[14] > (cfg.CALIBRATION_BLINK_MAX ?? 0.45)) return false;
    if (features[15] > (cfg.CALIBRATION_BLINK_MAX ?? 0.45)) return false;

    const snap = {
      yaw: features[6],
      pitch: features[7],
      roll: features[8],
      distance: features[9],
      faceX: features[10],
      faceY: features[11],
      faceW: features[12],
      faceH: features[13],
    };

    if (!qualityState.baseline) {
      qualityState.baseline = { ...snap };
      return true;
    }

    const base = qualityState.baseline;
    if (Math.abs(snap.yaw - base.yaw) > (cfg.CALIBRATION_MAX_YAW_DRIFT_RAD ?? 0.12)) return false;
    if (Math.abs(snap.pitch - base.pitch) > (cfg.CALIBRATION_MAX_PITCH_DRIFT_RAD ?? 0.12)) return false;
    if (Math.abs(snap.roll - base.roll) > (cfg.CALIBRATION_MAX_ROLL_DRIFT_RAD ?? 0.14)) return false;
    if (Math.abs(snap.distance - base.distance) > (cfg.CALIBRATION_MAX_DISTANCE_DRIFT_CM ?? 4.5)) return false;
    if (Math.abs(snap.faceX - base.faceX) > (cfg.CALIBRATION_MAX_FACE_CENTER_DRIFT ?? 0.05)) return false;
    if (Math.abs(snap.faceY - base.faceY) > (cfg.CALIBRATION_MAX_FACE_CENTER_DRIFT ?? 0.05)) return false;
    if (Math.abs(snap.faceW - base.faceW) > (cfg.CALIBRATION_MAX_FACE_SIZE_DRIFT ?? 0.04)) return false;
    if (Math.abs(snap.faceH - base.faceH) > (cfg.CALIBRATION_MAX_FACE_SIZE_DRIFT ?? 0.04)) return false;

    const alpha = cfg.CALIBRATION_STABILITY_EMA_ALPHA ?? 0.25;
    for (const key of Object.keys(base)) {
      base[key] = alpha * snap[key] + (1 - alpha) * base[key];
    }
    return true;
  },

  /**
   * Multi-head holdout: runs Classifier.validate with held-out samples,
   * returning a { [tag]: score } map.
   */
  _holdoutValidateMulti(samples, labelsByMode, holdoutFraction) {
    if (samples.length === 0) return {};
    const n = Math.max(1, Math.floor(samples.length * holdoutFraction));
    const indices = [];
    const step = Math.max(1, Math.floor(samples.length / n));
    for (let i = 0; i < samples.length && indices.length < n; i += step) {
      indices.push(i);
    }
    const heldSamples = indices.map(i => samples[i]);
    const heldLabels = {
      regression: indices.map(i => labelsByMode.regression[i]),
      classification: indices.map(i => labelsByMode.classification[i]),
    };
    return window.Classifier.validate(heldSamples, heldLabels);
  },

  async _confirmLowAccuracy(introEl) {
    return new Promise(resolve => {
      const row = document.createElement('div');
      row.style.marginTop = '16px';
      row.innerHTML = `
        <button class="cal-start-btn" id="cal-accept">Continue anyway</button>
        <button class="cal-start-btn" id="cal-recal" style="background: transparent; color: var(--accent); border: 1px solid var(--accent); margin-left: 12px;">Recalibrate</button>
      `;
      introEl.appendChild(row);
      introEl.querySelector('#cal-accept').addEventListener('click', () => resolve(true));
      introEl.querySelector('#cal-recal').addEventListener('click', () => resolve(false));
    });
  },
};
