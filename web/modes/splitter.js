// Draggable splitter between grid tracks.
//
// splitter(element, container, { axis, onMove(fraction), onReset }) calls
// onMove with the pointer position as a fraction (0..1) of the container's
// width ("x") or height ("y") while dragging; double-click calls onReset.

export function splitter(element, container, { axis, onMove, onReset }) {
  element.classList.add("splitter", axis === "x" ? "splitter-x" : "splitter-y");
  element.setAttribute("role", "separator");
  element.setAttribute("aria-orientation", axis === "x" ? "vertical" : "horizontal");
  const fraction = (event) => {
    const box = container.getBoundingClientRect();
    return axis === "x" ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height;
  };
  element.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    element.classList.add("dragging");
    const move = (e) => onMove(Math.min(1, Math.max(0, fraction(e))));
    const up = () => {
      element.classList.remove("dragging");
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
  });
  element.addEventListener("dblclick", () => onReset?.());
}
