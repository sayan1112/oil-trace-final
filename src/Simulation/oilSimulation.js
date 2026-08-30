// ============================================================
// OILTRACE — DETERMINISTIC LAGRANGIAN OIL-SPILL SIMULATION
// ============================================================
// Visual model for the frontend demo:
//   RED   = highest-concentration / source-core oil
//   BLUE  = actively drifting oil
//   GREEN = dispersed / leading-edge oil
//
// The particle field, particle trails and oil-flow lines all come
// from the SAME deterministic simulation clock. This prevents the
// lines from visually separating from the oil plume.
// ============================================================

import { defaultCurrentField } from "./currentField.js";
import { defaultWindField } from "./windField.js";

function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function random() {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const METERS_PER_DEGREE_LAT = 111000;

function metersPerDegreeLng(latitude) {
  return Math.cos((latitude * Math.PI) / 180) * METERS_PER_DEGREE_LAT;
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * METERS_PER_DEGREE_LAT;
  const dLng = (lng2 - lng1) * metersPerDegreeLng((lat1 + lat2) / 2);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function classifyParticle(distanceFromSource, elapsedMinutes) {
  // Keep a small green release signature at the first few frames,
  // then let concentration determine the color of the plume.
  if (elapsedMinutes <= 8 && distanceFromSource < 700) return "initial";
  if (distanceFromSource <= 900) return "stranded"; // red core / highest concentration
  if (distanceFromSource <= 2800) return "active"; // blue active plume
  return "initial"; // green dispersed / leading edge
}

export function generateOilSimulation({
  incident,
  currentField = defaultCurrentField,
  windField = defaultWindField,
  particleCount = 2200,
  startMinutes = -45,
  endMinutes = 30,
  stepMinutes = 2,
  seed = 26143,
} = {}) {
  const centerLat = Number(
    incident?.centroid?.latitude ?? incident?.location?.latitude ?? 18.52,
  );
  const centerLng = Number(
    incident?.centroid?.longitude ?? incident?.location?.longitude ?? 72.912,
  );

  const prng = seededRandom(seed);
  const baseParticles = [];

  for (let i = 0; i < particleCount; i += 1) {
    const angle = prng() * Math.PI * 2;
    const radius = Math.sqrt(prng()) * 0.0028;

    const coreFraction = prng();
    const isCore = coreFraction < 0.30;

    baseParticles.push({
      id: i,
      initLat: centerLat + Math.sin(angle) * radius,
      initLng: centerLng + Math.cos(angle) * radius,
      // Core particles move much more slowly, maintaining the dense
      // red source pool while the remaining particles advect away.
      speedMultiplier: isCore
        ? 0.08 + prng() * 0.24
        : 0.72 + prng() * 0.46,
      spreadMultiplier: 0.65 + prng() * 0.8,
      radiusPixels: 2.0 + prng() * 1.8,
      turbulencePhase: prng() * Math.PI * 2,
      isCore,
    });
  }

  const totalDurationMinutes = endMinutes - startMinutes;

  const particleHistories = baseParticles.map((particle) => {
    const history = [[particle.initLng, particle.initLat]];
    let lat = particle.initLat;
    let lng = particle.initLng;

    for (let minute = 1; minute <= totalDurationMinutes; minute += 1) {
      if (particle.isCore) {
        // Small stochastic movement keeps the red source area alive
        // without pulling the concentration core away from the release.
        lat += Math.sin(minute * 0.16 + particle.turbulencePhase) * 0.000035;
        lng += Math.cos(minute * 0.14 + particle.turbulencePhase) * 0.000035;
      } else {
        const absoluteMinute = startMinutes + minute;
        const current = currentField.getVelocity(lat, lng, absoluteMinute);
        const wind = windField.getVelocity(lat, lng, absoluteMinute);

        // Diffusion grows with time so the plume visibly widens as it travels.
        const diffusion =
          0.000075 * Math.sqrt(minute) * particle.spreadMultiplier;
        const turbLat =
          Math.sin(minute * 0.19 + particle.turbulencePhase) * diffusion;
        const turbLng =
          Math.cos(minute * 0.23 + particle.turbulencePhase) * diffusion * 0.72;

        lat +=
          (current.dLatPerMin + wind.dLatPerMin) *
            particle.speedMultiplier +
          turbLat;
        lng +=
          (current.dLngPerMin + wind.dLngPerMin) *
            particle.speedMultiplier +
          turbLng;
      }

      history.push([lng, lat]);
    }

    return history;
  });

  /* ----------------------------------------------------------
     FLOW-LINE MODEL

     These are not vessel tracks. They are modeled oil transport
     streamlines generated from the same current + wind field used
     by the particles. Every line starts INSIDE the dense source
     area and then follows the particle plume.
  ---------------------------------------------------------- */
  const flowLineOffsets = [-0.0045, -0.002, 0, 0.002, 0.0045];

  function buildFlowLines(elapsedMinutes) {
    const paths = flowLineOffsets.map((offset, lineIndex) => {
      const path = [[centerLat, centerLng]];
      let lat = centerLat;
      let lng = centerLng;

      const total = Math.max(0, Math.floor(elapsedMinutes));
      for (let minute = 1; minute <= total; minute += 1) {
        const current = currentField.getVelocity(
          lat,
          lng,
          startMinutes + minute,
        );
        const wind = windField.getVelocity(
          lat,
          lng,
          startMinutes + minute,
        );

        lat += (current.dLatPerMin + wind.dLatPerMin) * 0.98;
        lng += (current.dLngPerMin + wind.dLngPerMin) * 0.98;

        // Curvature makes the streamlines follow the plume instead of
        // looking like unrelated straight vessel paths.
        const curve =
          Math.sin((minute / 24) * Math.PI + lineIndex * 0.7) *
          0.000035;
        lat += curve;

        if (minute <= 4) {
          const ramp = minute / 4;
          lat += offset * 0.20 * ramp;
          lng += offset * 0.05 * ramp;
        } else {
          lat += offset * 0.008;
          lng += offset * 0.002;
        }

        path.push([lat, lng]);
      }

      return {
        id: `oil-flow-${lineIndex}`,
        path,
      };
    });

    return paths.filter((line) => line.path.length >= 2);
  }

  const frames = [];
  const trajectoryPoints = [];
  const totalSteps = Math.floor(totalDurationMinutes / stepMinutes);

  for (let step = 0; step <= totalSteps; step += 1) {
    const timeMinutes = startMinutes + step * stepMinutes;
    const elapsedMinutes = Math.max(0, timeMinutes - startMinutes);
    const minuteIndex = Math.min(elapsedMinutes, totalDurationMinutes);

    let sumLat = 0;
    let sumLng = 0;
    let sumWeight = 0;

    const frameParticles = [];
    const frameTrails = [];

    baseParticles.forEach((particle, index) => {
      const history = particleHistories[index];
      const position = history[minuteIndex];
      const lng = position[0];
      const lat = position[1];

      const distanceFromSource = distanceMeters(
        centerLat,
        centerLng,
        lat,
        lng,
      );

      const category = classifyParticle(
        distanceFromSource,
        elapsedMinutes,
      );

      // Weight the centreline toward actual high-concentration parcels.
      const concentrationWeight =
        category === "stranded"
          ? 3.5
          : category === "active"
            ? 1.4
            : 0.55;

      sumLat += lat * concentrationWeight;
      sumLng += lng * concentrationWeight;
      sumWeight += concentrationWeight;

      frameParticles.push({
        id: particle.id,
        latitude: lat,
        longitude: lng,
        position: [lng, lat],
        radiusPixels: particle.radiusPixels,
        category,
      });

      // Draw enough historical trails to make the transport direction
      // obvious, but not so many that the map becomes a solid mass.
      if (index % 5 === 0 && minuteIndex >= 2) {
        const start = Math.max(0, minuteIndex - 18);
        const trailPath = history.slice(start, minuteIndex + 1);
        if (trailPath.length >= 2) {
          frameTrails.push({
            id: particle.id,
            path: trailPath,
          });
        }
      }
    });

    const centerlineLat = sumWeight ? sumLat / sumWeight : centerLat;
    const centerlineLng = sumWeight ? sumLng / sumWeight : centerLng;

    const baseHour = 10;
    const baseMin = 45;
    const absoluteMinutes = baseHour * 60 + baseMin + timeMinutes;
    const hh = String(Math.floor((absoluteMinutes / 60) % 24)).padStart(2, "0");
    const mm = String(Math.floor(absoluteMinutes % 60)).padStart(2, "0");
    const timeLabel = `${hh}:${mm}`;

    const flowLines = buildFlowLines(elapsedMinutes);

    trajectoryPoints.push({
      timeMinutes,
      timeLabel,
      latitude: centerlineLat,
      longitude: centerlineLng,
    });

    frames.push({
      timeMinutes,
      timeLabel,
      particles: frameParticles,
      trails: frameTrails,
      flowLines,
      centerOfMass: [centerlineLat, centerlineLng],
    });
  }

  return {
    frames,
    trajectoryPoints,
    startMinutes,
    endMinutes,
    stepMinutes,
    isSimulated: true,
    dataStatus: "SIMULATED LAGRANGIAN PARTICLE DRIFT MODEL",
    getFrameByProgress(progressRatio) {
      if (!frames.length) return null;
      const clamped = Math.max(0, Math.min(1, Number(progressRatio) || 0));
      const index = Math.min(
        frames.length - 1,
        Math.floor(clamped * (frames.length - 1)),
      );
      return frames[index];
    },
  };
}
