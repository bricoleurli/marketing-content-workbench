// Run in the top console on /overlays after scrolling the inspector to its end.
(() => {
  const frame = document.querySelector('.workbench-host-frame:not([hidden])');
  const doc = frame.contentDocument;
  const view = frame.contentWindow;
  const stage = doc.querySelector('.overlays-stage');
  const pane = doc.querySelector('.overlay-inspector-pane');
  const button = doc.querySelector('#renderButton');
  const bounds = pane.getBoundingClientRect();
  const end = button.getBoundingClientRect();
  if (view.innerWidth > 1024 && stage.getBoundingClientRect().bottom > view.innerHeight + 1)
    throw Error('FAIL: stage extends beyond viewport');
  if (view.innerWidth > 1024 && (end.bottom > bounds.bottom || end.top < bounds.top))
    throw Error('FAIL: bottom export control is not reachable');
  if (view.innerWidth <= 720 && view.getComputedStyle(doc.body).overflowY === 'hidden')
    throw Error('FAIL: mobile document scrolling is disabled');
  return 'PASS: scroll bounds and bottom controls';
})();
