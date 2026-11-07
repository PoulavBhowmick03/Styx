// Landing-page footer only. Decoration: it reads and writes nothing else, and the page works without it.
// The big name grows slightly and gains strength as the page scrolls it into view, and eases back on the way up.
const band = document.querySelector<HTMLElement>(".mark-band");

if (band && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let queued = false;
  const place = () => {
    queued = false;
    const box = band.getBoundingClientRect();
    if (box.height === 0) return; // the landing is hidden on the alert and approval views
    // 0 when the band's top edge reaches the bottom of the window, 1 when all of it is in view.
    const progress = Math.min(1, Math.max(0, (window.innerHeight - box.top) / box.height));
    band.style.setProperty("--p", progress.toFixed(3));
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(place); } };
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue);
  place();
}
