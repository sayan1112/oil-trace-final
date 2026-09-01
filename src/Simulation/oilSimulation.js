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
import { displaySpillPolygon } from "./slickShape.js";

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

function spillRing(incident) {
  const ring = displaySpillPolygon(incident);
  if (!Array.isArray(ring) || ring.length < 4) return null;
  return ring;
}

function ringBBox(ring) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  ring.forEach(([lat, lng]) => {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  });
  return { minLat, maxLat, minLng, maxLng };
}

function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0];
    const xi = ring[i][1];
    const yj = ring[j][0];
    const xj = ring[j][1];
    const crosses = yi > lat !== yj > lat;
    if (!crosses) continue;
    const xAtLat = ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (lng < xAtLat) inside = !inside;
  }
  return inside;
}

function sampleInRing(ring, bbox, prng, centerLat, centerLng, mode) {
  if (!ring) {
    const angle = prng() * Math.PI * 2;
    const radius = Math.sqrt(prng()) * 0.08;
    return {
      lat: centerLat + Math.sin(angle) * radius * 0.65,
      lng: centerLng + Math.cos(angle) * radius,
    };
  }

  const latSpan = Math.max(0.002, bbox.maxLat - bbox.minLat);
  const lngSpan = Math.max(0.002, bbox.maxLng - bbox.minLng);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    let lat;
    let lng;
    if (mode === "core") {
      const angle = prng() * Math.PI * 2;
      const radius = Math.sqrt(prng()) * 0.28;
      lat = centerLat + Math.sin(angle) * radius * latSpan * 0.45;
      lng = centerLng + Math.cos(angle) * radius * lngSpan * 0.45;
    } else if (mode === "edge") {
      lat = bbox.minLat + prng() * latSpan;
      lng = bbox.minLng + prng() * lngSpan;
    } else {
      const angle = prng() * Math.PI * 2;
      const radius = Math.sqrt(prng());
      lat = centerLat + Math.sin(angle) * radius * latSpan * 0.55;
      lng = centerLng + Math.cos(angle) * radius * lngSpan * 0.55;
    }
    if (pointInRing(lat, lng, ring)) return { lat, lng };
  }

  return { lat: centerLat, lng: centerLng };
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * METERS_PER_DEGREE_LAT;
  const dLng = (lng2 - lng1) * metersPerDegreeLng((lat1 + lat2) / 2);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function classifyParticle(distanceFromSource, elapsedMinutes, slickSpanKm) {
  const coreM = Math.max(2200, slickSpanKm * 220);
  const midM = Math.max(6000, slickSpanKm * 550);
  if (distanceFromSource <= coreM) return "stranded";
  if (distanceFromSource <= midM) return "active";
  if (elapsedMinutes <= 8) return "stranded";
  return "initial";
}

function advectStep(lat, lng, minute, currentField, windField, dtMinutes, sign) {
  const current = currentField.getVelocity(lat, lng, minute);
  const wind = windField.getVelocity(lat, lng, minute);
  return {
    lat: lat + sign * (current.dLatPerMin + wind.dLatPerMin) * dtMinutes,
    lng: lng + sign * (current.dLngPerMin + wind.dLngPerMin) * dtMinutes,
  };
}

export function generateOilSimulation({
  incident,
  currentField = defaultCurrentField,
  windField = defaultWindField,
  particleCount = 2600,
  startMinutes = 0,
  endMinutes = 360,
  stepMinutes = 6,
  seed = 26143,
} = {}) {
  const centerLat = Number(
    incident?.centroid?.latitude ?? incident?.location?.latitude ?? 35.63533,
  );
  const centerLng = Number(
    incident?.centroid?.longitude ?? incident?.location?.longitude ?? 34.8704,
  );
  const ring = spillRing(incident);
  const bbox = ring ? ringBBox(ring) : null;
  const slickSpanKm = bbox
    ? Math.max(
        (bbox.maxLat - bbox.minLat) * 111,
        (bbox.maxLng - bbox.minLng) * 85,
      )
    : 8;

  const prng = seededRandom(seed);
  const baseParticles = [];

  for (let i = 0; i < particleCount; i += 1) {
    const coreFraction = prng();
    const isCore = coreFraction < 0.22;
    const isEdge = !isCore && coreFraction > 0.78;
    const spawn = sampleInRing(
      ring,
      bbox,
      prng,
      centerLat,
      centerLng,
      isCore ? "core" : isEdge ? "edge" : "mid",
    );

    baseParticles.push({
      id: i,
      endLat: spawn.lat,
      endLng: spawn.lng,
      spreadMultiplier: isCore ? 0.18 + prng() * 0.16 : 0.55 + prng() * 0.7,
      radiusPixels: (isCore ? 1.8 : isEdge ? 1.15 : 1.4) + prng() * 0.7,
      turbulencePhase: prng() * Math.PI * 2,
      isCore,
      isEdge,
    });
  }

  const totalDurationMinutes = endMinutes - startMinutes;
  const dt = 2;

  const particleHistories = baseParticles.map((particle) => {
    // Observed slick samples are the *detection-time* positions. Reverse
    // the current+wind field so the Replay clock can start at the release
    // cluster and drift into the SAR footprint.
    let lat = particle.endLat;
    let lng = particle.endLng;
    for (let minute = totalDurationMinutes; minute > 0; minute -= dt) {
      const next = advectStep(
        lat,
        lng,
        startMinutes + minute,
        currentField,
        windField,
        dt,
        -1,
      );
      lat = next.lat;
      lng = next.lng;
    }

    const history = [[lng, lat]];
    for (let minute = dt; minute <= totalDurationMinutes; minute += dt) {
      const diffusion =
        0.000004 * Math.sqrt(minute) * particle.spreadMultiplier;
      const turbLat =
        Math.sin(minute * 0.11 + particle.turbulencePhase) * diffusion;
      const turbLng =
        Math.cos(minute * 0.14 + particle.turbulencePhase) * diffusion * 0.78;
      const next = advectStep(
        lat,
        lng,
        startMinutes + minute,
        currentField,
        windField,
        dt,
        1,
      );
      lat = next.lat + turbLat;
      lng = next.lng + turbLng;
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
  const flowLineOffsets = bbox
    ? [
        -(bbox.maxLng - bbox.minLng) * 0.08,
        -(bbox.maxLng - bbox.minLng) * 0.03,
        0,
        (bbox.maxLng - bbox.minLng) * 0.03,
        (bbox.maxLng - bbox.minLng) * 0.08,
      ]
    : [-0.0045, -0.002, 0, 0.002, 0.0045];

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
    const historyCap = particleHistories[0]?.length ? particleHistories[0].length - 1 : 0;
    const historyIndex = Math.min(Math.floor(elapsedMinutes / dt), historyCap);

    let sumLat = 0;
    let sumLng = 0;
    let sumWeight = 0;

    const frameParticles = [];
    const frameTrails = [];

    baseParticles.forEach((particle, index) => {
      const history = particleHistories[index];
      const position = history[historyIndex];
      const lng = position[0];
      const lat = position[1];

      const category = particle.isCore
        ? "stranded"
        : particle.isEdge
          ? "initial"
          : "active";

      const concentrationWeight =
        category === "stranded" ? 3.5 : category === "active" ? 1.4 : 0.55;

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

      if (index % 4 === 0 && historyIndex >= 2) {
        const start = Math.max(0, historyIndex - 16);
        const trailPath = history.slice(start, historyIndex + 1);
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

    const baseHour = 6;
    const baseMin = 0;
    const absoluteMinutes = baseHour * 60 + baseMin + elapsedMinutes;
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
