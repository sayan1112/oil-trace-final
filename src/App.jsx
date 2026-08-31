import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";

import {
  MapContainer,
  TileLayer,
  Marker,
  Tooltip,
  Polyline,
  Polygon,
  Circle,
  CircleMarker,
  useMap,
} from "react-leaflet";

import "leaflet/dist/leaflet.css";
import L from "leaflet";

import incidentData from "./data/incident.json";

import ReplayPanel from "./components/ReplayPanel";
import EvidencePanel from "./components/EvidencePanel";
import "./components/EvidencePanel.css";

import { SuspectPanel } from "./components/SuspectPanel";
import Sidebar from "./Sidebar";

import DeckOilOverlay from "./components/DeckOilOverlay";
import { DetectionPanel } from "./components/DetectionPanel";

import "./App.css";

import { scoreAllVessels } from "./utils/attributionScoring";
import {
  warmBackend,
  getBackendHealth,
  runHindcast,
  getCandidateVessels,
  runAttribution,
  runForwardSimulation,
  runCounterfactual,
  bboxFromGeometry,
  trajectoryPoints,
  sourceRegionForFrontend,
  slickFromDetection,
  slickFromIncident,
  normalizeVessels,
  buildFrontendScoring,
  shiftIsoHours,
  assertWithinForcingCoverage,
  isWithinForcingCoverage,
  transposeSlickToDemoWindow,
} from "./services/backendApi";
import { generateOilSimulation } from "./Simulation/oilSimulation";
import { defaultCurrentField } from "./Simulation/currentField";
import { defaultWindField } from "./Simulation/windField";
import { warmDetectionService } from "./services/detectionApi";

/* =========================================================
   LEAFLET MARKER FIX
========================================================= */

delete L.Icon.Default.prototype._getIconUrl;

L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

/* =========================================================
   INCIDENT DATA
========================================================= */

const incident = incidentData.incident;

/* =========================================================
   HELPERS
========================================================= */

function getConfidencePercent(confidence) {
  const value = Number(confidence);
  if (!Number.isFinite(value)) return 0;
  return Math.max(
    0,
    Math.min(100, value <= 1 ? Math.round(value * 100) : Math.round(value))
  );
}

function getVesselProbabilityClass(confidence) {
  const percentage = getConfidencePercent(confidence);
  if (percentage >= 70) return "probability-high";
  if (percentage >= 40) return "probability-medium";
  return "probability-low";
}

/* =========================================================
   VESSEL ICON
========================================================= */

function createVesselIcon({
  selected = false,
  replay = false,
  candidateRank = null,
  attributionConfidence = 0,
}) {
  const probabilityClass = getVesselProbabilityClass(attributionConfidence);
  const confidencePercent = getConfidencePercent(attributionConfidence);

  if (replay) {
    // Sleek directional ship icon for replay animation
    const ringColor = candidateRank === 1
      ? "#d97706"
      : selected
      ? "#2563eb"
      : "#64748b";

    return L.divIcon({
      className: "oiltrace-vessel-icon-wrapper",
      html: `
        <div class="vessel-replay-marker" style="
          position:relative;
          width:34px;
          height:34px;
          display:flex;
          align-items:center;
          justify-content:center;
        ">
          <div style="
            position:absolute;
            inset:-4px;
            border-radius:50%;
            border:2px solid ${ringColor};
            opacity:0.7;
          "></div>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.6))">
            <path d="M12 2 L20 20 L12 16 L4 20 Z"
              fill="${ringColor}" opacity="0.95" />
          </svg>
          <div style="
            position:absolute;
            top:-18px;
            left:50%;
            transform:translateX(-50%);
            background:${ringColor};
            color:#fff;
            font-size:9px;
            font-weight:700;
            padding:1px 5px;
            border-radius:4px;
            white-space:nowrap;
            box-shadow:0 1px 4px rgba(0,0,0,0.4);
          ">${confidencePercent}%</div>
        </div>
      `,
      iconSize:   [34, 34],
      iconAnchor: [17, 17],
      popupAnchor: [0, -20],
    });
  }

  return L.divIcon({
    className: "oiltrace-vessel-icon-wrapper",
    html: `
      <div
        class="
          oiltrace-vessel-marker
          ${selected ? "is-selected" : ""}
          ${candidateRank === 1 ? "is-top-candidate" : ""}
          ${probabilityClass}
        "
        title="Vessel attribution probability: ${confidencePercent}%"
      >
        <div class="vessel-probability-label">${confidencePercent}%</div>
        <div class="vessel-probability-ring"></div>
        <div class="vessel-marker-body">
          <span class="vessel-marker-symbol">⚓</span>
        </div>
      </div>
    `,
    iconSize:   [58, 58],
    iconAnchor: [29, 29],
    popupAnchor: [0, -30],
  });
}

/* =========================================================
   GEOGRAPHIC DATA
========================================================= */

const leafletCentroid = [
  Number(incident.centroid.latitude),
  Number(incident.centroid.longitude),
];

const spillPolygon = Array.isArray(incident.spillPolygon)
  ? incident.spillPolygon
      .filter(
        (point) =>
          Array.isArray(point) &&
          point.length >= 2 &&
          Number.isFinite(Number(point[0])) &&
          Number.isFinite(Number(point[1]))
      )
      .map(([latitude, longitude]) => [
        Number(latitude),
        Number(longitude),
      ])
  : [];

/* =========================================================
   MAP HELPERS
========================================================= */

function getIncidentPoints() {
  const points = [];

  if (Array.isArray(incident?.spillPolygon)) {
    incident.spillPolygon.forEach((point) => {
      if (Array.isArray(point) && point.length >= 2) {
        const latitude = Number(point[0]);
        const longitude = Number(point[1]);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          points.push([latitude, longitude]);
        }
      }
    });
  }

  if (
    incident?.centroid &&
    Number.isFinite(Number(incident.centroid.latitude)) &&
    Number.isFinite(Number(incident.centroid.longitude))
  ) {
    points.push([
      Number(incident.centroid.latitude),
      Number(incident.centroid.longitude),
    ]);
  }

  if (Array.isArray(incident?.vessels)) {
    incident.vessels.forEach((vessel) => {
      const latitude = Number(vessel?.position?.latitude);
      const longitude = Number(vessel?.position?.longitude);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        points.push([latitude, longitude]);
      }
    });
  }

  return points;
}

/* =========================================================
   FIT MAP
========================================================= */

function FitMapToIncident() {
  const map = useMap();
  const hasInitializedRef = useRef(false);

  useEffect(() => {
    // Camera initialization is deliberately isolated from React UI state.
    // Selecting a vessel, opening a panel, changing theme, or changing a
    // layer must never call any Leaflet camera method.
    if (hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    const points = getIncidentPoints();
    if (!points.length) return;

    // The grid layout may not have sized the map container yet on first
    // paint; fitting a 0-size map collapses to maxZoom at a bogus center.
    // Retry until the container has a real size.
    let cancelled = false;
    const fit = () => {
      if (cancelled) return;
      map.invalidateSize({ pan: false });
      const size = map.getSize();
      if (size.x < 200 || size.y < 200) {
        setTimeout(fit, 120);
        return;
      }
      map.fitBounds(L.latLngBounds(points), {
        paddingTopLeft: [70, 70],
        paddingBottomRight: [390, 70],
        maxZoom: 13,
        animate: false,
      });
    };
    fit();
    return () => { cancelled = true; };
  }, [map]);

  return null;
}

/* =========================================================
   MAP TOOLBAR
========================================================= */

function MapToolbar({ darkMode, onToggleTheme, onTriggerBacktrack, isBacktracking }) {
  const map = useMap();

  const handleResetView = () => {
    const points = getIncidentPoints();
    if (!points.length) return;
    map.fitBounds(L.latLngBounds(points), {
      paddingTopLeft: [100, 80],
      paddingBottomRight: [100, 80],
      animate: true,
      duration: 0.7,
    });
  };

  const handleFullscreen = () => {
    const mapElement = document.querySelector(".map");
    if (!mapElement) return;
    if (!document.fullscreenElement) {
      mapElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  };

  return (
    <div className="oiltrace-map-toolbar" aria-label="Map controls">
      <button
        type="button"
        className="map-tool-button backtrack-tool-button"
        onClick={onTriggerBacktrack}
        disabled={isBacktracking}
        title="Backtrack Oil Spill Source"
        aria-label="Backtrack Oil Spill Source"
        style={{
          background: isBacktracking ? "#0284c7" : "linear-gradient(135deg, #0284c7, #0f766e)",
          color: "#ffffff",
          fontWeight: 600,
          padding: "0 0.85rem",
          width: "auto",
          borderRadius: "6px",
          gap: "0.4rem",
          display: "flex",
          alignItems: "center",
          boxShadow: "0 2px 8px rgba(2, 132, 199, 0.4)",
        }}
      >
        <span style={{ fontSize: "1rem" }}>{isBacktracking ? "⌛" : "↺"}</span>
        <span>{isBacktracking ? "BACKTRACKING..." : "BACKTRACK OIL"}</span>
      </button>

      <span className="map-tool-divider" />

      <button
        type="button"
        className="map-tool-button zoom-button"
        onClick={() => map.zoomIn()}
        title="Zoom in"
        aria-label="Zoom in"
      >
        +
      </button>

      <button
        type="button"
        className="map-tool-button zoom-button"
        onClick={() => map.zoomOut()}
        title="Zoom out"
        aria-label="Zoom out"
      >
        −
      </button>

      <span className="map-tool-divider" />

      <button
        type="button"
        className="map-tool-button"
        onClick={handleResetView}
        title="Reset map view"
        aria-label="Reset map view"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7" />
          <circle cx="12" cy="12" r="2" />
          <path d="M12 2v3" />
          <path d="M12 19v3" />
          <path d="M2 12h3" />
          <path d="M19 12h3" />
        </svg>
      </button>

      <button
        type="button"
        className="map-tool-button"
        onClick={handleFullscreen}
        title="Fullscreen"
        aria-label="Fullscreen"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 3H3v5" />
          <path d="M3 3l6 6" />
          <path d="M16 3h5v5" />
          <path d="M21 3l-6 6" />
          <path d="M8 21H3v-5" />
          <path d="M3 21l6-6" />
          <path d="M16 21h5v-5" />
          <path d="M21 21l-6-6" />
        </svg>
      </button>

      <span className="map-tool-divider" />

      <button
        type="button"
        className="map-tool-button theme-tool-button"
        onClick={onToggleTheme}
        title={darkMode ? "Switch to light theme" : "Switch to dark theme"}
        aria-label={darkMode ? "Switch to light theme" : "Switch to dark theme"}
      >
        {darkMode ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2" />
            <path d="M12 20v2" />
            <path d="m4.93 4.93 1.41 1.41" />
            <path d="m17.66 17.66 1.41 1.41" />
            <path d="M2 12h2" />
            <path d="M20 12h2" />
            <path d="m4.93 19.07 1.41-1.41" />
            <path d="m17.66 6.34 1.41-1.41" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
          </svg>
        )}
      </button>
    </div>
  );
}

/* =========================================================
   VESSEL TOOLTIP
========================================================= */

function VesselPopup({ vessel, show = true }) {
  const confidencePercent = getConfidencePercent(vessel.attributionConfidence);

  if (!show) return null;

  return (
    <Tooltip
      direction="top"
      offset={[0, -22]}
      opacity={1}
      className="oiltrace-vessel-tooltip"
    >
      <div className="vessel-tooltip-content">
        <div className="vessel-tooltip-header">
          <strong>{vessel.name}</strong>
          <span
            className={`vessel-tooltip-probability ${getVesselProbabilityClass(
              vessel.attributionConfidence
            )}`}
          >
            {confidencePercent}%
          </span>
        </div>

        <div className="vessel-tooltip-row">
          <span>Type</span>
          <strong>{vessel.type}</strong>
        </div>

        <div className="vessel-tooltip-row">
          <span>Speed</span>
          <strong>{vessel.speedKnots} knots</strong>
        </div>

        <div className="vessel-tooltip-row">
          <span>Heading</span>
          <strong>{vessel.heading}°</strong>
        </div>

        <div className="vessel-tooltip-row">
          <span>Candidate rank</span>
          <strong>#{vessel.candidateRank}</strong>
        </div>

        <div className="vessel-tooltip-row">
          <span>Attribution confidence</span>
          <strong>{confidencePercent}%</strong>
        </div>
      </div>
    </Tooltip>
  );
}

/* =========================================================
   INCIDENT PANEL
========================================================= */

function IncidentPanel({ vessels, onSelectVessel, onClose, onTriggerBacktrack, isBacktracking }) {
  const topCandidate =
    vessels.find((vessel) => vessel.candidateRank === 1) || vessels[0];

  const detectedDate = new Date(incident.detectedAt);

  const detectedDateText = detectedDate.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

  const detectedTimeText = detectedDate.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });

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
    report += `Detected Date/Time:     ${detectedDateText} ${detectedTimeText} UTC\n`;
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
    vessels.forEach((v, idx) => {
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
      className="oiltrace-context-panel incident-context-panel"
      aria-label="Incident information"
    >
      <div className="context-panel-header">
        <div>
          <span className="context-kicker">INCIDENT</span>
          <h2>{incident.id}</h2>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <button
            type="button"
            className="incident-export-button"
            onClick={handleExportReport}
            title="Export full incident investigation report"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "5px 9px",
              background: "rgba(15, 23, 42, 0.05)",
              border: "1px solid rgba(15, 23, 42, 0.12)",
              borderRadius: "6px",
              fontSize: "10px",
              fontWeight: "700",
              cursor: "pointer",
              color: "inherit",
            }}
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Report</span>
          </button>

          <button
            type="button"
            className="context-close-button"
            onClick={onClose}
            aria-label="Close incident panel"
          >
            ×
          </button>
        </div>
      </div>

      <div className="incident-status-row">
        <span className="incident-status">{incident.status}</span>
        <span className="incident-severity">{incident.severity}</span>
      </div>

      <section className="context-section">
        <span className="context-section-label">INCIDENT</span>
        <h3 className="incident-title">{incident.spillType}</h3>
        <div style={{ marginTop: "6px", display: "inline-flex", alignItems: "center", gap: "6px", background: "rgba(37, 99, 235, 0.08)", padding: "4px 8px", borderRadius: "5px", fontSize: "11px", fontWeight: "700", fontFamily: "ui-monospace, monospace", color: "#1d4ed8" }}>
          <span>📍</span>
          <span>{formattedCoordinates}</span>
        </div>
        <p className="incident-time" style={{ marginTop: "6px" }}>
          {detectedDateText} · {detectedTimeText} UTC
        </p>
      </section>

      <section className="context-section">
        <span className="context-section-label">SPILL ASSESSMENT</span>
        <div className="incident-metrics">
          <div className="incident-metric">
            <strong>{incident.areaKm2}</strong>
            <span>km²</span>
            <small>AREA</small>
          </div>

          <div className="incident-metric">
            <strong>
              {Math.round(incident.detectionConfidence * 100)}%
            </strong>
            <span>confidence</span>
            <small>DETECTION</small>
          </div>

          <div className="incident-metric">
            <strong>{incident.satellite.platform}</strong>
            <span>{incident.satellite.sensor}</span>
            <small>SENSOR</small>
          </div>
        </div>
      </section>

      <section className="context-section" style={{ background: "rgba(2, 132, 199, 0.08)", padding: "1rem", borderRadius: "8px", border: "1px solid rgba(2, 132, 199, 0.2)" }}>
        <span className="context-section-label" style={{ color: "#0284c7" }}>SOURCE ESTIMATION</span>
        <h4 style={{ margin: "0.25rem 0 0.5rem 0", fontSize: "0.95rem" }}>Backward Trajectory Analysis</h4>
        <p style={{ fontSize: "0.8rem", color: "#64748b", margin: "0 0 0.75rem 0" }}>
          Reconstruct historical oil transport backwards from detection time to estimate origin region.
        </p>
        <button
          type="button"
          className="inspect-candidate-button"
          onClick={onTriggerBacktrack}
          disabled={isBacktracking}
          style={{ background: "#0284c7", color: "#ffffff", justifyContent: "center" }}
        >
          {isBacktracking ? "Backtracking..." : "Run Backtrack Analysis ↺"}
        </button>
      </section>

      <section className="context-section">
        <div className="context-section-heading">
          <span className="context-section-label">INVESTIGATION</span>
          <span className="candidate-count">{vessels.length}</span>
        </div>

        <div className="incident-candidate-summary">
          <div>
            <span className="candidate-summary-label">TOP CANDIDATE</span>
            <strong>{topCandidate?.name || "No candidate"}</strong>
          </div>

          {topCandidate && (
            <div className="candidate-confidence">
              <strong>
                {getConfidencePercent(topCandidate.attributionConfidence)}%
              </strong>
              <span>attribution</span>
            </div>
          )}
        </div>

        {topCandidate && (
          <button
            type="button"
            className="inspect-candidate-button"
            onClick={() => onSelectVessel(topCandidate)}
          >
            Inspect candidate <span>→</span>
          </button>
        )}
      </section>

      <section className="context-section">
        <span className="context-section-label">TIMELINE</span>
        <div className="incident-timeline">
          {incident.timeline.map((event, index) => (
            <div
              className={`incident-timeline-item ${
                index === incident.timeline.length - 1 ? "timeline-final" : ""
              }`}
              key={`${event.time}-${index}`}
            >
              <div className="timeline-marker">
                <span />
              </div>
              <div className="timeline-content">
                <strong>{event.time}</strong>
                <span>{event.label}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}

/* =========================================================
   LEGEND
========================================================= */

function LegendPanel({ onClose }) {
  return (
    <aside className="oiltrace-context-panel legend-context-panel" aria-label="Map legend">
      <div className="context-panel-header legend-panel-header">
        <div>
          <span className="context-kicker">MAP REFERENCE</span>
          <h2>Legend</h2>
          <p className="legend-panel-subtitle">Map symbols and investigation layers</p>
        </div>

        <button type="button" className="context-close-button" onClick={onClose} aria-label="Close legend">
          ×
        </button>
      </div>

      <div className="legend-content">
        <section className="legend-group">
          <div className="legend-group-title">OIL / LAGRANGIAN DRIFT</div>
          <div className="legend-items">
            <div className="legend-item"><span className="legend-particle legend-particle-initial" /><span>Dispersed / leading-edge oil</span></div>
            <div className="legend-item"><span className="legend-particle legend-particle-active" /><span>Active drifting oil</span></div>
            <div className="legend-item"><span className="legend-particle legend-particle-stranded" /><span>High-concentration oil core</span></div>
            <div className="legend-item"><span className="legend-drift-trail" /><span>Particle drift history</span></div>
            <div className="legend-item"><span className="legend-oil-centerline" /><span>Oil transport flow lines</span></div>
            <div className="legend-item"><span className="legend-backtrack-path" /><span>Backtracked transport path</span></div>
            <div className="legend-item"><span className="legend-spill-boundary" /><span>Detected spill boundary</span></div>
            <div className="legend-item"><span className="legend-spill-centroid" /><span>Spill centroid</span></div>
            <div className="legend-item"><span className="legend-source-region" /><span>Source uncertainty region</span></div>
            <div className="legend-item"><span className="legend-line" style={{ backgroundColor: "#0284c7" }} /><span>Simulated ocean current</span></div>
            <div className="legend-item"><span className="legend-line" style={{ backgroundColor: "#f59e0b" }} /><span>Simulated wind field</span></div>
          </div>
        </section>

        <section className="legend-group">
          <div className="legend-group-title">VESSELS / TRAJECTORIES</div>
          <div className="legend-items">
            <div className="legend-item"><span className="legend-vessel"><span>⚓</span></span><span>Candidate vessel</span></div>
            <div className="legend-item"><span className="legend-vessel legend-top-vessel"><span>⚓</span></span><span>Top candidate</span></div>
            <div className="legend-item"><span className="legend-line legend-selected" /><span>Selected vessel trajectory</span></div>
            <div className="legend-item"><span className="legend-line legend-candidate" /><span>Top candidate trajectory</span></div>
            <div className="legend-item"><span className="legend-line legend-muted-trajectory" /><span>Other vessel trajectory</span></div>
          </div>
        </section>

        <section className="legend-group">
          <div className="legend-group-title">ATTRIBUTION CONFIDENCE</div>
          <div className="legend-items">
            <div className="legend-item"><span className="legend-probability-dot probability-high-dot" /><span>High attribution · 70–100%</span></div>
            <div className="legend-item"><span className="legend-probability-dot probability-medium-dot" /><span>Medium attribution · 40–69%</span></div>
            <div className="legend-item"><span className="legend-probability-dot probability-low-dot" /><span>Low attribution · 0–39%</span></div>
          </div>
        </section>

        <div className="legend-note">
          <strong>SIMULATED LAGRANGIAN PARTICLE DRIFT</strong>
          <p>Particles are advected by the simulated ocean current and wind fields. Green marks the dispersed leading edge, blue marks active drift, and red marks the densest oil core.</p>
          <p>The dark dashed flow lines are generated from the same current + wind field and start inside the dense oil core, so they remain attached to the visible plume.</p>
        </div>
      </div>
    </aside>
  );
}

/* =========================================================
   APP
========================================================= */

function App() {
  /* =======================================================
     FORWARD OIL SIMULATION ENGINE
  ======================================================= */

  const oilSimulation = useMemo(
    () => generateOilSimulation({ incident }),
    []
  );

  /* =======================================================
     SIMULATED OCEAN CURRENT & WIND FIELD VECTORS
  ======================================================= */

  const simulatedCurrentVectors = useMemo(() => {
    const vectors = [];
    for (let lat = 59.95; lat <= 60.42; lat += 0.055) {
      for (let lng = 4.25; lng <= 4.98; lng += 0.075) {
        const vel = defaultCurrentField.getVelocity(lat, lng, 0);
        const rad = ((90 - vel.direction) * Math.PI) / 180;
        const len = 0.014;
        const endLat = lat + Math.sin(rad) * len * 0.9;
        const endLng = lng + Math.cos(rad) * len;
        const headLen = 0.004;
        const headAngle1 = rad + Math.PI * 0.82;
        const headAngle2 = rad - Math.PI * 0.82;
        const h1 = [endLat + Math.sin(headAngle1) * headLen * 0.9, endLng + Math.cos(headAngle1) * headLen];
        const h2 = [endLat + Math.sin(headAngle2) * headLen * 0.9, endLng + Math.cos(headAngle2) * headLen];
        vectors.push({
          id: `curr-${lat.toFixed(3)}-${lng.toFixed(3)}`,
          positions: [[lat, lng], [endLat, endLng]],
          arrowHead: [h1, [endLat, endLng], h2],
          speed: vel.speed,
          direction: vel.direction,
        });
      }
    }
    return vectors;
  }, []);

  const simulatedWindVectors = useMemo(() => {
    const vectors = [];
    for (let lat = 59.97; lat <= 60.40; lat += 0.055) {
      for (let lng = 4.28; lng <= 4.95; lng += 0.075) {
        const wind = defaultWindField.getVelocity(lat, lng, 0);
        const rad = ((90 - wind.direction) * Math.PI) / 180;
        const len = 0.015;
        const endLat = lat + Math.sin(rad) * len * 0.9;
        const endLng = lng + Math.cos(rad) * len;
        const headLen = 0.004;
        const headAngle1 = rad + Math.PI * 0.82;
        const headAngle2 = rad - Math.PI * 0.82;
        const h1 = [endLat + Math.sin(headAngle1) * headLen * 0.9, endLng + Math.cos(headAngle1) * headLen];
        const h2 = [endLat + Math.sin(headAngle2) * headLen * 0.9, endLng + Math.cos(headAngle2) * headLen];
        vectors.push({
          id: `wind-${lat.toFixed(3)}-${lng.toFixed(3)}`,
          positions: [[lat, lng], [endLat, endLng]],
          arrowHead: [h1, [endLat, endLng], h2],
          speed: wind.speed,
          direction: wind.direction,
        });
      }
    }
    return vectors;
  }, []);

  /* =======================================================
     DYNAMIC BACKTRACK ENGINE STATE
  ======================================================= */

  const [backtrackResult, setBacktrackResult] = useState(null);
  const [isBacktracking, setIsBacktracking] = useState(false);
  const [backtrackVisible, setBacktrackVisible] = useState(false);
  const [backtrackStatusText, setBacktrackStatusText] = useState("");

  // Live backend investigation artifacts (null until the pipeline runs)
  const [backendVessels, setBackendVessels] = useState(null);
  const [forwardResult, setForwardResult] = useState(null);
  const [counterfactualResult, setCounterfactualResult] = useState(null);
  const [backendError, setBackendError] = useState(null);
  const [backendOnline, setBackendOnline] = useState(null); // null=checking
  const [transposeNotice, setTransposeNotice] = useState(null);

  const calculatedSourceRegion = useMemo(() => {
    if (backtrackResult?.sourceRegion) {
      return backtrackResult.sourceRegion;
    }
    return incident.sourceRegion;
  }, [backtrackResult]);

  /* =======================================================
     VESSEL SCORING
  ======================================================= */

  // Backend-attributed vessels take over as soon as the live pipeline has
  // run; the static incident.json list is only the initial preview.
  const scoredVessels = useMemo(
    () =>
      backendVessels ?? scoreAllVessels(incident.vessels, calculatedSourceRegion),
    [backendVessels, calculatedSourceRegion]
  );

  /* =======================================================
     ACTIVE SIDEBAR ITEM & THEME
  ======================================================= */

  const [activeItem, setActiveItem] = useState("map");

  const [darkMode, setDarkMode] = useState(() => {
    try {
      return localStorage.getItem("oiltrace-theme") === "dark";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("oiltrace-theme", darkMode ? "dark" : "light");
    } catch {
      // Ignore
    }
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    document.body.dataset.theme = darkMode ? "dark" : "light";
  }, [darkMode]);

  /* =======================================================
     SELECTED VESSEL
  ======================================================= */

  const [selectedVesselId, setSelectedVesselId] = useState(null);

  const selectedVessel = scoredVessels.find(
    (vessel) => vessel.id === selectedVesselId
  );

  /* =======================================================
     MAP LAYERS
  ======================================================= */

  const [layers, setLayers] = useState({
    spill: true,
    oilTrajectory: true,
    backtrack: true,
    sourceRegion: true,
    trajectories: true,
    vessels: true,
    oceanCurrent: false,
    windField: false,
    detectedSlicks: true,
  });

  /* =======================================================
     DETECTION API STATE
  ======================================================= */

  // GeoJSON FeatureCollection returned by the Detection Service, or null
  const [detectionResult, setDetectionResult] = useState(null);

  // Backtrack seed override: { lat, lon } from a detected slick centroid
  const [apiSeedOverride, setApiSeedOverride] = useState(null);
  // Which slick ID is the active seed (for button highlight)
  const [activeSeedId, setActiveSeedId] = useState(null);

  // Fire-and-forget warm-up on mount so both services are ready
  useEffect(() => {
    warmDetectionService();
    warmBackend();
    getBackendHealth()
      .then(() => setBackendOnline(true))
      .catch(() => setBackendOnline(false));
  }, []);

  const handleDetectionResult = useCallback((geojson) => {
    setDetectionResult(geojson);
    // Auto-enable the detected slicks layer when results arrive
    setLayers((prev) => ({ ...prev, detectedSlicks: true }));
  }, []);

  const handleSeedOverride = useCallback(({ lat, lon }, slickId) => {
    setApiSeedOverride({ lat, lon });
    setActiveSeedId(slickId);
  }, []);

  const handleClearSeed = useCallback(() => {
    setApiSeedOverride(null);
    setActiveSeedId(null);
  }, []);

  const toggleLayer = (layer) => {
    setLayers((previous) => ({
      ...previous,
      [layer]: !previous[layer],
    }));
  };

  /* =======================================================
     REPLAY CONTROLS
  ======================================================= */

  const [isPlaying, setIsPlaying] = useState(false);
  const [replayProgress, setReplayProgress] = useState(0);
  const [replaySpeed, setReplaySpeed] = useState(1);

  const totalReplayPoints = useMemo(() => {
    if (!scoredVessels.length) return 1;
    return Math.max(
      ...scoredVessels.map((vessel) => vessel.trajectory?.length || 1)
    );
  }, [scoredVessels]);

  const replayProgressRatio = useMemo(() => {
    const maxP = Math.max(1, totalReplayPoints - 1);
    return Math.max(0, Math.min(1, replayProgress / maxP));
  }, [replayProgress, totalReplayPoints]);

  const currentOilFrame = useMemo(
    () => oilSimulation.getFrameByProgress(replayProgressRatio),
    [oilSimulation, replayProgressRatio]
  );

  // Outside Replay mode, show the actual detected-spill state (10:45)
  // instead of leaving the map on the untouched 10:00 release cluster.
  // Replay mode then takes over the exact same simulation clock and slider.
  const detectionOilFrame = useMemo(
    () => oilSimulation.getFrameByProgress(0.6),
    [oilSimulation]
  );

  const displayOilFrame = activeItem === "replay" ? currentOilFrame : detectionOilFrame;
  const currentOilParticles = displayOilFrame?.particles || [];
  const currentOilTrails = displayOilFrame?.trails || [];
  const currentOilFlowLines = displayOilFrame?.flowLines || [];

  /* =======================================================
     REPLAY ENGINE
  ======================================================= */

  useEffect(() => {
    if (!isPlaying) return undefined;

    const intervalTime = 120 / replaySpeed;
    const interval = setInterval(() => {
      setReplayProgress((previous) => {
        const next = previous + 0.035 * replaySpeed;
        if (next >= totalReplayPoints - 1) {
          setIsPlaying(false);
          return totalReplayPoints - 1;
        }
        return next;
      });
    }, intervalTime);

    return () => clearInterval(interval);
  }, [isPlaying, replaySpeed, totalReplayPoints]);

  /* =======================================================
     BACKTRACK RUNNER
  ======================================================= */

  // Full live investigation pipeline against the OilTrace backend:
  // hindcast (OpenDrift) → AIS vessel query → attribution → forward
  // simulation → counterfactual. Every analytical value shown afterwards
  // comes from these responses.
  const handleRunBacktrack = useCallback(async () => {
    if (isBacktracking) return;

    setBacktrackVisible(true);
    setActiveItem("backtrack");
    setIsBacktracking(true);
    setBackendError(null);

    try {
      // The slick to hindcast: an ML-detected slick if the user picked one
      // as seed, otherwise the demo incident slick.
      let slick = null;
      let transposed = false;
      if (activeSeedId && detectionResult?.features?.length) {
        const feature = detectionResult.features.find(
          (f) => String(f?.properties?.id) === String(activeSeedId)
        );
        if (feature) slick = slickFromDetection(feature);
      }
      if (slick && !isWithinForcingCoverage(slick)) {
        // The detected slick lies outside the backend's forcing-data window
        // (the ML demo scene is in the Eastern Mediterranean; forcing covers
        // only the North Sea demo window). Offer to carry its real shape
        // into the demo window so the physics can run — clearly labeled.
        const ok = window.confirm(
          "The detected slick is outside the backend's forcing-data coverage " +
            "(North Sea 4–6°E / 59–61°N, 20–22 Aug 2025 UTC), so OpenDrift has no " +
            "currents or wind there.\n\n" +
            "Run it as a DEMO TRANSPOSITION instead? The slick's real detected " +
            "shape is kept, but its location and time are moved into the demo " +
            "window. Results will be labeled accordingly.\n\n" +
            "Cancel to keep the seed unused (the Norway demo incident runs instead)."
        );
        if (ok) {
          slick = transposeSlickToDemoWindow(slick);
          transposed = true;
        } else {
          slick = null;
        }
      }
      if (!slick) slick = slickFromIncident(incident);

      // Fail fast with a clear message when the slick lies outside the demo
      // forcing-data window — OpenDrift has no currents/wind anywhere else.
      assertWithinForcingCoverage(slick);
      setTransposeNotice(
        transposed
          ? "The ML-detected slick's real shape was moved into the North Sea demo forcing window (location/time are not the detection's own). All results below are computed by the backend on the transposed slick."
          : null
      );

      setBacktrackStatusText("Backend hindcast: OpenDrift backward simulation...");
      const hc = await runHindcast(slick, 2);
      const sourceRegion = sourceRegionForFrontend(hc.source_region);
      setBacktrackResult({
        sourceRegion,
        sourceEstimate: {
          latitude: sourceRegion.center.latitude,
          longitude: sourceRegion.center.longitude,
        },
        confidence: sourceRegion.confidence,
        uncertainty: {
          radiusMeters: sourceRegion.radiusMeters,
          radiusKm: Number((sourceRegion.radiusMeters / 1000).toFixed(2)),
          confidence: sourceRegion.confidence,
          particleConvergence: "Backend OpenDrift hindcast",
        },
        trajectory: trajectoryPoints(hc.backward_trajectory),
        backend: hc,
      });

      setBacktrackStatusText("Querying AIS vessels near the source region...");
      const region = hc.source_region?.candidate_regions?.[0];
      const bbox = bboxFromGeometry(region?.geometry, 0.6);
      const start = shiftIsoHours(region?.start_time_utc || slick.timestamp_utc, -12);
      const end = shiftIsoHours(region?.end_time_utc || slick.timestamp_utc, 12);
      const vessels = await getCandidateVessels(bbox, start, end);

      setBacktrackStatusText("Ranking candidates (backend attribution engine)...");
      const attribution = await runAttribution(
        slick.id || incident.id,
        hc.source_region,
        vessels,
        15
      );
      let normalized = normalizeVessels(vessels, attribution);

      const top = attribution?.top_candidates?.[0];
      if (top?.forward_request) {
        setBacktrackStatusText("Forward simulation from estimated release...");
        const fwd = await runForwardSimulation(top.forward_request);
        setForwardResult(fwd);

        setBacktrackStatusText("Counterfactual: comparing with observed slick...");
        const cf = await runCounterfactual(
          slick.id || incident.id,
          fwd.vessel_mmsi,
          fwd,
          slick
        );
        setCounterfactualResult(cf);

        normalized = normalized.map((v) =>
          String(v.mmsi) === String(top.vessel_mmsi)
            ? {
                ...v,
                evidence: {
                  ...v.evidence,
                  drift: {
                    score: Math.max(0, Math.min(1, +(cf.spatial_agreement || 0))),
                    label:
                      cf.explanation ||
                      `Counterfactual: ${Math.round((cf.spatial_agreement || 0) * 100)}% spatial agreement, ` +
                        `${cf.trajectory_reaches_slick ? "trajectory reaches slick" : "trajectory misses slick"}.`,
                  },
                },
              }
            : v
        );
      } else {
        setForwardResult(null);
        setCounterfactualResult(null);
      }

      setBackendVessels(
        normalized.map((v) => ({
          ...v,
          scoring: buildFrontendScoring(v),
        }))
      );
      setBackendOnline(true);
    } catch (err) {
      setBackendError(err?.message || String(err));
      setBackendOnline(false);
    } finally {
      setIsBacktracking(false);
      setBacktrackStatusText("");
    }
  }, [isBacktracking, activeSeedId, detectionResult]);

  /* =======================================================
     REPLAY POSITION & TRAJECTORY COMPUTATION
  ======================================================= */

  const getReplayPosition = (vessel) => {
    const trajectory = vessel.trajectory || [];
    if (!trajectory.length) {
      return [vessel.position.latitude, vessel.position.longitude];
    }
    if (trajectory.length === 1) {
      return [trajectory[0].latitude, trajectory[0].longitude];
    }

    const clampedProgress = Math.max(
      0,
      Math.min(replayProgress, trajectory.length - 1)
    );
    const lowerIndex = Math.floor(clampedProgress);
    const upperIndex = Math.min(lowerIndex + 1, trajectory.length - 1);
    const fraction = clampedProgress - lowerIndex;

    const start = trajectory[lowerIndex];
    const end = trajectory[upperIndex];

    return [
      start.latitude + (end.latitude - start.latitude) * fraction,
      start.longitude + (end.longitude - start.longitude) * fraction,
    ];
  };

  const getReplayTrajectory = (vessel) => {
    const trajectory = vessel.trajectory || [];
    if (!trajectory.length) return [];

    const visibleProgress = Math.min(replayProgress, trajectory.length - 1);
    const completedPoints = Math.floor(visibleProgress);

    const points = trajectory
      .slice(0, completedPoints + 1)
      .map((point) => [point.latitude, point.longitude]);

    if (completedPoints < trajectory.length - 1) {
      points.push(getReplayPosition(vessel));
    }

    return points;
  };

  /* =======================================================
     SELECTION & NAVIGATION
  ======================================================= */

  const handleSelectVessel = useCallback((vessel) => {
    if (!vessel) return;
    setSelectedVesselId(vessel.id);
    setActiveItem("vessels");
  }, []);

  const handleDeselect = () => {
    setSelectedVesselId(null);
    setActiveItem("map");
  };

  const handleNavigation = (item) => {
    setActiveItem(item);

    // Backtrack graphics belong only to the Backtrack investigation mode.
    // Opening Replay, Legend, Incident, Vessels, Evidence, or Map hides them.
    if (item !== "backtrack") {
      setBacktrackVisible(false);
    }

    if (["map", "incident", "vessels", "legend", "evidence", "tools", "replay", "detect"].includes(item)) {
      setIsPlaying(false);
    }

    if (item === "map") {
      setSelectedVesselId(null);
    }
  };

  const handleSpillClick = () => {
    setBacktrackVisible(false);
    setActiveItem("map");
  };

  const appThemeClass = darkMode ? "app-dark" : "app-light";

  const mapSourceRegion = backtrackVisible ? calculatedSourceRegion : incident.sourceRegion;

  const sourceCenter = [
    Number(mapSourceRegion?.center?.latitude ?? leafletCentroid[0]),
    Number(mapSourceRegion?.center?.longitude ?? leafletCentroid[1]),
  ];
  const sourceRadiusMeters = Number(mapSourceRegion?.radiusMeters ?? 1800);

  const backtrackedCenterline = useMemo(() => {
    if (!backtrackResult?.trajectory) return [];
    return backtrackResult.trajectory.map((pt) => [pt.latitude, pt.longitude]);
  }, [backtrackResult]);

  /* =======================================================
     RENDER (SINGLE MapContainer STRICTLY ENFORCED)
  ======================================================= */

  return (
    <div className={`app ${appThemeClass}`}>
      {/* SIDEBAR */}
      <Sidebar
        activeItem={activeItem}
        layers={layers}
        onToggleLayer={toggleLayer}
        onSelect={handleNavigation}
        onTriggerBacktrack={handleRunBacktrack}
        darkMode={darkMode}
      />

      {/* SINGLE MAP CONTAINER */}
      <MapContainer
        center={leafletCentroid}
        zoom={11}
        className="map"
        preferCanvas={false}
        zoomAnimation={false}
        fadeAnimation={false}
        markerZoomAnimation={false}
      >
        {/* BASE MAP */}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />

        {/* SIMULATED OCEAN CURRENT LAYER */}
        {layers.oceanCurrent && simulatedCurrentVectors.map((vec) => (
          <Fragment key={vec.id}>
            <Polyline
              positions={vec.positions}
              pathOptions={{
                color: "#0284c7",
                weight: 2,
                opacity: 0.8,
                lineCap: "round",
              }}
            >
              <Tooltip sticky direction="top">
                <strong>Simulated Ocean Current</strong>
                <br />
                Speed: {vec.speed.toFixed(2)} m/s ({(vec.speed * 1.94384).toFixed(1)} kts)
                <br />
                Heading: {Math.round(vec.direction)}° (Northwest coastal drift)
              </Tooltip>
            </Polyline>
            <Polyline
              positions={vec.arrowHead}
              pathOptions={{
                color: "#0284c7",
                weight: 2,
                opacity: 0.85,
                lineCap: "round",
              }}
            />
          </Fragment>
        ))}

        {/* SIMULATED WIND FIELD LAYER */}
        {layers.windField && simulatedWindVectors.map((vec) => (
          <Fragment key={vec.id}>
            <Polyline
              positions={vec.positions}
              pathOptions={{
                color: "#f59e0b",
                weight: 2,
                opacity: 0.8,
                lineCap: "round",
              }}
            >
              <Tooltip sticky direction="top">
                <strong>Simulated Wind Field</strong>
                <br />
                Speed: {vec.speed.toFixed(1)} m/s ({(vec.speed * 1.94384).toFixed(1)} kts)
                <br />
                Heading: {Math.round(vec.direction)}° (NNW wind, 3.0% oil windage)
              </Tooltip>
            </Polyline>
            <Polyline
              positions={vec.arrowHead}
              pathOptions={{
                color: "#f59e0b",
                weight: 2,
                opacity: 0.85,
                lineCap: "round",
              }}
            />
          </Fragment>
        ))}

        {/* OIL PARTICLE FIELD (LAGRANGIAN PARTICLE DOTS — Leaflet canvas) */}
        {layers.spill && (
          <DeckOilOverlay
            enabled={layers.spill}
            particles={currentOilParticles}
            trails={currentOilTrails}
          />
        )}

        {/* OIL TRANSPORT FLOW LINES */}
        {layers.oilTrajectory && currentOilFlowLines.map((line, index) => (
          line.path.length >= 2 && (
            <Polyline
              key={line.id}
              positions={line.path}
              pathOptions={{
                color: "#1e293b",
                weight: index === 2 ? 3.5 : 2.2,
                opacity: index === 2 ? 0.86 : 0.52,
                dashArray: index === 2 ? "7 6" : "5 7",
                lineCap: "round",
                lineJoin: "round",
              }}
            >
              {index === 2 && (
                <Tooltip sticky direction="top">
                  <strong>Oil Transport Flow</strong>
                  <br />
                  Modeled current + wind streamline through the densest oil field
                </Tooltip>
              )}
            </Polyline>
          )
        ))}

        {/* BACKTRACKED TRANSPORT PATH */}
        {backtrackVisible && layers.backtrack && backtrackedCenterline.length >= 2 && (
          <Polyline
            positions={backtrackedCenterline}
            pathOptions={{
              color: "#06b6d4",
              weight: 3.5,
              opacity: 0.9,
              dashArray: "4 6",
              lineCap: "round",
            }}
          >
            <Tooltip sticky direction="top">
              <strong>Backtracked Transport Path</strong>
              <br />
              Inferred historical drift path (Confidence: {backtrackResult?.confidence}%)
            </Tooltip>
          </Polyline>
        )}

        {/* BACKTRACKED SUSPECT INTERSECTION LINK */}
        {backtrackVisible && layers.backtrack && backtrackResult && scoredVessels.find((v) => v.candidateRank === 1) && (
          <Polyline
            positions={[
              sourceCenter,
              [
                Number(scoredVessels.find((v) => v.candidateRank === 1).position.latitude),
                Number(scoredVessels.find((v) => v.candidateRank === 1).position.longitude),
              ],
            ]}
            pathOptions={{
              color: "#d97706",
              weight: 2.5,
              opacity: 0.9,
              dashArray: "4 6",
              lineCap: "round",
            }}
          >
            <Tooltip sticky direction="top">
              <strong>Candidate Vessel Intersection</strong>
              <br />
              Top Suspect: {scoredVessels.find((v) => v.candidateRank === 1).name} (
              {Math.round(scoredVessels.find((v) => v.candidateRank === 1).attributionConfidence * 100)}% Confidence)
            </Tooltip>
          </Polyline>
        )}

        {/* BACKEND FORWARD SIMULATION: trajectory + predicted footprint */}
        {backtrackVisible && layers.backtrack && forwardResult?.trajectory?.coordinates?.length >= 2 && (
          <Polyline
            positions={forwardResult.trajectory.coordinates.map(([lon, lat]) => [lat, lon])}
            pathOptions={{
              color: "#7c3aed",
              weight: 3,
              opacity: 0.9,
              dashArray: "2 7",
              lineCap: "round",
            }}
          >
            <Tooltip sticky direction="top">
              <strong>Forward Simulation (backend)</strong>
              <br />
              Release {forwardResult.release_time_utc} · MMSI {forwardResult.vessel_mmsi}
            </Tooltip>
          </Polyline>
        )}
        {backtrackVisible && layers.backtrack && forwardResult?.predicted_footprint && (
          <Polygon
            positions={
              forwardResult.predicted_footprint.type === "Polygon"
                ? [forwardResult.predicted_footprint.coordinates[0].map(([lon, lat]) => [lat, lon])]
                : forwardResult.predicted_footprint.coordinates.map((poly) =>
                    poly[0].map(([lon, lat]) => [lat, lon])
                  )
            }
            pathOptions={{
              color: "#0d9488",
              weight: 2,
              opacity: 0.9,
              fillColor: "#0d9488",
              fillOpacity: 0.16,
            }}
          >
            <Tooltip sticky direction="top">
              <strong>Predicted Footprint (backend)</strong>
              <br />
              Simulated particle envelope — not an observed slick
              {counterfactualResult && (
                <>
                  <br />
                  Counterfactual: {Math.round((counterfactualResult.spatial_agreement || 0) * 100)}%
                  overlap · {counterfactualResult.evidence_strength}
                </>
              )}
            </Tooltip>
          </Polygon>
        )}

        {/* API DETECTED SLICK POLYGONS (from Detection Service) */}
        {layers.detectedSlicks && detectionResult && detectionResult.features.map((feature) => {
          const { id, confidence, area_km2, centroid: slickCentroid } = feature.properties;
          const geometry = feature.geometry;
          // Convert GeoJSON [lon, lat] coords to Leaflet [lat, lon]
          const toLeaflet = (coords) => coords.map(([lon, lat]) => [lat, lon]);

          const ringPositions =
            geometry.type === "Polygon"
              ? [toLeaflet(geometry.coordinates[0])]
              : geometry.coordinates.map((poly) => toLeaflet(poly[0]));

          const slickColor = confidence >= 0.75 ? "#06b6d4" : "#22d3ee";
          const confidencePct = Math.round(confidence * 100);

          return (
            <Fragment key={`api-slick-${id}`}>
              {/* Outer ring(s) */}
              {ringPositions.map((ring, ri) => (
                <Polygon
                  key={`ring-${id}-${ri}`}
                  positions={ring}
                  pathOptions={{
                    color: slickColor,
                    weight: 2,
                    opacity: 0.9,
                    fillColor: slickColor,
                    fillOpacity: 0.12,
                    lineCap: "round",
                    lineJoin: "round",
                    dashArray: "6 5",
                  }}
                >
                  <Tooltip sticky direction="top">
                    <strong>API Detection: {id}</strong>
                    <br />
                    Area: {area_km2.toFixed(1)} km²
                    <br />
                    Confidence: {confidencePct}%
                    {confidence < 0.75 && <em> (uncertain)</em>}
                    <br />
                    Centroid: {slickCentroid.lat.toFixed(4)}°N {slickCentroid.lon.toFixed(4)}°E
                  </Tooltip>
                </Polygon>
              ))}
              {/* Centroid marker */}
              <CircleMarker
                center={[slickCentroid.lat, slickCentroid.lon]}
                radius={5}
                pathOptions={{
                  color: slickColor,
                  weight: 2,
                  opacity: 1,
                  fillColor: slickColor,
                  fillOpacity: 0.85,
                }}
              >
                <Tooltip direction="top" offset={[0, -6]}>
                  <strong>Slick centroid: {id}</strong>
                  <br />
                  {slickCentroid.lat.toFixed(5)}°N, {slickCentroid.lon.toFixed(5)}°E
                </Tooltip>
              </CircleMarker>
            </Fragment>
          );
        })}

        {/* SPILL POLYGON */}
        {layers.spill && spillPolygon.length >= 3 && (
          <Polygon
            positions={spillPolygon}
            pathOptions={{
              color: "#ef4444",
              weight: 2,
              opacity: 0.9,
              fillColor: "#ef4444",
              fillOpacity: 0.08,
              lineCap: "round",
              lineJoin: "round",
            }}
            eventHandlers={{ click: handleSpillClick }}
          >
            <Tooltip sticky direction="top">
              <strong>Detected Oil Spill</strong>
              <br />
              Area: {incident.areaKm2} km²
              <br />
              Detection confidence: {getConfidencePercent(incident.detectionConfidence)}%
            </Tooltip>
          </Polygon>
        )}

        {/* SOURCE UNCERTAINTY REGION */}
        {layers.sourceRegion && sourceRadiusMeters > 0 && (
          <Circle
            center={sourceCenter}
            radius={sourceRadiusMeters}
            pathOptions={{
              color: backtrackVisible && backtrackResult ? "#0284c7" : "#2563eb",
              weight: 2.5,
              opacity: 0.9,
              dashArray: "8 7",
              fillColor: backtrackVisible && backtrackResult ? "#0284c7" : "#2563eb",
              fillOpacity: 0.04,
            }}
          >
            <Tooltip sticky direction="top">
              <strong>
                {backtrackVisible && backtrackResult ? "Calculated Source Region" : "Probable Source Region"}
              </strong>
              <br />
              Confidence: {(backtrackVisible ? calculatedSourceRegion : incident.sourceRegion)?.confidence ?? 78}%
              <br />
              Uncertainty Radius: {(sourceRadiusMeters / 1000).toFixed(2)} km
            </Tooltip>
          </Circle>
        )}

        {/* SPILL CENTROID */}
        {layers.spill && (
          <>
            <CircleMarker
              center={leafletCentroid}
              radius={7}
              pathOptions={{
                color: "#b91c1c",
                weight: 2,
                opacity: 1,
                fillColor: "#ef4444",
                fillOpacity: 0.9,
              }}
            >
              <Tooltip direction="top" offset={[0, -7]}>
                <strong>Spill Centroid</strong>
                <br />
                {incident.centroid.latitude.toFixed(4)}, {incident.centroid.longitude.toFixed(4)}
              </Tooltip>
            </CircleMarker>

            <CircleMarker
              center={leafletCentroid}
              radius={2.5}
              pathOptions={{
                stroke: false,
                fillColor: "#ffffff",
                fillOpacity: 1,
              }}
            />
          </>
        )}

        {/* MAP TOOLBAR */}
        <MapToolbar
          darkMode={darkMode}
          onToggleTheme={() => setDarkMode((prev) => !prev)}
          onTriggerBacktrack={handleRunBacktrack}
          isBacktracking={isBacktracking}
        />

        {/* INITIAL MAP FIT */}
        <FitMapToIncident />

        {/* VESSELS + TRAJECTORIES */}
        {scoredVessels.map((vessel) => {
          const isSelected = selectedVesselId === vessel.id;
          const hasSelection = Boolean(selectedVesselId);
          const showVesselTooltip = !selectedVesselId;

          const normalTrajectory = (vessel.trajectory || []).map((point) => [
            Number(point.latitude),
            Number(point.longitude),
          ]);

          const replayTrajectory = getReplayTrajectory(vessel);
          const replayPosition = getReplayPosition(vessel);

          let polylineColor = "#94a3b8";
          let polylineWeight = 2;
          let polylineOpacity = 0.45;

          if (isSelected) {
            polylineColor = "#2563eb";
            polylineWeight = 5;
            polylineOpacity = 1;
          } else if (vessel.candidateRank === 1) {
            polylineColor = "#d97706";
            polylineWeight = 3.5;
            polylineOpacity = hasSelection ? 0.75 : 0.95;
          } else if (hasSelection) {
            polylineColor = "#94a3b8";
            polylineWeight = 2;
            polylineOpacity = 0.18;
          }

          const handleVesselClick = (event) => {
            if (event?.originalEvent) {
              L.DomEvent.stopPropagation(event.originalEvent);
            }
            handleSelectVessel(vessel);
          };

          return (
            <Fragment key={vessel.id}>
              {/* NORMAL TRAJECTORY */}
              {layers.trajectories && !isPlaying && normalTrajectory.length >= 2 && (
                <>
                  {isSelected && (
                    <Polyline
                      positions={normalTrajectory}
                      pathOptions={{
                        color: "#60a5fa",
                        weight: 11,
                        opacity: 0.18,
                        lineCap: "round",
                        lineJoin: "round",
                      }}
                    />
                  )}
                  <Polyline
                    positions={normalTrajectory}
                    pathOptions={{
                      color: polylineColor,
                      weight: polylineWeight,
                      opacity: polylineOpacity,
                      lineCap: "round",
                      lineJoin: "round",
                    }}
                  />
                </>
              )}

              {/* REPLAY TRAJECTORY */}
              {layers.trajectories && isPlaying && replayTrajectory.length >= 2 && (
                <>
                  {isSelected && (
                    <Polyline
                      positions={replayTrajectory}
                      pathOptions={{
                        color: "#60a5fa",
                        weight: 11,
                        opacity: 0.18,
                        lineCap: "round",
                        lineJoin: "round",
                      }}
                    />
                  )}
                  <Polyline
                    positions={replayTrajectory}
                    pathOptions={{
                      color: isSelected
                        ? "#2563eb"
                        : vessel.candidateRank === 1
                        ? "#d97706"
                        : "#94a3b8",
                      weight: isSelected ? 5 : vessel.candidateRank === 1 ? 3 : 2,
                      opacity: isSelected ? 1 : vessel.candidateRank === 1 ? 0.9 : 0.5,
                      lineCap: "round",
                      lineJoin: "round",
                    }}
                  />
                </>
              )}

              {/* NORMAL VESSEL MARKER */}
              {layers.vessels && !isPlaying && (
                <Marker
                  position={[
                    Number(vessel.position.latitude),
                    Number(vessel.position.longitude),
                  ]}
                  icon={createVesselIcon({
                    selected: isSelected,
                    candidateRank: vessel.candidateRank,
                    attributionConfidence: vessel.attributionConfidence,
                  })}
                  interactive
                  zIndexOffset={
                    isSelected
                      ? 1000
                      : vessel.candidateRank === 1
                      ? 200
                      : 0
                  }
                  eventHandlers={{ click: handleVesselClick }}
                >
                  <VesselPopup vessel={vessel} show={showVesselTooltip} />
                </Marker>
              )}

              {/* REPLAY VESSEL MARKER */}
              {layers.vessels && isPlaying && (
                <Marker
                  position={replayPosition}
                  icon={createVesselIcon({
                    selected: isSelected,
                    replay: true,
                    candidateRank: vessel.candidateRank,
                    attributionConfidence: vessel.attributionConfidence,
                  })}
                  interactive
                  zIndexOffset={
                    isSelected
                      ? 1000
                      : vessel.candidateRank === 1
                      ? 200
                      : 0
                  }
                  eventHandlers={{ click: handleVesselClick }}
                >
                  <VesselPopup vessel={vessel} show={showVesselTooltip} />
                </Marker>
              )}
            </Fragment>
          );
        })}
      </MapContainer>

      {/* BACKTRACK ANALYSIS PANEL */}
      {isBacktracking && (
        <div style={{
          position: "fixed",
          bottom: "2rem",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 3000,
          width: "340px",
          background: "linear-gradient(135deg, rgba(6,18,42,0.97) 0%, rgba(8,28,60,0.97) 100%)",
          border: "1px solid rgba(6,182,212,0.35)",
          borderRadius: "16px",
          boxShadow: "0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(6,182,212,0.12), inset 0 1px 0 rgba(255,255,255,0.06)",
          backdropFilter: "blur(20px)",
          overflow: "hidden",
          animation: "backtrackPanelIn 0.35s cubic-bezier(0.16,1,0.3,1)",
        }}>
          {/* Animated cyan scan line */}
          <div style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "2px",
            background: "linear-gradient(90deg, transparent, #06b6d4, #22d3ee, transparent)",
            animation: "scanLine 1.8s ease-in-out infinite",
          }} />

          <div style={{ padding: "1.25rem 1.25rem 1rem" }}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
              {/* Sonar pulse ring */}
              <div style={{ position: "relative", width: "36px", height: "36px", flexShrink: 0 }}>
                <div style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: "50%",
                  border: "2px solid #06b6d4",
                  animation: "sonarPulse 1.4s ease-out infinite",
                }} />
                <div style={{
                  position: "absolute",
                  inset: "6px",
                  borderRadius: "50%",
                  background: "rgba(6,182,212,0.2)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "13px",
                }}>🔍</div>
              </div>
              <div>
                <div style={{
                  color: "#e2e8f0",
                  fontWeight: 700,
                  fontSize: "0.85rem",
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                }}>Backtrack Analysis</div>
                <div style={{
                  color: "#06b6d4",
                  fontSize: "0.7rem",
                  fontWeight: 500,
                  marginTop: "1px",
                }}>Lagrangian Backward Transport</div>
              </div>
            </div>

            {/* Current step */}
            <div style={{
              background: "rgba(6,182,212,0.08)",
              border: "1px solid rgba(6,182,212,0.2)",
              borderRadius: "10px",
              padding: "0.6rem 0.85rem",
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              marginBottom: "0.9rem",
            }}>
              <span style={{
                display: "inline-block",
                width: "14px",
                height: "14px",
                border: "2px solid #06b6d4",
                borderTopColor: "transparent",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
                flexShrink: 0,
              }} />
              <span style={{ color: "#94a3b8", fontSize: "0.78rem", lineHeight: 1.4 }}>
                {backtrackStatusText || "Initialising backward transport engine..."}
              </span>
            </div>

            {/* Progress steps */}
            {[
              "OpenDrift backward hindcast (backend)",
              "AIS vessel query near source region",
              "Attribution engine ranking",
              "Forward simulation + counterfactual",
            ].map((step, i) => (
              <div key={step} style={{
                display: "flex",
                alignItems: "center",
                gap: "0.55rem",
                marginBottom: "0.4rem",
                opacity: 0.55 + i * 0.1,
              }}>
                <div style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background: "#06b6d4",
                  flexShrink: 0,
                  animation: `dotPulse ${0.6 + i * 0.25}s ease-in-out infinite alternate`,
                }} />
                <span style={{ color: "#64748b", fontSize: "0.72rem" }}>{step}</span>
              </div>
            ))}
          </div>

          {/* Animated progress bar */}
          <div style={{ height: "3px", background: "rgba(255,255,255,0.05)", position: "relative" }}>
            <div style={{
              position: "absolute",
              left: 0,
              top: 0,
              height: "100%",
              width: "60%",
              background: "linear-gradient(90deg, #06b6d4, #22d3ee)",
              borderRadius: "0 2px 2px 0",
              animation: "progressBar 1.4s ease-in-out infinite alternate",
              boxShadow: "0 0 8px rgba(6,182,212,0.6)",
            }} />
          </div>
        </div>
      )}

      {/* DEMO TRANSPOSITION NOTICE */}
      {transposeNotice && !isBacktracking && (
        <div
          style={{
            position: "fixed",
            top: "5.2rem",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2900,
            maxWidth: "520px",
            background: "rgba(45,30,4,0.95)",
            border: "1px solid rgba(245,158,11,0.5)",
            borderRadius: "12px",
            padding: "0.7rem 1rem",
            color: "#fde68a",
            fontSize: "0.78rem",
            lineHeight: 1.45,
            boxShadow: "0 14px 36px rgba(0,0,0,0.45)",
          }}
        >
          <strong style={{ color: "#fbbf24" }}>Demo transposition.</strong>{" "}
          {transposeNotice}
          <button
            onClick={() => setTransposeNotice(null)}
            style={{
              marginLeft: "0.6rem",
              background: "none",
              border: "1px solid rgba(251,191,36,0.5)",
              borderRadius: "7px",
              color: "#fcd34d",
              padding: "0.12rem 0.5rem",
              fontSize: "0.7rem",
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* BACKEND ERROR TOAST */}
      {backendError && (
        <div
          style={{
            position: "fixed",
            bottom: "2rem",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 3000,
            maxWidth: "440px",
            background: "rgba(40,10,12,0.96)",
            border: "1px solid rgba(239,68,68,0.45)",
            borderRadius: "12px",
            padding: "0.8rem 1rem",
            color: "#fecaca",
            fontSize: "0.8rem",
            lineHeight: 1.45,
            boxShadow: "0 18px 44px rgba(0,0,0,0.5)",
          }}
        >
          <strong style={{ color: "#f87171" }}>Backend request failed.</strong>{" "}
          {backendError}
          {backendOnline === false && (
            <>
              {" "}Check that the OilTrace backend is running and reachable
              (VITE_BACKEND_BASE_URL).
            </>
          )}
          <button
            onClick={() => setBackendError(null)}
            style={{
              marginLeft: "0.7rem",
              background: "none",
              border: "1px solid rgba(248,113,113,0.5)",
              borderRadius: "7px",
              color: "#fca5a5",
              padding: "0.15rem 0.55rem",
              fontSize: "0.72rem",
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* INCIDENT PANEL */}
      {activeItem === "incident" && (
        <IncidentPanel
          vessels={scoredVessels}
          onSelectVessel={handleSelectVessel}
          onClose={() => setActiveItem("map")}
          onTriggerBacktrack={handleRunBacktrack}
          isBacktracking={isBacktracking}
        />
      )}

      {/* VESSEL / SUSPECT PANEL */}
      {activeItem === "vessels" && (
        <SuspectPanel
          selectedVessel={selectedVessel}
          allVessels={scoredVessels}
          onSelectVessel={handleSelectVessel}
          onClose={handleDeselect}
        />
      )}

      {/* LEGEND */}
      {activeItem === "legend" && (
        <LegendPanel onClose={() => setActiveItem("map")} />
      )}

      {/* REPLAY PANEL */}
      {activeItem === "replay" && (
        <ReplayPanel
          vessels={scoredVessels}
          isPlaying={isPlaying}
          setIsPlaying={setIsPlaying}
          replayProgress={replayProgress}
          setReplayProgress={setReplayProgress}
          replaySpeed={replaySpeed}
          setReplaySpeed={setReplaySpeed}
          totalPoints={totalReplayPoints}
          timeLabel={currentOilFrame?.timeLabel}
          onClose={() => {
            setIsPlaying(false);
            setActiveItem("map");
          }}
        />
      )}

      {/* EVIDENCE PANEL */}
      {activeItem === "evidence" && (
        <EvidencePanel
          vessel={selectedVessel}
          onClose={() => setActiveItem(selectedVessel ? "vessels" : "map")}
        />
      )}

      {/* DETECTION SERVICE PANEL */}
      {activeItem === "detect" && (
        <DetectionPanel
          onDetectionResult={handleDetectionResult}
          onClose={() => setActiveItem("map")}
          onSeedOverride={handleSeedOverride}
          onClearSeed={handleClearSeed}
          activeSeedId={activeSeedId}
          currentResult={detectionResult}
        />
      )}
    </div>
  );
}

export default App;