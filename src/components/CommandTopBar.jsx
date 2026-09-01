import { Bell, Search } from "lucide-react";

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
        <Search size={16} strokeWidth={1.8} />
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
          <Bell size={18} strokeWidth={1.8} />
          <span className="stitch-badge" />
        </button>
      </div>
    </header>
  );
}
