import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { buildCloud, cloudPositions, overlayFrameFromCloud, envelopeRadiusKm } from "../Simulation/particles";

// OpenDrift-style particle clouds for the BACKEND simulations, all driven by
// the app's ONE master simulation clock (`timeMs`):
//
//   • teal cloud  — backward-hindcast reconstruction (probable source region
//     converging onto the observed slick) across the whole window
//   • black cloud — released oil: appears exactly when the clock reaches the
//     backend's estimated release time, then drifts along the forward
//     trajectory and spreads to the predicted footprint
//   • a red pulse marks the release moment at the release location
//
// Everything is a deterministic, seeded visualisation of backend outputs —
// centroid paths, timestamps and spread envelopes come from the API
// responses; nothing is computed locally. The overlay owns no clock: the
// Replay panel and the chip below both steer the same master clock.

const RELEASE_PULSE_SIM_MS = 8 * 60 * 1000;

export default function DriftCloudOverlay({
  hindcast,
  forward,
  slickGeometry,
  visible,
  timeMs,
}) {
  const map = useMap();
  const canvasRef = useRef(null);
  const originRef = useRef(null);
  const backBufRef = useRef(null);
  const fwdBufRef = useRef(null);

  /* ── Clouds from backend outputs ─────────────────────────────────── */

  const backCloud = useMemo(() => {
    if (!hindcast?.backward_trajectory || !hindcast?.trajectory_timestamps_utc?.length)
      return null;
    let points = (hindcast.backward_trajectory.coordinates || []).map(
      ([lon, lat]) => [lat, lon]
    );
    let timesUtc = hindcast.trajectory_timestamps_utc;
    // The teal packet must visibly travel BACK from the slick to the source
    // (that is the story of a hindcast), so keep slick→source point order
    // and give it ascending display times for the animation clock.
    const descending =
      timesUtc.length >= 2 &&
      Date.parse(timesUtc[0]) > Date.parse(timesUtc[timesUtc.length - 1]);
    if (descending) {
      timesUtc = [...timesUtc].reverse();
    } else {
      points = [...points].reverse();
    }
    let times = timesUtc.map((t) => Date.parse(t));
    const region = hindcast.source_region?.candidate_regions?.[0];

    // Pace the backward phase to finish by the estimated release moment —
    // the geometry stays exactly what the backend hindcast computed; only
    // the animation timing is compressed.
    const relT = forward?.release_time_utc ? Date.parse(forward.release_time_utc) : NaN;
    if (Number.isFinite(relT) && relT > times[0]) {
      const t0 = times[0];
      const span0 = Math.max(1, times[times.length - 1] - t0);
      times = times.map((t) => t0 + ((t - t0) / span0) * (relT - t0));
    }
    return buildCloud({
      points,
      timesUtc: times,
      count: 800,
      startSpreadKm: envelopeRadiusKm(slickGeometry, 1.8),
      endSpreadKm: envelopeRadiusKm(region?.geometry, 2.5),
      seed: "oiltrace-back",
    });
  }, [hindcast, forward, slickGeometry]);

  const fwdCloud = useMemo(() => {
    if (!forward?.trajectory || !forward?.trajectory_timestamps_utc?.length) return null;
    const points = (forward.trajectory.coordinates || []).map(([lon, lat]) => [lat, lon]);
    return buildCloud({
      points,
      timesUtc: forward.trajectory_timestamps_utc,
      count: 1800,
      startSpreadKm: 0.18,
      // Spread out to the observed slick's own envelope so the travelling
      // oil visually arrives at the detected slick footprint.
      endSpreadKm: Math.min(
        2.2,
        envelopeRadiusKm(forward.predicted_footprint || slickGeometry, 1.6)
      ),
      seed: "oiltrace-fwd",
    });
  }, [forward, slickGeometry]);

  const releaseLatLng = useMemo(() => {
    const loc = forward?.release_location;
    if (!loc) return null;
    return [+loc.lat, +loc.lon];
  }, [forward]);

  /* ── Drawing (both clouds, one clock) ────────────────────────────── */

  const stateRef = useRef({});
  stateRef.current = { visible, backCloud, fwdCloud, releaseLatLng, timeMs };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const origin = originRef.current;
    if (!canvas || !origin) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr, h = canvas.height / dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { visible: vis, backCloud: bc, fwdCloud: fc, releaseLatLng: rel, timeMs: t } =
      stateRef.current;
    if (!vis || (!bc && !fc)) return;
    const tMs = Number.isFinite(t) ? t : (fc || bc).t0;
    const zoom = map.getZoom();
    const r = Math.max(1.05, Math.min(2.8, 1.15 * Math.pow(1.12, 10.5 - zoom)));

    const toXY = (pair) => {
      const point = map.latLngToLayerPoint([pair[1], pair[0]]);
      return { x: point.x - origin.x, y: point.y - origin.y };
    };

    // Small arrowhead at b, pointing along a→b.
    const drawArrowHead = (a, b, color) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 6) return;
      const ux = dx / len, uy = dy / len;
      const size = 7;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(b.x - size * (ux * 0.87 - uy * 0.5), b.y - size * (uy * 0.87 + ux * 0.5));
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x - size * (ux * 0.87 + uy * 0.5), b.y - size * (uy * 0.87 - ux * 0.5));
      ctx.stroke();
    };

    // Label chip riding the leading edge of a cloud; side keeps the two
    // labels from colliding when the packets cross paths.
    const drawLabel = (tip, text, color, side = "right") => {
      ctx.font = "700 11px Inter, system-ui, sans-serif";
      const tw = ctx.measureText(text).width;
      const pad = 7, ch = 20;
      let x = side === "right" ? tip.x + 12 : tip.x - tw - pad * 2 - 12;
      let y = side === "right" ? tip.y - ch - 10 : tip.y + 14;
      x = Math.max(4, Math.min(x, w - tw - pad * 2 - 4));
      y = Math.max(4, Math.min(y, h - ch - 4));
      ctx.beginPath();
      ctx.roundRect(x, y, tw + pad * 2, ch, 6);
      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(text, x + pad, y + 14);
    };

    const drawCloud = (cloud, fill, trailStroke, bufRef, label, side) => {
      const pos = cloudPositions(cloud, tMs, bufRef.current);
      bufRef.current = pos;
      const trail = overlayFrameFromCloud(cloud, tMs).trails[0]?.path || [];
      if (trail.length >= 2) {
        ctx.beginPath();
        trail.forEach((pair, index) => {
          const { x, y } = toXY(pair);
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = trailStroke;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.fillStyle = fill;
      const cr = r * 1.35;
      for (let i = 0; i < cloud.count; i += 1) {
        const lat = pos[i * 2];
        const lng = pos[i * 2 + 1];
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const point = map.latLngToLayerPoint([lat, lng]);
        const x = point.x - origin.x;
        const y = point.y - origin.y;
        if (x < -cr || y < -cr || x > w + cr || y > h + cr) continue;
        ctx.beginPath();
        ctx.arc(x, y, cr, 0, Math.PI * 2);
        ctx.fill();
      }
      // Direction arrows along the travelled path + a moving label chip so
      // forward and backward can never be confused.
      if (trail.length >= 2) {
        const solid = fill.replace(/[\d.]+\)$/, "0.95)");
        const step = Math.max(3, Math.floor(trail.length / 4));
        for (let i = step; i < trail.length; i += step) {
          drawArrowHead(toXY(trail[i - 1]), toXY(trail[i]), solid);
        }
        const tip = toXY(trail[trail.length - 1]);
        drawArrowHead(toXY(trail[trail.length - 2]), tip, solid);
        if (label) drawLabel(tip, label, solid, side);
      }
    };

    // Two phases, never on screen together:
    //   PHASE 1 (before release) — teal backward hindcast traces from the
    //     slick to the backend's estimated source region.
    //   PHASE 2 (after release)  — the teal analysis clears and the green
    //     forward drift plays alone from the release point toward the slick.
    const releaseGate = fc ? fc.t0 - 1000 : Infinity;
    if (tMs < releaseGate) {
      if (bc && tMs >= bc.t0) {
        drawCloud(bc, "rgba(11, 130, 150, 0.9)", "rgba(13, 178, 200, 0.45)", backBufRef, "BACKWARD · tracing to source", "left");
      }
    } else if (fc) {
      drawCloud(fc, "rgba(22, 140, 65, 0.9)", "rgba(34, 197, 94, 0.45)", fwdBufRef, "FORWARD · oil drifting to slick", "right");
    }

    if (fc && rel && tMs >= fc.t0) {
      const since = tMs - fc.t0;
      if (since <= RELEASE_PULSE_SIM_MS) {
        const f = since / RELEASE_PULSE_SIM_MS;
        const p = map.latLngToLayerPoint(rel);
        const x = p.x - origin.x;
        const y = p.y - origin.y;
        ctx.strokeStyle = `rgba(180, 83, 9, ${(1 - f) * 0.7})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 8 + f * 28, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }, [map]);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  /* ── Canvas lifecycle in the overlay pane ────────────────────────── */

  useEffect(() => {
    const canvas = L.DomUtil.create("canvas", "leaflet-zoom-animated");
    canvas.style.pointerEvents = "none";
    map.getPanes().overlayPane.appendChild(canvas);
    canvasRef.current = canvas;

    const reset = () => {
      const topLeft = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(canvas, topLeft);
      originRef.current = topLeft;
      const size = map.getSize(), dpr = window.devicePixelRatio || 1;
      if (canvas.width !== size.x * dpr || canvas.height !== size.y * dpr) {
        canvas.width = size.x * dpr;
        canvas.height = size.y * dpr;
        canvas.style.width = `${size.x}px`;
        canvas.style.height = `${size.y}px`;
      }
      drawRef.current();
    };
    const animateZoom = (e) => {
      const scale = map.getZoomScale(e.zoom);
      const offset = map
        ._getCenterOffset(e.center)
        ._multiplyBy(-scale)
        .subtract(map._getMapPanePos());
      L.DomUtil.setTransform(canvas, offset, scale);
    };
    map.on("move moveend zoomend viewreset resize", reset);
    if (map.options.zoomAnimation && L.Browser.any3d) map.on("zoomanim", animateZoom);
    reset();
    return () => {
      map.off("move moveend zoomend viewreset resize", reset);
      map.off("zoomanim", animateZoom);
      L.DomUtil.remove(canvas);
      canvasRef.current = null;
    };
  }, [map]);

  useEffect(() => { drawRef.current(); }, [timeMs, visible, backCloud, fwdCloud, draw]);

  return null;
}
