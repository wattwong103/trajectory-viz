/**
 * Composite PNG export (Phase 3).
 *
 * The scene lives on TWO canvases — MapLibre's basemap below, deck.gl's
 * layers above. The old export grabbed document.querySelector('canvas')
 * (the first one) and lost every deck layer. This composites all canvases
 * in DOM order (= stacking order) onto one offscreen 2D canvas.
 *
 * Requires preserveDrawingBuffer on both contexts (set in MapView) so
 * drawImage sees the last-drawn frame instead of a cleared buffer.
 */

export function exportCompositePng(container: HTMLElement, filename: string): void {
  // Explicit stacking order — DOM order is NOT reliable here (DeckGL mounts
  // its canvas before the MapLibre child): basemap first, deck layers last,
  // anything else in between.
  const canvases = Array.from(container.querySelectorAll('canvas')).sort((a, b) => {
    const rank = (c: HTMLCanvasElement) =>
      c.classList.contains('maplibregl-canvas') ? 0 : c.id === 'deckgl-overlay' ? 2 : 1;
    return rank(a) - rank(b);
  });
  if (canvases.length === 0) return;

  const target = document.createElement('canvas');
  // Device-pixel size of the first (basemap) canvas; all map canvases share it.
  target.width = canvases[0].width;
  target.height = canvases[0].height;
  const ctx = target.getContext('2d');
  if (!ctx) return;

  // Dark backdrop in case a canvas renders transparent at the edges.
  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, target.width, target.height);

  for (const c of canvases) {
    try {
      ctx.drawImage(c, 0, 0, target.width, target.height);
    } catch (e) {
      // A CORS-tainted canvas throws SecurityError — skip it rather than
      // failing the whole export (carto tiles are CORS-enabled, so this
      // should not happen in practice).
      console.warn('exportCompositePng: skipping unreadable canvas', e);
    }
  }

  target.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}
