// Links: Bézier curves from each formula and proof line to the Database
// rows it created, drawn in the gutters between the panes.
//
// createLinks({ top, formula, database, proof }) -> { setLineIds(map), redraw(), destroy() }
//   top: the panes' grid; formula/database/proof: panes ({ section, body }).
//   Formula rows carry data-ids ("3" or "1-2"), proof rows data-n (display
//   line), Database rows data-id. setLineIds takes vr_line_ids' map
//   ({"<line>": [id, ...]}).
// A curve whose row is scrolled out of view is drawn dashed to the pane's
// edge; hovering a row highlights its curves.

const SVG = "http://www.w3.org/2000/svg";

/** "1-2" -> [1, 2]; "3" -> [3]. */
function expandIds(text) {
  const [lo, hi = lo] = String(text).split("-").map(Number);
  return Number.isFinite(lo) ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : [];
}

export function createLinks({ top, formula, database, proof }) {
  const svg = document.createElementNS(SVG, "svg");
  svg.classList.add("links-layer");
  svg.setAttribute("aria-hidden", "true");
  top.append(svg);
  let lineIds = {};
  let hot = null;
  let frame = 0;

  const visible = (pane) => !pane.section.hidden && pane.section.offsetParent !== null;

  /** The row's centre, clamped to its pane body; `off` when clamped. */
  function anchor(row, body, origin) {
    const r = row.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const clamped = Math.min(Math.max(y, b.top + 2), b.bottom - 2);
    return { y: clamped - origin.top, off: clamped !== y };
  }

  function draw() {
    frame = 0;
    svg.replaceChildren();
    if (!visible(database)) return;
    const origin = top.getBoundingClientRect();
    svg.setAttribute("width", origin.width);
    svg.setAttribute("height", origin.height);
    const dbRows = new Map([...database.body.querySelectorAll(".row[data-id]")].map((row) => [Number(row.dataset.id), row]));
    const dbBox = database.section.getBoundingClientRect();

    const link = (fromKey, row, pane, id, side) => {
      const target = dbRows.get(id);
      if (!target) return;
      const a = anchor(row, pane.body, origin);
      const b = anchor(target, database.body, origin);
      if (a.off && b.off) return;
      const box = pane.section.getBoundingClientRect();
      const [x0, x1] = side === "left"
        ? [box.right - origin.left, dbBox.left - origin.left]
        : [dbBox.right - origin.left, box.left - origin.left];
      const [ya, yb] = side === "left" ? [a.y, b.y] : [b.y, a.y];
      const mid = (x1 - x0) / 2;
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", `M ${x0} ${ya} C ${x0 + mid} ${ya}, ${x1 - mid} ${yb}, ${x1} ${yb}`);
      path.setAttribute("class", `link ${target.classList.contains("core") ? "core" : "derived"}${a.off || b.off ? " off" : ""}`);
      path.dataset.from = fromKey;
      path.dataset.db = String(id);
      svg.append(path);
    };

    if (visible(formula)) {
      for (const row of formula.body.querySelectorAll(".row[data-ids]")) {
        for (const id of expandIds(row.dataset.ids)) link(`f:${row.dataset.ids}`, row, formula, id, "left");
      }
    }
    if (visible(proof)) {
      for (const row of proof.body.querySelectorAll(".row[data-n]")) {
        for (const id of lineIds[row.dataset.n] ?? []) link(`p:${row.dataset.n}`, row, proof, id, "right");
      }
    }
    markHot();
  }

  function markHot() {
    svg.classList.toggle("has-hot", !!hot);
    for (const path of svg.children) {
      path.classList.toggle("hot", !!hot && (hot.from ? path.dataset.from === hot.from : path.dataset.db === hot.db));
    }
  }

  const redraw = () => { if (!frame) frame = requestAnimationFrame(draw); };

  const onOver = (event) => {
    const row = event.target.closest?.(".row");
    const next = !row ? null
      : row.dataset.ids ? { from: `f:${row.dataset.ids}` }
      : row.dataset.n ? { from: `p:${row.dataset.n}` }
      : row.dataset.id ? { db: row.dataset.id }
      : null;
    if (JSON.stringify(next) === JSON.stringify(hot)) return;
    hot = next;
    markHot();
  };
  const onLeave = () => { hot = null; markHot(); };
  top.addEventListener("mouseover", onOver);
  top.addEventListener("mouseleave", onLeave);
  const bodies = [formula.body, database.body, proof.body];
  for (const body of bodies) body.addEventListener("scroll", redraw, { passive: true });
  const resize = new ResizeObserver(redraw);
  resize.observe(top);
  for (const pane of [formula, database, proof]) resize.observe(pane.section);
  const mutations = new MutationObserver(redraw);
  for (const body of bodies) mutations.observe(body, { childList: true });
  redraw();

  return {
    setLineIds(map) {
      lineIds = map && !map.error ? map : {};
      redraw();
    },
    redraw,
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      top.removeEventListener("mouseover", onOver);
      top.removeEventListener("mouseleave", onLeave);
      for (const body of bodies) body.removeEventListener("scroll", redraw);
      resize.disconnect();
      mutations.disconnect();
      svg.remove();
    },
  };
}
