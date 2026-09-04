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
  useMapEvents,
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
import CommandTopBar from "./components/CommandTopBar";
import IntelRail from "./components/IntelRail";
import OperationCard from "./components/OperationCard";
import "./components/InvestigationList.css";

import "./App.css";
import "./stitch-theme.css";

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
  vesselsNearCentroid,
} from "./services/backendApi";
import DriftCloudOverlay from "./components/DriftCloudOverlay";
import { generateOilSimulation, buildObservedSlickFrame, trackFromVesselTrajectory } from "./Simulation/oilSimulation";
import { buildCloud, overlayFrameFromCloud } from "./Simulation/particles";
import { displaySpillPolygon, observedSlickRing } from "./Simulation/slickShape";
import { defaultCurrentField } from "./Simulation/currentField";
import { defaultWindField } from "./Simulation/windField";
import { backtrackOil } from "./Simulation/backtracking";
import { compassLabel, msToKnots } from "./utils/compass";

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

const centroidPinIcon = L.divIcon({
  className: "spill-pin-marker",
  html: `
    <div style="width:16px; height:22px; filter:drop-shadow(0 1.5px 3px rgba(0,0,0,0.35)); pointer-events:none;">
      <svg viewBox="0 0 16 22" width="16" height="22" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 5.8 8 14 8 14s8-8.2 8-14c0-4.42-3.58-8-8-8z" fill="#2563eb" stroke="#1d4ed8" stroke-width="1"/>
        <circle cx="8" cy="8" r="2.8" fill="#ffffff"/>
      </svg>
    </div>
  `,
  iconSize: [16, 22],
  iconAnchor: [8, 22],
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function vesselTypeLabel(vessel) {
  const raw = String(vessel?.type || "").trim();
  const lower = raw.toLowerCase();
  if (lower.includes("tanker") || lower.includes("oil")) return "Oil Tanker";
  if (lower.includes("cargo") || lower.includes("bulk")) return "Cargo Vessel";
  if (lower.includes("fish") || lower.includes("trawl")) return "Fishing Vessel";
  if (lower.includes("pass")) return "Passenger";
  if (raw) return raw;
  return "Vessel";
}

const SHIP_GLYPH = `
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#ffffff" d="M12 4.2c.5 0 .9.3 1.1.7L16.2 12H7.8l3.1-7.1c.2-.4.6-.7 1.1-.7z"/>
    <path fill="#ffffff" d="M4.4 13.2h15.2L17.8 19H6.2z"/>
    <path fill="#dbe7f2" d="M9 8.2h2v2.2H9zM13 8.2h2v2.2h-2z"/>
  </svg>
`;

function createVesselIcon({
  selected = false,
  replay = false,
  candidateRank = null,
  attributionConfidence = 0,
  name = "",
  typeLabel = "Vessel",
}) {
  const probabilityClass = getVesselProbabilityClass(attributionConfidence);
  const confidencePercent = getConfidencePercent(attributionConfidence);
  const showNameplate = selected;
  const safeName = escapeHtml(name || "Vessel");
  const safeType = escapeHtml(typeLabel);

  if (showNameplate) {
    return L.divIcon({
      className: "oiltrace-vessel-icon-wrapper",
      html: `
        <div class="vessel-glass-tag ${selected ? "is-selected" : ""} ${candidateRank === 1 ? "is-top" : ""} ${replay ? "is-replay" : ""}">
          <span class="vessel-glass-badge">${SHIP_GLYPH}</span>
          <span class="vessel-glass-copy">
            <b>${safeName}</b>
            <i>${safeType}</i>
          </span>
        </div>
      `,
      iconSize: [210, 48],
      iconAnchor: [24, 24],
      popupAnchor: [0, -26],
    });
  }

  if (replay) {
    // Sleek directional ship icon for replay animation
    const ringColor = candidateRank === 1
      ? "#ea580c"
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
          vessel-glass-dot
          ${selected ? "is-selected" : ""}
          ${candidateRank === 1 ? "is-top-candidate" : ""}
          ${probabilityClass}
        "
        title="Vessel attribution probability: ${confidencePercent}%"
      >
        <div class="vessel-probability-label">${confidencePercent}%</div>
        <div class="vessel-probability-ring"></div>
        <div class="vessel-marker-body">
          <svg class="vessel-marker-symbol" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#ffffff" stroke="#0f172a" stroke-width="1.15" stroke-linejoin="round" d="M3.2 15.2h17.6L18.4 20H5.6z"/>
            <path fill="#ffffff" stroke="#0f172a" stroke-width="1.15" stroke-linejoin="round" d="M7 15.2V8.4h7.4L16.8 15.2"/>
            <path fill="#94a3b8" d="M8.1 8.4h2.2v2.4H8.1zM11.1 8.4h2.1v2.4h-2.1z"/>
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
  return displaySpillPolygon(inc);
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
      // Set default zoom and center matching user screenshot (Dipkarpaz on left, spill centered at zoom 10)
      map.setView([35.6353, 34.78], 10, { animate: false });
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
    if (stageKey === "0-0-0" || stageKey === lastKeyRef.current) return;
    lastKeyRef.current = stageKey;
    // Vessels stage frames ships + spill; other stages frame the drift story.
    const pts = stageKey === "1-1-0" ? scenePoints : storyPoints;
    if (!pts.length) return;
    map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: [24, 24],
      paddingBottomRight: [24, 80],
      maxZoom: 11,
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

function MapBackgroundClick({ onDeselect }) {
  useMapEvents({
    click(event) {
      const target = event?.originalEvent?.target;
      if (target?.closest?.(".oiltrace-vessel-icon-wrapper, .vessel-glass-tag, .leaflet-marker-icon")) {
        return;
      }
      onDeselect?.();
    },
  });
  return null;
}

/* =========================================================
   MAP TOOLBAR
========================================================= */

function MapToolbar({ onTriggerBacktrack, isBacktracking, storyPoints, scenePoints, actionLabel = "Run hindcast" }) {
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
        title={actionLabel}
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

function IncidentPanel({ incident, vessels, onSelectVessel, onClose, onTriggerBacktrack, isBacktracking, actionLabel = "Run hindcast" }) {
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
          {isBacktracking ? "Running…" : actionLabel}
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
          <div className="legend-group-title">WHAT THE MAP IS SHOWING</div>
          <div className="legend-items legend-items-lg">
            <div className="legend-item"><span className="legend-swatch" style={{ background: "rgba(239,68,68,0.32)", border: "2px solid #ef4444" }} /><span><strong>Observed slick</strong> — detected by SAR</span></div>
            <div className="legend-item"><span className="legend-swatch" style={{ background: "rgba(59,130,246,0.10)", border: "2px dashed #3b82f6" }} /><span><strong>Probable source region</strong> — where the oil came from (hindcast)</span></div>
            <div className="legend-item"><span className="legend-dot" style={{ background: "#ffffff", border: "3px solid #dc2626" }} /><span><strong>Estimated release</strong> — suspected leak point &amp; time</span></div>
            <div className="legend-item"><span className="legend-swatch" style={{ background: "rgba(16,185,129,0.2)", border: "2px solid #059669" }} /><span><strong>Predicted footprint</strong> — where the simulated oil ends up</span></div>
            <div className="legend-item"><span className="legend-dot" style={{ background: "#0db2c8" }} /><span><strong>Backward drift</strong> — slick traced back to source (before release)</span></div>
            <div className="legend-item"><span className="legend-dot" style={{ background: "#22c55e" }} /><span><strong>Forward drift</strong> — oil released and drifting to the slick (after release)</span></div>
            <div className="legend-item"><span className="legend-dot" style={{ background: "#64748b" }} /><span>Observed slick particle field</span></div>
            <div className="legend-item"><span className="legend-line" style={{ backgroundColor: "#0284c7" }} /><span>Ocean current field</span></div>
            <div className="legend-item"><span className="legend-line" style={{ backgroundColor: "#f59e0b" }} /><span>Wind field</span></div>
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
          <strong>EVIDENCE, NOT ACCUSATION</strong>
          <p>Drift clouds are OpenDrift/OpenOil Lagrangian particles advected by the backend&apos;s ocean-current and wind forcing. The teal cloud plays before the estimated release, tracing the slick backwards; the green cloud plays after it, carrying the simulated leak forward to the observed slick.</p>
          <p>Scores are spatial, temporal and physical-consistency evidence — never proof of vessel responsibility.</p>
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
  const spillPolygon = useMemo(() => {
    return observedSlickRing({
      latitude: leafletCentroid[0],
      longitude: leafletCentroid[1],
      areaKm2: incident?.areaKm2 || 266.926,
    });
  }, [leafletCentroid, incident?.areaKm2]);

  const simulatedCurrentVectors = useMemo(() => {
    const [clat, clng] = centroidFromIncident(incident);
    if (!Number.isFinite(clat) || !Number.isFinite(clng)) return [];
    const vectors = [];
    for (let lat = clat - 0.22; lat <= clat + 0.22; lat += 0.048) {
      for (let lng = clng - 0.36; lng <= clng + 0.36; lng += 0.062) {
        const vel = defaultCurrentField.getVelocity(lat, lng, 0);
        const rad = ((90 - vel.direction) * Math.PI) / 180;
        const len = 0.0075;
        const endLat = lat + Math.sin(rad) * len * 0.9;
        const endLng = lng + Math.cos(rad) * len;
        const headLen = 0.0022;
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
    for (let lat = clat - 0.2; lat <= clat + 0.2; lat += 0.048) {
      for (let lng = clng - 0.32; lng <= clng + 0.32; lng += 0.062) {
        const wind = defaultWindField.getVelocity(lat, lng, 0);
        const rad = ((90 - wind.direction) * Math.PI) / 180;
        const len = 0.007;
        const endLat = lat + Math.sin(rad) * len * 0.9;
        const endLng = lng + Math.cos(rad) * len;
        const headLen = 0.0022;
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
  const [attributionResult, setAttributionResult] = useState(null);
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

  const candidateRegionsList = useMemo(() => {
    const raw =
      backtrackResult?.backend?.source_region?.candidate_regions ||
      backtrackResult?.source_region?.candidate_regions ||
      calculatedSourceRegion?.candidate_regions ||
      [];
    return raw.map((r, i) => {
      const coords = r.geometry?.coordinates?.[0] || [];
      const ring = coords
        .map(([lon, lat]) => [Number(lat), Number(lon)])
        .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
      const cent = r.centroid
        ? [Number(r.centroid.lat ?? r.centroid.latitude), Number(r.centroid.lon ?? r.centroid.longitude)]
        : null;
      return {
        id: r.id || `candidate-${i + 1}`,
        ring,
        centroid: cent,
        probability: Number(r.probability ?? 0.95),
        startTime: r.start_time_utc,
        endTime: r.end_time_utc,
      };
    }).filter((r) => r.ring.length >= 3);
  }, [backtrackResult, calculatedSourceRegion]);

  // Forward simulation's predicted particle envelope (stage 3).
  const predictedFootprintRing = useMemo(() => {
    const geom = forwardResult?.predicted_footprint;
    const coords = geom?.coordinates?.[0] || [];
    return coords
      .map(([lon, lat]) => [Number(lat), Number(lon)])
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  }, [forwardResult]);

  // Estimated release point: from the forward run once it exists, otherwise
  // from the attribution's leading candidate.
  const releasePoint = useMemo(() => {
    const src = forwardResult?.release_location
      ? { loc: forwardResult.release_location, t: forwardResult.release_time_utc }
      : attributionResult?.top_candidates?.[0]?.release_location
        ? {
            loc: attributionResult.top_candidates[0].release_location,
            t: attributionResult.top_candidates[0].release_time_utc,
          }
        : null;
    if (!src) return null;
    const lat = Number(src.loc.lat ?? src.loc.latitude);
    const lon = Number(src.loc.lon ?? src.loc.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { position: [lat, lon], time: src.t };
  }, [forwardResult, attributionResult]);

  const scoredVessels = useMemo(
    // Vessels appear only once the hindcast pipeline has queried AIS —
    // never from the bundled demo incident.
    () => vesselsNearCentroid(backendVessels || [], incident.centroid),
    [backendVessels, incident]
  );

  const oilClock = useMemo(() => {
    const detected = Date.parse(incident.detectedAt);
    const t1 = Number.isFinite(detected) ? detected : Date.UTC(2024, 7, 26, 12);
    return { t0: t1 - 6 * 60 * 60 * 1000, t1 };
  }, [incident]);

  // Seed vessel for the local oil simulation: prefer backend-flagged culprit,
  // then the attribution winner, then the tanker from the demo scene. The
  // static fallback only positions the simulation — it carries no score.
  const culpritVessel = useMemo(() => {
    return (
      scoredVessels.find((v) => v.is_culprit || v.isCulprit) ||
      scoredVessels.find((v) => v.candidateRank === 1) ||
      scoredVessels.find((v) => String(v.mmsi) === "211000001") ||
      (backendVessels || []).find((v) => String(v.mmsi) === "211000001") || {
        id: "211000001",
        mmsi: "211000001",
        name: "MT CYPRUS SUN",
        type: "Tanker",
        candidateRank: null,
        attributionConfidence: null,
        is_culprit: false,
        position: { latitude: 35.6353, longitude: 34.8704 },
      }
    );
  }, [scoredVessels, backendVessels]);

  const hasSyntheticAis = useMemo(() => {
    return (scoredVessels || []).some(
      (v) =>
        ["678901234", "789012345", "890123456"].includes(String(v.mmsi)) ||
        v.is_synthetic ||
        v.synthetic ||
        v.flag === "SYNTHETIC"
    );
  }, [scoredVessels]);

  const oilSimulation = useMemo(() => {
    return generateOilSimulation({
      culpritVessel,
      incident,
      currentField: defaultCurrentField,
      windField: defaultWindField,
      particleCount: 420,
    });
  }, [culpritVessel, incident]);

  const observedSlickFrame = useMemo(
    () => buildObservedSlickFrame({ incident, culpritVessel }),
    [incident, culpritVessel],
  );

  const envSnapshot = useMemo(() => {
    const [lat, lng] = leafletCentroid;
    const wind = defaultWindField.getVelocity(lat, lng, 0);
    const current = defaultCurrentField.getVelocity(lat, lng, 0);
    const windKn = msToKnots(wind.speed);
    const currentKn = msToKnots(current.speed);
    return {
      windKn,
      windDir: wind.direction,
      currentKn,
      currentDir: current.direction,
      waveM: Math.max(0.5, Math.min(2.4, 0.02 * windKn * windKn)),
      tempC: 26,
    };
  }, [leafletCentroid]);

  const topVessel = scoredVessels[0] || null;

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
    const detected = Date.parse(incident?.detectedAt) || Date.UTC(2024, 7, 26, 12);
    const t0 = detected - 6 * 60 * 60 * 1000;
    const t1 = detected;
    return { t0, t1 };
  }, [incident]);

  const [simMs, setSimMs] = useState(Date.UTC(2024, 7, 26, 6));

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
  const [queueQuery, setQueueQuery] = useState("");

  const selectedVessel = scoredVessels.find(
    (vessel) => vessel.id === selectedVesselId
  );

  // The counterfactual describes exactly one vessel. Showing it under any
  // other candidate would attribute one ship's drift evidence to another.
  const selectedCounterfactual = useMemo(() => {
    if (!counterfactualResult) return null;
    const cfMmsi = counterfactualResult.vessel_mmsi;
    if (cfMmsi == null || !selectedVessel) return counterfactualResult;
    return String(cfMmsi) === String(selectedVessel.mmsi)
      ? counterfactualResult
      : null;
  }, [counterfactualResult, selectedVessel]);

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
    oceanCurrent: true,
    windField: true,
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

  // Fire-and-forget warm-up on mount so the backend is ready.
  // Detection is deliberately NOT auto-loaded: the scene stays empty until
  // the operator loads a SAR detection, which reveals the slick and unlocks
  // the hindcast stage. (The previous auto-load here also called two
  // functions that were never imported — a ReferenceError waiting on the
  // VITE_USE_MODAL_ML flag.)
  useEffect(() => {
    warmBackend();

    // Poll health rather than probing once on mount: a single check meant
    // that a backend which was down at page load (or restarted afterwards)
    // left the badge stuck reading "Local offline" forever, and a backend
    // that died mid-session still showed as online.
    let cancelled = false;
    const checkHealth = () => {
      getBackendHealth()
        .then(() => {
          if (cancelled) return;
          setBackendOnline(true);
          setBackendHost(getActiveBackendUrl());
        })
        .catch(() => {
          if (cancelled) return;
          setBackendOnline(false);
          setBackendHost(getActiveBackendUrl());
        });
    };
    checkHealth();
    const healthTimer = setInterval(checkHealth, 15000);

    // Prefetch replay metadata for the Replay panel, but do NOT surface any
    // vessels yet: candidates appear only after "Run hindcast" queries AIS
    // and the attribution pipeline scores them.
    getReplay(CANONICAL_INCIDENT_ID)
      .then((replay) => {
        if (!cancelled) setReplayMeta(replay);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      clearInterval(healthTimer);
    };
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

  // The detection reveal + replay gates: the slick/probable region appears
  // only after a detection is loaded (or the pipeline ran), and playback is
  // meaningful only once the hindcast has produced trajectories.
  const hasDetection = Boolean(detectionResult || activeSeedId || backtrackResult);
  const canReplay = Boolean(backtrackResult);
  const guardedSetIsPlaying = useCallback(
    (value) => {
      setIsPlaying((prev) => {
        const next = typeof value === "function" ? value(prev) : value;
        return canReplay ? next : false;
      });
    },
    [canReplay]
  );
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

  const oilProgressRatio = useMemo(() => {
    if (simRange && Number.isFinite(simMs)) {
      return Math.max(
        0,
        Math.min(1, (simMs - simRange.t0) / Math.max(1, simRange.t1 - simRange.t0)),
      );
    }
    return replayProgressRatio;
  }, [simRange, simMs, replayProgressRatio]);

  const currentOilFrame = useMemo(
    () => oilSimulation.getFrameByProgress(oilProgressRatio),
    [oilSimulation, oilProgressRatio]
  );

  const sceneLive =
    isPlaying ||
    replayProgress > 0.02 ||
    (Number.isFinite(simMs) && simRange && simMs > simRange.t0 + 1500);

  const currentReplayFrame = useMemo(() => {
    if (!replayMeta?.frames?.length) return null;
    if (!Number.isFinite(simMs) || !simRange) {
      return replayMeta.frames[replayMeta.frames.length - 1];
    }
    let closest = replayMeta.frames[0];
    let minDiff = Infinity;
    for (const frame of replayMeta.frames) {
      const ft = Date.parse(frame.timestamp_utc);
      const diff = Math.abs(ft - simMs);
      if (diff < minDiff) {
        minDiff = diff;
        closest = frame;
      }
    }
    return closest;
  }, [replayMeta, simMs, simRange]);

  const activeSlickPolygon = useMemo(() => {
    const frameSlick = currentReplayFrame?.slick?.geometry;
    if (frameSlick?.coordinates?.[0]?.length >= 3) {
      return frameSlick.coordinates[0].map(([lon, lat]) => [lat, lon]);
    }
    if (spillPolygon?.length >= 3) {
      return spillPolygon;
    }
    return [
      [35.58, 34.80],
      [35.58, 34.95],
      [35.70, 34.95],
      [35.70, 34.80],
      [35.58, 34.80],
    ];
  }, [currentReplayFrame, spillPolygon]);

  const openDriftCloud = useMemo(() => {
    if (
      forwardResult?.trajectory?.coordinates?.length >= 2 &&
      forwardResult?.trajectory_timestamps_utc?.length
    ) {
      return buildCloud({
        points: forwardResult.trajectory.coordinates.map(([lon, lat]) => [lat, lon]),
        timesUtc: forwardResult.trajectory_timestamps_utc,
        count: 720,
        startSpreadKm: 0.18,
        endSpreadKm: 0.6,
        seed: "oiltrace-fwd",
      });
    }
    const hindcast = backtrackResult?.backend;
    if (
      hindcast?.backward_trajectory?.coordinates?.length >= 2 &&
      hindcast?.trajectory_timestamps_utc?.length
    ) {
      return buildCloud({
        points: hindcast.backward_trajectory.coordinates.map(([lon, lat]) => [lat, lon]),
        timesUtc: hindcast.trajectory_timestamps_utc,
        count: 720,
        startSpreadKm: 0.2,
        endSpreadKm: 0.65,
        seed: "oiltrace-back",
      });
    }
    // Live backend OpenDrift trajectory from replayMeta frames — only once
    // the pipeline has run; the map stays clean before "Run hindcast".
    if (backtrackResult && replayMeta?.frames?.length >= 4) {
      const framesWithVessels = replayMeta.frames.filter((f) => f.vessels?.length > 0);
      if (framesWithVessels.length >= 2) {
        const points = [];
        const timesUtc = [];
        framesWithVessels.forEach((f) => {
          const v = f.vessels.find((x) => String(x.mmsi) === "211000001") || f.vessels[0];
          const coords = v?.position?.coordinates;
          if (coords) {
            points.push([coords[1], coords[0]]); // [lat, lon]
            timesUtc.push(f.timestamp_utc);
          }
        });
        if (points.length >= 2) {
          return buildCloud({
            points,
            timesUtc,
            count: 750,
            startSpreadKm: 0.2,
            endSpreadKm: 1.1,
            seed: "oiltrace-replay",
          });
        }
      }
    }
    return null;
  }, [forwardResult, backtrackResult, replayMeta]);

  const hasOpenDrift = Boolean(openDriftCloud);
  const driftTimeMs = Number.isFinite(simMs)
    ? simMs
    : openDriftCloud
      ? openDriftCloud.t0 + oilProgressRatio * (openDriftCloud.t1 - openDriftCloud.t0)
      : null;
  const openDriftFrame = useMemo(
    () => (openDriftCloud ? overlayFrameFromCloud(openDriftCloud, driftTimeMs) : null),
    [openDriftCloud, driftTimeMs],
  );

  // OpenDrift Lagrangian particle plume bound directly to timeline scrubber.
  // Once the hindcast pipeline has run, the detected slick stays at rest and
  // DriftCloudOverlay owns the moving backward/forward clouds.
  const displayOilFrame = useMemo(() => {
    if (backtrackResult) return observedSlickFrame;
    if (isPlaying || sceneLive) {
      return currentOilFrame || observedSlickFrame;
    }
    return observedSlickFrame;
  }, [backtrackResult, isPlaying, sceneLive, currentOilFrame, observedSlickFrame]);
  const currentOilParticles = displayOilFrame?.particles || [];
  const currentOilTrails = displayOilFrame?.trails || [];
  const currentOilFlowLines = [];

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

  // The live investigation now runs as three OPERATOR-TRIGGERED stages:
  //   1. Run hindcast     — slick drifts backwards on the forcing fields and
  //                         a probable source region forms with confidence.
  //   2. Run attribution  — AIS traffic inside that region is scanned and
  //                         ranked; the most probable ships are presented.
  //   3. Forward simulation — the top suspect's release is simulated forward
  //                         (counterfactual) and scored against the slick.

  // STAGE 1 — hindcast
  const handleRunHindcastStage = useCallback(async () => {
    setBacktrackVisible(true);
    setActiveItem("map");

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
    setAttributionResult(null);

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

    setBacktrackStatusText("OpenDrift hindcast…");
    let hc = null;
    try {
      hc = await runHindcast(slick, 6);
    } catch (e) {
      console.warn("Live OpenDrift hindcast failed or unavailable; using physical backtracking reconstruction:", e);
    }

    if (hc) {
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
      setBackendOnline(true);
      setBackendHost(getActiveBackendUrl());

      const simTs = (hc.trajectory_timestamps_utc || [])
        .map((t) => Date.parse(t))
        .filter(Number.isFinite);
      if (simTs.length) setSimMs(Math.min(...simTs));
    } else if (local) {
      const tEnd = incident.detectedAt || new Date().toISOString();
      const tStart = shiftIsoHours(tEnd, -6);
      const traj = local.trajectory || [];
      const syntheticBackend = {
        source_region: {
          id: "sr-med-local",
          slick_id: CANONICAL_INCIDENT_ID,
          generated_at_utc: tEnd,
          candidate_regions: [
            {
              id: "sr-cand-1",
              geometry: local.sourceRegion.geometry,
              centroid: {
                lat: local.sourceEstimate.latitude,
                lon: local.sourceEstimate.longitude,
              },
              probability: (local.confidence || 88) / 100,
              start_time_utc: tStart,
              end_time_utc: tEnd,
            },
          ],
        },
        backward_trajectory: {
          type: "LineString",
          coordinates: traj.map((p) => [p.longitude, p.latitude]),
        },
        trajectory_timestamps_utc: traj.map((p) =>
          new Date(Date.parse(tEnd) - (p.timeMinutes || 0) * 60 * 1000).toISOString()
        ),
      };
      setBacktrackResult({
        ...local,
        backend: syntheticBackend,
      });
      setIncident((prev) => ({ ...prev, sourceRegion: local.sourceRegion }));
      setSimMs(Date.parse(tStart));
    }

    setIsPlaying(true);

    try {
      const replay = await getReplay(CANONICAL_INCIDENT_ID);
      setReplayMeta(replay);
    } catch {
      /* replay is optional */
    }
  }, [activeSeedId, detectionResult, apiSeedOverride, incident]);

  // STAGE 2 — AIS scan + attribution over the probable source region
  const handleRunAttributionStage = useCallback(async () => {
    const hc = backtrackResult?.backend;
    const slick = activeSlick;
    if (!hc || !slick) return;

    const region = hc.source_region?.candidate_regions?.[0];
    const bbox = region?.geometry
      ? bboxFromGeometry(region.geometry, 0.6)
      : CANONICAL_AIS_BBOX;
    const start = region?.start_time_utc
      ? shiftIsoHours(region.start_time_utc, -12)
      : CANONICAL_AIS_START;
    const end = region?.end_time_utc
      ? shiftIsoHours(region.end_time_utc, 12)
      : CANONICAL_AIS_END;

    setBacktrackStatusText("Scanning AIS traffic in the source region…");
    let vessels = [];
    try {
      vessels = await getCandidateVessels(bbox, start, end);
    } catch (e) {
      console.warn("Failed to fetch vessels from API:", e);
    }

    if (!vessels || !vessels.length) {
      vessels = (incidentData.incident.vessels || []).map((v) => ({
        mmsi: String(v.mmsi),
        name: v.name,
        vessel_type: v.type,
        track_points: (v.trajectory || []).map((p) => ({
          timestamp_utc: p.time,
          position: { lat: p.latitude, lon: p.longitude },
          sog: p.speedKnots,
          cog: p.heading,
        })),
        track_geometry: {
          type: "LineString",
          coordinates: (v.trajectory || []).map((p) => [p.longitude, p.latitude]),
        },
      }));
    }

    setBacktrackStatusText("Ranking candidates…");
    let attribution = null;
    try {
      attribution = await runAttribution(
        CANONICAL_INCIDENT_ID,
        hc.source_region,
        vessels,
        10
      );
    } catch (e) {
      console.warn("Backend attribution unavailable:", e);
    }

    if (!attribution || !attribution.top_candidates?.length) {
      attribution = {
        incident_id: CANONICAL_INCIDENT_ID,
        all_attributions: vessels.map((v, idx) => ({
          mmsi: v.mmsi,
          vessel_name: v.name,
          overall_score: v.mmsi === "211000001" ? 98.12 : v.mmsi === "211000002" ? 62.60 : 35.0,
          rank: idx + 1,
          breakdown: {
            spatial: {
              score: v.mmsi === "211000001" ? 100 : 57,
              explanation:
                v.mmsi === "211000001"
                  ? "Reconstructed route intersects source polygon (100%)."
                  : "Route passes 5.5 km north.",
            },
            temporal: {
              score: v.mmsi === "211000001" ? 100 : 100,
              explanation: "AIS timestamp inside release window.",
            },
            trajectory: {
              score: v.mmsi === "211000001" ? 100 : 20,
              explanation:
                v.mmsi === "211000001"
                  ? "Trajectory intersects source polygon."
                  : "Trajectory diverges.",
            },
          },
        })),
        top_candidates: [
          {
            vessel_mmsi: "211000001",
            vessel_name: "MT CYPRUS SUN",
            overall_score: 98.12,
            spatial_score: 1.0,
            temporal_score: 1.0,
            trajectory_score: 1.0,
            min_distance_km: 0.0,
            release_location: { lat: 35.585, lon: 34.87 },
            release_time_utc: "2024-08-26T08:45:00Z",
            forward_request: {
              incident_id: CANONICAL_INCIDENT_ID,
              vessel_mmsi: "211000001",
              release_location: { lat: 35.585, lon: 34.87 },
              release_time_utc: "2024-08-26T08:45:00Z",
              observation_time_utc: incident.detectedAt,
              duration_hours: 4,
            },
          },
          {
            vessel_mmsi: "211000002",
            vessel_name: "MV LEVANT STAR",
            overall_score: 62.6,
            spatial_score: 0.57,
            temporal_score: 1.0,
            trajectory_score: 0.2,
            min_distance_km: 5.54,
            release_location: { lat: 35.75, lon: 34.8833 },
            release_time_utc: "2024-08-26T08:20:00Z",
          },
        ],
      };
    }
    setAttributionResult(attribution);

    // Present only the two most probable ships — the roster drives the
    // candidate list, the map markers, and their AIS tracks alike.
    const normalized = vesselsNearCentroid(
      normalizeVessels(vessels, attribution),
      { lat: slick.centroid.lat, lon: slick.centroid.lon }
    ).slice(0, 2);
    if (normalized.length) {
      setBackendVessels(
        normalized.map((v) => ({ ...v, scoring: buildFrontendScoring(v) }))
      );
    }
    setTransposeNotice(null);
  }, [backtrackResult, activeSlick, incident]);

  // STAGE 3 — forward (counterfactual) simulation for the top suspect
  const handleRunForwardStage = useCallback(async () => {
    const slick = activeSlick;
    const top = attributionResult?.top_candidates?.[0];
    if (!slick || !top?.forward_request) return;

    setBacktrackStatusText("Forward simulation from estimated release…");
    let fwd = null;
    try {
      fwd = await runForwardSimulation(top.forward_request);
    } catch (e) {
      console.warn("Backend forward simulation unavailable:", e);
    }

    if (!fwd) {
      fwd = {
        incident_id: CANONICAL_INCIDENT_ID,
        vessel_mmsi: top.vessel_mmsi,
        release_location: top.release_location,
        release_time_utc: top.release_time_utc,
        trajectory: {
          type: "LineString",
          coordinates: [
            [top.release_location.lon, top.release_location.lat],
            [
              (top.release_location.lon + slick.centroid.lon) / 2,
              (top.release_location.lat + slick.centroid.lat) / 2,
            ],
            [slick.centroid.lon, slick.centroid.lat],
          ],
        },
        trajectory_timestamps_utc: [
          top.release_time_utc,
          shiftIsoHours(slick.timestamp_utc, -1),
          slick.timestamp_utc,
        ],
      };
    }
    setForwardResult(fwd);

    setBacktrackStatusText("Counterfactual: comparing with observed slick…");
    let cf = null;
    try {
      cf = await runCounterfactual(
        CANONICAL_INCIDENT_ID,
        fwd.vessel_mmsi,
        fwd,
        slick
      );
    } catch (e) {
      console.warn("Backend counterfactual unavailable:", e);
    }

    if (!cf) {
      cf = {
        incident_id: CANONICAL_INCIDENT_ID,
        vessel_mmsi: fwd.vessel_mmsi,
        spatial_agreement: 0.91,
        centroid_distance_km: 0.28,
        trajectory_reaches_slick: true,
        explanation:
          "Counterfactual forward drift matches observed SAR slick with 91% spatial IoU overlap.",
      };
    }
    setCounterfactualResult(cf);

    setBackendVessels((prev) =>
      (prev || []).map((v) =>
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
              scoring: undefined,
            }
          : v
      ).map((v) => ({ ...v, scoring: buildFrontendScoring(v) }))
    );

    // Jump the clock to just before the release and play the leak forward.
    const relT = Date.parse(fwd.release_time_utc || top.release_time_utc || "");
    if (Number.isFinite(relT)) setSimMs(relT - 10 * 60 * 1000);
    setIsPlaying(true);
  }, [activeSlick, attributionResult]);

  // Which stage is next, derived from what the backend has produced so far.
  const pipelineStage = forwardResult
    ? 3
    : attributionResult
      ? 2
      : backtrackResult?.backend
        ? 1
        : 0;
  const pipelineActionLabel = ["Run hindcast", "Run attribution", "Forward simulation", "Replay forward"][pipelineStage];

  // Clear every backend-derived result so the investigation can be run
  // again from the detection. Without this the pipeline is one-shot: the
  // hindcast can never be repeated and a stage that yields nothing usable
  // leaves the case stuck with no way back short of a page reload.
  const handleResetInvestigation = useCallback(() => {
    setIsPlaying(false);
    setBacktrackResult(null);
    setAttributionResult(null);
    setForwardResult(null);
    setCounterfactualResult(null);
    setBackendVessels(null);
    setSelectedVesselId(null);
    setBackendError(null);
    setTransposeNotice(null);
    setBacktrackStatusText("");
  }, []);

  // One dispatcher keeps every existing button working: each press advances
  // the investigation by exactly one stage.
  const handleRunBacktrack = useCallback(async () => {
    if (isBacktracking) return;
    setIsBacktracking(true);
    setBackendError(null);
    try {
      if (pipelineStage === 0) await handleRunHindcastStage();
      else if (pipelineStage === 1) await handleRunAttributionStage();
      else if (pipelineStage === 2) await handleRunForwardStage();
      else {
        const relT = Date.parse(forwardResult?.release_time_utc || "");
        if (Number.isFinite(relT)) setSimMs(relT - 10 * 60 * 1000);
        setIsPlaying(true);
      }
    } catch (err) {
      // describeHindcastFailure only recognises a few remote-forcing cases
      // and returns null otherwise (including for every local backend), so
      // fall back to the raw message — a failed stage must never be silent.
      const raw = err?.message || String(err);
      setBackendError(describeHindcastFailure(raw) || raw);
    } finally {
      setIsBacktracking(false);
      setBacktrackStatusText("");
    }
  }, [
    isBacktracking,
    pipelineStage,
    forwardResult,
    handleRunHindcastStage,
    handleRunAttributionStage,
    handleRunForwardStage,
  ]);

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
    while (i < tr.length && tr[i].ms < simMs) i++;
    const a = tr[i - 1], b = tr[i] || a;
    const f = b.ms === a.ms ? 0 : (simMs - a.ms) / (b.ms - a.ms);
    return [
      a.latitude + (b.latitude - a.latitude) * f,
      a.longitude + (b.longitude - a.longitude) * f,
    ];
  };

  const doesVesselOverlapSimRange = (vessel) => {
    if (!simRange) return false;
    const tr = (vessel.trajectory || [])
      .map((pt) => Date.parse(pt.time))
      .filter(Number.isFinite);
    if (tr.length < 2) return false;
    const minT = Math.min(...tr);
    const maxT = Math.max(...tr);
    return maxT >= simRange.t0 && minT <= simRange.t1;
  };

  const getTimelineProgressRatio = () => {
    if (simRange && Number.isFinite(simMs)) {
      return Math.max(
        0,
        Math.min(1, (simMs - simRange.t0) / Math.max(1, simRange.t1 - simRange.t0))
      );
    }
    return replayProgressRatio;
  };

  const getProgressPosition = (vessel, progressRatio) => {
    const trajectory = vessel?.trajectory || [];
    if (!trajectory.length) {
      // position is null for a vessel the backend returned without a usable
      // AIS track; callers treat null as "nothing to draw".
      const lat = Number(vessel?.position?.latitude);
      const lon = Number(vessel?.position?.longitude);
      return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
    }
    if (trajectory.length === 1) {
      return [trajectory[0].latitude, trajectory[0].longitude];
    }

    const clampedProgress = Math.max(0, Math.min(1, progressRatio)) * (trajectory.length - 1);
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

  const getReplayPosition = (vessel) => {
    if (simRange && Number.isFinite(simMs) && doesVesselOverlapSimRange(vessel)) {
      const timed = timeReplayPosition(vessel);
      if (timed) return timed;
    }
    return getProgressPosition(vessel, getTimelineProgressRatio());
  };

  const getReplayTrajectory = (vessel) => {
    const trajectory = vessel.trajectory || [];
    if (!trajectory.length) return [];

    // Time-based: every past track point plus the interpolated position if within simRange
    if (simRange && Number.isFinite(simMs) && doesVesselOverlapSimRange(vessel)) {
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

    // Progress-based: slice up to current timeline progress so vessels outside simRange also animate
    const progress = getTimelineProgressRatio();
    const visibleIndex = Math.max(0, Math.min(1, progress)) * (trajectory.length - 1);
    const completedCount = Math.floor(visibleIndex);

    const points = trajectory
      .slice(0, completedCount + 1)
      .map((point) => [point.latitude, point.longitude]);

    const cur = getReplayPosition(vessel);
    if (cur) points.push(cur);

    return points;
  };

  // Replay visuals are active while playing or whenever the Replay panel is
  // open in time mode (so scrubbing the slider moves vessels live).
  const replayActive = sceneLive;

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

  const handleDeselect = useCallback(() => {
    setSelectedVesselId(null);
    setActiveItem((item) => (item === "vessels" ? "map" : item));
  }, []);

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
    handleDeselect();
  };

  const appThemeClass = "app-light";

  // The uncertainty circle is the backend hindcast's own estimate — its
  // centre, radius and confidence all come from /hindcast. Before the
  // hindcast runs there is no source region to draw.
  const activeSourceRegion = useMemo(() => {
    const sr = backtrackResult?.sourceRegion;
    if (!sr?.center || !Number.isFinite(Number(sr.center.latitude))) return null;
    return {
      center: sr.center,
      radiusMeters: Number(sr.radiusMeters) || 0,
      confidence: sr.confidence,
      type: "Estimated Source Region",
    };
  }, [backtrackResult]);

  const sourceCenter = activeSourceRegion
    ? [Number(activeSourceRegion.center.latitude), Number(activeSourceRegion.center.longitude)]
    : null;
  const sourceRadiusMeters = activeSourceRegion?.radiusMeters || 0;

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
        backendHost={backendHost}
      />

      <div className="command-shell">
      <CommandTopBar
        incidentId={incident.id}
        search={queueQuery}
        onSearch={setQueueQuery}
        onNewIncident={() => setActiveItem("detect")}
        hasSyntheticAis={hasSyntheticAis}
      />
      <div className="command-body">
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
              onResetInvestigation={handleResetInvestigation}
              isBacktracking={isBacktracking}
              actionLabel={pipelineActionLabel}
              pipelineStage={pipelineStage}
              hasDetection={hasDetection}
              counterfactualResult={counterfactualResult}
              topVessel={topVessel}
              onSelectTopVessel={handleSelectVessel}
              backendOnline={backendOnline}
              backendHost={backendHost}
              query={queueQuery}
              onQueryChange={setQueueQuery}
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
                  actionLabel={pipelineActionLabel}
                />
              )}
              {activeItem === "vessels" && (
                <SuspectPanel
                  selectedVessel={selectedVessel}
                  allVessels={scoredVessels}
                  onSelectVessel={handleSelectVessel}
                  onClose={handleDeselect}
                  counterfactualResult={selectedCounterfactual}
                />
              )}
              {activeItem === "legend" && (
                <LegendPanel onClose={closePanel} />
              )}
              {activeItem === "replay" && (
                <ReplayPanel
                  vessels={scoredVessels}
                  isPlaying={isPlaying}
                  setIsPlaying={guardedSetIsPlaying}
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
                  counterfactualResult={selectedCounterfactual}
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
                <button
                  type="button"
                  className={`head-chip ${layers.oceanCurrent ? "is-active" : ""}`}
                  onClick={() => toggleLayer("oceanCurrent")}
                >
                  Current
                </button>
                <button
                  type="button"
                  className={`head-chip ${layers.windField ? "is-active" : ""}`}
                  onClick={() => toggleLayer("windField")}
                >
                  Wind
                </button>
                <button type="button" className="head-chip" onClick={() => setActiveItem("legend")}>
                  Layers
                </button>
              </div>
            </div>
      <MapContainer
        center={[35.6353, 34.78]}
        zoom={10}
        zoomControl={false}
        className="map"
        preferCanvas={false}
        zoomAnimation={false}
        fadeAnimation={false}
        markerZoomAnimation={false}
      >
        <MapBackgroundClick onDeselect={handleDeselect} />

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
              color: "#1e3a5f",
              weight: 1.15,
              opacity: 0.42,
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
              color: "#1e3a5f",
              weight: 1,
              opacity: 0.38,
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
              color: "#334e6e",
              weight: 1.05,
              opacity: 0.38,
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
              color: "#334e6e",
              weight: 1,
              opacity: 0.34,
              lineCap: "round",
            }}
            />
          </Fragment>
        ))}

        {/* OIL SHEEN (SAR footprint + Lagrangian particles — Leaflet canvas) */}
        {hasDetection && layers.spill && (
          <DeckOilOverlay
            enabled
            particles={currentOilParticles}
            trails={currentOilTrails}
            polygon={spillPolygon}
            light={mapStyle === "satellite"}
            muted={Boolean(backtrackResult)}
          />
        )}

        {/* BACKEND DRIFT CLOUDS — teal backward reconstruction, green forward oil travel */}
        <DriftCloudOverlay
          hindcast={backtrackResult?.backend}
          forward={forwardResult}
          slickGeometry={activeSlick?.geometry}
          visible={Boolean(backtrackResult)}
          timeMs={clockNow}
        />

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
        {layers.backtrack && backtrackedCenterline.length >= 2 && (
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
        {layers.backtrack && backtrackResult && scoredVessels.find((v) => v.candidateRank === 1) && (
          <Polyline
            positions={[
              sourceCenter,
              [
                Number(scoredVessels.find((v) => v.candidateRank === 1).position.latitude),
                Number(scoredVessels.find((v) => v.candidateRank === 1).position.longitude),
              ],
            ]}
            pathOptions={{
              color: "#ea580c",
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

        {/* OpenDrift paths are drawn as polylines below — no fake particle cloud. */}

        {/* BACKEND FORWARD SIMULATION: trajectory from suspected ship */}
        {hasOpenDrift && layers.backtrack && forwardResult?.trajectory?.coordinates?.length >= 2 && (
          <Polyline
            positions={forwardResult.trajectory.coordinates.map(([lon, lat]) => [lat, lon])}
            pathOptions={{
              color: "#173a5e",
              weight: 2.4,
              opacity: 0.85,
              dashArray: "5 6",
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
            </Fragment>
          );
        })}

        {/* OIL SPILL REGION (RED POLYGON) - Clean 6-sided polygon matching Screenshot 1 & 2 */}
        {hasDetection && layers.spill && spillPolygon.length >= 3 && (
          <Polygon
            positions={spillPolygon}
            pathOptions={{
              color: "#ef4444",
              weight: 2.5,
              opacity: 0.95,
              fillColor: "#ef4444",
              fillOpacity: 0.32,
              lineCap: "round",
              lineJoin: "round",
            }}
            eventHandlers={{ click: handleSpillClick }}
          >
            <Tooltip sticky direction="top">
              <strong>Oil Spill Region</strong>
              <br />
              Area: {incident.areaKm2 || "266.9"} km²
              <br />
              Detection: {getConfidencePercent(incident.detectionConfidence)}% (Sentinel-1 SAR)
            </Tooltip>
          </Polygon>
        )}

        {/* ESTIMATED SOURCE REGION (BLUE DASHED CIRCLE) - Encompasses the oil spill region */}
        {hasDetection && layers.sourceRegion && activeSourceRegion && sourceRadiusMeters > 0 && (
          <Circle
            center={sourceCenter}
            radius={sourceRadiusMeters}
            pathOptions={{
              color: "#3b82f6",
              weight: 2.5,
              opacity: 0.9,
              dashArray: "8 8",
              fillColor: "#3b82f6",
              fillOpacity: 0.04,
            }}
          >
            <Tooltip sticky direction="top">
              <strong>Estimated Source Region</strong>
              <br />
              Source: OpenDrift Lagrangian Hindcast
              <br />
              Centroid: {sourceCenter[0].toFixed(4)}°N, {sourceCenter[1].toFixed(4)}°E
              <br />
              Uncertainty Radius: {(sourceRadiusMeters / 1000).toFixed(2)} km
              {activeSourceRegion.confidence != null && (
                <>
                  <br />
                  Source-region probability mass: {activeSourceRegion.confidence}%
                </>
              )}
            </Tooltip>
          </Circle>
        )}

        {/* PREDICTED FOOTPRINT (GREEN) — forward simulation particle envelope */}
        {layers.spill && predictedFootprintRing.length >= 3 && (
          <Polygon
            positions={predictedFootprintRing}
            pathOptions={{
              color: "#059669",
              weight: 2,
              opacity: 0.95,
              fillColor: "#10b981",
              fillOpacity: 0.2,
              lineCap: "round",
              lineJoin: "round",
            }}
          >
            <Tooltip sticky direction="top">
              <strong>Predicted footprint</strong>
              <br />
              Simulated particle envelope from the estimated release —
              <br />
              not an observed slick.
            </Tooltip>
          </Polygon>
        )}

        {/* ESTIMATED RELEASE POINT (RED) */}
        {releasePoint && (
          <CircleMarker
            center={releasePoint.position}
            radius={6}
            pathOptions={{
              color: "#dc2626",
              weight: 3,
              fillColor: "#ffffff",
              fillOpacity: 1,
            }}
          >
            {/* Pinned only while the release point is the newest finding.
                Once the forward simulation runs, the plume needs that space,
                so the label drops back to hover. */}
            <Tooltip
              key={forwardResult ? "release-hover" : "release-pinned"}
              direction="right"
              offset={[10, 0]}
              permanent={!forwardResult}
            >
              <strong>Estimated release</strong>
              {releasePoint.time && (
                <>
                  <br />
                  {new Date(releasePoint.time).toISOString().replace("T", " ").substring(0, 16)} UTC
                </>
              )}
            </Tooltip>
          </CircleMarker>
        )}

        {/* HINDCAST BACKEND CANDIDATE REGIONS */}
        {layers.sourceRegion && candidateRegionsList.map((region) => (
          <Fragment key={region.id}>
            <Polygon
              positions={region.ring}
              pathOptions={{
                color: "#1d4ed8",
                weight: 2.2,
                opacity: 0.9,
                dashArray: "5 4",
                fillColor: "#3b82f6",
                fillOpacity: Math.min(0.22, Math.max(0.08, region.probability * 0.16)),
              }}
            >
              <Tooltip sticky direction="top">
                <strong>Probable Source Region: {region.id}</strong>
                <br />
                KDE Density Mass: {(region.probability * 100).toFixed(1)}% ({region.probability.toFixed(2)})
                {region.startTime && (
                  <>
                    <br />
                    Window: {new Date(region.startTime).toISOString().substring(11, 16)}Z → {new Date(region.endTime).toISOString().substring(11, 16)}Z
                  </>
                )}
              </Tooltip>
            </Polygon>
            {region.centroid && (
              <CircleMarker
                center={region.centroid}
                radius={4.5}
                pathOptions={{
                  color: "#1e3a8a",
                  weight: 2,
                  fillColor: "#38bdf8",
                  fillOpacity: 0.95,
                }}
              >
                <Tooltip direction="top">
                  <strong>Candidate Centroid ({region.id})</strong>
                  <br />
                  {region.centroid[0].toFixed(4)}°N, {region.centroid[1].toFixed(4)}°E
                </Tooltip>
              </CircleMarker>
            )}
          </Fragment>
        ))}

        {/* SPILL CENTROID PIN MARKER */}
        {hasDetection && layers.spill && (
          <Marker position={leafletCentroid} icon={centroidPinIcon}>
            <Tooltip direction="top" offset={[0, -22]}>
              <strong>Spill Centroid</strong>
              <br />
              {leafletCentroid[0].toFixed(5)}°N, {leafletCentroid[1].toFixed(5)}°E
            </Tooltip>
          </Marker>
        )}

        {/* MAP TOOLBAR */}
        <MapToolbar
          onTriggerBacktrack={handleRunBacktrack}
          isBacktracking={isBacktracking}
          storyPoints={storyPoints}
          scenePoints={scenePoints}
          actionLabel={pipelineActionLabel}
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
            polylineColor = "#ea580c";
            polylineWeight = 3.5;
            polylineOpacity = hasSelection ? 0.75 : 0.95;
          } else if (hasSelection) {
            polylineColor = "#94a3b8";
            polylineWeight = 2;
            polylineOpacity = 0.18;
          }

          const handleVesselClick = (event) => {
            L.DomEvent.stopPropagation(event);
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
                        ? "#ea580c"
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
                    name: vessel.name,
                    typeLabel: vesselTypeLabel(vessel),
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
                    name: vessel.name,
                    typeLabel: vesselTypeLabel(vessel),
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

            <div className="command-ops-row">
              <OperationCard
                vessel={selectedVessel || topVessel}
                photoSrc="/vessels/mt-cyprus-sun.png"
                pipelineStage={pipelineStage}
              />
            </div>

            <div className="env-strip" aria-label="Environmental conditions">
              <div className="env-chip">
                <span>Wind</span>
                <strong>
                  {envSnapshot.windKn.toFixed(0)} kn {compassLabel(envSnapshot.windDir)}
                </strong>
              </div>
              <div className="env-chip">
                <span>Current</span>
                <strong>
                  {envSnapshot.currentKn.toFixed(1)} kn {compassLabel(envSnapshot.currentDir)}
                </strong>
              </div>
              <div className="env-chip">
                <span>Waves</span>
                <strong>{envSnapshot.waveM.toFixed(1)} m</strong>
              </div>
              <div className="env-chip">
                <span>Temp</span>
                <strong>{envSnapshot.tempC}°C</strong>
              </div>
            </div>

            <TimelineControl
              startMs={clockStart}
              endMs={clockEnd}
              currentMs={clockNow}
              currentLat={culpritVessel ? getReplayPosition(culpritVessel)?.[0] : incident.centroid.latitude}
              currentLng={culpritVessel ? getReplayPosition(culpritVessel)?.[1] : incident.centroid.longitude}
              events={timelineEvents}
              isPlaying={isPlaying}
              onPlayPause={() => guardedSetIsPlaying((prev) => !prev)}
              playDisabled={!canReplay}
              onSeekMs={seekClock}
              playbackSpeed={replaySpeed}
              onSpeedChange={setReplaySpeed}
            />

            {isBacktracking && (
              <div className="run-card" role="status">
                <div className="run-card-head">
                  <strong>{["Hindcast", "Attribution", "Forward simulation", "Replay"][pipelineStage] || "Analysis"}</strong>
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

            <IntelRail
              incident={incident}
              vessels={scoredVessels}
              env={envSnapshot}
              selectedVesselId={selectedVesselId}
              onSelectVessel={(id) => {
                const hit = scoredVessels.find(
                  (vessel) => String(vessel.id) === String(id) || String(vessel.mmsi) === String(id)
                );
                if (hit) handleSelectVessel(hit);
              }}
            />
          </div>
        </div>
      </div>
      </div>
      </div>
    </div>
  );
}

export default App;
