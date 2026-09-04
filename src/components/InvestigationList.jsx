import { useMemo, useState } from "react";
import "./InvestigationList.css";

function confidencePct(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n <= 1 ? Math.round(n * 100) : Math.round(n)));
}

function statusClass(pct) {
  if (pct == null) return "delivered";
  if (pct >= 70) return "in-transit";
  if (pct >= 40) return "queued";
  return "delivered";
}

function formatCoord(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "—";
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(3)}°${ns}  ${Math.abs(lon).toFixed(3)}°${ew}`;
}

const WORKFLOW_STEPS = [
  { id: "detect", num: "01", label: "Detection", hint: "SAR oil slick" },
  { id: "hindcast", num: "02", label: "Hindcast", hint: "Backtrack source" },
  { id: "attribution", num: "03", label: "Attribution", hint: "Rank vessels" },
  { id: "forward", num: "04", label: "Forward", hint: "Counterfactual" },
];

export default function InvestigationList({
  incident,
  vessels = [],
  detectionCount = 0,
  selectedVesselId,
  onSelectVessel,
  onOpenIncident,
  onOpenDetect,
  onRunHindcast,
  onResetInvestigation,
  isBacktracking = false,
  actionLabel = "Run hindcast",
  pipelineStage = 0,
  hasDetection = false,
  counterfactualResult,
  topVessel,
  onSelectTopVessel,
  backendOnline,
  backendHost,
  query: queryProp,
  onQueryChange,
}) {
  const [queryLocal, setQueryLocal] = useState("");
  const query = queryProp ?? queryLocal;
  const setQuery = onQueryChange || setQueryLocal;
  const [filter, setFilter] = useState("all");

  const ranked = useMemo(
    () => [...vessels].sort((a, b) => (a.candidateRank || 99) - (b.candidateRank || 99)),
    [vessels]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ranked.filter((v) => {
      const pct = confidencePct(v.attributionConfidence);
      if (filter === "ranked" && (pct ?? 0) < 40) return false;
      if (filter === "high" && (pct ?? 0) < 70) return false;
      if (!q) return true;
      return [v.name, v.id, v.mmsi, v.type, v.flag]
        .filter(Boolean)
        .some((part) => String(part).toLowerCase().includes(q));
    });
  }, [ranked, query, filter]);

  const lat = Number(incident?.centroid?.latitude ?? incident?.location?.latitude);
  const lon = Number(incident?.centroid?.longitude ?? incident?.location?.longitude);
  const isLocal = /localhost|127\.0\.0\.1/i.test(String(backendHost || ""));
  const linkLabel =
    backendOnline === true
      ? isLocal
        ? "Local"
        : "Live"
      : backendOnline === false
        ? isLocal
          ? "Local offline"
          : "Offline"
        : "Checking";

  return (
    <section className="inv-list" aria-label="Investigation queue">
      <header className="inv-list-header">
        <div>
          <p className="inv-kicker">Case queue</p>
          <h2>Tracking slicks</h2>
        </div>
        <span className={`inv-link-chip ${backendOnline === true ? "ok" : backendOnline === false ? "bad" : "wait"}`}>
          {linkLabel}
        </span>
      </header>

      {/* Investigation workflow — the operator can always see which stage the
          case has reached and what the next action produces. */}
      <ol className="inv-workflow" aria-label="Investigation workflow">
        {WORKFLOW_STEPS.map((step, index) => {
          // Step 01 is complete once a detection is loaded; steps 02-04 map
          // onto pipelineStage 1-3.
          const done = index === 0 ? hasDetection : pipelineStage >= index;
          const isActive =
            index === 0 ? !hasDetection : hasDetection && pipelineStage === index - 1;
          return (
            <li
              key={step.id}
              className={`inv-step ${done ? "is-done" : ""} ${isActive && !done ? "is-active" : ""}`}
            >
              <span className="inv-step-num" aria-hidden="true">
                {done ? "✓" : step.num}
              </span>
              <span className="inv-step-text">
                <strong>{step.label}</strong>
                <small>{step.hint}</small>
              </span>
            </li>
          );
        })}
      </ol>

      {/* Verdict — the conclusion of the whole investigation, surfaced here
          instead of being buried inside the vessel dossier's scroll area. */}
      {counterfactualResult && topVessel && (
        <div className="inv-verdict">
          <div className="inv-verdict-head">
            <span className="inv-verdict-kicker">Result · counterfactual</span>
            <span className={`inv-verdict-strength ${/strong/i.test(counterfactualResult.evidence_strength || "") ? "is-strong" : ""}`}>
              {counterfactualResult.evidence_strength
                ? `${counterfactualResult.evidence_strength} evidence`
                : "Scored"}
            </span>
          </div>
          <button type="button" className="inv-verdict-vessel" onClick={() => onSelectTopVessel?.(topVessel)}>
            <strong>{topVessel.name || topVessel.mmsi}</strong>
            <span>
              MMSI {topVessel.mmsi}
              {confidencePct(topVessel.attributionConfidence) != null
                ? ` · ${confidencePct(topVessel.attributionConfidence)}% attribution`
                : ""}
            </span>
          </button>
          <div className="inv-verdict-metrics">
            <div>
              <small>Footprint overlap</small>
              <strong>
                {counterfactualResult.spatial_agreement != null
                  ? `${Math.round(counterfactualResult.spatial_agreement * 100)}%`
                  : "—"}
              </strong>
            </div>
            <div>
              <small>Centroid offset</small>
              <strong>
                {counterfactualResult.centroid_distance_km != null
                  ? `${Number(counterfactualResult.centroid_distance_km).toFixed(2)} km`
                  : "—"}
              </strong>
            </div>
            <div>
              <small>Reaches slick</small>
              <strong className={counterfactualResult.trajectory_reaches_slick ? "is-yes" : "is-no"}>
                {counterfactualResult.trajectory_reaches_slick ? "Yes" : "No"}
              </strong>
            </div>
          </div>
          <p className="inv-verdict-note">
            Physical-consistency evidence from the forward simulation — not proof of responsibility.
          </p>
        </div>
      )}

      <div className="inv-search">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search MMSI, name, type"
          aria-label="Search vessels"
        />
      </div>


      <div className="inv-actions">
        <button type="button" className="inv-action primary" onClick={onRunHindcast} disabled={isBacktracking}>
          {isBacktracking ? "Running…" : actionLabel}
        </button>
        {pipelineStage > 0 && onResetInvestigation ? (
          <button
            type="button"
            className="inv-action"
            onClick={onResetInvestigation}
            disabled={isBacktracking}
            title="Clear all analysis results and start again from the detection"
          >
            Reset analysis
          </button>
        ) : (
          <button type="button" className="inv-action" onClick={onOpenDetect}>
            SAR detect
          </button>
        )}
      </div>

      {ranked[0] && (
        <div className="inv-top-hit">
          <div>
            <p>{confidencePct(ranked[0].attributionConfidence) == null ? "Nearby vessel" : "Top candidate"}</p>
            <strong>{ranked[0].name || ranked[0].mmsi}</strong>
          </div>
          <button type="button" className="inv-action" onClick={() => onSelectVessel?.(ranked[0])}>
            {confidencePct(ranked[0].attributionConfidence) == null
              ? "inspect"
              : `${confidencePct(ranked[0].attributionConfidence)}% inspect`}
          </button>
        </div>
      )}

      <div className="inv-section-label">
        Candidate vessels
        <span>{visible.length}</span>
      </div>

      <div className="inv-cards">
        {visible.map((vessel) => {
          const pct = confidencePct(vessel.attributionConfidence);
          const selected = selectedVesselId === vessel.id;
          const initial = (vessel.name || "V").trim().charAt(0);
          return (
            <button
              key={vessel.id}
              type="button"
              className={`inv-vessel-card ${selected ? "is-selected" : ""}`}
              onClick={() => onSelectVessel?.(vessel)}
            >
              <div className="inv-case-top">
                <strong>#{vessel.mmsi || vessel.id}</strong>
                <span className={`inv-badge ${statusClass(pct)}`}>
                  {pct == null
                    ? "Not scored"
                    : `${pct >= 70 ? "High" : pct >= 40 ? "Medium" : "Low"} · ${pct}%`}
                </span>
              </div>
              <div className="inv-route">
                <span>{vessel.type || "Vessel"}</span>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 16h18l-2 4H5l-2-4Z" />
                  <path d="M7 16V9h10v7" />
                </svg>
                <span>Rank {vessel.candidateRank || "—"}</span>
              </div>
              <div className="inv-person">
                <span className="inv-avatar" aria-hidden="true">
                  {initial}
                </span>
                <div>
                  <strong>{vessel.name}</strong>
                  <small>{vessel.flag || "AIS track"}</small>
                </div>
              </div>
            </button>
          );
        })}
        {!visible.length && (
          <p className="inv-empty">
            {pipelineStage >= 1
              ? "Probable source region estimated. Run attribution to scan AIS traffic inside it and rank candidate vessels."
              : "No candidates yet. Run hindcast to trace the slick back to its probable source region."}
          </p>
        )}
      </div>

      {backendHost && (
        <p className="inv-host" title={backendHost}>
          {backendHost.replace(/^https?:\/\//, "")}
        </p>
      )}
    </section>
  );
}
