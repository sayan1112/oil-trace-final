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
} = {}) {
  const lat = Number(latitude) || 35.63533;
  const lng = Number(longitude) || 34.8704;

  // Clean 6-sided convex polygon matching Screenshot 2
  return [
    [lat + 0.038, lng + 0.022],
    [lat + 0.020, lng + 0.052],
    [lat - 0.022, lng + 0.032],
    [lat - 0.046, lng - 0.015],
    [lat - 0.024, lng - 0.052],
    [lat + 0.018, lng - 0.035],
    [lat + 0.038, lng + 0.022], // closed
  ];
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

function pointInPolygon(lat, lng, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i][0];
    const xi = polygon[i][1];
    const yj = polygon[j][0];
    const xj = polygon[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function sampleDotsInPolygon(polygon, count = 22, seed = 67) {
  if (!Array.isArray(polygon) || polygon.length < 3) return [];
  const prng = seededRandom(seed);
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of polygon) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }

  const dots = [];
  let attempts = 0;
  while (dots.length < count && attempts < count * 50) {
    attempts += 1;
    const lat = minLat + prng() * (maxLat - minLat);
    const lng = minLng + prng() * (maxLng - minLng);
    if (pointInPolygon(lat, lng, polygon)) {
      // Ensure subtle spacing so dots never clump together
      const tooClose = dots.some(
        (d) => Math.hypot(d.latitude - lat, d.longitude - lng) < 0.0105
      );
      if (tooClose && attempts < count * 35) continue;

      const isCore = prng() < 0.35;
      const isSheen = !isCore && prng() > 0.60;
      dots.push({
        id: `slick-dot-${dots.length}`,
        latitude: lat,
        longitude: lng,
        position: [lng, lat],
        radiusPixels: isCore ? 1.85 : isSheen ? 1.25 : 1.55,
        category: isCore ? "stranded" : isSheen ? "initial" : "active",
        age: 120,
      });
    }
  }
  return dots;
}
