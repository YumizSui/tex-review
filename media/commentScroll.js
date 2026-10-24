/** Keep a wheel gesture on its original scroll container as cards move below it. */
export function commentScrollHandler(source, findTarget, lineHeight, now = () => performance.now()) {
  let owner = null, last = -Infinity;
  return event => {
    if (event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const time = now();
    if (!owner || owner.isConnected === false || time - last > 180) owner = findTarget(event.target) || source;
    last = time;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? lineHeight(owner) : event.deltaMode === 2 ? owner.clientHeight : 1;
    owner.scrollTop += event.deltaY * unit;
  };
}
