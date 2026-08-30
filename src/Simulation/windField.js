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
    // Default wind: North-North-West wind blowing toward South-South-East (u = 2.5 m/s, v = -4.0 m/s)
    this.baseU = options.baseU ?? 2.5;
    this.baseV = options.baseV ?? -4.0;
    this.windageFactor = options.windageFactor ?? 0.03; // 3% rule of thumb
    this.description = options.description ?? "SIMULATED WIND FIELD (NNW 5.2 m/s)";
  }

  /**
   * Get wind vector and its effective oil drift contribution at coordinate and time.
   * @param {number} latitude
   * @param {number} longitude
   * @param {number} timeMinutes
   * @returns {{ u: number, v: number, speed: number, direction: number, driftU: number, driftV: number, dLatPerMin: number, dLngPerMin: number }}
   */
  getVelocity(latitude, longitude, timeMinutes = 0) {
    const lat = Number(latitude) || 18.52;
    const lng = Number(longitude) || 72.912;
    const t = Number(timeMinutes) || 0;

    const dLat = lat - 18.52;
    const dLng = lng - 72.912;

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
