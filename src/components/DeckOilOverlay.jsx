import { memo, useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "./DeckOilOverlay.css";

/* =========================================================
   OILTRACE — LAGRANGIAN PARTICLE OVERLAY

   This overlay renders the PARTICLES produced by
   Simulation/oilSimulation.js. It does not generate a second,
   unrelated plume. That keeps:

     replay time -> oil particles -> particle trails -> centreline

   on the same simulation clock.

   The canvas sits below Leaflet's marker pane so vessel markers
   remain visible while oil travels underneath them.
========================================================= */

const CATEGORY_COLORS = {
  initial: [212, 168, 48],
  active: [176, 92, 18],
  stranded: [92, 36, 8],
};

class OilCanvasLayer {
  constructor() {
    this._particles = [];
    this._trails = [];
    this._canvas = null;
    this._ctx = null;
    this._map = null;
    this._dpr = 1;
    this._width = 0;
    this._height = 0;
    this._rafId = null;
    this._lastViewKey = null;

    // Stable bound callbacks — created once in constructor so
    // map.on / map.off always get the exact same function reference.
    this._boundScheduleRedraw = this._scheduleRedraw.bind(this);
    this._boundOnSettled = this._onSettled.bind(this);
  }

  addTo(map) {
    this._map = map;

    const canvas = document.createElement("canvas");
    canvas.className = "oiltrace-oil-canvas";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.pointerEvents = "none";

    // Keep the canvas as a fixed, screen-space layer. Leaflet zoom animation
    // is disabled on the MapContainer so this layer cannot visually drift
    // while Leaflet's vector/tile panes are being animated.
    map.getContainer().appendChild(canvas);

    this._canvas = canvas;
    this._ctx = canvas.getContext("2d", { alpha: true });

    this._syncSize();
    this._hasViewChanged();
    this._redraw();

    // Strategy:
    //   - "move" events fire continuously during pan AND during setView
    //     animation. Batch them via RAF so we only redraw once per visual
    //     frame. This is safe because the particles are geo-coordinates;
    //     latLngToContainerPoint() always uses the current projection.
    //
    //   - "moveend", "zoomend", "viewreset": fire once when the map
    //     settles. Do a final clean redraw via _onSettled() which cancels
    //     any pending RAF first to avoid a duplicate frame.
    //
    //   - "resize": map container resized — re-sync canvas dimensions then
    //     redraw via _onSettled().
    //
    // We intentionally do NOT listen to "flystart" — we no longer use
    // flyTo() to move the map (replaced with setView), so the flystart
    // event is never fired. Keeping it would be dead code.
    map.on("move", this._boundScheduleRedraw);
    map.on("moveend zoomend viewreset resize", this._boundOnSettled);
    window.addEventListener("resize", this._boundOnSettled);

    return this;
  }

  remove() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    if (this._map) {
      this._map.off("move", this._boundScheduleRedraw);
      this._map.off("moveend zoomend viewreset resize", this._boundOnSettled);
    }

    window.removeEventListener("resize", this._boundOnSettled);

    if (this._canvas?.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }

    this._canvas = null;
    this._ctx = null;
    this._map = null;
    this._particles = [];
    this._trails = [];
  }

  setFrame({ particles = [], trails = [] } = {}) {
    const nextParticles = Array.isArray(particles) ? particles : [];
    const nextTrails = Array.isArray(trails) ? trails : [];

    // Do absolutely nothing when React re-renders for an unrelated UI
    // action (for example selecting a vessel). The oil field must remain
    // pixel-stable until the actual simulation frame changes.
    if (nextParticles === this._particles && nextTrails === this._trails) {
      return;
    }

    this._particles = nextParticles;
    this._trails = nextTrails;
    this._scheduleRedraw(true);
  }

  // Called when the map fully settles (moveend/zoomend/resize/setFrame).
  // Cancels any pending batched-move RAF and does a clean synchronous draw.
  _onSettled() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    // A vessel click must not cause a particle-field redraw. Only redraw
    // after an actual Leaflet viewport change (center/zoom/size).
    if (!this._hasViewChanged()) return;
    this._redraw();
  }

  _hasViewChanged() {
    if (!this._map) return false;
    const center = this._map.getCenter();
    const zoom = this._map.getZoom();
    const size = this._map.getSize();
    const key = [
      center.lat.toFixed(7),
      center.lng.toFixed(7),
      Number(zoom).toFixed(4),
      size.x,
      size.y,
    ].join("|");

    if (key === this._lastViewKey) return false;
    this._lastViewKey = key;
    return true;
  }

  // Called on every "move" event during panning / setView animation.
  // Batches into at most one redraw per animation frame.
  _scheduleRedraw(force = false) {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      if (force || this._hasViewChanged()) {
        this._redraw();
      }
    });
  }

  _syncSize() {
    if (!this._map || !this._canvas || !this._ctx) return false;

    const size = this._map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const targetW = Math.max(1, Math.round(size.x * dpr));
    const targetH = Math.max(1, Math.round(size.y * dpr));

    // Only update canvas pixel dimensions if size or DPR actually changed.
    // Setting canvas.width re-allocates GPU backbuffers and clears state.
    if (
      this._canvas.width !== targetW ||
      this._canvas.height !== targetH ||
      this._dpr !== dpr
    ) {
      this._dpr = dpr;
      this._width = size.x;
      this._height = size.y;
      this._canvas.style.width = `${size.x}px`;
      this._canvas.style.height = `${size.y}px`;
      this._canvas.width = targetW;
      this._canvas.height = targetH;
      this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return true;
    }

    return false;
  }

  _redraw() {
    const canvas = this._canvas;
    const ctx = this._ctx;
    const map = this._map;

    if (!canvas || !ctx || !map) return;

    this._syncSize();

    const cssWidth = this._width || canvas.width / this._dpr;
    const cssHeight = this._height || canvas.height / this._dpr;

    ctx.clearRect(0, 0, cssWidth, cssHeight);
    const zoom = map.getZoom();
    const zoomBoost = Math.pow(1.55, Math.max(0, 12.2 - zoom));
    const pad = 24 + 40 * zoomBoost;

    /* -------------------------------------------------------
       PARTICLE DRIFT TRAILS

       Draw a restrained subset of the simulation's actual
       particle histories. These are trails, not vessel paths.
    ------------------------------------------------------- */
    if (this._trails.length && zoom >= 11) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // The simulation supplies roughly half the particles as trails.
      // Rendering every historical segment would unnecessarily cover
      // the basemap, so keep every 4th trail and the recent portion.
      const stride = this._trails.length > 350 ? 4 : 2;

      for (let i = 0; i < this._trails.length; i += stride) {
        const trail = this._trails[i];
        if (!Array.isArray(trail?.path) || trail.path.length < 2) continue;

        const start = Math.max(0, trail.path.length - 24);
        const recent = trail.path.slice(start);
        if (recent.length < 2) continue;

        ctx.beginPath();
        let hasPoint = false;

        for (let j = 0; j < recent.length; j += 1) {
          const pair = recent[j];
          if (!Array.isArray(pair) || pair.length < 2) continue;

          const lng = Number(pair[0]);
          const lat = Number(pair[1]);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

          const point = map.latLngToContainerPoint(L.latLng(lat, lng));

          if (!hasPoint) {
            ctx.moveTo(point.x, point.y);
            hasPoint = true;
          } else {
            ctx.lineTo(point.x, point.y);
          }
        }

        if (hasPoint) {
          ctx.strokeStyle = zoom < 11 ? "rgba(92, 54, 12, 0.08)" : "rgba(92, 54, 12, 0.16)";
        ctx.lineWidth = zoom < 11 ? 2.4 : 1;
          ctx.stroke();
        }
      }

      ctx.restore();
    }

    /* -------------------------------------------------------
       ACTIVE OIL PARTICLES

       The particle coordinates and categories come directly from
       the current simulation frame. No independent animation is
       applied here, so the map scrub and particle field stay synced.
    ------------------------------------------------------- */
    if (this._particles.length) {
      ctx.save();
      ctx.globalCompositeOperation = "source-over";

      const plotted = [];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const particle of this._particles) {
        const lat = Number(particle?.latitude);
        const lng = Number(particle?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

        const point = map.latLngToContainerPoint(L.latLng(lat, lng));
        if (
          point.x < -pad ||
          point.x > cssWidth + pad ||
          point.y < -pad ||
          point.y > cssHeight + pad
        ) {
          continue;
        }

        plotted.push({ point, particle });
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }

      if (plotted.length) {
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const rx = Math.max(22, (maxX - minX) / 2 + 16 * zoomBoost);
        const ry = Math.max(16, (maxY - minY) / 2 + 12 * zoomBoost);
        const sheen = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
        sheen.addColorStop(0, "rgba(72, 28, 6, 0.42)");
        sheen.addColorStop(0.35, "rgba(140, 72, 16, 0.28)");
        sheen.addColorStop(0.7, "rgba(196, 140, 48, 0.14)");
        sheen.addColorStop(1, "rgba(196, 140, 48, 0)");
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, Math.max(0.55, ry / rx));
        ctx.beginPath();
        ctx.fillStyle = sheen;
        ctx.arc(0, 0, rx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      for (const { point, particle } of plotted) {
        const [r, g, b] =
          CATEGORY_COLORS[particle.category] || CATEGORY_COLORS.active;
        const radius = Math.max(
          zoom < 11 ? 7 : 4,
          Math.min(28, (Number(particle.radiusPixels) || 3.5) * 2.2 * zoomBoost)
        );
        const gradient = ctx.createRadialGradient(
          point.x,
          point.y,
          0,
          point.x,
          point.y,
          radius
        );
        const coreAlpha = (particle.category === "stranded" ? 0.58 : 0.34) * (zoom < 11 ? 1.25 : 1);
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${coreAlpha})`);
        gradient.addColorStop(0.45, `rgba(${r}, ${g}, ${b}, ${coreAlpha * 0.45})`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
        ctx.beginPath();
        ctx.fillStyle = gradient;
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }
}

function DeckOilOverlay({
  enabled = true,
  particles = [],
  trails = [],
}) {
  const map = useMap();
  const layerRef = useRef(null);

  /* Mount exactly once per map/enabled state.
     The canvas is created once and reused for every render.
     It is removed only when the component unmounts or enabled changes. */
  useEffect(() => {
    if (!map || !enabled) return undefined;

    const layer = new OilCanvasLayer();
    layer.addTo(map);
    layerRef.current = layer;

    return () => {
      layer.remove();
      layerRef.current = null;
    };
  }, [map, enabled]);

  /* Update only the frame data. Do NOT recreate the canvas layer on
     every replay tick; that caused unnecessary flicker and made the
     vessel/oil stacking unreliable. */
  useEffect(() => {
    layerRef.current?.setFrame({ particles, trails });
  }, [particles, trails]);

  return null;
}


// Vessel selection changes many map elements, but it must never cause the
// oil canvas component itself to re-render. Keep the particle layer isolated
// from UI-only state changes.
export default memo(DeckOilOverlay, (prev, next) =>
  prev.enabled === next.enabled &&
  prev.particles === next.particles &&
  prev.trails === next.trails
);
