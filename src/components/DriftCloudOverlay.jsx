import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { buildCloud, cloudPositions, envelopeRadiusKm } from "../Simulation/particles";

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

function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

const RELEASE_PULSE_SIM_MS = 8 * 60 * 1000; // pulse lasts 8 simulated minutes

export default function DriftCloudOverlay({
  hindcast,
  forward,
  slickGeometry,
  visible,
  timeMs,
  playing,
  onPlayPause,
  onRestart,
  speed,
  onSpeed,
}) {
  const map = useMap();
  const canvasRef = useRef(null);
  const originRef = useRef(null);
  const backBufRef = useRef(null);
  const fwdBufRef = useRef(null);
  // View mode: which cloud(s) to display — everything stays on the one clock.
  const [mode, setMode] = useState("both"); // 'both' | 'back' | 'fwd'

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
      count: 1400,
      startSpreadKm: 0.25,
      endSpreadKm: envelopeRadiusKm(forward.predicted_footprint, 2.0),
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
  stateRef.current = { visible, backCloud, fwdCloud, releaseLatLng, timeMs, mode };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const origin = originRef.current;
    if (!canvas || !origin) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr, h = canvas.height / dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { visible: vis, backCloud: bc, fwdCloud: fc, releaseLatLng: rel, timeMs: t, mode: md } =
      stateRef.current;
    if (!vis || (!bc && !fc)) return;
    const tMs = Number.isFinite(t) ? t : (fc || bc).t1;
    const r = map.getZoom() >= 10 ? 1.9 : 1.5;

    const drawCloud = (cloud, style, bufRef) => {
      const pos = cloudPositions(cloud, tMs, bufRef.current);
      bufRef.current = pos;
      ctx.fillStyle = style;
      for (let i = 0; i < cloud.count; i++) {
        const p = map.latLngToLayerPoint([pos[i * 2], pos[i * 2 + 1]]);
        const x = p.x - origin.x, y = p.y - origin.y;
        if (x < -8 || y < -8 || x > w + 8 || y > h + 8) continue;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 6.2832);
        ctx.fill();
      }
    };

    // Reconstruction cloud runs across the whole window.
    if (bc && md !== "fwd") drawCloud(bc, "rgba(8,94,120,0.45)", backBufRef);

    // Released oil exists only from the estimated release time onward.
    if (fc && md !== "back" && tMs >= fc.t0) {
      drawCloud(fc, "rgba(15,19,25,0.62)", fwdBufRef);

      // Release pulse: expanding red ring right after the release moment.
      const since = tMs - fc.t0;
      if (rel && since <= RELEASE_PULSE_SIM_MS) {
        const f = since / RELEASE_PULSE_SIM_MS;
        const p = map.latLngToLayerPoint(rel);
        const x = p.x - origin.x, y = p.y - origin.y;
        ctx.strokeStyle = `rgba(217,47,35,${(1 - f) * 0.9})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(x, y, 8 + f * 34, 0, 6.2832);
        ctx.stroke();
        ctx.fillStyle = `rgba(217,47,35,${(1 - f) * 0.8})`;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, 6.2832);
        ctx.fill();
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
    map.on("moveend zoomend viewreset resize", reset);
    if (map.options.zoomAnimation && L.Browser.any3d) map.on("zoomanim", animateZoom);
    reset();
    return () => {
      map.off("moveend zoomend viewreset resize", reset);
      map.off("zoomanim", animateZoom);
      L.DomUtil.remove(canvas);
      canvasRef.current = null;
    };
  }, [map]);

  useEffect(() => { drawRef.current(); }, [timeMs, visible, backCloud, fwdCloud, mode, draw]);

  /* ── Control chip (steers the master clock) ──────────────────────── */

  if (!visible || (!backCloud && !fwdCloud)) return null;
  const t = Number.isFinite(timeMs) ? timeMs : (fwdCloud || backCloud).t1;
  const released = fwdCloud && t >= fwdCloud.t0;

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        bottom: "1.1rem",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 900,
        display: "flex",
        alignItems: "center",
        gap: "0.55rem",
        background: "rgba(8,20,36,0.92)",
        border: "1px solid rgba(148,163,184,0.25)",
        borderRadius: "12px",
        padding: "0.45rem 0.75rem",
        color: "#e2e8f0",
        fontSize: "0.75rem",
        boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
      }}
    >
      <span style={{ fontWeight: 700, letterSpacing: "0.06em" }}>DRIFT REPLAY</span>
      <span style={{ fontVariantNumeric: "tabular-nums", minWidth: "72px" }}>{fmtClock(t)}</span>
      <button
        onClick={() => onPlayPause?.()}
        style={{ background: "#2563eb", border: "none", borderRadius: "8px", color: "#fff", width: "30px", height: "26px", fontSize: "0.7rem" }}
        title="Play / pause drift replay"
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <button
        onClick={() => onRestart?.()}
        style={{ background: "none", border: "1px solid rgba(148,163,184,0.4)", borderRadius: "8px", color: "#cbd5e1", width: "28px", height: "26px", fontSize: "0.7rem" }}
        title="Replay from the start of the window"
      >
        ↺
      </button>
      <select
        value={speed}
        onChange={(e) => onSpeed?.(Number(e.target.value))}
        style={{ background: "rgba(15,30,52,0.9)", color: "#e2e8f0", border: "1px solid rgba(148,163,184,0.35)", borderRadius: "7px", height: "26px", fontSize: "0.72rem" }}
      >
        <option value={0.5}>0.5×</option>
        <option value={1}>1×</option>
        <option value={2}>2×</option>
        <option value={4}>4×</option>
      </select>
      <span style={{ display: "inline-flex", gap: "2px", background: "rgba(15,30,52,0.9)", border: "1px solid rgba(148,163,184,0.35)", borderRadius: "8px", padding: "2px" }}>
        {[
          ["back", "◀ Backtrack", "#67e8f9"],
          ["both", "Both", "#e2e8f0"],
          ["fwd", "Forward ▶", "#cbd5e1"],
        ].map(([key, label, color]) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            disabled={key !== "back" && !fwdCloud}
            style={{
              background: mode === key ? "#2563eb" : "none",
              border: "none",
              borderRadius: "6px",
              color: mode === key ? "#fff" : color,
              padding: "0.15rem 0.5rem",
              fontSize: "0.68rem",
              opacity: key !== "back" && !fwdCloud ? 0.4 : 1,
            }}
            title={
              key === "back"
                ? "Teal cloud: backward hindcast reconstruction"
                : key === "fwd"
                  ? "Black cloud: released oil (appears at estimated release)"
                  : "Show both clouds"
            }
          >
            {label}
          </button>
        ))}
      </span>
      {mode !== "back" && fwdCloud && (
        <span
          style={{
            display: "inline-flex", alignItems: "center", gap: "0.3rem", fontSize: "0.68rem",
            color: released ? "#e2e8f0" : "#64748b",
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: released ? "#0f1319" : "#334155", outline: released ? "none" : "1px dashed #475569" }} />
          {released ? "released oil" : "awaiting release"}
        </span>
      )}
    </div>
  );
}
