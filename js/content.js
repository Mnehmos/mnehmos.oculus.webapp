/**
 * Lesson loader.
 *
 * Lessons live in content/lessons/{id}.json. Each lesson is a typed record with:
 *   - metadata (title, kicker, prerequisites, estimated time)
 *   - ordered array of bricks
 *
 * Brick types:
 *   - opening, setup, equation, reveal, diagram, aside, synthesis → content
 *   - hint → attached to another brick via hintFor; initially empty
 *
 * Span values:
 *   - full        → spans all 6 grid columns
 *   - two-thirds  → spans 4 columns
 *   - half        → spans 3 columns
 *   - third       → spans 2 columns
 */

const Content = {

  async loadLesson(lessonId) {
    const res = await fetch(`content/lessons/${lessonId}.json`);
    if (!res.ok) throw new Error(`Lesson not found: ${lessonId}`);
    return await res.json();
  },

  /**
   * Render a lesson into the brick-grid container. Populates:
   *   - document title, kicker, meta
   *   - one .brick element per lesson brick
   *
   * Hint slots get rendered empty — the controller fills them at runtime when
   * confusion is detected.
   */
  renderLesson(lesson, container, headerEls) {
    if (headerEls.kicker) headerEls.kicker.textContent = lesson.kicker || '';
    if (headerEls.title)  headerEls.title.textContent  = lesson.title;
    if (headerEls.meta)   headerEls.meta.textContent   =
      `Estimated reading time: ${lesson.estimatedMinutes} minutes · Prerequisites: ${lesson.prerequisites}`;

    container.innerHTML = '';

    for (const brick of lesson.bricks) {
      const el = document.createElement('div');
      el.className = `brick span-${brick.span}`;
      el.dataset.brickId = brick.id;
      el.dataset.brickType = brick.type;
      // Page field on bricks enables multi-page lessons without scroll.
      // Bricks default to page 1 if unspecified (back-compat with any
      // author-side JSON that hasn't opted in yet).
      el.dataset.page = String(brick.page || 1);

      if (brick.type === 'hint') {
        el.classList.add('hint-slot');
        el.dataset.hintFor = brick.hintFor;
        // Store the payload for later fill but don't render it yet.
        el.dataset.hintLabel = brick.label || '';
        el.dataset.hintHtml = brick.html || '';
        el.textContent = 'awaiting signal';
      } else {
        el.dataset.expectedDwellMs = brick.expectedDwellMs || 5000;
        const body = document.createElement('div');
        body.className = 'brick-body';
        if (brick.heading) {
          const h = document.createElement('h2');
          h.textContent = brick.heading;
          body.appendChild(h);
        }
        const content = document.createElement('div');
        content.innerHTML = brick.html;
        // Wrap each word in a <span class="word"> so ReaderCursor can
        // highlight / dwell-track at word granularity. Skips text nodes
        // inside code, equations, SVG — anything where word boundaries
        // would break rendering.
        this.wrapWords(content);
        body.appendChild(content);
        el.appendChild(body);
      }

      container.appendChild(el);
    }
  },

  /**
   * Count how many distinct `page` values the lesson's bricks span.
   * Lessons without any page field effectively have 1 page.
   */
  totalPages(lesson) {
    const pages = new Set();
    for (const brick of lesson.bricks) pages.add(brick.page || 1);
    return pages.size;
  },

  /**
   * Hide all bricks not on `pageNum`. Called both during calibration
   * (to isolate one page at a time) and during reading (to navigate).
   * Returns the array of currently-visible brick elements.
   */
  showPage(container, pageNum) {
    const visible = [];
    const all = container.querySelectorAll('.brick');
    for (const el of all) {
      const isOn = String(el.dataset.page) === String(pageNum);
      el.classList.toggle('page-hidden', !isOn);
      if (isOn) visible.push(el);
    }
    return visible;
  },

  /**
   * Return the brick elements currently on the given page (regardless of
   * whether that page is the currently-visible one).
   */
  bricksOnPage(container, pageNum) {
    return Array.from(container.querySelectorAll(`.brick[data-page="${pageNum}"]`));
  },

  /**
   * Walk text nodes inside `root` and wrap each whitespace-separated
   * word in <span class="word">. Skips nodes inside tags or classes
   * where word-level spans would break rendering (code, equations,
   * SVG diagrams).
   *
   * Called once per brick at render time. Idempotent enough — if the
   * root already contains .word spans they'll be skipped because
   * they're inside a parent we don't filter; but don't call twice.
   */
  wrapWords(root) {
    const SKIP_TAGS = new Set([
      'CODE', 'PRE',
      'SVG', 'G', 'PATH', 'CIRCLE', 'LINE', 'RECT', 'TEXT', 'DEFS',
      'MARKER', 'POLYGON', 'POLYLINE', 'ELLIPSE',
      'SCRIPT', 'STYLE',
    ]);
    const SKIP_CLASSES = new Set(['equation', 'diagram']);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentNode;
        while (p && p !== root) {
          if (p.nodeType === Node.ELEMENT_NODE) {
            if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
            if (p.classList) {
              for (const cls of SKIP_CLASSES) {
                if (p.classList.contains(cls)) return NodeFilter.FILTER_REJECT;
              }
            }
          }
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    for (const textNode of textNodes) {
      const text = textNode.nodeValue;
      if (!text || !text.trim()) continue;

      // Split preserving whitespace runs so we don't collapse spaces.
      const parts = text.split(/(\s+)/);
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        if (part.length === 0) continue;
        if (/^\s+$/.test(part)) {
          frag.appendChild(document.createTextNode(part));
        } else {
          const span = document.createElement('span');
          span.className = 'word';
          span.textContent = part;
          frag.appendChild(span);
        }
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }
  },

  /**
   * List of available lessons for the landing page to offer.
   */
  availableLessons: [
    { id: 'gravity',   title: 'Why Does a Heavier Object Fall at the Same Rate?', subject: 'Physics' },
    { id: 'recursion', title: 'Why Does Recursion Work Without Falling Forever?', subject: 'Computer Science' },
  ],
};

window.Content = Content;
