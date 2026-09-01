import "./Sidebar.css";
import {
  Droplets,
  ScanLine,
  Undo2,
  Ship,
  FileText,
  CirclePlay,
  Map,
} from "lucide-react";

const NAV = [
  { id: "incident", label: "Incident", Icon: ScanLine },
  { id: "detect", label: "Detection", Icon: Droplets },
  { id: "backtrack", label: "Hindcast", Icon: Undo2 },
  { id: "vessels", label: "Vessels", Icon: Ship },
  { id: "evidence", label: "Evidence", Icon: FileText },
  { id: "replay", label: "Replay", Icon: CirclePlay },
  { id: "map", label: "Scene", Icon: Map },
];

function Sidebar({
  activeItem,
  onSelect,
  onTriggerBacktrack,
  backendOnline,
}) {

  return (
    <aside className="oiltrace-sidebar command-nav stitch-nav" aria-label="OilTrace navigation">
      <div className="sidebar-brand stitch-brand">
        <div className="brand-mark stitch-drop" aria-hidden="true">
          <Droplets size={18} color="#fff" strokeWidth={2.4} />
        </div>
        <div className="brand-text">
          <strong className="brand-name">OilTrace</strong>
        </div>
      </div>

      <nav className="sidebar-navigation">
        {NAV.map((item) => {
          const Icon = item.Icon;
          return (
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
                <Icon size={20} strokeWidth={1.75} />
              </span>
              <span className="sidebar-label">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer command-user stitch-nav-foot">
        <div className={`stitch-mission ${backendOnline === false ? "is-off" : ""}`}>
          <span className={`demo-dot ${backendOnline === false ? "offline" : ""}`} />
          <div>
            <strong>SIH 26143</strong>
            <small>{backendOnline === false ? "Watch floor offline" : "NTRO · E. Med"}</small>
          </div>
        </div>
        <div className="stitch-user">
          <span className="stitch-avatar" aria-hidden="true">SD</span>
          <div>
            <strong>Sayan D.</strong>
            <small>Duty analyst</small>
          </div>
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
