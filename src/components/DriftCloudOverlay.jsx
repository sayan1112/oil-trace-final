import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { buildCloud, cloudPositions, envelopeRadiusKm } from "../Simulation/particles";

// OpenDrift-style particle cloud for the BACKEND simulations.
//
// Renders an animated cloud of pseudo-particles along the backend's
// backward-hindcast trajectory (source region → observed slick) and, once the
// forward simulation has run, along the forward trajectory (release →
// predicted footprint). The cloud is a deterministic, seeded visualisation of
// the backend outputs — centroid path, timestamps and spread envelopes all
// come from the API responses; nothing is computed locally.
//
// The canvas lives in Leaflet's overlay pane so it pans with the map for free
// and is CSS-scaled during animated zooms (Leaflet.heat technique).

const PLAY_MS = 13000; // full simulation span at 1× — presentable pacing

function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export default function DriftCloudOverlay({ hindcast, forward, slickGeometry, visible }) {
  const map = useMap();
  const canvasRef = useRef(null);
  const originRef = useRef(null);
  const posBufRef = useRef(null);
  const [phase, setPhase] = useState("back"); // 'back' | 'fwd'
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [clockMs, setClockMs] = useState(null);

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
      count: 900,
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

  const activeCloud = phase === "fwd" && fwdCloud ? fwdCloud : backCloud;

  /* ── Drawing ─────────────────────────────────────────────────────── */

  const stateRef = useRef({});
  stateRef.current = { visible, activeCloud, phase, clockMs };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const origin = originRef.current;
    if (!canvas || !origin) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr, h = canvas.height / dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { visible: vis, activeCloud: cloud, phase: ph, clockMs: t } = stateRef.current;
    if (!vis || !cloud) return;
    const tMs = t ?? cloud.t1;
    const pos = cloudPositions(cloud, tMs, posBufRef.current);
    posBufRef.current = pos;
    ctx.fillStyle = ph === "fwd" ? "rgba(15,19,25,0.62)" : "rgba(8,94,120,0.55)";
    const r = map.getZoom() >= 10 ? 1.9 : 1.5;
    for (let i = 0; i < cloud.count; i++) {
      const p = map.latLngToLayerPoint([pos[i * 2], pos[i * 2 + 1]]);
      const x = p.x - origin.x, y = p.y - origin.y;
      if (x < -8 || y < -8 || x > w + 8 || y > h + 8) continue;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 6.2832);
      ctx.fill();
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

  /* ── Auto-play when a simulation arrives ─────────────────────────── */

  useEffect(() => {
    if (!backCloud) return;
    setPhase("back");
    setClockMs(backCloud.t0);
    setPlaying(true);
  }, [backCloud]);

  useEffect(() => {
    if (!fwdCloud) return;
    setPhase("fwd");
    setClockMs(fwdCloud.t0);
    setPlaying(true);
  }, [fwdCloud]);

  /* ── Smooth playback clock (local rAF variable, not React state) ── */

  useEffect(() => {
    if (!playing || !activeCloud) return;
    let raf, last = performance.now();
    let cur = clockMs ?? activeCloud.t0;
    if (cur >= activeCloud.t1 - 500) cur = activeCloud.t0;
    const rate = ((activeCloud.t1 - activeCloud.t0) / PLAY_MS) * speed;
    const tick = (now) => {
      cur = Math.min(activeCloud.t1, cur + (now - last) * rate);
      last = now;
      setClockMs(cur);
      if (cur >= activeCloud.t1) { setPlaying(false); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, activeCloud]);

  useEffect(() => { drawRef.current(); }, [clockMs, visible, activeCloud, draw]);

  /* ── Replay control chip ─────────────────────────────────────────── */

  if (!visible || !activeCloud) return null;
  const t = clockMs ?? activeCloud.t1;

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
        gap: "0.5rem",
        background: "rgba(8,20,36,0.92)",
        border: "1px solid rgba(148,163,184,0.25)",
        borderRadius: "12px",
        padding: "0.45rem 0.7rem",
        color: "#e2e8f0",
        fontSize: "0.75rem",
        boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
      }}
    >
      <span style={{ fontWeight: 700, letterSpacing: "0.06em", color: phase === "fwd" ? "#cbd5e1" : "#67e8f9" }}>
        {phase === "fwd" ? "FORWARD DRIFT" : "BACKTRACK DRIFT"}
      </span>
      <span style={{ fontVariantNumeric: "tabular-nums", minWidth: "70px" }}>{fmtClock(t)}</span>
      <button
        onClick={() => setPlaying((p) => !p)}
        style={{ background: "#2563eb", border: "none", borderRadius: "8px", color: "#fff", width: "30px", height: "26px", fontSize: "0.7rem" }}
        title="Play / pause drift animation"
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <button
        onClick={() => { setClockMs(activeCloud.t0); setPlaying(true); }}
        style={{ background: "none", border: "1px solid rgba(148,163,184,0.4)", borderRadius: "8px", color: "#cbd5e1", width: "28px", height: "26px", fontSize: "0.7rem" }}
        title="Replay from release"
      >
        ↺
      </button>
      <select
        value={speed}
        onChange={(e) => setSpeed(Number(e.target.value))}
        style={{ background: "rgba(15,30,52,0.9)", color: "#e2e8f0", border: "1px solid rgba(148,163,184,0.35)", borderRadius: "7px", height: "26px", fontSize: "0.72rem" }}
      >
        <option value={1}>1×</option>
        <option value={2}>2×</option>
        <option value={4}>4×</option>
      </select>
      {backCloud && fwdCloud && (
        <button
          onClick={() => {
            const next = phase === "fwd" ? "back" : "fwd";
            const cloud = next === "fwd" ? fwdCloud : backCloud;
            setPhase(next);
            setClockMs(cloud.t0);
            setPlaying(true);
          }}
          style={{ background: "none", border: "1px solid rgba(148,163,184,0.4)", borderRadius: "8px", color: "#cbd5e1", padding: "0 0.5rem", height: "26px", fontSize: "0.68rem" }}
          title="Switch between backtrack and forward drift"
        >
          {phase === "fwd" ? "⇤ Backtrack" : "Forward ⇥"}
        </button>
      )}
    </div>
  );
}
