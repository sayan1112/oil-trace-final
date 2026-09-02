// ============================================================
// OILTRACE — DETERMINISTIC WIND FIELD MODEL
// ============================================================
//
// Represents atmospheric wind vector field for oil drift calculations.
// Standard maritime oil spill models apply a 3.0% windage coefficient
// (oil slick drift = surface current + 0.03 * wind velocity).
// ============================================================

const METERS_PER_DEGREE_LAT = 111000;

function getMetersPerDegreeLng(latitude) {
  const rad = (latitude * Math.PI) / 180;
  return Math.cos(rad) * METERS_PER_DEGREE_LAT;
}

export class WindField {
  constructor(options = {}) {
    // Base wind vector from backend med_wind.nc: u10=2.82 m/s, v10=2.94 m/s (4.40 m/s, 69.0° ENE)
    this.baseU = options.baseU ?? 2.82;
    this.baseV = options.baseV ?? 2.94;
    this.windageFactor = options.windageFactor ?? 0.03; // 3% standard oil windage rule
    this.description = options.description ?? "BACKEND ERA5 WIND FIELD (med_wind.nc)";
  }

  /**
   * Get wind vector and its effective oil drift contribution at coordinate and time.
   * @param {number} latitude
   * @param {number} longitude
   * @param {number} timeMinutes
   * @returns {{ u: number, v: number, speed: number, direction: number, driftU: number, driftV: number, dLatPerMin: number, dLngPerMin: number }}
   */
  getVelocity(latitude, longitude, timeMinutes = 0) {
    const lat = Number(latitude) || 35.63533;
    const lng = Number(longitude) || 34.8704;
    const t = Number(timeMinutes) || 0;

    const dLat = lat - 35.63533;
    const dLng = lng - 34.8704;

    const uSpatial = Math.cos(dLat * 50) * 0.4;
    const vSpatial = Math.sin(dLng * 60) * 0.5;

    const timePhase = (t / 180) * Math.PI * 2;
    const uTime = Math.sin(timePhase) * 0.3;
    const vTime = Math.cos(timePhase) * 0.4;

    const u = this.baseU + uSpatial + uTime;
    const v = this.baseV + vSpatial + vTime;

    const speed = Math.sqrt(u * u + v * v);
    const direction = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;

    // Oil drift vector contributed by wind
    const driftU = u * this.windageFactor;
    const driftV = v * this.windageFactor;

    const metersPerDegreeLng = getMetersPerDegreeLng(lat);
    const dLngPerMin = (driftU * 60) / metersPerDegreeLng;
    const dLatPerMin = (driftV * 60) / METERS_PER_DEGREE_LAT;

    return {
      u,
      v,
      speed,
      direction,
      driftU,
      driftV,
      dLatPerMin,
      dLngPerMin,
      isSimulated: true,
    };
  }
}

export const defaultWindField = new WindField();
