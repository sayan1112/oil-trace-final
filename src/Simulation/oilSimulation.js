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

export function interpolateReleaseTrack(track, t) {
  const pts = Array.isArray(track) ? track : [];
  if (!pts.length) return null;
  if (t <= pts[0].t) return { lat: pts[0].lat, lng: pts[0].lng };
  const last = pts[pts.length - 1];
  if (t >= last.t) return { lat: last.lat, lng: last.lng };
  let i = 1;
  while (i < pts.length && pts[i].t < t) i += 1;
  const a = pts[i - 1];
  const b = pts[i] || a;
  const span = Math.max(1e-6, b.t - a.t);
  const f = (t - a.t) / span;
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lng: a.lng + (b.lng - a.lng) * f,
  };
}

export function defaultReleaseTrack(incident, currentField, windField, durationMinutes) {
  const centerLat = Number(
    incident?.centroid?.latitude ?? incident?.location?.latitude ?? 35.63533,
  );
  const centerLng = Number(
    incident?.centroid?.longitude ?? incident?.location?.longitude ?? 34.8704,
  );
  let lat = centerLat;
  let lng = centerLng;
  for (let minute = durationMinutes; minute > 0; minute -= 2) {
    const next = advectStep(lat, lng, minute, currentField, windField, 2, -1);
    lat = next.lat;
    lng = next.lng;
  }
  return [
    { t: 0, lat, lng },
    {
      t: durationMinutes * 0.58,
      lat: lat + (centerLat - lat) * 0.62,
      lng: lng + (centerLng - lng) * 0.62,
    },
    { t: durationMinutes, lat: centerLat, lng: centerLng },
  ];
}

export function trackFromVesselTrajectory(vessel, t0Ms, t1Ms) {
  const duration = Math.max(1, (t1Ms - t0Ms) / 60000);
  const pts = (vessel?.trajectory || [])
    .map((point) => ({
      t: (Date.parse(point.time) - t0Ms) / 60000,
      lat: Number(point.latitude),
      lng: Number(point.longitude),
    }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.lat) && Number.isFinite(point.lng))
    .sort((a, b) => a.t - b.t);
  if (pts.length >= 2) return pts;
  const lat = Number(vessel?.position?.latitude);
  const lng = Number(vessel?.position?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [
    { t: 0, lat, lng },
    { t: duration, lat, lng },
  ];
}

export function buildObservedSlickFrame({
  incident,
  particleCount = 2400,
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
  const prng = seededRandom(seed);
  const particles = [];
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
    particles.push({
      id: i,
      latitude: spawn.lat,
      longitude: spawn.lng,
      position: [spawn.lng, spawn.lat],
      radiusPixels: (isCore ? 1.8 : isEdge ? 1.15 : 1.4) + prng() * 0.7,
      category: isCore ? "stranded" : isEdge ? "initial" : "active",
    });
  }
  return { particles, trails: [], flowLines: [] };
}

export function generateOilSimulation({
  incident,
  currentField = defaultCurrentField,
  windField = defaultWindField,
  particleCount = 2200,
  startMinutes = 0,
  endMinutes = 360,
  stepMinutes = 6,
  seed = 26143,
  releaseTrack = null,
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
  const totalDurationMinutes = endMinutes - startMinutes;
  const dt = 2;
  const track =
    Array.isArray(releaseTrack) && releaseTrack.length >= 2
      ? releaseTrack
      : defaultReleaseTrack(incident, currentField, windField, totalDurationMinutes);

  const baseParticles = [];
  const emitEvery = 3;
  let nextId = 0;
  for (let birth = 0; birth <= totalDurationMinutes - 8 && nextId < particleCount; birth += emitEvery) {
    const origin = interpolateReleaseTrack(track, birth);
    if (!origin) break;
    const early = birth < totalDurationMinutes * 0.38;
    const burst = early ? 22 : 10;
    for (let k = 0; k < burst && nextId < particleCount; k += 1) {
      const coreFraction = prng();
      const isCore = coreFraction < 0.2;
      const isEdge = !isCore && coreFraction > 0.82;
      const jitter = (isCore ? 0.0012 : 0.0036) * (0.35 + prng());
      const angle = prng() * Math.PI * 2;
      baseParticles.push({
        id: nextId,
        birth,
        initLat: origin.lat + Math.sin(angle) * jitter * 0.65,
        initLng: origin.lng + Math.cos(angle) * jitter,
        spreadMultiplier: isCore ? 0.22 + prng() * 0.2 : 0.7 + prng() * 0.85,
        radiusPixels: (isCore ? 1.85 : isEdge ? 1.1 : 1.35) + prng() * 0.65,
        turbulencePhase: prng() * Math.PI * 2,
        isCore,
        isEdge,
      });
      nextId += 1;
    }
  }

  const slotCount = Math.floor(totalDurationMinutes / dt) + 1;
  const particleHistories = baseParticles.map((particle) => {
    const history = new Array(slotCount).fill(null);
    const birthIndex = Math.min(slotCount - 1, Math.floor(particle.birth / dt));
    let lat = particle.initLat;
    let lng = particle.initLng;
    history[birthIndex] = [lng, lat];
    for (let i = birthIndex + 1; i < slotCount; i += 1) {
      const minute = i * dt;
      const age = Math.max(0, minute - particle.birth);
      const diffusion = 0.000007 * Math.sqrt(age) * particle.spreadMultiplier;
      const turbLat = Math.sin(minute * 0.11 + particle.turbulencePhase) * diffusion;
      const turbLng = Math.cos(minute * 0.14 + particle.turbulencePhase) * diffusion * 0.78;
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
      history[i] = [lng, lat];
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
    const origin = interpolateReleaseTrack(track, 0) || {
      lat: centerLat,
      lng: centerLng,
    };
    const paths = flowLineOffsets.map((offset, lineIndex) => {
      const path = [[origin.lat, origin.lng]];
      let lat = origin.lat;
      let lng = origin.lng;

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
      if (elapsedMinutes + 0.01 < particle.birth) return;
      const history = particleHistories[index];
      const position = history[historyIndex];
      if (!position) return;
      const lng = position[0];
      const lat = position[1];
      const age = Math.max(0, elapsedMinutes - particle.birth);
      const category =
        age < 18 ? "stranded" : age < 80 ? "active" : "initial";

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
        const trailPath = history
          .slice(start, historyIndex + 1)
          .filter(Boolean);
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
