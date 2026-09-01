// Display-only SAR footprint. Ranking, hindcast, and scores still come from the API.

function seededRandom(seed) {
  let s = Math.abs(Number(seed) || 67) % 2147483647;
  if (s <= 0) s += 2147483646;
  return function random() {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function isAxisAlignedBBox(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  const lats = new Set();
  const lngs = new Set();
  ring.forEach((point) => {
    const lat = Number(point?.[0]);
    const lng = Number(point?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    lats.add(lat.toFixed(5));
    lngs.add(lng.toFixed(5));
  });
  return lats.size <= 2 && lngs.size <= 2;
}

export function observedSlickRing({
  latitude,
  longitude,
  areaKm2 = 266.926,
  seed = 67,
} = {}) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

  const area = Math.max(40, Number(areaKm2) || 266.926);
  const aspect = 2.55;
  const minorKm = Math.sqrt(area / (Math.PI * aspect));
  const majorKm = minorKm * aspect;
  const heading = (62 * Math.PI) / 180;
  const prng = seededRandom(seed);
  const count = 56;
  const ring = [];

  for (let i = 0; i < count; i += 1) {
    const t = (i / count) * Math.PI * 2;
    const lobe =
      0.78 +
      0.16 * Math.sin(2 * t + 0.4) +
      0.09 * Math.sin(5 * t + prng() * 0.8) +
      0.05 * Math.sin(9 * t);
    const east0 = Math.cos(t) * majorKm * lobe;
    const north0 = Math.sin(t) * minorKm * lobe * (0.72 + 0.2 * Math.abs(Math.sin(t)));
    const east = east0 * Math.cos(heading) - north0 * Math.sin(heading);
    const north = east0 * Math.sin(heading) + north0 * Math.cos(heading);
    const dLat = north / 111.0;
    const dLng = east / (111.0 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
    ring.push([lat + dLat, lng + dLng]);
  }
  ring.push(ring[0]);
  return ring;
}

export function displaySpillPolygon(incident) {
  const raw = Array.isArray(incident?.spillPolygon) ? incident.spillPolygon : [];
  const ring = raw
    .map((point) => [Number(point?.[0]), Number(point?.[1])])
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));

  if (ring.length >= 6 && !isAxisAlignedBBox(ring)) return ring;

  return observedSlickRing({
    latitude: incident?.centroid?.latitude ?? incident?.location?.latitude,
    longitude: incident?.centroid?.longitude ?? incident?.location?.longitude,
    areaKm2: incident?.areaKm2,
    seed: 67,
  });
}
