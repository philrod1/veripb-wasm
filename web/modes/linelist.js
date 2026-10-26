// A virtual list of text lines held in an array (modes/vlist.js over local
// data): only the lines on screen are in the DOM, however long the array.
//
// createLineList(body, lines) -> { update(), setFilter(text), atBottom(),
//                                  toBottom(), total }
//   body: the scroll container; lines: an array the caller may append to,
//   then call update(). setFilter(text): show only the lines containing
//   `text` (case-insensitive); "" shows all.

import { createVirtualList } from "./vlist.js";

export function createLineList(body, lines) {
  let query = "";
  let matches = null; // indices into `lines` while filtered
  let scanned = 0; // lines already checked against `query`
  const shown = () => {
    if (!query) return lines;
    if (!matches) {
      matches = [];
      scanned = 0;
    }
    for (; scanned < lines.length; scanned++) if (lines[scanned].toLowerCase().includes(query)) matches.push(scanned);
    return matches;
  };
  const text = (position) => (query ? lines[matches[position]] : lines[position]);
  const list = createVirtualList({
    body,
    fetch: (start, count) => {
      const view = shown();
      return Promise.resolve({ total: view.length, rows: Array.from({ length: Math.max(0, Math.min(count, view.length - start)) }, (_, i) => text(start + i)), generation: 0 });
    },
    render: (line) => Object.assign(document.createElement("div"), { className: "row line", textContent: line || " " }),
  });
  return {
    get total() {
      return shown().length;
    },
    update() {
      list.refresh();
    },
    setFilter(next) {
      query = next.trim().toLowerCase();
      matches = null;
      body.scrollTop = 0;
      list.refresh();
    },
    atBottom: () => body.scrollTop + body.clientHeight >= body.scrollHeight - 4,
    toBottom() {
      list.scrollTo(Math.max(0, shown().length - 1));
    },
  };
}
