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
    // Base current vector from backend med_currents.nc: uo=0.096 m/s, vo=-0.132 m/s (0.22 m/s, 154.5° SSE)
    this.baseU = options.baseU ?? 0.096;
    this.baseV = options.baseV ?? -0.132;
    this.shearScale = options.shearScale ?? 0.15;
    this.wavePeriodMinutes = options.wavePeriodMinutes ?? 120;
    this.description = options.description ?? "BACKEND CMEMS OCEAN CURRENT (med_currents.nc)";
  }

  getVelocity(latitude, longitude, timeMinutes = 0) {
    const lat = Number(latitude) || 35.63533;
    const lng = Number(longitude) || 34.8704;
    const t = Number(timeMinutes) || 0;

    const dLat = lat - 35.63533;
    const dLng = lng - 34.8704;

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
