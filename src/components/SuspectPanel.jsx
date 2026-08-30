import React, { useState, useMemo } from "react";
import "./SuspectPanel.css";

export function SuspectPanel({
  selectedVessel,
  allVessels = [],
  onSelectVessel,
  onClose,
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState("all"); // "all" | "high" | "medium" | "low"
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const getAisStatusClass = (status) => {
    const value = (status || "").toLowerCase();
    if (value === "good" || value === "optimal" || value === "nominal") {
      return "badge-good";
    }
    if (value === "warning" || value === "degraded") {
      return "badge-warning";
    }
    if (value === "critical" || value === "bad") {
      return "badge-danger";
    }
    return "badge-neutral";
  };

  const getScoreColor = (score) => {
    if (score >= 0.7) return "#3b82f6";
    if (score >= 0.5) return "#d97706";
    return "#64748b";
  };

  // Safe Top Candidate
  const topCandidate = useMemo(() => {
    if (!allVessels || !allVessels.length) return null;
    return allVessels.find((v) => v.candidateRank === 1) || allVessels[0];
  }, [allVessels]);

  // Filtered vessels for scalable backend data (handles 3 or 100+ vessels)
  const filteredVessels = useMemo(() => {
    if (!Array.isArray(allVessels)) return [];
    return allVessels.filter((vessel) => {
      const name = (vessel.name || "").toLowerCase();
      const type = (vessel.type || "").toLowerCase();
      const id = (vessel.id || "").toLowerCase();
      const flag = (vessel.flag || "").toLowerCase();
      const query = searchQuery.toLowerCase().trim();

      const matchesSearch =
        !query ||
        name.includes(query) ||
        type.includes(query) ||
        id.includes(query) ||
        flag.includes(query);

      const conf = Number(vessel.attributionConfidence) || 0;
      let matchesFilter = true;
      if (riskFilter === "high") matchesFilter = conf >= 0.6;
      else if (riskFilter === "medium") matchesFilter = conf >= 0.4 && conf < 0.6;
      else if (riskFilter === "low") matchesFilter = conf < 0.4;

      return matchesSearch && matchesFilter;
    });
  }, [allVessels, searchQuery, riskFilter]);

  // Next/Prev navigation when inspecting a vessel
  const currentIndex = selectedVessel
    ? allVessels.findIndex((v) => v.id === selectedVessel.id)
    : -1;

  const handlePrev = () => {
    if (currentIndex > 0) {
      onSelectVessel(allVessels[currentIndex - 1]);
    } else if (allVessels.length > 0) {
      onSelectVessel(allVessels[allVessels.length - 1]);
    }
  };

  const handleNext = () => {
    if (currentIndex >= 0 && currentIndex < allVessels.length - 1) {
      onSelectVessel(allVessels[currentIndex + 1]);
    } else if (allVessels.length > 0) {
      onSelectVessel(allVessels[0]);
    }
  };

  // =====================================================
  // OVERVIEW STATE (NO VESSEL CURRENTLY SELECTED)
  // =====================================================
  if (!selectedVessel) {
    return (
      <aside className="suspect-panel suspect-panel-open" aria-label="Vessel investigation">
        {/* PANEL HEADER */}
        <div className="panel-header">
          <div>
            <div className="panel-kicker-row">
              <span className="live-pulse-dot" />
              <span className="panel-kicker">MARITIME SURVEILLANCE &amp; ATTRIBUTION</span>
            </div>
            <h2>Vessel Investigation</h2>
            <p className="panel-header-description">
              Candidate vessels evaluated against backtracked Lagrangian source region.
            </p>
          </div>
          <button
            type="button"
            className="close-button"
            onClick={onClose}
            aria-label="Close vessel investigation"
          >
            ×
          </button>
        </div>

        <div className="panel-scroll-content">
          {/* QUICK METRICS BAR */}
          <div className="investigation-metrics-grid">
            <div className="investigation-metric-card">
              <span className="metric-label">TRACKED TARGETS</span>
              <span className="metric-val">{allVessels.length}</span>
              <span className="metric-sub">in corridor</span>
            </div>
            <div className="investigation-metric-card highlight-metric">
              <span className="metric-label">TOP MATCH</span>
              <span className="metric-val">
                {topCandidate ? Math.round((topCandidate.attributionConfidence || 0) * 100) : 0}%
              </span>
              <span className="metric-sub">{topCandidate?.name || "None"}</span>
            </div>
            <div className="investigation-metric-card">
              <span className="metric-label">RELEASE WINDOW</span>
              <span className="metric-val">T-45m</span>
              <span className="metric-sub">10:00–10:45 UTC</span>
            </div>
          </div>

          {/* PRIMARY SUSPECT SPOTLIGHT */}
          {topCandidate && !searchQuery && riskFilter === "all" && (
            <div className="primary-suspect-spotlight">
              <div className="spotlight-badge">
                <span className="spotlight-star">★</span>
                <span>PRIMARY ATTRIBUTION TARGET</span>
              </div>

              <div className="spotlight-body">
                <div className="spotlight-title-row">
                  <div>
                    <h3 className="spotlight-name">{topCandidate.name}</h3>
                    <span className="spotlight-type">
                      {topCandidate.type || "Commercial Vessel"} • {topCandidate.flag || "Panama"}
                    </span>
                  </div>
                  <div className="spotlight-score-pill">
                    <span className="score-num">
                      {Math.round((topCandidate.attributionConfidence || 0) * 100)}%
                    </span>
                    <span className="score-lbl">MATCH</span>
                  </div>
                </div>

                {/* Score bar */}
                <div className="spotlight-meter">
                  <div
                    className="spotlight-meter-fill"
                    style={{
                      width: `${Math.round((topCandidate.attributionConfidence || 0) * 100)}%`,
                    }}
                  />
                </div>

                {/* Tags */}
                <div className="spotlight-tags">
                  <span className="spotlight-tag alert-tag">Trajectory Crossing</span>
                  <span className="spotlight-tag warn-tag">
                    Speed Anomaly ({topCandidate.speedKnots ?? "N/A"} kts)
                  </span>
                  <span className="spotlight-tag">Heading {topCandidate.heading ?? 0}°</span>
                </div>

                <button
                  type="button"
                  className="spotlight-action-btn"
                  onClick={() => onSelectVessel(topCandidate)}
                >
                  <span>Inspect Forensic Evidence</span>
                  <span className="btn-arrow">→</span>
                </button>
              </div>
            </div>
          )}

          {/* ALL CANDIDATE VESSELS LIST WITH SEARCH & FILTER */}
          <div className="candidate-overview-section">
            <div className="section-title-row">
              <span className="overview-label">ALL CANDIDATE VESSELS</span>
              <span className="candidate-count-badge">
                {filteredVessels.length} of {allVessels.length} Available
              </span>
            </div>

            {/* SEARCH & FILTER CONTROLS (Ensures scalability for 10-100+ real backend targets) */}
            <div className="vessel-search-bar-wrap">
              <span className="search-icon">🔍</span>
              <input
                type="text"
                className="vessel-search-input"
                placeholder="Search by vessel name, MMSI, type..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="clear-search-btn"
                  onClick={() => setSearchQuery("")}
                >
                  ×
                </button>
              )}
            </div>

            {/* RISK FILTER CHIPS */}
            <div className="risk-filter-chips">
              <button
                type="button"
                className={`filter-chip ${riskFilter === "all" ? "filter-chip-active" : ""}`}
                onClick={() => setRiskFilter("all")}
              >
                All ({allVessels.length})
              </button>
              <button
                type="button"
                className={`filter-chip filter-high ${riskFilter === "high" ? "filter-chip-active" : ""}`}
                onClick={() => setRiskFilter("high")}
              >
                High Risk (&ge;60%)
              </button>
              <button
                type="button"
                className={`filter-chip filter-med ${riskFilter === "medium" ? "filter-chip-active" : ""}`}
                onClick={() => setRiskFilter("medium")}
              >
                Medium (40-59%)
              </button>
              <button
                type="button"
                className={`filter-chip filter-low ${riskFilter === "low" ? "filter-chip-active" : ""}`}
                onClick={() => setRiskFilter("low")}
              >
                Low (&lt;40%)
              </button>
            </div>

            {/* CANDIDATE CARDS */}
            <div className="candidate-card-list">
              {filteredVessels.length === 0 ? (
                <div className="no-vessels-found">
                  <span>No vessels match the search criteria.</span>
                  <button
                    type="button"
                    className="reset-filter-btn"
                    onClick={() => {
                      setSearchQuery("");
                      setRiskFilter("all");
                    }}
                  >
                    Reset Filters
                  </button>
                </div>
              ) : (
                filteredVessels.map((vessel) => {
                  const confPercent = Math.round((vessel.attributionConfidence || 0) * 100);
                  const isTop = vessel.candidateRank === 1;

                  return (
                    <button
                      key={vessel.id}
                      type="button"
                      className={`candidate-entry-card ${isTop ? "candidate-card-top" : ""}`}
                      onClick={() => onSelectVessel(vessel)}
                    >
                      <div className="card-rank-indicator">
                        <span className={`rank-badge rank-${vessel.candidateRank || "other"}`}>
                          {vessel.candidateRank || "-"}
                        </span>
                      </div>

                      <div className="card-main-info">
                        <div className="card-name-row">
                          <span className="vessel-title">{vessel.name || "Unknown Vessel"}</span>
                          <span
                            className={`vessel-conf-badge conf-${
                              confPercent >= 60 ? "high" : confPercent >= 40 ? "med" : "low"
                            }`}
                          >
                            {confPercent}%
                          </span>
                        </div>

                        <div className="card-sub-row">
                          <span>{vessel.type || "Vessel"}</span>
                          <span>•</span>
                          <span>{vessel.speedKnots ?? "N/A"} kts</span>
                          <span>•</span>
                          <span>{vessel.heading ?? 0}°</span>
                        </div>

                        {/* Mini progress bar */}
                        <div className="candidate-mini-bar">
                          <div
                            className="candidate-mini-fill"
                            style={{
                              width: `${confPercent}%`,
                              backgroundColor: isTop
                                ? "#d97706"
                                : confPercent >= 50
                                ? "#3b82f6"
                                : "#64748b",
                            }}
                          />
                        </div>
                      </div>

                      <div className="card-chevron">›</div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* ATTRIBUTION METHODOLOGY SUMMARY */}
          <div className="attribution-methodology-card">
            <div className="methodology-header">
              <span className="methodology-icon">⚡</span>
              <span className="methodology-title">Attribution Methodology</span>
            </div>
            <p className="methodology-desc">
              Scores are calculated by combining backward Lagrangian transport convergence, vessel AIS trajectory crossing, temporal release window overlap, and counterfactual forward plume drift matching.
            </p>
          </div>
        </div>
      </aside>
    );
  }

  // =====================================================
  // SELECTED CANDIDATE VIEW
  // =====================================================
  const {
    candidateRank,
    name,
    type,
    speedKnots,
    heading,
    attributionConfidence,
    evidence,
  } = selectedVessel;

  const confidencePercent = Math.round((attributionConfidence || 0) * 100);

  return (
    <aside className="suspect-panel suspect-panel-open" aria-label="Vessel investigation">
      {/* HEADER */}
      <div className="panel-header">
        <div>
          <span className="panel-kicker">VESSEL FORENSIC DOSSIER</span>
          <h2>{name || "Candidate Vessel"}</h2>
          <p className="panel-header-description">
            Analytical attribution evidence and trajectory match.
          </p>
        </div>
        <button
          type="button"
          className="close-button"
          onClick={onClose}
          aria-label="Close vessel investigation"
        >
          ×
        </button>
      </div>

      {/* MODERN SCALABLE TARGET SWITCHER (Handles any number of backend vessels smoothly) */}
      <div className="vessel-selector-stepper-bar">
        <button
          type="button"
          className="stepper-nav-btn"
          onClick={handlePrev}
          title="Previous candidate"
        >
          ◀
        </button>

        <div className="stepper-dropdown-container">
          <button
            type="button"
            className="stepper-current-trigger"
            onClick={() => setDropdownOpen((prev) => !prev)}
          >
            <span className={`stepper-rank-tag rank-${candidateRank || "other"}`}>
              #{candidateRank || "-"}
            </span>
            <span className="stepper-name-text">{name}</span>
            <span className="stepper-conf-text">{confidencePercent}%</span>
            <span className="stepper-arrow">{dropdownOpen ? "▲" : "▼"}</span>
          </button>

          {dropdownOpen && (
            <div className="stepper-dropdown-menu">
              <div className="dropdown-header-row">
                <span>SELECT TARGET ({allVessels.length})</span>
              </div>
              <div className="dropdown-items-scroll">
                {allVessels.map((v) => {
                  const isCur = v.id === selectedVessel.id;
                  const cPct = Math.round((v.attributionConfidence || 0) * 100);
                  return (
                    <button
                      key={v.id}
                      type="button"
                      className={`dropdown-item-btn ${isCur ? "dropdown-item-active" : ""}`}
                      onClick={() => {
                        onSelectVessel(v);
                        setDropdownOpen(false);
                      }}
                    >
                      <span className="item-rank">#{v.candidateRank}</span>
                      <span className="item-name">{v.name}</span>
                      <span className="item-type">{v.type || "Vessel"}</span>
                      <span className="item-conf">{cPct}%</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          className="stepper-nav-btn"
          onClick={handleNext}
          title="Next candidate"
        >
          ▶
        </button>
      </div>

      <div className="panel-scroll-content">
        {/* VESSEL IDENTITY */}
        <section className="panel-section identity-section">
          <div className="identity-heading">
            <div className={`identity-marker rank-${candidateRank || "other"}`}>
              <span>▲</span>
            </div>
            <div>
              <span className="section-label">
                {candidateRank === 1 ? "★ PRIMARY SUSPECT" : `CANDIDATE RANK #${candidateRank || "-"}`}
              </span>
              <h2 className="vessel-name">{name}</h2>
              <div className="vessel-type-badge">
                {type || "Commercial"} Vessel
                {selectedVessel.flag && (
                  <span className="vessel-flag"> • {selectedVessel.flag}</span>
                )}
              </div>
            </div>
          </div>

          <div className="vessel-telemetry-grid">
            <div className="telemetry-item">
              <span className="telemetry-label">Speed</span>
              <span className="telemetry-value">{speedKnots ?? "N/A"} kts</span>
            </div>
            <div className="telemetry-item">
              <span className="telemetry-label">Heading</span>
              <span className="telemetry-value">{heading ?? 0}°</span>
            </div>
            <div className="telemetry-item">
              <span className="telemetry-label">Candidate Rank</span>
              <span className="telemetry-value">
                #{candidateRank || "-"} of {allVessels.length}
              </span>
            </div>
            <div className="telemetry-item">
              <span className="telemetry-label">Vessel ID</span>
              <span className="telemetry-value mono">{selectedVessel.id}</span>
            </div>
          </div>
        </section>

        {/* ATTRIBUTION SCORE */}
        <section className="panel-section confidence-section">
          <div className="confidence-header">
            <div className="confidence-title-group">
              <span className="section-label">ATTRIBUTION SCORE</span>
              <h3 className="confidence-heading">Attribution Confidence</h3>
            </div>
            <div
              className={`confidence-value-pill conf-${
                confidencePercent >= 60 ? "high" : confidencePercent >= 40 ? "med" : "low"
              }`}
            >
              {confidencePercent}%
            </div>
          </div>

          <div className="confidence-meter-container">
            <div
              className="confidence-meter-bar"
              style={{
                width: `${confidencePercent}%`,
                backgroundColor:
                  candidateRank === 1
                    ? "#d97706"
                    : confidencePercent >= 50
                    ? "#3b82f6"
                    : "#64748b",
              }}
            />
          </div>

          <p className="confidence-disclaimer">
            <span className="info-icon" aria-hidden="true">i</span>
            <span>
              Attribution score reflects spatial-temporal and counterfactual evidence, not legal certainty.
            </span>
          </p>
        </section>

        {/* EVIDENCE BREAKDOWN */}
        <section className="panel-section evidence-section">
          <div className="section-heading-row">
            <h3 className="section-title">Evidence Breakdown</h3>
            <span className="section-count">5 signals</span>
          </div>

          <div className="evidence-cards-list">
            {[
              ["Spatial Proximity", evidence?.spatial],
              ["Temporal Window", evidence?.temporal],
              ["Trajectory Compatibility", evidence?.trajectory],
              ["Drift & Counterfactual", evidence?.drift],
            ].map(
              ([title, item]) =>
                item && (
                  <div className="evidence-card" key={title}>
                    <div className="evidence-card-header">
                      <div className="evidence-label-group">
                        <span className="evidence-category">{title}</span>
                        <span className="evidence-desc">{item.label}</span>
                      </div>
                      <span className="evidence-score-badge">
                        {Math.round((item.score || 0) * 100)}%
                      </span>
                    </div>

                    <div className="evidence-bar-bg">
                      <div
                        className="evidence-bar-fill"
                        style={{
                          width: `${Math.round((item.score || 0) * 100)}%`,
                          backgroundColor: getScoreColor(item.score || 0),
                        }}
                      />
                    </div>
                  </div>
                )
            )}

            {evidence?.aisReliability && (
              <div className="evidence-card ais-card">
                <div className="evidence-card-header">
                  <div className="evidence-label-group">
                    <span className="evidence-category">AIS Reliability</span>
                    <span className="evidence-desc">
                      {evidence.aisReliability.label}
                    </span>
                  </div>
                  <span
                    className={`ais-status-badge ${getAisStatusClass(
                      evidence.aisReliability.status
                    )}`}
                  >
                    {evidence.aisReliability.status}
                  </span>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* FOOTER */}
      <div className="panel-footer">
        <button
          type="button"
          className="deselect-action-btn"
          onClick={onClose}
        >
          ← Back to All Candidates
        </button>
      </div>
    </aside>
  );
}

export default SuspectPanel;