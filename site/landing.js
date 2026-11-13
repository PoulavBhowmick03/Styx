// Landing-page footer only. Decoration: it reads and writes nothing else, and the page works without it.
// The big name grows slightly and gains strength as the page scrolls it into view.
const band = document.querySelector('.mark-band');
if (band && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  let queued = false;
  const place = () => {
    queued = false;
    const box = band.getBoundingClientRect();
    if (box.height === 0) return;
    band.style.setProperty('--p', Math.min(1, Math.max(0, (innerHeight - box.top) / box.height)).toFixed(3));
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(place); } };
  addEventListener('scroll', queue, { passive: true });
  addEventListener('resize', queue);
  place();
}
