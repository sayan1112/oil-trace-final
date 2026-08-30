// ============================================================
// OILTRACE — BACKWARD TRANSPORT & SOURCE ESTIMATION ENGINE
// ============================================================
//
// Performs backward Lagrangian advection-diffusion modeling
// from the detected oil spill polygon backward in time through
// historical ocean current and wind fields.
//
// Reconstructs:
//   - Backtracked particle transport paths (Leaflet/Deck visual)
//   - Inferred release window source region (center, radius, confidence)
//   - Scientific uncertainty estimation
// ============================================================

import { defaultCurrentField } from "./currentField.js";
import { defaultWindField } from "./windField.js";

/* Seeded PRNG for deterministic backtracking */
function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Execute backward transport simulation from detected spill polygon/centroid.
 */
export function backtrackOil({
  incident,
  centroid,
  spillPolygon,
  currentField = defaultCurrentField,
  windField = defaultWindField,
  backtrackMinutes = 45, // Backtrack 45 mins (e.g. 10:45 -> 10:00)
  stepMinutes = 2,
  particleCount = 600,
  seed = 42,
} = {}) {
  const targetCentroid = centroid || incident?.centroid || incident?.location || { latitude: 18.52, longitude: 72.912 };
  const lat = Number(targetCentroid.latitude);
  const lng = Number(targetCentroid.longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const prng = seededRandom(seed);
  const polygon = spillPolygon || incident?.spillPolygon || [];

  // 1. Seed initial particles distributed across the spill polygon / geometry
  const initialParticles = [];
  const spreadRadius = 0.002; // ~220m spread

  for (let i = 0; i < particleCount; i++) {
    let pLat = lat;
    let pLng = lng;

    if (polygon.length >= 3) {
      const minLat = Math.min(...polygon.map((pt) => pt[0]));
      const maxLat = Math.max(...polygon.map((pt) => pt[0]));
      const minLng = Math.min(...polygon.map((pt) => pt[1]));
      const maxLng = Math.max(...polygon.map((pt) => pt[1]));

      pLat = minLat + prng() * (maxLat - minLat);
      pLng = minLng + prng() * (maxLng - minLng);
    } else {
      const angle = prng() * Math.PI * 2;
      const r = Math.sqrt(prng()) * spreadRadius;
      pLat = lat + Math.sin(angle) * r;
      pLng = lng + Math.cos(angle) * r;
    }

    initialParticles.push({
      id: i,
      startLat: pLat,
      startLng: pLng,
      speedFactor: 0.88 + prng() * 0.24,
      lateralBias: (prng() - 0.5) * 0.0002,
      turbulencePhase: prng() * Math.PI * 2,
    });
  }

  // 2. Trace backward in time from t = 0 to t = backtrackMinutes
  const totalSteps = Math.floor(backtrackMinutes / stepMinutes);
  const particlePaths = initialParticles.map((p) => [{ latitude: p.startLat, longitude: p.startLng, timeMinutes: 0 }]);
  const backwardFrames = [];

  for (let step = 1; step <= totalSteps; step++) {
    const elapsedBackMinutes = step * stepMinutes;
    const currentFrameParticles = [];

    initialParticles.forEach((p, idx) => {
      const path = particlePaths[idx];
      const lastPoint = path[path.length - 1];

      let curLat = lastPoint.latitude;
      let curLng = lastPoint.longitude;

      for (let m = 0; m < stepMinutes; m++) {
        const t = -(elapsedBackMinutes - stepMinutes + m);
        const cur = currentField.getVelocity(curLat, curLng, t);
        const wnd = windField.getVelocity(curLat, curLng, t);

        const turbLat = (Math.sin(step * 0.4 + p.turbulencePhase) * 0.00007 + p.lateralBias) * p.speedFactor;
        const turbLng = Math.cos(step * 0.35 + p.turbulencePhase) * 0.00007 * p.speedFactor;

        curLat -= (cur.dLatPerMin + wnd.dLatPerMin) * p.speedFactor - turbLat;
        curLng -= (cur.dLngPerMin + wnd.dLngPerMin) * p.speedFactor - turbLng;
      }

      path.push({
        latitude: curLat,
        longitude: curLng,
        timeMinutes: elapsedBackMinutes,
      });

      currentFrameParticles.push({
        position: [curLng, curLat],
        latitude: curLat,
        longitude: curLng,
      });
    });

    backwardFrames.push({
      timeMinutes: elapsedBackMinutes,
      particles: currentFrameParticles,
    });
  }

  // Format Deck.gl PathLayer format for backward particle drift paths
  const backtrackPaths = particlePaths
    .filter((_, idx) => idx % 3 === 0)
    .map((path, idx) => ({
      id: idx,
      path: path.map((pt) => [pt.longitude, pt.latitude]),
    }));

  // 3. Cluster Analysis at Historical Release Window
  const historicalEndpoints = particlePaths.map((path) => path[path.length - 1]);
  let avgLat = 0;
  let avgLng = 0;

  historicalEndpoints.forEach((pt) => {
    avgLat += pt.latitude;
    avgLng += pt.longitude;
  });

  avgLat /= historicalEndpoints.length;
  avgLng /= historicalEndpoints.length;

  let sumSqDist = 0;
  historicalEndpoints.forEach((pt) => {
    const dLatMeters = (pt.latitude - avgLat) * 111000;
    const dLngMeters = (pt.longitude - avgLng) * 111000 * Math.cos((avgLat * Math.PI) / 180);
    sumSqDist += dLatMeters * dLatMeters + dLngMeters * dLngMeters;
  });

  const stdDevMeters = Math.sqrt(sumSqDist / historicalEndpoints.length);
  const uncertaintyRadiusMeters = Math.max(1200, Math.min(3500, Math.round(stdDevMeters * 1.8)));
  const confidence = Math.max(65, Math.min(95, Math.round(100 - (uncertaintyRadiusMeters / 3500) * 35)));

  const backtrackTrajectory = [];
  for (let s = 0; s <= totalSteps; s++) {
    let stepLat = 0;
    let stepLng = 0;
    particlePaths.forEach((path) => {
      stepLat += path[s].latitude;
      stepLng += path[s].longitude;
    });
    backtrackTrajectory.push({
      timeMinutes: s * stepMinutes,
      latitude: stepLat / particlePaths.length,
      longitude: stepLng / particlePaths.length,
    });
  }

  return {
    sourceEstimate: {
      latitude: Number(avgLat.toFixed(5)),
      longitude: Number(avgLng.toFixed(5)),
    },
    sourceRegion: {
      type: "Calculated backtrack region",
      center: {
        latitude: Number(avgLat.toFixed(5)),
        longitude: Number(avgLng.toFixed(5)),
      },
      radiusMeters: uncertaintyRadiusMeters,
      confidence,
      isCalculated: true,
    },
    uncertainty: {
      radiusKm: Number((uncertaintyRadiusMeters / 1000).toFixed(2)),
      radiusMeters: uncertaintyRadiusMeters,
      confidence,
      particleConvergence: confidence >= 80 ? "High convergence" : "Moderate convergence",
    },
    confidence,
    trajectory: backtrackTrajectory,
    particlePaths,
    backtrackPaths,
    backwardFrames,
    isSimulated: true,
    dataStatus: "SIMULATED BACKTRACK ENGINE",
  };
}

export function runBacktracking(options = {}) {
  const result = backtrackOil(options);
  if (!result || !result.backwardFrames) return [];
  return result.backwardFrames.map((frame) => ({
    timeMinutes: frame.timeMinutes,
    particles: frame.particles.map((p, idx) => ({
      id: idx,
      latitude: p.latitude,
      longitude: p.longitude,
    })),
  }));
}