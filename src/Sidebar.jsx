import { useState } from "react";
import "./Sidebar.css";

const NAV = [
  {
    group: "Operations",
    items: [
      { id: "incident", label: "Incident" },
      { id: "detect", label: "Detection" },
      { id: "backtrack", label: "Hindcast" },
    ],
  },
  {
    group: "Investigation",
    items: [
      { id: "vessels", label: "Vessels" },
      { id: "evidence", label: "Evidence" },
      { id: "replay", label: "Replay" },
    ],
  },
  {
    group: "Map",
    items: [
      { id: "map", label: "Scene" },
      { id: "legend", label: "Legend" },
    ],
  },
];

function NavIcon({ id }) {
  const common = { viewBox: "0 0 24 24", "aria-hidden": true };
  switch (id) {
    case "incident":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="2.4" />
        </svg>
      );
    case "detect":
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M8 9h8M8 12h5M8 15h6" />
        </svg>
      );
    case "backtrack":
      return (
        <svg {...common}>
          <path d="M9 7 5 12l4 5" />
          <path d="M5 12h14" />
        </svg>
      );
    case "vessels":
      return (
        <svg {...common}>
          <path d="M4 15h16l-2 4H6l-2-4Z" />
          <path d="M8 15V9h8v6" />
        </svg>
      );
    case "evidence":
      return (
        <svg {...common}>
          <path d="M7 4h8l4 4v12H7z" />
          <path d="M15 4v4h4" />
        </svg>
      );
    case "replay":
      return (
        <svg {...common}>
          <path d="M8 8v8l7-4z" />
        </svg>
      );
    case "map":
      return (
        <svg {...common}>
          <path d="M4 6.5 9 4l6 2.5L20 4v13.5L15 20l-6-2.5L4 20V6.5Z" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="6" cy="7" r="1.4" />
          <circle cx="6" cy="12" r="1.4" />
          <circle cx="6" cy="17" r="1.4" />
          <path d="M10 7h9M10 12h9M10 17h9" />
        </svg>
      );
  }
}

function Sidebar({
  activeItem,
  layers,
  onToggleLayer,
  onSelect,
  onTriggerBacktrack,
  backendOnline,
}) {
  const [layersOpen, setLayersOpen] = useState(false);

  return (
    <aside className="oiltrace-sidebar command-nav" aria-label="OilTrace navigation">
      <div className="sidebar-brand">
        <div className="brand-mark">
          <span />
        </div>
        <div className="brand-text">
          <div className="brand-name">OILTRACE</div>
          <div className="brand-subtitle">SIH 26143 · NTRO</div>
        </div>
      </div>

      <nav className="sidebar-navigation">
        {NAV.map((section) => (
          <div className="navigation-section" key={section.group}>
            <p className="nav-group-label">{section.group}</p>
            {section.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`sidebar-item ${activeItem === item.id ? "active" : ""}`}
                onClick={() => {
                  if (item.id === "backtrack") onTriggerBacktrack?.();
                  else onSelect?.(item.id);
                }}
              >
                <span className="sidebar-icon">
                  <NavIcon id={item.id} />
                </span>
                <span className="sidebar-label">{item.label}</span>
                {item.id === "detect" && <span className="nav-count">SAR</span>}
              </button>
            ))}
          </div>
        ))}

        <div className="sidebar-divider" />

        <div className="navigation-section">
          <button
            type="button"
            className={`sidebar-item ${layersOpen ? "active" : ""}`}
            onClick={() => setLayersOpen((open) => !open)}
            aria-expanded={layersOpen}
          >
            <span className="sidebar-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 4 4 8.5 12 13 20 8.5 12 4Z" />
                <path d="M4 12 12 16.5 20 12" />
                <path d="M4 15.5 12 20 20 15.5" />
              </svg>
            </span>
            <span className="sidebar-label">Layers</span>
            <span className={`layer-chevron ${layersOpen ? "open" : ""}`}>›</span>
          </button>

          {layersOpen && (
            <div className="layer-options" id="oiltrace-layer-options">
              {[
                ["spill", "Oil plume", "spill-color"],
                ["oilTrajectory", "Oil trajectory", null],
                ["backtrack", "Hindcast path", null],
                ["sourceRegion", "Source region", "source-color"],
                ["trajectories", "Vessel tracks", "trajectory-color"],
                ["vessels", "Vessels", "vessel-color"],
                ["oceanCurrent", "Ocean current", null],
                ["windField", "Wind field", null],
                ["detectedSlicks", "Detected slicks", null],
              ].map(([key, label, colorClass]) => (
                <label className="layer-option" key={key}>
                  <input
                    type="checkbox"
                    checked={Boolean(layers?.[key])}
                    onChange={() => onToggleLayer?.(key)}
                  />
                  <span>
                    <span className={`layer-color ${colorClass || ""}`} />
                    {label}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      </nav>

      <div className="sidebar-footer command-user">
        <span className={`demo-dot ${backendOnline === false ? "offline" : ""}`} />
        <div className="brand-text" style={{ opacity: 1, transform: "none", marginLeft: 10 }}>
          <div className="brand-name" style={{ fontSize: 13, letterSpacing: "0.02em" }}>
            Duty desk
          </div>
          <div className="brand-subtitle">Maritime analyst</div>
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
