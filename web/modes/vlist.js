// A virtual list: a pane body that shows a window of a long list of rows of
// one height, fetched on demand, so a list of any length costs the page only
// what is on screen plus a screen of slack either side.
//
// createVirtualList({ body, fetch, render, placeholder, onLoad, onRender }) -> list
//   fetch(start, count) -> Promise<{total, rows, generation} | {error} | null>
//   render(row, position) -> Element: one row (rows must all be one height)
//   placeholder(position) -> Element, optional: a row not fetched yet
//   (default: an empty row); fetches wait while the source is busy
//   onLoad({total, generation} | {error} | null): after each fetch
//   onRender(): after each draw
// list: { refresh(), redraw(), scrollTo(position, block), rowAt(position),
//         total, generation, error, visibleRange() -> [first, last] }
//   refresh(): fetch the rows again (the data changed), showing the old ones
//   until their replacements arrive;
//   redraw(): re-render the cached rows (only their presentation changed).
// A focused element inside a row (such as an input) keeps its focus and
// selection across a draw that re-renders its row, or the next draw that
// does if its row is not drawn yet, unless focus has moved on meanwhile.

const CHUNK = 200;

export function createVirtualList({ body, fetch, render, placeholder, onLoad, onRender }) {
  const sizer = Object.assign(document.createElement("div"), { className: "vlist-sizer" });
  const windowEl = Object.assign(document.createElement("div"), { className: "vlist-window" });
  sizer.append(windowEl);
  body.replaceChildren(sizer);
  let rowHeight = 21;
  let chunks = new Map();
  // The rows from before the last refresh, shown until replaced.
  let stale = new Map();
  let pending = new Set();
  let version = 0;
  let frame = 0;
  let refocus = null;
  // A scrollTo() past the rows known so far, applied once they are.
  let wanted = null;
  const list = { total: 0, generation: null, error: null };

  function visibleRange() {
    const first = Math.floor(body.scrollTop / rowHeight);
    const shown = Math.ceil((body.clientHeight || 400) / rowHeight);
    return [first, Math.min(list.total, first + shown) - 1];
  }

  function load(chunk) {
    if (chunks.has(chunk) || pending.has(chunk)) return;
    const mine = version;
    pending.add(chunk);
    fetch(chunk * CHUNK, CHUNK).then((result) => {
      if (mine !== version) return;
      pending.delete(chunk);
      list.error = result?.error ?? null;
      if (!pending.size) stale = new Map();
      if (!result || result.error) {
        list.total = 0;
        list.generation = null;
        chunks = new Map();
        stale = new Map();
      } else {
        chunks.set(chunk, result.rows);
        list.total = result.total;
        list.generation = result.generation;
      }
      onLoad?.(result && !result.error ? { total: result.total, generation: result.generation } : result);
      schedule();
    });
  }

  function draw() {
    frame = 0;
    sizer.style.height = `${list.total * rowHeight}px`;
    if (wanted && wanted.position < list.total) {
      scrollNow(wanted.position, wanted.block);
      wanted = null;
    }
    // Before rendering: a row's render may move a focused element (an input)
    // into its new, detached row, which drops its focus.
    const active = document.activeElement;
    if (active && active !== document.body && windowEl.contains(active)) {
      refocus = { element: active, selection: typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null };
    } else if (refocus && active && active !== document.body) {
      refocus = null;
    }
    const [first, last] = visibleRange();
    const slack = Math.max(20, last - first + 1);
    const from = Math.max(0, first - slack);
    const to = Math.min(list.total - 1, last + slack);
    for (let c = Math.floor(from / CHUNK); c <= Math.floor(Math.max(from, to) / CHUNK); c++) load(c);
    const rows = [];
    for (let pos = from; pos <= to; pos++) {
      const row = list.rowAt(pos);
      rows.push(row ? render(row, pos)
        : placeholder?.(pos) ?? Object.assign(document.createElement("div"), { className: "row vlist-loading", textContent: " " }));
    }
    windowEl.style.transform = `translateY(${from * rowHeight}px)`;
    windowEl.replaceChildren(...rows);
    if (refocus?.element.isConnected) {
      refocus.element.focus({ preventScroll: true });
      if (refocus.selection) refocus.element.setSelectionRange(...refocus.selection);
      refocus = null;
    }
    const measured = windowEl.firstElementChild?.getBoundingClientRect().height;
    if (measured && Math.abs(measured - rowHeight) > 0.5) {
      rowHeight = measured;
      schedule();
    }
    onRender?.();
  }

  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
  function scrollNow(position, block) {
    const top = position * rowHeight;
    if (block === "center") body.scrollTop = Math.max(0, top - (body.clientHeight - rowHeight) / 2);
    else if (top < body.scrollTop) body.scrollTop = top;
    else if (top + rowHeight > body.scrollTop + body.clientHeight) body.scrollTop = top + rowHeight - body.clientHeight;
  }
  body.addEventListener("scroll", schedule, { passive: true });
  new ResizeObserver(schedule).observe(body);

  return Object.assign(list, {
    rowAt(pos) {
      const chunk = Math.floor(pos / CHUNK);
      return (chunks.get(chunk) ?? stale.get(chunk))?.[pos % CHUNK] ?? null;
    },
    refresh() {
      version += 1;
      stale = new Map([...stale, ...chunks]);
      chunks = new Map();
      pending = new Set();
      load(Math.floor(Math.floor(body.scrollTop / rowHeight) / CHUNK));
      schedule();
    },
    redraw: schedule,
    /**
     * Scrolls so `position` is in view: "nearest" (default) or "center"; if
     * the list does not have that many rows yet, once it does.
     */
    scrollTo(position, block = "nearest") {
      if (position < list.total) {
        sizer.style.height = `${list.total * rowHeight}px`;
        scrollNow(position, block);
        wanted = null;
      } else {
        wanted = { position, block };
      }
      schedule();
    },
    visibleRange,
    /** Draws now rather than at the next frame (tests, and scroll-then-flash). */
    drawNow() {
      if (frame) cancelAnimationFrame(frame);
      draw();
    },
  });
}
