/** Keep a wheel gesture on its original scroll container as cards move below it. */
export function commentScrollHandler(source, findTarget, lineHeight, now = () => performance.now(), parentTarget = null, onOuterScroll = null) {
  let owner = null, last = -Infinity;
  return event => {
    if (event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const time = now();
    if (!owner || owner.isConnected === false || time - last > 180) owner = findTarget(event.target, event) || source;
    last = time;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? lineHeight(owner) : event.deltaMode === 2 ? owner.clientHeight : 1;
    const outerBefore = source.scrollTop;
    let remaining = event.deltaY * unit;
    while (remaining) {
      const before = owner.scrollTop;
      owner.scrollTop += remaining;
      remaining -= owner.scrollTop - before;
      if (!parentTarget || owner === source || Math.abs(remaining) < .5) break;
      const parent = parentTarget(owner) || source;
      if (parent === owner) break;
      owner = parent;
    }
    const delta = source.scrollTop - outerBefore;
    if (delta) onOuterScroll?.(delta);
  };
}
