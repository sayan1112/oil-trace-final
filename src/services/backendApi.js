/**
 * OilTrace Backend API client + frontend-shape adapters.
 *
 * BASE resolution:
 *   1. VITE_BACKEND_BASE_URL from .env (use this to point at the deployed
 *      Modal/Render backend, e.g. https://sih-oil-spill-26143-backend.onrender.com)
 *   2. Falls back to the local dev backend.
 *
 * All analytical outputs (source regions, rankings, trajectories, footprints,
 * counterfactual verdicts) come from these endpoints — never computed locally.
 */

export const BACKEND_BASE =
  import.meta.env.VITE_BACKEND_BASE_URL || "http://127.0.0.1:8000";

const API = `${BACKEND_BASE}/api/v1`;

async function request(path, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}${path}`, { ...options, signal: controller.signal });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) {
      throw new Error(`${r.status}: ${data?.detail ?? data?.message ?? r.statusText}`);
    }
    return data;
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error(`Backend request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ── Health / warm-up ─────────────────────────────────────────────── */

export const warmBackend = () => request("/health", {}, 60000).catch(() => null);
export const getBackendHealth = () => request("/health", {}, 60000);
export const getBackendPing = () => request("/ping", {}, 60000);
export const getMlHealth = () => request("/health/ml", {}, 120000);

/* ── Investigation endpoints ──────────────────────────────────────── */

export function detectOilSpills(file, acquiredAtUtc) {
  const fd = new FormData();
  fd.append("image", file);
  if (acquiredAtUtc) fd.append("acquired_at_utc", acquiredAtUtc);
  return request("/detect", { method: "POST", body: fd }, 300000);
}

export function runHindcast(slick, durationHours = 12) {
  return request(
    "/hindcast",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slick, duration_hours: durationHours }),
    },
    180000
  );
}

export function getCandidateVessels(bbox, start, end) {
  const q = new URLSearchParams({ bbox, start, end });
  return request(`/vessels?${q}`, {}, 120000);
}

export function runAttribution(incidentId, sourceRegion, vessels, uncertaintyRadiusKm = 15) {
  return request(
    "/attribute",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        incident_id: incidentId,
        source_region: sourceRegion,
        vessels,
        uncertainty_radius_km: uncertaintyRadiusKm,
      }),
    },
    180000
  );
}

export function runForwardSimulation(forwardRequest) {
  return request(
    "/forward",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forwardRequest),
    },
    180000
  );
}

export function runCounterfactual(incidentId, vesselMmsi, forwardResult, observedSlick) {
  return request(
    "/counterfactual",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        incident_id: incidentId,
        vessel_mmsi: vesselMmsi,
        forward_result: forwardResult,
        observed_slick: observedSlick,
      }),
    },
    120000
  );
}

export function getReplay(id) {
  return request(`/replay/${encodeURIComponent(id)}`, {}, 120000);
}

/* ── Geometry helpers ─────────────────────────────────────────────── */

function rings(g) {
  if (!g) return [];
  if (g.type === "Polygon") return g.coordinates || [];
  if (g.type === "MultiPolygon") return (g.coordinates || []).flatMap((x) => x || []);
  return [];
}

export function bboxFromGeometry(g, pad = 0) {
  const pts = rings(g).flatMap((x) => x || []);
  if (!pts.length) throw new Error("Backend returned empty source-region geometry.");
  const xs = pts.map((p) => +p[0]).filter(Number.isFinite);
  const ys = pts.map((p) => +p[1]).filter(Number.isFinite);
  return [
    Math.min(...xs) - pad,
    Math.min(...ys) - pad,
    Math.max(...xs) + pad,
    Math.max(...ys) + pad,
  ].join(",");
}

/** Backend LineString ([lon, lat]) → [{latitude, longitude}, ...] */
export function trajectoryPoints(geometry) {
  if (!geometry || geometry.type !== "LineString") return [];
  return (geometry.coordinates || [])
    .map(([lon, lat]) => ({ latitude: +lat, longitude: +lon }))
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
}

/* ── Backend → frontend shape adapters ────────────────────────────── */

/** Backend source_region → the sourceRegion shape the map/panels render. */
export function sourceRegionForFrontend(sr) {
  const c = sr?.candidate_regions?.[0];
  const centroid = c?.centroid || { lat: 0, lon: 0 };
  const pts = rings(c?.geometry).flatMap((x) => x || []);
  const ds = pts
    .map(([lon, lat]) =>
      Math.hypot(
        (+lat - centroid.lat) * 111.32,
        (+lon - centroid.lon) * 111.32 * Math.cos((centroid.lat * Math.PI) / 180)
      )
    )
    .filter(Number.isFinite);
  return {
    type: "Uncertainty region",
    center: { latitude: +centroid.lat, longitude: +centroid.lon },
    radiusMeters: Math.max(250, (ds.length ? Math.max(...ds) : 1) * 1000),
    confidence: Math.round(+(c?.probability || 0) * 100),
    isCalculated: true,
    geometry: c?.geometry,
    backendSourceRegion: sr,
  };
}

/** ML/backend detection feature → the Slick payload /hindcast expects. */
export function slickFromDetection(f) {
  const p = f?.properties || f;
  const g = f?.geometry || p.geometry;
  if (!g) throw new Error("No slick geometry is available for hindcast.");
  return {
    id: p.id || "detected-slick",
    timestamp_utc: p.timestamp_utc || new Date().toISOString(),
    centroid: { lat: +p.centroid.lat, lon: +p.centroid.lon },
    geometry: g,
    area_km2: +(p.area_km2 || 0),
    confidence: +(p.confidence || 0),
    sensor: p.sensor || "SAR",
    scene_id: p.scene_id || null,
  };
}

/** incident.json incident → the Slick payload /hindcast expects. */
export function slickFromIncident(i) {
  return {
    id: i.id,
    timestamp_utc: i.detectedAt,
    centroid: { lat: +i.centroid.latitude, lon: +i.centroid.longitude },
    geometry: {
      type: "Polygon",
      coordinates: [(i.spillPolygon || []).map(([lat, lon]) => [lon, lat])],
    },
    area_km2: +(i.areaKm2 || 0),
    confidence: +(i.detectionConfidence || 0),
    sensor: i.satellite?.sensor || "SAR",
    scene_id: i.satellite?.imageId || null,
  };
}

const DISPLAY_WEIGHTS = {
  spatial: 0.25, temporal: 0.25, trajectory: 0.2, drift: 0.2, aisReliability: 0.1,
};

/** Backend vessels + attribution → the vessel objects Sayan's UI renders. */
export function normalizeVessels(vessels, attr) {
  const am = new Map((attr?.all_attributions || []).map((a) => [String(a.mmsi), a]));
  const cm = new Map((attr?.top_candidates || []).map((a) => [String(a.vessel_mmsi), a]));
  return (vessels || [])
    .map((v) => {
      const pts = (v.track_points || [])
        .map((p) => ({
          time: p.timestamp_utc,
          latitude: +p.position.lat,
          longitude: +p.position.lon,
          speedKnots: p.sog == null ? null : +p.sog,
          heading: p.heading == null ? (p.cog == null ? null : +p.cog) : +p.heading,
        }))
        .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
      const a = am.get(String(v.mmsi));
      const c = cm.get(String(v.mmsi));
      const overall = +(a?.overall_score ?? c?.overall_score ?? 0);
      const rank = +(a?.rank ?? c?.rank ?? 999);
      const b = a?.evidence_breakdown || {};
      const rel = +(c?.ais_reliability_score || 0);
      const sc = (x) => +(x ?? 0);
      const ev = {
        spatial: {
          score: sc(c?.spatial_score) || sc(b.spatial?.score) / 100,
          label: b.spatial?.explanation || "Spatial compatibility with source region.",
        },
        temporal: {
          score: sc(c?.temporal_score) || sc(b.temporal?.score) / 100,
          label: b.temporal?.explanation || "Temporal compatibility with release window.",
        },
        trajectory: {
          score: sc(c?.trajectory_score) || sc(b.trajectory?.score) / 100,
          label: b.trajectory?.explanation || "Trajectory compatibility with source region.",
        },
        drift: { score: 0, label: "Counterfactual simulation pending." },
        aisReliability: {
          score: rel,
          status: rel >= 0.7 ? "Good" : rel >= 0.4 ? "Warning" : "Critical",
          label: "AIS reliability from backend attribution.",
        },
      };
      return {
        id: String(v.mmsi),
        mmsi: String(v.mmsi),
        name: v.name || `MMSI ${v.mmsi}`,
        type: v.vessel_type || "Unknown",
        flag: "AIS",
        position: pts.length
          ? { latitude: pts.at(-1).latitude, longitude: pts.at(-1).longitude }
          : { latitude: 0, longitude: 0 },
        speedKnots: pts.at(-1)?.speedKnots ?? 0,
        heading: pts.at(-1)?.heading ?? 0,
        candidateRank: rank,
        attributionConfidence: Math.max(0, Math.min(1, overall / 100)),
        evidence: ev,
        trajectory: pts,
        backend: { raw: v, attribution: a, candidate: c },
      };
    })
    .sort(
      (x, y) =>
        x.candidateRank - y.candidateRank ||
        y.attributionConfidence - x.attributionConfidence
    );
}

/** Backend-derived vessel → the `scoring` object the evidence panels render. */
export function buildFrontendScoring(v) {
  const e = v.evidence || {};
  const arr = [
    ["spatial", "Spatial Proximity", e.spatial],
    ["temporal", "Temporal Window", e.temporal],
    ["trajectory", "Trajectory Compatibility", e.trajectory],
    ["drift", "Drift / Counterfactual", e.drift],
    ["aisReliability", "AIS Reliability", e.aisReliability],
  ];
  const items = arr.map(([key, title, x]) => {
    const value = Math.round(Math.max(0, Math.min(1, +(x?.score || 0))) * 100);
    const weight = DISPLAY_WEIGHTS[key] ?? 0.2;
    return {
      key,
      title,
      short: key === "aisReliability" ? "AIS" : key.toUpperCase(),
      icon: key === "spatial" ? "⌖" : key === "temporal" ? "◷" : key === "trajectory" ? "↗" : key === "drift" ? "≈" : "◉",
      value,
      weight,
      weightedValue: Math.round(value * weight),
      description: x?.label || "Backend evidence signal.",
      status: x?.status,
    };
  });
  const confidence = Math.round((v.attributionConfidence || 0) * 100);
  return {
    confidence,
    overallScore: confidence,
    assessment:
      confidence >= 70
        ? "High attribution support"
        : confidence >= 40
          ? "Moderate attribution support"
          : "Low attribution support",
    assessmentClass: confidence >= 70 ? "strong" : confidence >= 40 ? "moderate" : "weak",
    evidenceItems: items,
    strongSignals: items.filter((x) => x.value >= 80).length,
    moderateSignals: items.filter((x) => x.value >= 60 && x.value < 80).length,
    weakSignals: items.filter((x) => x.value < 60).length,
    warnings:
      confidence < 40
        ? ["No strong candidate was returned by the backend attribution engine."]
        : [],
    weights: { ...DISPLAY_WEIGHTS },
  };
}

export function shiftIsoHours(iso, hours) {
  return new Date(new Date(iso).getTime() + hours * 3600 * 1000).toISOString();
}
