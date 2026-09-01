// OpenDrift-style particle cloud rendering.
//
// The backend returns the model's centroid trajectory, its timestamps, and the
// spatial envelopes (source region / predicted footprint). This module renders
// that output as an animated cloud of pseudo-particles — an ILLUSTRATIVE
// visualisation of the computed drift and its uncertainty envelope, not extra
// model data. The cloud is deterministic (seeded PRNG), anchored to the
// backend trajectory, and scaled to the backend envelopes, so it never shows
// anything the model did not compute.

const KM_PER_DEG_LAT = 111.32;

// Deterministic PRNG (mulberry32) so replays look identical.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Approximate gaussian from PRNG (Box–Muller).
function gauss(rnd) {
  const u = Math.max(rnd(), 1e-9), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Representative radius (km) of a polygon envelope around its centroid.
export function envelopeRadiusKm(geometry, fallbackKm = 1.5) {
  if (!geometry) return fallbackKm;
  const rings =
    geometry.type === "Polygon" ? [geometry.coordinates[0]] :
    geometry.type === "MultiPolygon" ? geometry.coordinates.map((p) => p[0]) : [];
  const pts = rings.flat();
  if (pts.length < 3) return fallbackKm;
  let cx = 0, cy = 0;
  for (const [lon, lat] of pts) { cx += lon; cy += lat; }
  cx /= pts.length; cy /= pts.length;
  const kmLon = KM_PER_DEG_LAT * Math.cos((cy * Math.PI) / 180);
  let sum = 0;
  for (const [lon, lat] of pts) {
    const dx = (lon - cx) * kmLon, dy = (lat - cy) * KM_PER_DEG_LAT;
    sum += Math.sqrt(dx * dx + dy * dy);
  }
  return Math.max(0.2, (sum / pts.length) * 0.9);
}

// Build a particle cloud bound to a backend trajectory.
//   points        [[lat, lon], ...]   (backend trajectory, any order)
//   timesUtc      ISO strings aligned 1:1 with points
//   startSpreadKm cloud radius at the earliest timestamp
//   endSpreadKm   cloud radius at the latest timestamp
export function buildCloud({ points, timesUtc, count, startSpreadKm, endSpreadKm, seed }) {
  if (!points?.length || !timesUtc?.length) return null;
  const n = Math.min(points.length, timesUtc.length);
  const samples = [];
  for (let i = 0; i < n; i++)
    samples.push({ t: new Date(timesUtc[i]).getTime(), lat: points[i][0], lon: points[i][1] });
  samples.sort((a, b) => a.t - b.t);

  const rnd = mulberry32(hashSeed(seed));
  const parts = new Float32Array(count * 4); // ang, radial, birthFrac, wobblePhase
  for (let i = 0; i < count; i++) {
    parts[i * 4] = rnd() * Math.PI * 2;
    parts[i * 4 + 1] = Math.min(1.8, Math.abs(gauss(rnd))) * 0.42;
    parts[i * 4 + 2] = Math.pow(rnd(), 0.72) * 0.62;
    parts[i * 4 + 3] = rnd() * Math.PI * 2;
  }
  return {
    samples,
    parts,
    count,
    startSpreadKm: Math.min(0.35, Number(startSpreadKm) || 0.2),
    endSpreadKm: Math.min(2.4, Number(endSpreadKm) || 1.4),
    t0: samples[0].t,
    t1: samples[samples.length - 1].t,
  };
}

// Centroid position at time t (piecewise-linear over backend timestamps).
function centroidAt(samples, t) {
  if (t <= samples[0].t) return samples[0];
  const last = samples[samples.length - 1];
  if (t >= last.t) return last;
  let i = 1;
  while (samples[i].t < t) i++;
  const a = samples[i - 1], b = samples[i];
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

// Particle [lat, lon] pairs at time t → flat Float64Array [lat0, lon0, ...].
export function cloudPositions(cloud, tMs, out) {
  const { samples, parts, count, startSpreadKm, endSpreadKm, t0, t1 } = cloud;
  const span = Math.max(1, t1 - t0);
  const res = out && out.length === count * 2 ? out : new Float64Array(count * 2);
  const now = Number.isFinite(tMs) ? tMs : t0;
  for (let i = 0; i < count; i++) {
    const ang = parts[i * 4];
    const rad = parts[i * 4 + 1];
    const birthFrac = parts[i * 4 + 2];
    const ph = parts[i * 4 + 3];
    const birthT = t0 + birthFrac * span;
    if (now < birthT) {
      res[i * 2] = Number.NaN;
      res[i * 2 + 1] = Number.NaN;
      continue;
    }
    // Spread particles along the OpenDrift centroid path from release
    // to the current clock, so the plume moves with the model.
    const alongT = t0 + birthFrac * Math.max(0, now - t0);
    const c = centroidAt(samples, alongT);
    const age = Math.max(0, Math.min(1, (now - birthT) / span));
    const spread = startSpreadKm + (endSpreadKm - startSpreadKm) * Math.sqrt(age);
    const wob = 1 + 0.12 * Math.sin(ph + age * 6.2);
    const rKm = rad * spread * wob;
    const kmLon = KM_PER_DEG_LAT * Math.cos((c.lat * Math.PI) / 180);
    res[i * 2] = c.lat + (Math.sin(ang) * rKm) / KM_PER_DEG_LAT;
    res[i * 2 + 1] = c.lon + (Math.cos(ang) * rKm) / kmLon;
  }
  return res;
}

export function overlayFrameFromCloud(cloud, tMs) {
  if (!cloud?.samples?.length) return { particles: [], trails: [], flowLines: [] };
  const now = Number.isFinite(tMs)
    ? Math.min(cloud.t1, Math.max(cloud.t0, tMs))
    : cloud.t0;
  const c = centroidAt(cloud.samples, now);
  const kmLon = KM_PER_DEG_LAT * Math.cos((c.lat * Math.PI) / 180);
  const particles = [];
  for (let i = 0; i < cloud.count; i += 1) {
    const ang = cloud.parts[i * 4];
    const rad = cloud.parts[i * 4 + 1];
    const rKm = rad * 0.55;
    particles.push({
      id: i,
      latitude: c.lat + (Math.sin(ang) * rKm) / KM_PER_DEG_LAT,
      longitude: c.lon + (Math.cos(ang) * rKm) / kmLon,
      position: [
        c.lon + (Math.cos(ang) * rKm) / kmLon,
        c.lat + (Math.sin(ang) * rKm) / KM_PER_DEG_LAT,
      ],
      radiusPixels: rad < 0.35 ? 1.7 : 1.2,
      category: rad < 0.35 ? "stranded" : rad < 0.7 ? "active" : "initial",
    });
  }
  const trailPath = cloud.samples
    .filter((sample) => sample.t <= now + 1000)
    .map((sample) => [sample.lon, sample.lat]);
  return {
    particles,
    trails: trailPath.length >= 2 ? [{ id: "opendrift-path", path: trailPath }] : [],
    flowLines: [],
  };
}
