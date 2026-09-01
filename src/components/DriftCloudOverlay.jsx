import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { buildCloud, cloudPositions, cloudTrail, envelopeRadiusKm } from "../Simulation/particles";

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
    const points = (hindcast.backward_trajectory.coordinates || []).map(
      ([lon, lat]) => [lat, lon]
    );
    const region = hindcast.source_region?.candidate_regions?.[0];
    return buildCloud({
      points,
      timesUtc: hindcast.trajectory_timestamps_utc,
      count: 800,
      startSpreadKm: envelopeRadiusKm(region?.geometry, 2.5),
      endSpreadKm: envelopeRadiusKm(slickGeometry, 1.8),
      seed: "oiltrace-back",
    });
  }, [hindcast, slickGeometry]);

  const fwdCloud = useMemo(() => {
    if (!forward?.trajectory || !forward?.trajectory_timestamps_utc?.length) return null;
    const points = (forward.trajectory.coordinates || []).map(([lon, lat]) => [lat, lon]);
    return buildCloud({
      points,
      timesUtc: forward.trajectory_timestamps_utc,
      count: 1800,
      startSpreadKm: 0.18,
      endSpreadKm: Math.min(2.2, envelopeRadiusKm(forward.predicted_footprint, 1.6)),
      seed: "oiltrace-fwd",
    });
  }, [forward]);

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

    const drawCloud = (cloud, fill, bufRef) => {
      const pos = cloudPositions(cloud, tMs, bufRef.current);
      bufRef.current = pos;
      const trail = cloudTrail(cloud, tMs);
      if (trail.length >= 2) {
        ctx.beginPath();
        trail.forEach((pair, index) => {
          const point = map.latLngToLayerPoint([pair[1], pair[0]]);
          const x = point.x - origin.x;
          const y = point.y - origin.y;
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = "rgba(92, 54, 12, 0.18)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.fillStyle = fill;
      for (let i = 0; i < cloud.count; i += 1) {
        const lat = pos[i * 2];
        const lng = pos[i * 2 + 1];
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const point = map.latLngToLayerPoint([lat, lng]);
        const x = point.x - origin.x;
        const y = point.y - origin.y;
        if (x < -r || y < -r || x > w + r || y > h + r) continue;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    if (fc && tMs >= fc.t0 - 1000) {
      drawCloud(fc, "rgba(92, 42, 12, 0.28)", fwdBufRef);
    } else if (bc && tMs >= bc.t0) {
      drawCloud(bc, "rgba(67, 32, 10, 0.22)", backBufRef);
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
