import React from "react";
import "./IncidentPanel.css";

function IncidentPanel({ incident, vessels = [] }) {
  const sortedVessels = [...vessels].sort(
    (a, b) =>
      (a.candidateRank ?? 999) -
      (b.candidateRank ?? 999)
  );

  const topCandidate = sortedVessels[0];

  const formatDetectedTime = (value) => {
    if (!value) return "—";

    const date = new Date(value);

    return date.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }) + " UTC";
  };

  const lat = Number(incident?.centroid?.latitude ?? incident?.location?.latitude ?? 0);
  const lng = Number(incident?.centroid?.longitude ?? incident?.location?.longitude ?? 0);
  const latStr = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}`;
  const lngStr = `${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? "E" : "W"}`;
  const formattedCoordinates = `${latStr} · ${lngStr}`;

  const handleExportReport = () => {
    const timestamp = new Date().toISOString().replace(/T/, " ").substring(0, 19) + " UTC";
    const reportId = incident.id || "OT-INCIDENT-REPORT";

    let report = `================================================================================\n`;
    report += `OILTRACE — MARITIME INVESTIGATION REPORT\n`;
    report += `Generated:      ${timestamp}\n`;
    report += `Classification: OFFICIAL MARITIME REPORT (SIMULATED DATA DEMO)\n`;
    report += `================================================================================\n\n`;

    report += `1. INCIDENT IDENTIFICATION & LOCATION\n`;
    report += `--------------------------------------------------------------------------------\n`;
    report += `Incident ID:            ${incident.id || "—"}\n`;
    report += `Status:                 ${incident.status || "Under Investigation"}\n`;
    report += `Severity:               ${incident.severity || "High"}\n`;
    report += `Spill Type:             ${incident.spillType || "Suspected oil slick"}\n`;
    report += `Detected Date/Time:     ${formatDetectedTime(incident.detectedAt)}\n`;
    report += `Centroid Coordinates:   ${latStr}, ${lngStr} (${lat.toFixed(4)}, ${lng.toFixed(4)})\n`;
    report += `Estimated Area:         ${incident.areaKm2} km²\n`;
    report += `Detection Confidence:   ${Math.round((incident.detectionConfidence || 0) * 100)}%\n`;
    report += `Satellite Platform:     ${incident.satellite?.platform || "Sentinel-1"} (${incident.satellite?.sensor || "SAR"})\n`;
    report += `Product Image ID:       ${incident.satellite?.imageId || "DEMO-S1-001"}\n\n`;

    report += `2. SOURCE ESTIMATION (HYDRODYNAMIC BACKTRACKING)\n`;
    report += `--------------------------------------------------------------------------------\n`;
    const sourceLat = incident.sourceRegion?.center?.latitude ?? lat;
    const sourceLng = incident.sourceRegion?.center?.longitude ?? lng;
    const sourceRadiusKm = ((incident.sourceRegion?.radiusMeters || 1800) / 1000).toFixed(2);
    report += `Probable Source Center: ${Math.abs(sourceLat).toFixed(4)}° ${sourceLat >= 0 ? "N" : "S"}, ${Math.abs(sourceLng).toFixed(4)}° ${sourceLng >= 0 ? "E" : "W"}\n`;
    report += `Uncertainty Radius:     ${sourceRadiusKm} km (${incident.sourceRegion?.radiusMeters || 1800} m)\n`;
    report += `Source Type:            ${incident.sourceRegion?.type || "Uncertainty region"}\n\n`;

    report += `3. CANDIDATE VESSEL ATTRIBUTION RANKING\n`;
    report += `--------------------------------------------------------------------------------\n`;
    sortedVessels.forEach((v, idx) => {
      const conf = Math.round((v.attributionConfidence || 0) * 100);
      report += `Rank ${v.candidateRank || idx + 1}: ${v.name} [ID: ${v.id}]\n`;
      report += `  Type:                 ${v.type} | Flag: ${v.flag || "—"}\n`;
      report += `  Position:             ${Number(v.position?.latitude || 0).toFixed(4)}° N, ${Number(v.position?.longitude || 0).toFixed(4)}° E\n`;
      report += `  Speed / Heading:      ${v.speedKnots || 0} kts | ${v.heading || 0}°\n`;
      report += `  Attribution Score:    ${conf}% (${conf >= 70 ? "HIGH PROBABILITY" : conf >= 40 ? "MEDIUM PROBABILITY" : "LOW PROBABILITY"})\n`;
      if (v.evidence) {
        report += `  Evidence Breakdown:\n`;
        if (v.evidence.spatial) report += `    • Spatial Proximity:   ${Math.round((v.evidence.spatial.score || 0) * 100)}% (${v.evidence.spatial.label})\n`;
        if (v.evidence.temporal) report += `    • Temporal Overlap:    ${Math.round((v.evidence.temporal.score || 0) * 100)}% (${v.evidence.temporal.label})\n`;
        if (v.evidence.trajectory) report += `    • Trajectory Match:    ${Math.round((v.evidence.trajectory.score || 0) * 100)}% (${v.evidence.trajectory.label})\n`;
        if (v.evidence.drift) report += `    • Drift Counterfactual:${Math.round((v.evidence.drift.score || 0) * 100)}% (${v.evidence.drift.label})\n`;
        if (v.evidence.aisReliability) report += `    • AIS Coverage Status: ${v.evidence.aisReliability.status} (${v.evidence.aisReliability.label})\n`;
      }
      report += `\n`;
    });

    report += `4. INCIDENT TIMELINE\n`;
    report += `--------------------------------------------------------------------------------\n`;
    (incident.timeline || []).forEach((event) => {
      report += `${event.time} UTC  -  ${event.label}\n`;
    });
    report += `\n`;

    report += `5. DRIFT & WEATHER MODEL PARAMETERS (SIMULATED)\n`;
    report += `--------------------------------------------------------------------------------\n`;
    report += `Ocean Current:          Simulated Northwest Coastal Drift (Deterministic Field, ~1.8 m/s)\n`;
    report += `Atmospheric Wind:       Simulated NNW 5.2 m/s (Standard 3.0% windage coefficient)\n`;
    report += `Lagrangian Dispersion:  OpenDrift / OpenOil modeled particle advection & backward tracking\n\n`;

    report += `================================================================================\n`;
    report += `DISCLAIMER: All vessel positions, sensor data, and attribution scores in this\n`;
    report += `report are simulated for evaluation of the OilTrace automated attribution engine.\n`;
    report += `================================================================================\n`;

    const blob = new Blob([report], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `OILTRACE-REPORT-${reportId}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <aside
      className="incident-panel"
      aria-label="Incident overview"
    >
      {/* HEADER */}
      <div className="incident-panel-header">
        <div className="incident-header-top">
          <div>
            <span className="incident-kicker">
              INCIDENT
            </span>

            <h2>
              {incident.id}
            </h2>
          </div>

          <button
            type="button"
            className="incident-export-button"
            onClick={handleExportReport}
            title="Export full incident investigation report"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Export Report</span>
          </button>
        </div>

        <div className="incident-status-row">
          <span className="incident-status">
            {incident.status}
          </span>

          <span className="incident-severity">
            {incident.severity}
          </span>
        </div>
      </div>

      {/* INCIDENT DESCRIPTION & COORDINATES */}
      <section className="incident-block">
        <div className="incident-description">
          {incident.spillType}
        </div>

        <div className="incident-coordinates-card">
          <div className="coord-label">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
            <span>LOCATION / COORDINATES</span>
          </div>
          <div className="coord-values">
            <strong>{formattedCoordinates}</strong>
          </div>
        </div>

        <div className="incident-detected">
          <span>Detected</span>

          <strong>
            {formatDetectedTime(
              incident.detectedAt
            )}
          </strong>
        </div>
      </section>

      {/* SPILL ASSESSMENT */}
      <section className="incident-section">
        <div className="incident-section-title">
          Spill Assessment
        </div>

        <div className="incident-metrics">
          <div className="incident-metric">
            <span>AREA</span>

            <strong>
              {incident.areaKm2}
              <small> km²</small>
            </strong>
          </div>

          <div className="incident-metric">
            <span>DETECTION</span>

            <strong>
              {Math.round(
                incident.detectionConfidence *
                  100
              )}
              <small>%</small>
            </strong>
          </div>

          <div className="incident-metric">
            <span>SATELLITE</span>

            <strong>
              {incident.satellite?.platform ||
                "—"}
            </strong>

            <small className="metric-subtext">
              {incident.satellite?.sensor ||
                ""}
            </small>
          </div>
        </div>
      </section>

      {/* INVESTIGATION */}
      <section className="incident-section">
        <div className="incident-section-title">
          Investigation
        </div>

        <div className="incident-investigation-card">
          <div className="incident-candidate-count">
            <span>CANDIDATES</span>

            <strong>
              {vessels.length}
            </strong>

            <small>
              potential source vessels
            </small>
          </div>

          <div className="incident-top-candidate">
            <span>TOP CANDIDATE</span>

            <strong>
              {topCandidate?.name ||
                "No candidate"}
            </strong>

            {topCandidate && (
              <div className="incident-confidence">
                <span>
                  Attribution confidence
                </span>

                <strong>
                  {Math.round(
                    topCandidate.attributionConfidence *
                      100
                  )}
                  %
                </strong>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* TIMELINE */}
      <section className="incident-section">
        <div className="incident-section-title">
          Investigation Timeline
        </div>

        <div className="incident-timeline">
          {incident.timeline?.map(
            (event, index) => (
              <div
                className="incident-timeline-item"
                key={`${event.time}-${index}`}
              >
                <div className="timeline-marker">
                  <span />
                </div>

                <div className="timeline-content">
                  <strong>
                    {event.time}
                  </strong>

                  <span>
                    {event.label}
                  </span>
                </div>
              </div>
            )
          )}
        </div>
      </section>

      {/* DATA STATUS */}
      <div className="incident-data-note">
        <span className="incident-data-dot" />

        <div>
          <strong>
            {incident.satellite?.productStatus ||
              "Demo reference"}
          </strong>

          <span>
            Investigation data is simulated
            for demonstration.
          </span>
        </div>
      </div>
    </aside>
  );
}

export default IncidentPanel;