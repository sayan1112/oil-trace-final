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

class OilCanvasLayer {
  constructor() {
    this._particles = [];
    this._trails = [];
    this._polygon = [];
    this._light = false;
    this._muted = false;
    this._canvas = null;
    this._ctx = null;
    this._map = null;
    this._dpr = 1;
    this._width = 0;
    this._height = 0;
    this._rafId = null;
    this._animId = null;
    this._needsRedraw = false;
    this._lastViewKey = null;
    this._phase = 0;

    // Stable bound callbacks — created once in constructor so
    // map.on / map.off always get the exact same function reference.
    this._boundScheduleRedraw = this._scheduleRedraw.bind(this);
    this._boundOnSettled = this._onSettled.bind(this);
    this._boundTick = this._tick.bind(this);
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
    if (this._animId) {
      cancelAnimationFrame(this._animId);
      this._animId = null;
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

  setFrame({ particles = [], trails = [], polygon = [], light = false, muted = false } = {}) {
    const nextParticles = Array.isArray(particles) ? particles : [];
    const nextTrails = Array.isArray(trails) ? trails : [];
    const nextPolygon = Array.isArray(polygon) ? polygon : [];
    const nextLight = Boolean(light);
    const nextMuted = Boolean(muted);

    // Do absolutely nothing when React re-renders for an unrelated UI
    // action (for example selecting a vessel). The oil field must remain
    // pixel-stable until the actual simulation frame changes.
    if (
      nextParticles === this._particles &&
      nextTrails === this._trails &&
      nextPolygon === this._polygon &&
      nextLight === this._light &&
      nextMuted === this._muted
    ) {
      return;
    }

    this._particles = nextParticles;
    this._trails = nextTrails;
    this._polygon = nextPolygon;
    this._light = nextLight;
    this._muted = nextMuted;
    this._scheduleRedraw(true);
  }

  _tick(now) {
    this._phase = now / 3200;
    if (!this._lastAnim || now - this._lastAnim > 50) {
      this._lastAnim = now;
      this._redraw();
    }
    this._animId = requestAnimationFrame(this._boundTick);
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
    if (force) this._needsRedraw = true;
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      const must = this._needsRedraw;
      this._needsRedraw = false;
      if (must || force || this._hasViewChanged()) {
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

  _drawObservedSlick() {
    // Observed slick is the particle field — never a filled SAR blob.
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
    const zoomBoost = Math.pow(1.12, Math.max(0, 10.5 - zoom));
    const pad = 24 + 40 * zoomBoost;

    if (this._particles.length) {
      ctx.save();
      ctx.globalCompositeOperation = "source-over";

      const plotted = [];

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
      }

      // Normal crisp oil dots (matte dark petroleum core and clean sheen)
      const order = { initial: 0, sheen: 0, active: 1, stranded: 2, core: 2 };
      plotted.sort((a, b) => (order[a.particle.category] ?? 1) - (order[b.particle.category] ?? 1));

      for (const { point, particle } of plotted) {
        const cat = particle.category || "active";
        const isCore = cat === "stranded" || cat === "core";
        const isSheen = cat === "initial" || cat === "sheen";

        // Muted mode: after the hindcast pipeline runs, the observed slick
        // becomes a faint reference layer so the teal/green simulation
        // clouds own the visual foreground.
        const radius = (isCore ? 2.3 : isSheen ? 1.5 : 1.85) * (this._muted ? 0.8 : 1);
        // On the dark satellite basemap the petroleum-dark dots vanish, so
        // the light mode flips the particles to white.
        const color = this._muted
          ? this._light
            ? "rgba(226, 232, 240, 0.28)"
            : "rgba(51, 65, 85, 0.22)"
          : this._light
          ? isCore
            ? "rgba(255, 255, 255, 0.95)"
            : isSheen
            ? "rgba(226, 232, 240, 0.55)"
            : "rgba(241, 245, 249, 0.85)"
          : isCore
          ? "rgba(15, 23, 42, 0.92)"
          : isSheen
          ? "rgba(30, 41, 59, 0.55)"
          : "rgba(30, 41, 59, 0.85)";

        ctx.beginPath();
        ctx.fillStyle = color;
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
  polygon = [],
  light = false,
  muted = false,
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
    layerRef.current?.setFrame({ particles, trails, polygon, light, muted });
  }, [particles, trails, polygon, light, muted]);

  return null;
}


// Vessel selection changes many map elements, but it must never cause the
// oil canvas component itself to re-render. Keep the particle layer isolated
// from UI-only state changes.
export default memo(DeckOilOverlay, (prev, next) =>
  prev.enabled === next.enabled &&
  prev.particles === next.particles &&
  prev.trails === next.trails &&
  prev.polygon === next.polygon &&
  prev.light === next.light &&
  prev.muted === next.muted
);
