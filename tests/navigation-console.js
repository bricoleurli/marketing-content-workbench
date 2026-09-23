// Run in the top-level browser console after switching between workbench tabs.
// Checks rendered CSS (aria-hidden alone missed the original regression).
(() => {
  const frames = [...document.querySelectorAll('.workbench-host-frame')];
  const visible = frames.filter(frame => getComputedStyle(frame).display !== 'none');
  if (visible.length !== 1) throw new Error(`FAIL: ${visible.length} visible pages`);
  const frame = visible[0];
  if (frame.hidden || new URL(frame.src).pathname !== location.pathname)
    throw new Error('FAIL: visible page does not match current URL');
  const rect = frame.getBoundingClientRect();
  if (document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) !== frame)
    throw new Error('FAIL: another page covers the active page');
  return `PASS: ${location.pathname}, exactly one visible page (${frames.length} retained)`;
})();
