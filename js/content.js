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
        body.appendChild(content);
        el.appendChild(body);
      }

      container.appendChild(el);
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
