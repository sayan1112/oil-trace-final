/**
 * OilTrace Backend API client + frontend-shape adapters.
 *
 * Live requests go through `src/services/api.js` (Axios + Render → Modal failover).
 * Optional override: VITE_BACKEND_PRIMARY_URL / VITE_BACKEND_FALLBACK_URL.
 *
 * All analytical outputs (source regions, rankings, trajectories, footprints,
 * counterfactual verdicts) come from these endpoints — never computed locally.
 */

import { apiClient, describeBackendError, getActiveBackendUrl } from "./api";

export { getActiveBackendUrl };
export const BACKEND_BASE = getActiveBackendUrl();

async function request(path, options = {}, timeoutMs = 120000) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  try {
    const response = await apiClient.request({
      url: `/api/v1${path}`,
      method,
      data: options.body,
      headers,
      timeout: timeoutMs,
    });
    return response.data;
  } catch (error) {
    throw new Error(describeBackendError(error), { cause: error });
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

export function runHindcast(slick, durationHours = 6) {
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

export function runAttribution(incidentId, sourceRegion, vessels, uncertaintyRadiusKm = 10) {
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
    timestamp_utc: p.timestamp_utc || null,
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

export const CANONICAL_INCIDENT_ID = "incident-mediterranean-001";

export const CANONICAL_AIS_BBOX = "33.5,34.5,36.0,36.5";
export const CANONICAL_AIS_START = "2024-08-25T00:00:00Z";
export const CANONICAL_AIS_END = "2024-08-26T18:00:00Z";

export function latLngRingFromGeometry(g) {
  const ring = rings(g)[0] || [];
  return ring
    .map(([lon, lat]) => [+lat, +lon])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
}

export function incidentFromDetection(feature, seed) {
  const slick = slickFromDetection(feature);
  return {
    ...seed,
    areaKm2: slick.area_km2 || seed.areaKm2,
    detectionConfidence: slick.confidence || seed.detectionConfidence,
    detectedAt: slick.timestamp_utc || seed.detectedAt,
    centroid: {
      latitude: slick.centroid.lat,
      longitude: slick.centroid.lon,
    },
    location: {
      latitude: slick.centroid.lat,
      longitude: slick.centroid.lon,
    },
    spillPolygon: latLngRingFromGeometry(slick.geometry).length
      ? latLngRingFromGeometry(slick.geometry)
      : seed.spillPolygon,
    satellite: {
      ...(seed.satellite || {}),
      imageId: slick.scene_id || seed.satellite?.imageId,
    },
    vessels: [],
  };
}

export function vesselsFromReplay(replay) {
  const frames = replay?.frames || [];
  const byMmsi = new Map();
  for (const frame of frames) {
    const time = frame.timestamp_utc;
    for (const vessel of frame.vessels || []) {
      const coords = vessel.position?.coordinates;
      const lon = Number(coords?.[0]);
      const lat = Number(coords?.[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const id = String(vessel.mmsi);
      if (!byMmsi.has(id)) {
        byMmsi.set(id, {
          id,
          mmsi: id,
          name: vessel.name || `MMSI ${id}`,
          type: vessel.vessel_type || "Unknown",
          flag: "AIS",
          position: { latitude: lat, longitude: lon },
          speedKnots: 0,
          heading: 0,
          candidateRank: 99,
          attributionConfidence: 0,
          evidence: {},
          trajectory: [],
        });
      }
      const row = byMmsi.get(id);
      row.trajectory.push({ time, latitude: lat, longitude: lon });
      row.position = { latitude: lat, longitude: lon };
    }
  }
  return [...byMmsi.values()];
}

export function vesselsNearCentroid(vessels, centroid, maxDeg = 4) {
  const lat0 = +centroid?.latitude || +centroid?.lat;
  const lon0 = +centroid?.longitude || +centroid?.lon;
  if (!Number.isFinite(lat0) || !Number.isFinite(lon0)) return vessels || [];
  return (vessels || []).filter((vessel) => {
    const lat = +vessel.position?.latitude;
    const lon = +vessel.position?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    return Math.abs(lat - lat0) <= maxDeg && Math.abs(lon - lon0) <= maxDeg;
  });
}

/* ── Forcing-data coverage guard ──────────────────────────────────── */
// Canonical SIH demo: Eastern Mediterranean CMEMS/ERA5 window.
export const FORCING_COVERAGE = {
  minLon: 33.5, maxLon: 36.0, minLat: 34.5, maxLat: 36.5,
  startUtc: "2024-08-25T00:00:00Z", endUtc: "2024-08-27T00:00:00Z",
};

export function assertWithinForcingCoverage(slick) {
  const { lat, lon } = slick?.centroid || {};
  const t = Date.parse(slick?.timestamp_utc);
  const c = FORCING_COVERAGE;
  const inSpace = lon >= c.minLon && lon <= c.maxLon && lat >= c.minLat && lat <= c.maxLat;
  const inTime = Number.isFinite(t) && t >= Date.parse(c.startUtc) && t <= Date.parse(c.endUtc);
  if (!inSpace || !inTime) {
    throw new Error(
      `This slick (${(+lat).toFixed(2)}°N, ${(+lon).toFixed(2)}°E, ${slick?.timestamp_utc}) is outside ` +
      `the Mediterranean forcing-data coverage (${c.minLon}–${c.maxLon}°E, ${c.minLat}–${c.maxLat}°N, ` +
      `25–26 Aug 2024 UTC). OpenDrift cannot run without currents/wind for that location and time.`
    );
  }
}

export function describeHindcastFailure(message) {
  const msg = String(message || "");
  if (/Missing variables|first timestep|x_sea_water_velocity|x_wind|y_wind/i.test(msg)) {
    return "Live OpenDrift on this host still has North Sea forcing, so a Cyprus hindcast cannot read currents or wind. The slick stays in the Eastern Mediterranean with reconstructed drift.";
  }
  if (/hdf|netcdf/i.test(msg)) {
    return "Forcing NetCDF on the live server is unreadable. Showing reconstructed drift on the Mediterranean scene.";
  }
  if (/Unknown incident/i.test(msg)) {
    return "This backend has not published incident-mediterranean-001 yet.";
  }
  return "Live OpenDrift is unavailable. Showing reconstructed drift on the Mediterranean scene.";
}

export function describeEmptyMediterraneanAis() {
  return "GET /vessels for 33.5–36°E / 34.5–36.5°N (25–26 Aug 2024) returned no ships. The deployed AIS sample is still Norway-only, so none are drawn here.";
}
