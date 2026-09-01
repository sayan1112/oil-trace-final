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
import InvestigationList from "./components/InvestigationList";
import { TimelineControl } from "./components/TimelineControl";
import "./components/InvestigationList.css";

import "./App.css";

import {
  warmBackend,
  getBackendHealth,
  runHindcast,
  getCandidateVessels,
  runAttribution,
  runForwardSimulation,
  runCounterfactual,
  getReplay,
  bboxFromGeometry,
  trajectoryPoints,
  sourceRegionForFrontend,
  slickFromDetection,
  slickFromIncident,
  normalizeVessels,
  buildFrontendScoring,
  shiftIsoHours,
  assertWithinForcingCoverage,
  getActiveBackendUrl,
  describeHindcastFailure,
  describeEmptyMediterraneanAis,
  CANONICAL_INCIDENT_ID,
  CANONICAL_AIS_BBOX,
  CANONICAL_AIS_START,
  CANONICAL_AIS_END,
  incidentFromDetection,
  vesselsFromReplay,
  vesselsNearCentroid,
} from "./services/backendApi";
import DriftCloudOverlay from "./components/DriftCloudOverlay";
import { generateOilSimulation } from "./Simulation/oilSimulation";
import { defaultCurrentField } from "./Simulation/currentField";
import { defaultWindField } from "./Simulation/windField";
import { backtrackOil } from "./Simulation/backtracking";
import { warmDetectionService, fetchDemoDetection } from "./services/detectionApi";

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

const INCIDENT_SEED = incidentData.incident;

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
          <svg class="vessel-marker-symbol" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M4 15h16l-2 4H6l-2-4Z" />
            <path d="M8 15V9h8v6" />
          </svg>
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

function polygonFromIncident(inc) {
  return Array.isArray(inc?.spillPolygon)
    ? inc.spillPolygon
        .filter(
          (point) =>
            Array.isArray(point) &&
            point.length >= 2 &&
            Number.isFinite(Number(point[0])) &&
            Number.isFinite(Number(point[1]))
        )
        .map(([latitude, longitude]) => [Number(latitude), Number(longitude)])
    : [];
}

function centroidFromIncident(inc) {
  return [
    Number(inc?.centroid?.latitude ?? inc?.location?.latitude),
    Number(inc?.centroid?.longitude ?? inc?.location?.longitude),
  ];
}

/* =========================================================
   MAP HELPERS
========================================================= */

function getIncidentPoints(inc = INCIDENT_SEED) {
  const points = [];

  if (Array.isArray(inc?.spillPolygon)) {
    inc.spillPolygon.forEach((point) => {
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
    inc?.centroid &&
    Number.isFinite(Number(inc.centroid.latitude)) &&
    Number.isFinite(Number(inc.centroid.longitude))
  ) {
    points.push([
      Number(inc.centroid.latitude),
      Number(inc.centroid.longitude),
    ]);
  }

  if (Array.isArray(inc?.vessels)) {
    inc.vessels.forEach((vessel) => {
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

function pipelineStepIndex(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("ais")) return 1;
  if (t.includes("rank") || t.includes("attrib")) return 2;
  if (t.includes("forward") || t.includes("counter")) return 3;
  return 0;
}

function MapFill() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer()?.parentElement;
    if (!container) return undefined;
    const fit = () => map.invalidateSize({ pan: false });
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    fit();
    return () => observer.disconnect();
  }, [map]);
  return null;
}

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
        paddingTopLeft: [24, 24],
        paddingBottomRight: [24, 80],
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
   INVESTIGATION FOCUS CONTROLLER
   Keeps the visible area on the spill/vessel action:
   - refits automatically as each backend stage completes
   - soft-bounds panning so the user can't drift far from the scene
========================================================= */

function MapFocusController({ storyPoints, scenePoints, stageKey }) {
  const map = useMap();
  const lastKeyRef = useRef("0-0-0");

  useEffect(() => {
    if (stageKey === lastKeyRef.current) return;
    lastKeyRef.current = stageKey;
    // Vessels stage frames ships + spill; other stages frame the drift story.
    const pts = stageKey === "1-1-0" ? scenePoints : storyPoints;
    if (!pts.length) return;
    map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: [24, 24],
      paddingBottomRight: [24, 80],
      maxZoom: 12,
      animate: true,
      duration: 0.9,
    });
  }, [map, stageKey, storyPoints, scenePoints]);

  useEffect(() => {
    const pts = scenePoints.length ? scenePoints : storyPoints;
    if (!pts.length) return;
    map.setMaxBounds(L.latLngBounds(pts).pad(2.5));
    map.options.maxBoundsViscosity = 0.6;
    if (map.getMinZoom() < 6) map.setMinZoom(6);
  }, [map, storyPoints, scenePoints]);

  return null;
}

/* =========================================================
   MAP TOOLBAR
========================================================= */

function MapToolbar({ onTriggerBacktrack, isBacktracking, storyPoints, scenePoints }) {
  const map = useMap();

  const fitTo = (points) => {
    if (!points?.length) points = getIncidentPoints();
    if (!points.length) return;
    map.fitBounds(L.latLngBounds(points), {
      paddingTopLeft: [24, 24],
      paddingBottomRight: [24, 80],
      maxZoom: 12,
      animate: true,
      duration: 0.7,
    });
  };

  const handleResetView = () => fitTo(scenePoints);

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
        title="Run hindcast"
      >
        {isBacktracking ? "…" : "↩"}
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
        title="Reset view — spill + all vessels"
        aria-label="Reset view to spill and vessels"
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
        onClick={() => fitTo(storyPoints)}
        title="Focus spill — slick, source region & drift"
        aria-label="Focus on the oil spill drift story"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4c3.2 4 5.6 6.9 5.6 9.8a5.6 5.6 0 1 1-11.2 0C6.4 10.9 8.8 8 12 4z" />
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

function IncidentPanel({ incident, vessels, onSelectVessel, onClose, onTriggerBacktrack, isBacktracking }) {
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
        <div className="incident-coord-chip">
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

      <section className="context-section">
        <span className="context-section-label">SOURCE ESTIMATION</span>
        <h4 className="incident-title">Backward trajectory</h4>
        <p className="incident-time">
          Reconstruct oil transport back from detection to estimate the origin region.
        </p>
        <button
          type="button"
          className="inspect-candidate-button"
          onClick={onTriggerBacktrack}
          disabled={isBacktracking}
        >
          {isBacktracking ? "Running hindcast…" : "Run hindcast"}
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
          {(incident.timeline || []).map((event, index) => (
            <div
              className={`incident-timeline-item ${
                index === (incident.timeline || []).length - 1 ? "timeline-final" : ""
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
  const [incident, setIncident] = useState(INCIDENT_SEED);
  const leafletCentroid = centroidFromIncident(incident);
  const spillPolygon = polygonFromIncident(incident);

  const oilSimulation = useMemo(
    () => generateOilSimulation({ incident }),
    [incident]
  );

  const simulatedCurrentVectors = useMemo(() => {
    const [clat, clng] = centroidFromIncident(incident);
    if (!Number.isFinite(clat) || !Number.isFinite(clng)) return [];
    const vectors = [];
    for (let lat = clat - 0.22; lat <= clat + 0.22; lat += 0.055) {
      for (let lng = clng - 0.36; lng <= clng + 0.36; lng += 0.075) {
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
  }, [incident]);

  const simulatedWindVectors = useMemo(() => {
    const [clat, clng] = centroidFromIncident(incident);
    if (!Number.isFinite(clat) || !Number.isFinite(clng)) return [];
    const vectors = [];
    for (let lat = clat - 0.2; lat <= clat + 0.2; lat += 0.055) {
      for (let lng = clng - 0.32; lng <= clng + 0.32; lng += 0.075) {
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
  }, [incident]);

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
  const [backendHost, setBackendHost] = useState("");
  const [transposeNotice, setTransposeNotice] = useState(null);
  const [replayMeta, setReplayMeta] = useState(null);
  const [activeSlick, setActiveSlick] = useState(null); // slick sent to the backend

  const calculatedSourceRegion = backtrackResult?.sourceRegion || null;

  const scoredVessels = useMemo(
    () => vesselsNearCentroid(backendVessels || [], incident.centroid),
    [backendVessels, incident]
  );

  /* =======================================================
     LIVE FOCUS GEOMETRY (what the camera should frame)
  ======================================================= */

  // "Story": where the oil is — slick, source region, drift trajectories,
  // predicted footprint. Always from the live investigation state.
  const storyPoints = useMemo(() => {
    const pts = [];
    const pushRing = (ring) =>
      (ring || []).forEach(([lon, lat]) => pts.push([+lat, +lon]));
    const pushGeom = (g) => {
      if (!g) return;
      if (g.type === "Polygon") g.coordinates.forEach(pushRing);
      else if (g.type === "MultiPolygon")
        g.coordinates.forEach((poly) => poly.forEach(pushRing));
      else if (g.type === "LineString") pushRing(g.coordinates);
    };
    if (activeSlick?.geometry) pushGeom(activeSlick.geometry);
    else spillPolygon.forEach((p) => pts.push(p));
    pushGeom(calculatedSourceRegion?.geometry);
    if (calculatedSourceRegion?.center)
      pts.push([
        +calculatedSourceRegion.center.latitude,
        +calculatedSourceRegion.center.longitude,
      ]);
    (backtrackResult?.trajectory || []).forEach((p) =>
      pts.push([+p.latitude, +p.longitude])
    );
    pushGeom(forwardResult?.trajectory);
    pushGeom(forwardResult?.predicted_footprint);
    return pts.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  }, [activeSlick, calculatedSourceRegion, backtrackResult, forwardResult]);

  // "Scene": story + every vessel's track — spill AND ships in frame.
  const scenePoints = useMemo(() => {
    const pts = [...storyPoints];
    scoredVessels.forEach((v) => {
      if (v.position)
        pts.push([+v.position.latitude, +v.position.longitude]);
      (v.trajectory || []).forEach((p) =>
        pts.push([+p.latitude, +p.longitude])
      );
    });
    return pts.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  }, [storyPoints, scoredVessels]);

  const focusStageKey = `${backtrackResult ? 1 : 0}-${backendVessels ? 1 : 0}-${forwardResult ? 1 : 0}`;

  /* =======================================================
     MASTER SIMULATION CLOCK
     One UTC clock spanning the backend simulation window
     drives the Replay panel, the vessel replay AND the
     drift particle cloud - everything stays in sync.
  ======================================================= */

  const simRange = useMemo(() => {
    const ts = [];
    (backtrackResult?.backend?.trajectory_timestamps_utc || []).forEach((t) =>
      ts.push(Date.parse(t))
    );
    (forwardResult?.trajectory_timestamps_utc || []).forEach((t) =>
      ts.push(Date.parse(t))
    );
    if (replayMeta?.start_time_utc) ts.push(Date.parse(replayMeta.start_time_utc));
    if (replayMeta?.end_time_utc) ts.push(Date.parse(replayMeta.end_time_utc));
    (replayMeta?.frames || []).forEach((frame) => ts.push(Date.parse(frame.timestamp_utc)));
    const valid = ts.filter(Number.isFinite);
    if (valid.length < 2) return null;
    return { t0: Math.min(...valid), t1: Math.max(...valid) };
  }, [backtrackResult, forwardResult, replayMeta]);

  const [simMs, setSimMs] = useState(null);

  const fmtSimClock = (ms) => {
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };

  /* =======================================================
     ACTIVE SIDEBAR ITEM & THEME
  ======================================================= */

  const [activeItem, setActiveItem] = useState("map");
  const [mapStyle, setMapStyle] = useState("map");

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
      .then(() => {
        setBackendOnline(true);
        setBackendHost(getActiveBackendUrl());
      })
      .catch(() => setBackendOnline(false));

    fetchDemoDetection()
      .then((geojson) => {
        setDetectionResult(geojson);
        setLayers((prev) => ({ ...prev, detectedSlicks: true }));
        const feature = geojson?.features?.[0];
        if (!feature) return;
        const next = incidentFromDetection(feature, INCIDENT_SEED);
        setIncident(next);
        const slick = slickFromDetection(feature);
        setActiveSlick({
          ...slick,
          id: CANONICAL_INCIDENT_ID,
          timestamp_utc: slick.timestamp_utc || INCIDENT_SEED.detectedAt,
        });
        setActiveSeedId(feature.properties?.id || CANONICAL_INCIDENT_ID);
      })
      .catch(() => {});

    getReplay(CANONICAL_INCIDENT_ID)
      .then((replay) => {
        setReplayMeta(replay);
        const fromReplay = vesselsNearCentroid(
          vesselsFromReplay(replay),
          INCIDENT_SEED.centroid
        );
        if (fromReplay.length) {
          setBackendVessels((current) => current || fromReplay);
        }
      })
      .catch(() => {});

    getCandidateVessels(CANONICAL_AIS_BBOX, CANONICAL_AIS_START, CANONICAL_AIS_END)
      .then((vessels) => {
        const normalized = vesselsNearCentroid(
          normalizeVessels(vessels, null),
          INCIDENT_SEED.centroid
        );
        if (normalized.length) setBackendVessels(normalized);
      })
      .catch(() => {});
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
    const fromReplay = replayMeta?.frames?.length || 0;
    const fromTracks = scoredVessels.length
      ? Math.max(...scoredVessels.map((vessel) => vessel.trajectory?.length || 1))
      : 0;
    return Math.max(1, fromReplay, fromTracks);
  }, [scoredVessels, replayMeta]);

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
  // The local illustrative plume is a pre-analysis visual only. Once the
  // backend pipeline has produced real drift results, hide it — its
  // hardcoded wind/current constants contradict the OpenDrift output.
  const showLocalPlume = true;
  const currentOilParticles = showLocalPlume ? displayOilFrame?.particles || [] : [];
  const currentOilTrails = showLocalPlume ? displayOilFrame?.trails || [] : [];
  const currentOilFlowLines = showLocalPlume ? displayOilFrame?.flowLines || [] : [];

  /* =======================================================
     REPLAY ENGINE
  ======================================================= */

  useEffect(() => {
    if (!isPlaying) return undefined;

    // Time-based engine: advance the master UTC clock smoothly over the
    // backend simulation window (~16 s per full run at 1x).
    if (simRange) {
      let raf, last = performance.now();
      let cur = Number.isFinite(simMs) ? simMs : simRange.t0;
      if (cur >= simRange.t1 - 500) cur = simRange.t0;
      const rate = ((simRange.t1 - simRange.t0) / 16000) * replaySpeed;
      const tick = (now) => {
        cur = Math.min(simRange.t1, cur + (now - last) * rate);
        last = now;
        setSimMs(cur);
        if (cur >= simRange.t1) { setIsPlaying(false); return; }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }

    // Legacy index-based engine (pre-analysis demo replay).
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, replaySpeed, totalReplayPoints, simRange]);

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
    setActiveItem("map");
    setIsBacktracking(true);
    setBackendError(null);

    try {
      let slick = null;
      if (activeSeedId && detectionResult?.features?.length) {
        const feature = detectionResult.features.find(
          (f) => String(f?.properties?.id) === String(activeSeedId)
        );
        if (feature) slick = slickFromDetection(feature);
      }
      if (slick && apiSeedOverride) {
        slick = {
          ...slick,
          centroid: { lat: apiSeedOverride.lat, lon: apiSeedOverride.lon },
        };
      }
      if (!slick) slick = slickFromIncident(incident);
      slick = {
        ...slick,
        id: CANONICAL_INCIDENT_ID,
        timestamp_utc: slick.timestamp_utc || incident.detectedAt,
      };

      assertWithinForcingCoverage(slick);
      setTransposeNotice(null);
      setActiveSlick(slick);
      setForwardResult(null);
      setCounterfactualResult(null);

      setBacktrackStatusText("Reconstructing oil transport…");
      const local = backtrackOil({
        incident,
        centroid: {
          latitude: slick.centroid.lat,
          longitude: slick.centroid.lon,
        },
      });
      if (local) {
        setBacktrackResult(local);
        setBacktrackVisible(true);
      }

      let hc = null;
      let hindcastNotice = null;
      try {
        setBacktrackStatusText("OpenDrift hindcast…");
        hc = await runHindcast(slick, 6);
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
        setIncident((prev) => ({ ...prev, sourceRegion }));
      } catch (hindcastErr) {
        hindcastNotice = describeHindcastFailure(hindcastErr?.message || String(hindcastErr));
      }

      const region = hc?.source_region?.candidate_regions?.[0];
      const bbox = region?.geometry
        ? bboxFromGeometry(region.geometry, 0.6)
        : CANONICAL_AIS_BBOX;
      const start = region?.start_time_utc
        ? shiftIsoHours(region.start_time_utc, -12)
        : CANONICAL_AIS_START;
      const end = region?.end_time_utc
        ? shiftIsoHours(region.end_time_utc, 12)
        : CANONICAL_AIS_END;

      let vessels = [];
      let attribution = null;
      try {
        setBacktrackStatusText("Loading AIS candidates…");
        vessels = await getCandidateVessels(bbox, start, end);
        if (vessels.length) {
          setBacktrackStatusText("Ranking candidates…");
          attribution = await runAttribution(
            CANONICAL_INCIDENT_ID,
            hc?.source_region || {
              id: "sr-med",
              slick_id: CANONICAL_INCIDENT_ID,
              generated_at_utc: new Date().toISOString(),
              candidate_regions: [
                {
                  id: "local-src",
                  geometry: slick.geometry,
                  centroid: slick.centroid,
                  start_time_utc: start,
                  end_time_utc: end,
                  probability: 0.7,
                },
              ],
            },
            vessels,
            10
          );
        }
      } catch (aisErr) {
        hindcastNotice = [hindcastNotice, aisErr.message].filter(Boolean).join(" ");
      }

      if (!vessels.length) {
        hindcastNotice = [hindcastNotice, describeEmptyMediterraneanAis()].filter(Boolean).join(" ");
      }

      setTransposeNotice(hindcastNotice);

      let normalized = vesselsNearCentroid(
        attribution ? normalizeVessels(vessels, attribution) : normalizeVessels(vessels, null),
        { lat: slick.centroid.lat, lon: slick.centroid.lon }
      );

      const top = attribution?.top_candidates?.[0];
      try {
        if (hc && top?.forward_request) {
        setBacktrackStatusText("Forward simulation from estimated release...");
        const fwd = await runForwardSimulation(top.forward_request);
        setForwardResult(fwd);

        setBacktrackStatusText("Counterfactual: comparing with observed slick...");
        const cf = await runCounterfactual(
          CANONICAL_INCIDENT_ID,
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
                        `${cf.trajectory_reaches_slick ? "trajectory reaches slick" : "trajectory misses slick"}` +
                        (cf.centroid_distance_km != null ? `, ${Number(cf.centroid_distance_km).toFixed(2)} km.` : "."),
                  },
                },
              }
            : v
        );
      } else {
        setForwardResult(null);
        setCounterfactualResult(null);
      }
      } catch {
        setForwardResult(null);
        setCounterfactualResult(null);
      }

      if (normalized.length) {
        setBackendVessels(
          normalized.map((v) => ({
            ...v,
            scoring: buildFrontendScoring(v),
          }))
        );
      }
      const simTs = (hc?.trajectory_timestamps_utc || [])
        .map((t) => Date.parse(t))
        .filter(Number.isFinite);
      if (simTs.length) {
        setSimMs(Math.min(...simTs));
        setIsPlaying(true);
      }
      setBackendOnline(true);
      setBackendHost(getActiveBackendUrl());
      try {
        const replay = await getReplay(CANONICAL_INCIDENT_ID);
        setReplayMeta(replay);
      } catch {
        /* replay is optional until the backend publishes the Mediterranean incident */
      }
    } catch (err) {
      setBackendError(err?.message || String(err));
    } finally {
      setIsBacktracking(false);
      setBacktrackStatusText("");
    }
  }, [isBacktracking, activeSeedId, detectionResult, apiSeedOverride, incident]);

  /* =======================================================
     REPLAY POSITION & TRAJECTORY COMPUTATION
  ======================================================= */

  // Time-based interpolation along a vessel's AIS track (backend tracks
  // carry ISO timestamps); returns null when timestamps are unavailable.
  const timeReplayPosition = (vessel) => {
    if (!simRange || !Number.isFinite(simMs)) return null;
    const tr = (vessel.trajectory || [])
      .map((pt) => ({ ...pt, ms: Date.parse(pt.time) }))
      .filter((pt) => Number.isFinite(pt.ms));
    if (tr.length < 2) return null;
    if (simMs <= tr[0].ms) return [tr[0].latitude, tr[0].longitude];
    const last = tr[tr.length - 1];
    if (simMs >= last.ms) return [last.latitude, last.longitude];
    let i = 1;
    while (tr[i].ms < simMs) i++;
    const a = tr[i - 1], b = tr[i];
    const f = b.ms === a.ms ? 0 : (simMs - a.ms) / (b.ms - a.ms);
    return [
      a.latitude + (b.latitude - a.latitude) * f,
      a.longitude + (b.longitude - a.longitude) * f,
    ];
  };

  const getReplayPosition = (vessel) => {
    const timed = timeReplayPosition(vessel);
    if (timed) return timed;
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

    // Time-based: every past track point plus the interpolated position.
    if (simRange && Number.isFinite(simMs)) {
      const pts = trajectory
        .filter((pt) => {
          const ms = Date.parse(pt.time);
          return Number.isFinite(ms) && ms <= simMs;
        })
        .map((pt) => [pt.latitude, pt.longitude]);
      const cur = timeReplayPosition(vessel);
      if (cur) pts.push(cur);
      return pts;
    }

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

  // Replay visuals are active while playing or whenever the Replay panel is
  // open in time mode (so scrubbing the slider moves vessels live).
  const replayActive = isPlaying || (activeItem === "replay" && simRange && Number.isFinite(simMs));

  // Estimated-release position within the simulation window (0..1).
  const releaseMs = forwardResult ? Date.parse(forwardResult.release_time_utc) : NaN;
  const releaseFrac =
    simRange && Number.isFinite(releaseMs)
      ? Math.max(0, Math.min(1, (releaseMs - simRange.t0) / (simRange.t1 - simRange.t0)))
      : null;

  // Adapters mapping the ReplayPanel's index-based API onto the master clock.
  const panelMaxP = Math.max(1, totalReplayPoints - 1);
  const panelProgress =
    simRange && Number.isFinite(simMs)
      ? ((simMs - simRange.t0) / (simRange.t1 - simRange.t0)) * panelMaxP
      : replayProgress;
  const setPanelProgress = (next) => {
    const value = typeof next === "function" ? next(panelProgress) : next;
    if (simRange) {
      setSimMs(simRange.t0 + (value / panelMaxP) * (simRange.t1 - simRange.t0));
    } else {
      setReplayProgress(value);
    }
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

  const appThemeClass = "app-light";

  // Backend investigation layers stay visible while replaying, not only in
  // the explicit Backtrack tool view.
  const investigationVisible = backtrackVisible || activeItem === "replay";
  const showBackendOil = Boolean(
    investigationVisible && layers.backtrack && (backtrackResult?.backend || forwardResult)
  );

  const mapSourceRegion = investigationVisible ? calculatedSourceRegion : null;

  const sourceCenter = [
    Number(mapSourceRegion?.center?.latitude ?? leafletCentroid[0]),
    Number(mapSourceRegion?.center?.longitude ?? leafletCentroid[1]),
  ];
  const sourceRadiusMeters = Number(mapSourceRegion?.radiusMeters || 0);

  const backtrackedCenterline = useMemo(() => {
    if (!backtrackResult?.trajectory) return [];
    return backtrackResult.trajectory.map((pt) => [pt.latitude, pt.longitude]);
  }, [backtrackResult]);

  /* =======================================================
     RENDER (SINGLE MapContainer STRICTLY ENFORCED)
  ======================================================= */

  const showDetail = ["incident", "vessels", "legend", "replay", "evidence", "detect"].includes(activeItem);
  const closePanel = () => setActiveItem("map");
  const detectedMs = Date.parse(incident.detectedAt);
  const timelineEvents = (incident.timeline || []).map((event) => {
    const [hh, mm] = String(event.time).split(":").map(Number);
    const d = new Date(detectedMs);
    if (Number.isFinite(hh)) d.setUTCHours(hh, Number.isFinite(mm) ? mm : 0, 0, 0);
    return { ms: d.getTime(), label: event.label };
  });
  const clockStart = simRange?.t0 ?? Math.min(
    detectedMs - 6 * 60 * 60 * 1000,
    ...timelineEvents.map((event) => event.ms),
  );
  const clockEnd = simRange?.t1 ?? Math.max(detectedMs, ...timelineEvents.map((event) => event.ms));
  const clockNow = Number.isFinite(simMs)
    ? simMs
    : clockStart + Math.max(0, Math.min(1, replayProgress / Math.max(1, totalReplayPoints - 1))) * (clockEnd - clockStart);

  const seekClock = (ms) => {
    if (simRange) setSimMs(ms);
    else {
      const span = Math.max(1, clockEnd - clockStart);
      setReplayProgress(((ms - clockStart) / span) * Math.max(1, totalReplayPoints - 1));
    }
  };

  return (
    <div className={`app command-center ${appThemeClass}`}>
      <Sidebar
        activeItem={activeItem}
        layers={layers}
        onToggleLayer={toggleLayer}
        onSelect={handleNavigation}
        onTriggerBacktrack={handleRunBacktrack}
        backendOnline={backendOnline}
      />

      <div className="command-shell">
      <div className={`command-stage ${showDetail ? "is-detail" : ""}`}>
        <div className="command-stage-track">
          <div className="command-stage-pane">
            <InvestigationList
              incident={incident}
              vessels={scoredVessels}
              detectionCount={detectionResult?.features?.length || 0}
              selectedVesselId={selectedVesselId}
              onSelectVessel={handleSelectVessel}
              onOpenIncident={() => setActiveItem("incident")}
              onOpenDetect={() => setActiveItem("detect")}
              onRunHindcast={handleRunBacktrack}
              isBacktracking={isBacktracking}
              backendOnline={backendOnline}
              backendHost={backendHost}
            />
          </div>
          <div className="command-stage-pane command-detail">
              {activeItem === "incident" && (
                <IncidentPanel
                  incident={incident}
                  vessels={scoredVessels}
                  onSelectVessel={handleSelectVessel}
                  onClose={closePanel}
                  onTriggerBacktrack={handleRunBacktrack}
                  isBacktracking={isBacktracking}
                />
              )}
              {activeItem === "vessels" && (
                <SuspectPanel
                  selectedVessel={selectedVessel}
                  allVessels={scoredVessels}
                  onSelectVessel={handleSelectVessel}
                  onClose={handleDeselect}
                />
              )}
              {activeItem === "legend" && (
                <LegendPanel onClose={closePanel} />
              )}
              {activeItem === "replay" && (
                <ReplayPanel
                  vessels={scoredVessels}
                  isPlaying={isPlaying}
                  setIsPlaying={setIsPlaying}
                  replayProgress={panelProgress}
                  setReplayProgress={setPanelProgress}
                  replaySpeed={replaySpeed}
                  setReplaySpeed={setReplaySpeed}
                  totalPoints={totalReplayPoints}
                  timeLabel={simRange ? fmtSimClock(simMs ?? simRange.t1) : currentOilFrame?.timeLabel}
                  startLabel={simRange
                    ? `${fmtSimClock(simRange.t0)} UTC`
                    : undefined}
                  endLabel={simRange
                    ? `${fmtSimClock(simRange.t1)} UTC`
                    : undefined}
                  releaseFrac={simRange ? releaseFrac : undefined}
                  forcingTag={simRange ? "OpenDrift forcing" : undefined}
                  currentFieldDesc={simRange ? "Ocean currents from backend forcing" : undefined}
                  windFieldDesc={simRange ? "Wind field from backend forcing" : undefined}
                  onClose={() => {
                    setIsPlaying(false);
                    closePanel();
                  }}
                />
              )}
              {activeItem === "evidence" && (
                <EvidencePanel
                  vessel={selectedVessel}
                  onClose={() => setActiveItem(selectedVessel ? "vessels" : "map")}
                />
              )}
              {activeItem === "detect" && (
                <DetectionPanel
                  onDetectionResult={handleDetectionResult}
                  onClose={closePanel}
                  onSeedOverride={handleSeedOverride}
                  onClearSeed={handleClearSeed}
                  activeSeedId={activeSeedId}
                  currentResult={detectionResult}
                />
              )}
          </div>
        </div>
      </div>

      <div className="command-workspace">
        <div className="command-workspace-main">
          <div className="command-map-wrap">
            <div className="map-floating-head">
              <div className="map-title-stack">
                <div className="map-title-chip">
                  <p className="inv-kicker">{incident.id}</p>
                  <h1>{incident.spillType}</h1>
                </div>
                <div className="oil-legend-chip">
                  <span aria-hidden="true" />
                  {showBackendOil ? "Oil sheen from hindcast" : "Detected oil slick"}
                </div>
              </div>
              <div className="command-head-actions">
                <button
                  type="button"
                  className={`head-chip ${mapStyle === "map" ? "is-active" : ""}`}
                  onClick={() => setMapStyle("map")}
                >
                  Map
                </button>
                <button
                  type="button"
                  className={`head-chip ${mapStyle === "satellite" ? "is-active" : ""}`}
                  onClick={() => setMapStyle("satellite")}
                >
                  Satellite
                </button>
                <button type="button" className="head-chip" onClick={() => setActiveItem("legend")}>
                  Layers
                </button>
              </div>
            </div>
      <MapContainer
        center={leafletCentroid}
        zoom={11}
        zoomControl={false}
        className="map"
        preferCanvas={false}
        zoomAnimation={false}
        fadeAnimation={false}
        markerZoomAnimation={false}
      >
        {/* BASE MAP */}
        <TileLayer
          attribution={
            mapStyle === "satellite"
              ? "Tiles © Esri"
              : "© OpenStreetMap contributors"
          }
          url={
            mapStyle === "satellite"
              ? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          }
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
        {layers.spill && !showBackendOil && (
          <DeckOilOverlay
            enabled
            particles={currentOilParticles}
            trails={currentOilTrails}
          />
        )}

        {layers.oilTrajectory && !showBackendOil && currentOilFlowLines.map((line, index) => (
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
        {investigationVisible && layers.backtrack && backtrackedCenterline.length >= 2 && (
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
        {investigationVisible && layers.backtrack && backtrackResult && scoredVessels.find((v) => v.candidateRank === 1) && (
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

        {/* BACKEND DRIFT PARTICLE CLOUD (OpenDrift-style) */}
        <DriftCloudOverlay
          hindcast={backtrackResult?.backend}
          forward={forwardResult}
          slickGeometry={activeSlick?.geometry}
          visible={showBackendOil}
          timeMs={simMs}
        />

        {/* BACKEND FORWARD SIMULATION: trajectory + predicted footprint */}
        {investigationVisible && layers.backtrack && !showBackendOil && forwardResult?.trajectory?.coordinates?.length >= 2 && (
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
        {investigationVisible && layers.backtrack && forwardResult?.predicted_footprint && !showBackendOil && (
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
                  Counterfactual: {counterfactualResult.trajectory_reaches_slick ? "reaches slick" : "misses slick"}
                  {counterfactualResult.centroid_distance_km != null
                    ? ` · ${Number(counterfactualResult.centroid_distance_km).toFixed(2)} km`
                    : ""}
                  {counterfactualResult.spatial_agreement != null
                    ? ` · Jaccard ${Number(counterfactualResult.spatial_agreement).toFixed(3)}`
                    : ""}
                  {counterfactualResult.evidence_strength
                    ? ` · ${counterfactualResult.evidence_strength}`
                    : ""}
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
              color: "#5c3a12",
              weight: 1.2,
              opacity: 0.4,
              fillColor: "#2a1608",
              fillOpacity: showBackendOil ? 0.08 : 0.22,
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
        {layers.sourceRegion && mapSourceRegion && sourceRadiusMeters > 0 && (
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
              Confidence: {mapSourceRegion?.confidence ?? "—"}%
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
          onTriggerBacktrack={handleRunBacktrack}
          isBacktracking={isBacktracking}
          storyPoints={storyPoints}
          scenePoints={scenePoints}
        />

        {/* INITIAL MAP FIT */}
        <FitMapToIncident />
        <MapFill />

        {/* AUTO-REFIT + SOFT PAN BOUNDS AROUND THE INVESTIGATION */}
        <MapFocusController
          storyPoints={storyPoints}
          scenePoints={scenePoints}
          stageKey={focusStageKey}
        />

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
              {layers.trajectories && !replayActive && normalTrajectory.length >= 2 && (
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
              {layers.trajectories && replayActive && replayTrajectory.length >= 2 && (
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
              {layers.vessels && !replayActive && (
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
              {layers.vessels && replayActive && (
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

            <TimelineControl
              startMs={clockStart}
              endMs={clockEnd}
              currentMs={clockNow}
              events={timelineEvents}
              isPlaying={isPlaying}
              onPlayPause={() => setIsPlaying((prev) => !prev)}
              onSeekMs={seekClock}
              playbackSpeed={replaySpeed}
              onSpeedChange={setReplaySpeed}
            />

            {isBacktracking && (
              <div className="run-card" role="status">
                <div className="run-card-head">
                  <strong>Hindcast</strong>
                  <span className="run-badge">Running</span>
                </div>
                <p>{backtrackStatusText || "Connecting…"}</p>
                <div className="run-rail" aria-hidden="true">
                  {["Hindcast", "AIS", "Rank", "Forward"].map((label, index) => (
                    <span
                      key={label}
                      className={index <= pipelineStepIndex(backtrackStatusText) ? "is-on" : ""}
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {transposeNotice && !isBacktracking && (
              <div className="ops-toast warn">
                <strong>Note.</strong> {transposeNotice}
                <button type="button" onClick={() => setTransposeNotice(null)}>Dismiss</button>
              </div>
            )}

            {backendError && (
              <div className="ops-toast error">
                <strong>Request failed.</strong> {backendError}
                <button type="button" onClick={() => setBackendError(null)}>Dismiss</button>
              </div>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

export default App;
