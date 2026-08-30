// ============================================================
// OILTRACE — DETERMINISTIC OCEAN CURRENT FIELD MODEL
// ============================================================
//
// Represents a spatial-temporal ocean current field for Lagrangian drift.
// Configured with strong coastal shear and curved streamlines to match
// scientific OpenDrift / OpenOil particle transport visualizations.
// ============================================================

const METERS_PER_DEGREE_LAT = 111000;

function getMetersPerDegreeLng(latitude) {
  const rad = (latitude * Math.PI) / 180;
  return Math.cos(rad) * METERS_PER_DEGREE_LAT;
}

export class OceanCurrentField {
  constructor(options = {}) {
    // Base current vector: Westward-Northwestward drift (~1.8 m/s, ~3.5 knots)
    this.baseU = options.baseU ?? -1.45;
    this.baseV = options.baseV ?? 0.85;
    this.shearScale = options.shearScale ?? 0.25;
    this.wavePeriodMinutes = options.wavePeriodMinutes ?? 120;
    this.description = options.description ?? "SIMULATED OCEAN CURRENT (NORTHWEST COASTAL DRIFT)";
  }

  getVelocity(latitude, longitude, timeMinutes = 0) {
    const lat = Number(latitude) || 18.52;
    const lng = Number(longitude) || 72.912;
    const t = Number(timeMinutes) || 0;

    const dLat = lat - 18.52;
    const dLng = lng - 72.912;

    // Curved current streamlines creating a sweeping arc across the ocean
    const uSpatial = Math.sin(dLat * 40 + dLng * 20) * 0.45;
    const vSpatial = Math.cos(dLng * 45 - dLat * 15) * 0.35;

    const timePhase = (t / this.wavePeriodMinutes) * Math.PI * 2;
    const uTime = Math.sin(timePhase) * 0.15;
    const vTime = Math.cos(timePhase) * 0.12;

    const u = this.baseU + uSpatial + uTime;
    const v = this.baseV + vSpatial + vTime;

    const speed = Math.sqrt(u * u + v * v);
    const direction = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;

    const metersPerDegreeLng = getMetersPerDegreeLng(lat);
    const dLngPerMin = (u * 60) / metersPerDegreeLng;
    const dLatPerMin = (v * 60) / METERS_PER_DEGREE_LAT;

    return {
      u,
      v,
      speed,
      direction,
      dLatPerMin,
      dLngPerMin,
      isSimulated: true,
    };
  }
}

export const defaultCurrentField = new OceanCurrentField();
