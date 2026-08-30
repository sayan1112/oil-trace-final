// ============================================================
// OILTRACE ATTRIBUTION SCORING ENGINE
// ============================================================
//
// Combines weighted evidence signals to produce attribution scores:
//   Spatial Proximity       25%
//   Temporal Window         25%
//   Trajectory Match        20%
//   Drift & Counterfactual   20%
//   AIS Reliability         10%
//
// Can evaluate static incident JSON evidence OR calculate dynamic
// scores against a dynamic backtracked source region.
// ============================================================

const SCORING_WEIGHTS = {
  spatial: 0.25,
  temporal: 0.25,
  trajectory: 0.2,
  drift: 0.2,
  aisReliability: 0.1,
};

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalizeScore(value) {
  if (typeof value !== "number") {
    return 0;
  }
  if (value > 1) {
    return clamp(value / 100);
  }
  return clamp(value);
}

function scoreToPercent(score) {
  return Math.round(clamp(score) * 100);
}

function getAISReliabilityScore(aisReliability) {
  const status = aisReliability?.status?.toLowerCase()?.trim();
  switch (status) {
    case "good":
    case "optimal":
      return 1;
    case "warning":
    case "degraded":
      return 0.5;
    case "poor":
    case "critical":
      return 0.25;
    default:
      return 0.4;
  }
}

export function getSignalStrength(percentage) {
  if (percentage >= 80) return "Strong";
  if (percentage >= 60) return "Moderate";
  return "Weak";
}

export function getSignalClass(percentage) {
  if (percentage >= 80) return "strong";
  if (percentage >= 60) return "moderate";
  return "weak";
}

/**
 * Calculate distance between two lat/lng pairs in kilometers (Haversine formula).
 */

function calculateDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate dynamic attribution score for a single vessel.
 */
export function calculateAttributionScore(vessel, sourceRegion = null) {
  const rawEvidence = vessel?.evidence || {};

  let spatialScore = normalizeScore(rawEvidence.spatial?.score);
  let spatialLabel = rawEvidence.spatial?.label || "Spatial proximity to inferred source region.";

  // If a dynamically calculated source region is provided, compute true distance
  if (sourceRegion && sourceRegion.center) {
    const sCenter = sourceRegion.center;
    // Find vessel position near potential release time (e.g. 10:30 point in vessel trajectory or vessel position)
    let vesselLat = vessel.position?.latitude;
    let vesselLng = vessel.position?.longitude;

    if (Array.isArray(vessel.trajectory) && vessel.trajectory.length > 0) {
      // Find point near release window (10:30)
      const releasePoint = vessel.trajectory.find((pt) => pt.time === "10:30") || vessel.trajectory[0];
      vesselLat = releasePoint.latitude;
      vesselLng = releasePoint.longitude;
    }

    if (Number.isFinite(vesselLat) && Number.isFinite(vesselLng)) {
      const distKm = calculateDistanceKm(sCenter.latitude, sCenter.longitude, vesselLat, vesselLng);
      // Distance decay score: 1.0 at 0km, 0.5 at 3km, 0.1 at 8km
      spatialScore = clamp(Math.exp(-distKm / 3.2));
      spatialLabel = `${distKm.toFixed(1)} km from backtracked source region.`;
    }
  }

  const temporalScore = normalizeScore(rawEvidence.temporal?.score);
  const trajectoryScore = normalizeScore(rawEvidence.trajectory?.score);
  const driftScore = normalizeScore(rawEvidence.drift?.score);
  const aisScore = getAISReliabilityScore(rawEvidence.aisReliability);

  const weightedSpatial = spatialScore * SCORING_WEIGHTS.spatial;
  const weightedTemporal = temporalScore * SCORING_WEIGHTS.temporal;
  const weightedTrajectory = trajectoryScore * SCORING_WEIGHTS.trajectory;
  const weightedDrift = driftScore * SCORING_WEIGHTS.drift;
  const weightedAIS = aisScore * SCORING_WEIGHTS.aisReliability;

  const overallScore =
    weightedSpatial + weightedTemporal + weightedTrajectory + weightedDrift + weightedAIS;

  const confidence = scoreToPercent(overallScore);

  const evidenceItems = [
    {
      key: "spatial",
      title: "Spatial Proximity",
      short: "SPATIAL",
      icon: "⌖",
      value: scoreToPercent(spatialScore),
      weight: SCORING_WEIGHTS.spatial,
      weightedValue: scoreToPercent(weightedSpatial),
      description: spatialLabel,
    },
    {
      key: "temporal",
      title: "Temporal Window",
      short: "TEMPORAL",
      icon: "◷",
      value: scoreToPercent(temporalScore),
      weight: SCORING_WEIGHTS.temporal,
      weightedValue: scoreToPercent(weightedTemporal),
      description: rawEvidence.temporal?.label || "Temporal overlap with release window.",
    },
    {
      key: "trajectory",
      title: "Trajectory Compatibility",
      short: "TRACK",
      icon: "↗",
      value: scoreToPercent(trajectoryScore),
      weight: SCORING_WEIGHTS.trajectory,
      weightedValue: scoreToPercent(weightedTrajectory),
      description: rawEvidence.trajectory?.label || "Compatibility with historical vessel path.",
    },
    {
      key: "drift",
      title: "Drift / Counterfactual",
      short: "DRIFT",
      icon: "≈",
      value: scoreToPercent(driftScore),
      weight: SCORING_WEIGHTS.drift,
      weightedValue: scoreToPercent(weightedDrift),
      description: rawEvidence.drift?.label || "Counterfactual drift match.",
    },
    {
      key: "aisReliability",
      title: "AIS Reliability",
      short: "AIS",
      icon: "◉",
      value: scoreToPercent(aisScore),
      weight: SCORING_WEIGHTS.aisReliability,
      weightedValue: scoreToPercent(weightedAIS),
      description: rawEvidence.aisReliability?.label || "AIS observation reliability.",
      status: rawEvidence.aisReliability?.status || "Unknown",
    },
  ];

  const strongSignals = evidenceItems.filter((item) => item.value >= 80).length;
  const moderateSignals = evidenceItems.filter((item) => item.value >= 60 && item.value < 80).length;
  const weakSignals = evidenceItems.filter((item) => item.value < 60).length;

  let assessment = "Low attribution support";
  let assessmentClass = "weak";

  if (confidence >= 80) {
    assessment = "High attribution support";
    assessmentClass = "strong";
  } else if (confidence >= 60) {
    assessment = "Moderate attribution support";
    assessmentClass = "moderate";
  }

  const warnings = [];
  if (rawEvidence.aisReliability?.status?.toLowerCase() === "warning") {
    warnings.push("AIS data contains a reliability warning.");
  }
  if (weakSignals > 0) {
    warnings.push(`${weakSignals} evidence signal${weakSignals > 1 ? "s" : ""} remain weak.`);
  }
  if (confidence < 60) {
    warnings.push("Attribution support is currently weak.");
  }

  return {
    confidence,
    overallScore,
    assessment,
    assessmentClass,
    evidenceItems,
    strongSignals,
    moderateSignals,
    weakSignals,
    warnings,
    weights: { ...SCORING_WEIGHTS },
  };
}

/**
 * Score all candidate vessels and assign candidate ranks.
 */
export function scoreAllVessels(vessels = [], sourceRegion = null) {
  const scored = vessels.map((vessel) => {
    const scoring = calculateAttributionScore(vessel, sourceRegion);
    return {
      ...vessel,
      scoring,
      attributionConfidence: scoring.confidence / 100,
    };
  });

  const ranked = [...scored].sort((a, b) => b.scoring.confidence - a.scoring.confidence);

  const rankMap = new Map();
  ranked.forEach((vessel, index) => {
    rankMap.set(vessel.id, index + 1);
  });

  return scored.map((vessel) => ({
    ...vessel,
    candidateRank: rankMap.get(vessel.id) || 999,
  }));
}

export { SCORING_WEIGHTS, getAISReliabilityScore };