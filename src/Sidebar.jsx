import { useState } from "react";
import "./Sidebar.css";

const menuItems = [
  {
    id: "incident",
    label: "Incident",
    icon: (
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    ),
  },
  {
    id: "map",
    label: "Map",
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M4 6.5 9 4l6 2.5L20 4v13.5L15 20l-6-2.5L4 20V6.5Z" />
        <path d="M9 4v13.5M15 6.5V20" />
      </svg>
    ),
  },
  {
    id: "vessels",
    label: "Vessels",
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M5 14h14l-2 4H7l-2-4Z" />
        <path d="M8 14V9h8v5" />
        <path d="M10 9V6h4v3" />
        <path d="M3 18c1.5 1.5 3 1.5 4.5 0 1.5 1.5 3 1.5 4.5 0 1.5 1.5 3 1.5 4.5 0 1.5 1.5 3 3 1.5 4.5 0" />
      </svg>
    ),
  },
  {
    id: "layers",
    label: "Layers",
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M12 4 4 8.5 12 13 20 8.5 12 4Z" />
        <path d="M4 12 12 16.5 20 12" />
        <path d="M4 15.5 12 20 20 15.5" />
      </svg>
    ),
  },
  {
    id: "legend",
    label: "Legend",
    icon: (
      <svg viewBox="0 0 24 24">
        <circle cx="5" cy="6" r="1.5" />
        <circle cx="5" cy="12" r="1.5" />
        <circle cx="5" cy="18" r="1.5" />
        <path d="M9 6h11M9 12h11M9 18h11" />
      </svg>
    ),
  },
  {
    id: "backtrack",
    label: "Backtrack",
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  },
  {
    id: "evidence",
    label: "Evidence",
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M5 4h14v16H5z" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </svg>
    ),
  },
  {
    id: "replay",
    label: "Replay",
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M4 12a8 8 0 1 0 3-6" />
        <path d="M4 5v5h5" />
        <path d="m10 9 5 3-5 3V9Z" />
      </svg>
    ),
  },
];

function Sidebar({ activeItem, layers, onToggleLayer, onSelect, onTriggerBacktrack }) {
  const [layersOpen, setLayersOpen] = useState(false);

  const getIcon = (id) => menuItems.find((item) => item.id === id)?.icon;

  return (
    <aside className="oiltrace-sidebar" aria-label="Oiltrace navigation">
      {/* BRAND */}
      <div className="sidebar-brand">
        <div className="brand-mark">
          <span />
        </div>
        <div className="brand-text">
          <div className="brand-name">OILTRACE</div>
          <div className="brand-subtitle">Maritime Analysis</div>
        </div>
      </div>

      {/* NAVIGATION */}
      <nav className="sidebar-navigation" aria-label="Primary navigation">
        {/* MAIN SECTION */}
        <div className="navigation-section">
          {menuItems.slice(0, 3).map((item) => (
            <button
              key={item.id}
              type="button"
              className={`sidebar-item ${activeItem === item.id ? "active" : ""}`}
              onClick={() => onSelect?.(item.id)}
              aria-current={activeItem === item.id ? "page" : undefined}
            >
              <span className="sidebar-icon">{item.icon}</span>
              <span className="sidebar-label">{item.label}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-divider" />

        {/* MAP CONTROLS */}
        <div className="navigation-section">
          <button
            type="button"
            className={`sidebar-item ${layersOpen ? "active" : ""}`}
            onClick={() => setLayersOpen((previous) => !previous)}
            aria-expanded={layersOpen}
            aria-controls="oiltrace-layer-options"
          >
            <span className="sidebar-icon">{getIcon("layers")}</span>
            <span className="sidebar-label">Layers</span>
            <span className={`layer-chevron ${layersOpen ? "open" : ""}`} aria-hidden="true">
              ›
            </span>
          </button>

          {/* LAYER OPTIONS */}
          {layersOpen && (
            <div id="oiltrace-layer-options" className="layer-options">
              {/* OIL SPILL / PLUME */}
              <label className="layer-option">
                <input
                  type="checkbox"
                  checked={layers?.spill ?? true}
                  onChange={() => onToggleLayer?.("spill")}
                />
                <span>
                  <span className="layer-color spill-color" />
                  Oil Plume
                </span>
              </label>

              {/* OIL TRAJECTORY CENTERLINE */}
              <label className="layer-option">
                <input
                  type="checkbox"
                  checked={layers?.oilTrajectory ?? true}
                  onChange={() => onToggleLayer?.("oilTrajectory")}
                />
                <span>
                  <span className="layer-color" style={{ backgroundColor: "#1e293b" }} />
                  Oil Trajectory
                </span>
              </label>

              {/* BACKTRACK PATHS */}
              <label className="layer-option">
                <input
                  type="checkbox"
                  checked={layers?.backtrack ?? true}
                  onChange={() => onToggleLayer?.("backtrack")}
                />
                <span>
                  <span className="layer-color" style={{ backgroundColor: "#06b6d4" }} />
                  Backtrack Paths
                </span>
              </label>

              {/* SOURCE REGION */}
              <label className="layer-option">
                <input
                  type="checkbox"
                  checked={layers?.sourceRegion ?? true}
                  onChange={() => onToggleLayer?.("sourceRegion")}
                />
                <span>
                  <span className="layer-color source-color" />
                  Source Region
                </span>
              </label>

              {/* VESSEL TRAJECTORIES */}
              <label className="layer-option">
                <input
                  type="checkbox"
                  checked={layers?.trajectories ?? true}
                  onChange={() => onToggleLayer?.("trajectories")}
                />
                <span>
                  <span className="layer-color trajectory-color" />
                  Vessel Tracks
                </span>
              </label>

              {/* VESSELS */}
              <label className="layer-option">
                <input
                  type="checkbox"
                  checked={layers?.vessels ?? true}
                  onChange={() => onToggleLayer?.("vessels")}
                />
                <span>
                  <span className="layer-color vessel-color" />
                  Vessels
                </span>
              </label>

              {/* SIMULATED OCEAN CURRENT */}
              <label className="layer-option">
                <input
                  type="checkbox"
                  checked={layers?.oceanCurrent ?? false}
                  onChange={() => onToggleLayer?.("oceanCurrent")}
                />
                <span>
                  <span className="layer-color" style={{ backgroundColor: "#0284c7" }} />
                  Simulated Ocean Current
                </span>
              </label>

              {/* SIMULATED WIND FIELD */}
              <label className="layer-option">
                <input
                  type="checkbox"
                  checked={layers?.windField ?? false}
                  onChange={() => onToggleLayer?.("windField")}
                />
                <span>
                  <span className="layer-color" style={{ backgroundColor: "#f59e0b" }} />
                  Simulated Wind Field
                </span>
              </label>
            </div>
          )}

          {/* LEGEND */}
          <button
            type="button"
            className={`sidebar-item ${activeItem === "legend" ? "active" : ""}`}
            onClick={() => onSelect?.("legend")}
            aria-current={activeItem === "legend" ? "page" : undefined}
          >
            <span className="sidebar-icon">{getIcon("legend")}</span>
            <span className="sidebar-label">Legend</span>
          </button>
        </div>

        <div className="sidebar-divider" />

        {/* ANALYSIS & TOOLS */}
        <div className="navigation-section">
          {menuItems.slice(5).map((item) => (
            <button
              key={item.id}
              type="button"
              className={`sidebar-item ${activeItem === item.id ? "active" : ""}`}
              onClick={() => {
                if (item.id === "backtrack") {
                  onTriggerBacktrack?.();
                } else {
                  onSelect?.(item.id);
                }
              }}
              aria-current={activeItem === item.id ? "page" : undefined}
            >
              <span className="sidebar-icon">{item.icon}</span>
              <span className="sidebar-label">{item.label}</span>
            </button>
          ))}
        </div>
      </nav>

      {/* FOOTER */}
      <div className="sidebar-footer">
        <span className="demo-dot" aria-hidden="true" />
        <span className="demo-text">Demo Mode</span>
      </div>
    </aside>
  );
}

export default Sidebar;