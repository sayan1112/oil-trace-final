import { useMemo, useState } from "react";
import "./InvestigationList.css";

function confidencePct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n <= 1 ? Math.round(n * 100) : Math.round(n)));
}

function statusClass(pct) {
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

export default function InvestigationList({
  incident,
  vessels = [],
  detectionCount = 0,
  selectedVesselId,
  onSelectVessel,
  onOpenIncident,
  onOpenDetect,
  onRunHindcast,
  isBacktracking = false,
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
      if (filter === "ranked" && pct < 40) return false;
      if (filter === "high" && pct < 70) return false;
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
          {isBacktracking ? "Running pipeline…" : "Run hindcast"}
        </button>
        <button type="button" className="inv-action" onClick={onOpenDetect}>
          SAR detect
        </button>
      </div>

      {ranked[0] && (
        <div className="inv-top-hit">
          <div>
            <p>Top candidate</p>
            <strong>{ranked[0].name || ranked[0].mmsi}</strong>
          </div>
          <button type="button" className="inv-action" onClick={() => onSelectVessel?.(ranked[0])}>
            {confidencePct(ranked[0].attributionConfidence)}% inspect
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
                  {pct >= 70 ? "High" : pct >= 40 ? "Medium" : "Low"} · {pct}%
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
            No Mediterranean AIS tracks on the live API yet. Run hindcast after the backend Med deploy
            (MT Cyprus Sun / 211000001). Norway sample ships are not drawn on this scene.
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
