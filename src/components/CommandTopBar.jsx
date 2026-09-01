export default function CommandTopBar({
  incidentId,
  search,
  onSearch,
  onNewIncident,
}) {
  return (
    <header className="stitch-topbar">
      <nav className="stitch-crumbs" aria-label="Breadcrumb">
        <span>Incidents</span>
        <span aria-hidden="true">›</span>
        <strong>{incidentId}</strong>
      </nav>
      <label className="stitch-search">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch?.(event.target.value)}
          placeholder="Search vessels, areas, incidents..."
          aria-label="Search vessels, areas, incidents"
        />
      </label>
      <div className="stitch-top-actions">
        <button type="button" className="stitch-new" onClick={onNewIncident}>
          + New incident
        </button>
        <button type="button" className="stitch-icon-btn" aria-label="Notifications">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9" />
            <path d="M10 20a2 2 0 0 0 4 0" />
          </svg>
          <span className="stitch-badge" />
        </button>
      </div>
    </header>
  );
}
