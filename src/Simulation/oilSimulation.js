// ============================================================
// OILTRACE — OPENDRIFT LAGRANGIAN OIL DISPERSION MODEL
// ============================================================
// Simulates an OpenDrift-style Lagrangian particle plume strictly
// attached to the stern wake of the culprit vessel identified by
// the backend attribution engine.
//
// Key physical mechanics:
//   1. Origin: Attaches strictly to culprit vessel stern wake.
//   2. Advection: 2D surface drift = current + 0.03 * wind.
//   3. Dispersion: Deterministic physical eddy diffusion expanding
//      laterally down-drift into a semi-translucent plume.
//   4. Layered styling: High-density dark petroleum core at stern
//      fading out to marine petroleum slate and sky cyan sheen.
// ============================================================

import { defaultCurrentField } from "./currentField.js";
import { defaultWindField } from "./windField.js";

const METERS_PER_DEGREE_LAT = 111000;

function metersPerDegreeLng(latitude) {
  return Math.cos((latitude * Math.PI) / 180) * METERS_PER_DEGREE_LAT;
}

// Deterministic Pseudo-Random Generator (LCG) - ZERO Math.random()
function createPrng(seed = 26143) {
  let s = Math.abs(Number(seed) || 26143) % 2147483647;
  if (s <= 0) s += 2147483646;
  return function next() {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function interpolateReleaseTrack(track, t) {
  const pts = Array.isArray(track) ? track : [];
  if (!pts.length) return null;
  if (t <= pts[0].t) return { lat: pts[0].lat, lng: pts[0].lng, heading: pts[0].heading ?? 0 };
  const last = pts[pts.length - 1];
  if (t >= last.t) return { lat: last.lat, lng: last.lng, heading: last.heading ?? 0 };
  let i = 1;
  while (i < pts.length && pts[i].t < t) i += 1;
  const a = pts[i - 1];
  const b = pts[i] || a;
  const span = Math.max(1e-6, b.t - a.t);
  const f = (t - a.t) / span;
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lng: a.lng + (b.lng - a.lng) * f,
    heading: a.heading != null ? a.heading : 0,
  };
}

/**
 * Builds the culprit vessel transit track through the release window.
 * Default canonical culprit: MT CYPRUS SUN (MMSI 211000001).
 */
export function defaultReleaseTrack(incident, currentField, windField, durationMinutes = 360) {
  // Exact MT CYPRUS SUN (MMSI 211000001) transit from backend repo (ais_sample.py):
  // South → North along longitude 34.870°E at 12.5 knots:
  // 06:00 UTC: lat 35.420, lon 34.870
  // 09:15 UTC: lat 35.635, lon 34.870 (crosses through source polygon)
  // 12:00 UTC: lat 35.780, lon 34.870
  const lat0 = 35.420;
  const lat1 = 35.780;
  const lon0 = 34.870;
  const pts = [];
  const steps = 36;
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * durationMinutes;
    const f = i / steps;
    pts.push({
      t,
      lat: lat0 + f * (lat1 - lat0),
      lng: lon0,
      heading: 0, // Northbound
    });
  }
  return pts;
}

export function trackFromVesselTrajectory(vessel, t0Ms, t1Ms) {
  const duration = Math.max(1, (t1Ms - t0Ms) / 60000);
  const raw = Array.isArray(vessel?.trajectory) ? vessel.trajectory : [];
  const pts = raw
    .map((point) => {
      const pTime = Date.parse(point.time);
      return {
        t: Number.isFinite(pTime) ? (pTime - t0Ms) / 60000 : 0,
        lat: Number(point.latitude),
        lng: Number(point.longitude),
        heading: Number(point.heading ?? 0),
      };
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.t >= 0 && p.t <= duration)
    .sort((a, b) => a.t - b.t);

  if (pts.length >= 2) return pts;

  const vLat = Number(vessel?.position?.latitude);
  const vLng = Number(vessel?.position?.longitude);
  if (Number.isFinite(vLat) && Number.isFinite(vLng)) {
    return [
      { t: 0, lat: vLat - 0.10, lng: vLng, heading: 0 },
      { t: duration, lat: vLat + 0.10, lng: vLng, heading: 0 },
    ];
  }
  return null;
}

/**
 * Generate OpenDrift Lagrangian particle dispersion simulation.
 */
export function generateOilSimulation({
  culpritVessel = null,
  incident = null,
  currentField = defaultCurrentField,
  windField = defaultWindField,
  particleCount = 420,
  startMinutes = 0,
  endMinutes = 360,
  stepMinutes = 4,
  seed = 26143,
  releaseTrack = null,
} = {}) {
  const prng = createPrng(seed);
  const totalDurationMinutes = Math.max(1, endMinutes - startMinutes);
  const dt = 2; // 2-minute physical integration step

  // Build track strictly attached to culprit vessel MT CYPRUS SUN (MMSI 211000001)
  const isCyprusSun = !culpritVessel || String(culpritVessel.mmsi) === "211000001" || culpritVessel.is_culprit;
  let track = Array.isArray(releaseTrack) && releaseTrack.length >= 2 ? releaseTrack : null;
  if (!track && isCyprusSun && culpritVessel?.trajectory?.length >= 2) {
    const detected = Date.parse(incident?.detectedAt);
    const t1 = Number.isFinite(detected) ? detected : Date.UTC(2024, 7, 26, 12);
    const t0 = t1 - totalDurationMinutes * 60 * 1000;
    const candidateTrack = trackFromVesselTrajectory(culpritVessel, t0, t1);
    if (candidateTrack && candidateTrack.length >= 2) track = candidateTrack;
  }
  if (!track || track.length < 2) {
    track = defaultReleaseTrack(incident, currentField, windField, totalDurationMinutes);
  }

  // Pre-generate deterministic particle descriptors released at culprit stern wake
  // Release occurs as vessel transits through the probable source zone (08:15 UTC to 10:45 UTC)
  const baseParticles = [];
  const releaseStartFraction = 0.38; // Enters source region around 08:15 UTC
  const releaseEndFraction = 0.78;   // Leaves source region around 10:45 UTC
  const releaseSpan = releaseEndFraction - releaseStartFraction;

  for (let i = 0; i < particleCount; i += 1) {
    const fraction = i / Math.max(1, particleCount - 1);
    const birthFraction = releaseStartFraction + fraction * releaseSpan;
    const birth = birthFraction * totalDurationMinutes;
    const origin = interpolateReleaseTrack(track, birth) || track[0];

    // Stern wake geometry: offset behind vessel heading
    const rad = ((origin.heading || 0) * Math.PI) / 180;
    const sternDistanceM = 30 + prng() * 60; // 30-90m behind stern
    const sternLatOffset = (-Math.cos(rad) * sternDistanceM) / METERS_PER_DEGREE_LAT;
    const sternLngOffset = (-Math.sin(rad) * sternDistanceM) / metersPerDegreeLng(origin.lat);

    // Initial wake turbulence
    const wakeSpreadM = 15 + prng() * 45;
    const lateralAngle = rad + Math.PI / 2 + (prng() - 0.5) * 0.5;
    const wakeLatJitter = (Math.cos(lateralAngle) * (prng() - 0.5) * wakeSpreadM) / METERS_PER_DEGREE_LAT;
    const wakeLngJitter = (Math.sin(lateralAngle) * (prng() - 0.5) * wakeSpreadM) / metersPerDegreeLng(origin.lat);

    const isCore = prng() < 0.28;
    const isSheen = !isCore && prng() > 0.65;

    baseParticles.push({
      id: i,
      birth,
      initLat: origin.lat + sternLatOffset + wakeLatJitter,
      initLng: origin.lng + sternLngOffset + wakeLngJitter,
      spreadFactor: isCore ? 0.35 + prng() * 0.25 : isSheen ? 1.0 + prng() * 0.6 : 0.65 + prng() * 0.35,
      radiusPixels: isCore ? 2.5 + prng() * 0.6 : isSheen ? 1.3 + prng() * 0.4 : 1.8 + prng() * 0.5,
      eddyPhase1: prng() * Math.PI * 2,
      eddyPhase2: prng() * Math.PI * 2,
      isCore,
      isSheen,
    });
  }

  // Precompute Lagrangian advection trajectory histories using backend metocean fields
  const slotCount = Math.floor(totalDurationMinutes / dt) + 1;
  const particleHistories = baseParticles.map((p) => {
    const history = new Array(slotCount).fill(null);
    const birthSlot = Math.min(slotCount - 1, Math.floor(p.birth / dt));
    let lat = p.initLat;
    let lng = p.initLng;
    history[birthSlot] = [lng, lat];

    for (let slot = birthSlot + 1; slot < slotCount; slot += 1) {
      const minute = slot * dt;
      const ageMinutes = minute - p.birth;

      // Advection step with backend ocean current + wind forcing
      const current = currentField.getVelocity(lat, lng, startMinutes + minute);
      const wind = windField.getVelocity(lat, lng, startMinutes + minute);
      const advLat = (current.dLatPerMin + wind.dLatPerMin) * dt;
      const advLng = (current.dLngPerMin + wind.dLngPerMin) * dt;

      // OpenDrift lateral eddy diffusion: spread grows as sqrt(age)
      const diffScale = 0.000028 * Math.sqrt(Math.max(1, ageMinutes)) * p.spreadFactor;
      const turbLat = Math.sin(p.eddyPhase1 + ageMinutes * 0.05) * diffScale;
      const turbLng = Math.cos(p.eddyPhase2 + ageMinutes * 0.06) * diffScale * 1.25;

      lat = lat + advLat + turbLat;
      lng = lng + advLng + turbLng;
      history[slot] = [lng, lat];
    }
    return history;
  });

  // Assemble time-step frames
  const frames = [];
  const totalSteps = Math.floor(totalDurationMinutes / stepMinutes);

  for (let step = 0; step <= totalSteps; step += 1) {
    const elapsedMinutes = step * stepMinutes;
    const slotIndex = Math.min(
      slotCount - 1,
      Math.floor(elapsedMinutes / dt)
    );

    const frameParticles = [];
    const frameTrails = [];
    let sumLat = 0;
    let sumLng = 0;
    let count = 0;

    baseParticles.forEach((p, idx) => {
      if (elapsedMinutes < p.birth) return;
      const pos = particleHistories[idx][slotIndex];
      if (!pos) return;

      const lng = pos[0];
      const lat = pos[1];
      const age = elapsedMinutes - p.birth;

      // Layered dark categorization — all particles render as dark petroleum dots
      const category = age < 24 ? "stranded" : age < 110 ? "active" : "active";

      sumLat += lat;
      sumLng += lng;
      count += 1;

      frameParticles.push({
        id: p.id,
        latitude: lat,
        longitude: lng,
        position: [lng, lat],
        radiusPixels: p.radiusPixels,
        category,
        age,
      });

      // Streamline trail every 5th particle
      if (idx % 5 === 0 && slotIndex >= 3) {
        const trailStart = Math.max(0, slotIndex - 12);
        const trailPts = particleHistories[idx].slice(trailStart, slotIndex + 1).filter(Boolean);
        if (trailPts.length >= 2) {
          frameTrails.push({ id: p.id, path: trailPts });
        }
      }
    });

    const center = count ? [sumLat / count, sumLng / count] : [35.635, 34.870];
    const totalAbsM = 6 * 60 + elapsedMinutes;
    const hh = String(Math.floor((totalAbsM / 60) % 24)).padStart(2, "0");
    const mm = String(Math.floor(totalAbsM % 60)).padStart(2, "0");

    frames.push({
      timeMinutes: elapsedMinutes,
      timeLabel: `${hh}:${mm} UTC`,
      particles: frameParticles,
      trails: frameTrails,
      centerOfMass: center,
    });
  }

  return {
    frames,
    totalDurationMinutes,
    getFrameByProgress(ratio) {
      if (!frames.length) return null;
      const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
      const idx = Math.min(frames.length - 1, Math.floor(clamped * (frames.length - 1)));
      return frames[idx];
    },
  };
}

/**
 * Generates the fully dispersed OpenDrift plume at observation time.
 */
export function buildObservedSlickFrame({ incident, culpritVessel = null } = {}) {
  const sim = generateOilSimulation({
    culpritVessel,
    incident,
    particleCount: 420,
    startMinutes: 0,
    endMinutes: 360,
  });
  const lastFrame = sim.getFrameByProgress(1.0);
  return lastFrame || { particles: [], trails: [] };
}
