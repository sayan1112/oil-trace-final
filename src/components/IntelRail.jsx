import { compassLabel } from "../utils/compass";

function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n <= 1 ? Math.round(n * 100) : Math.round(n)));
}

function rankTone(value) {
  if (value >= 70) return "high";
  if (value >= 40) return "mid";
  return "low";
}

export default function IntelRail({
  incident,
  vessels = [],
  env,
  onSelectVessel,
  selectedVesselId,
}) {
  const lat = Number(incident?.centroid?.latitude ?? incident?.location?.latitude);
  const lon = Number(incident?.centroid?.longitude ?? incident?.location?.longitude);
  const conf = pct(incident?.detectionConfidence);
  const ranked = [...vessels].sort(
    (a, b) => (a.candidateRank || 99) - (b.candidateRank || 99)
  );

  return (
    <aside className="intel-rail" aria-label="Detection and environment">
      <div className="intel-card">
        <div className="intel-card-head">
          <h3>Detection summary</h3>
          <span>{incident?.detectedAt ? new Date(incident.detectedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "—"}</span>
        </div>
        <dl className="intel-kv">
          <div>
            <dt>First detection</dt>
            <dd>
              {incident?.detectedAt
                ? new Date(incident.detectedAt).toLocaleString("en-GB", {
                    day: "2-digit",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                    timeZone: "UTC",
                  }) + " UTC"
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Sensor</dt>
            <dd>{incident?.satellite?.platform || "Sentinel-1"} {incident?.satellite?.sensor || "SAR"}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{conf}%</dd>
          </div>
          <div>
            <dt>Slick area</dt>
            <dd>{Number(incident?.areaKm2 || 0).toFixed(3)} km²</dd>
          </div>
          <div>
            <dt>Centroid</dt>
            <dd>
              {Number.isFinite(lat) ? lat.toFixed(4) : "—"}°N,{" "}
              {Number.isFinite(lon) ? lon.toFixed(4) : "—"}°E
            </dd>
          </div>
        </dl>
      </div>

      <div className="intel-card">
        <h3>Environmental conditions</h3>
        <ul className="intel-env">
          <li>
            <span>Wind speed</span>
            <strong>{env.windKn.toFixed(0)} kn</strong>
          </li>
          <li>
            <span>Wind direction</span>
            <strong>
              {compassLabel(env.windDir)} ({Math.round(env.windDir)}°)
            </strong>
          </li>
          <li>
            <span>Sea current</span>
            <strong>
              {env.currentKn.toFixed(1)} kn · {compassLabel(env.currentDir)}
            </strong>
          </li>
          <li>
            <span>Wave height</span>
            <strong>{env.waveM.toFixed(1)} m</strong>
          </li>
          <li>
            <span>Sea temperature</span>
            <strong>{env.tempC}°C</strong>
          </li>
        </ul>
        <p className="intel-note">
          Wind and current at the slick centroid from the local drift fields used on the map. Wave height is estimated from wind; temperature is August Eastern Mediterranean climatology.
        </p>
      </div>

      <div className="intel-card">
        <h3>Possible sources</h3>
        {ranked.length ? (
          <ol className="intel-sources">
            {ranked.slice(0, 5).map((vessel) => {
              const score = pct(vessel.attributionConfidence);
              return (
                <li key={vessel.id || vessel.mmsi}>
                  <button
                    type="button"
                    className={String(selectedVesselId) === String(vessel.id) ? "is-on" : ""}
                    onClick={() => onSelectVessel?.(vessel.id)}
                  >
                    <span>
                      <strong>{vessel.name || vessel.mmsi}</strong>
                      <em>{vessel.mmsi}</em>
                    </span>
                    <b className={rankTone(score)}>{score}%</b>
                  </button>
                  <div className="intel-bar" aria-hidden="true">
                    <i className={rankTone(score)} style={{ width: `${score}%` }} />
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="intel-empty">No AIS candidates from the backend yet. Run hindcast when localhost:8000 is online.</p>
        )}
      </div>
    </aside>
  );
}
