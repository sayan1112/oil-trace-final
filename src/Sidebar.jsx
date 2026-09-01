import "./Sidebar.css";

const NAV = [
  { id: "incident", label: "Incident" },
  { id: "detect", label: "Detection" },
  { id: "backtrack", label: "Hindcast" },
  { id: "vessels", label: "Vessels" },
  { id: "evidence", label: "Evidence" },
  { id: "replay", label: "Replay" },
  { id: "map", label: "Scene" },
];

function NavIcon({ id }) {
  const common = {
    viewBox: "0 0 24 24",
    "aria-hidden": true,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.85",
    strokeLinecap: "round",
    strokeLinejoin: "round",
  };
  switch (id) {
    case "incident":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.5" />
          <circle cx="12" cy="12" r="2.2" />
        </svg>
      );
    case "detect":
      return (
        <svg {...common}>
          <rect x="5" y="6" width="14" height="12" rx="3.5" />
          <path d="M8 10h8M8 13h5" />
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
          <path d="M8 4h7l4 4v12H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
          <path d="M15 4v4h4" />
        </svg>
      );
    case "replay":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="m10 9 6 3-6 3z" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M4 7.2 9 5l6 2.4L20 5v12.6L15 20l-6-2.4L4 20Z" />
          <path d="M9 5v12.6M15 7.4V20" />
        </svg>
      );
  }
}

function Sidebar({
  activeItem,
  onSelect,
  onTriggerBacktrack,
  backendOnline,
  backendHost,
}) {
  const host = String(backendHost || "localhost:8000").replace(/^https?:\/\//, "");
  const shortHost = host.replace(/\/api\/v1\/?$/i, "");

  return (
    <aside className="oiltrace-sidebar command-nav stitch-nav" aria-label="OilTrace navigation">
      <div className="sidebar-brand stitch-brand">
        <div className="brand-mark stitch-drop" aria-hidden="true">
          <span />
        </div>
        <div className="brand-text">
          <strong className="brand-name">OilTrace</strong>
        </div>
      </div>

      <nav className="sidebar-navigation">
        {NAV.map((item) => (
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
          </button>
        ))}
      </nav>

      <div className="sidebar-footer command-user stitch-nav-foot">
        <div className={`stitch-backend ${backendOnline === false ? "is-off" : backendOnline ? "is-on" : ""}`}>
          <span className={`demo-dot ${backendOnline === false ? "offline" : ""}`} />
          <div>
            <strong>Backend</strong>
            <small>{backendOnline === false ? "Offline" : backendOnline ? "Local" : "Checking"}</small>
            <em>{shortHost}</em>
          </div>
        </div>
        <div className="stitch-user">
          <span className="stitch-avatar" aria-hidden="true">SD</span>
          <div>
            <strong>Sayan D.</strong>
            <small>Analyst</small>
          </div>
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
