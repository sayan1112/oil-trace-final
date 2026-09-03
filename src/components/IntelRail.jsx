import { useState } from "react";
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
  const [envOpen, setEnvOpen] = useState(true);
  const [sourcesOpen, setSourcesOpen] = useState(true);

  const ranked = [...vessels].sort(
    (a, b) => (a.candidateRank || 99) - (b.candidateRank || 99)
  );

  return (
    <aside className="intel-rail" aria-label="Environmental conditions and sources">
      <div className={`intel-card ${envOpen ? "is-open" : "is-collapsed"}`}>
        <button
          type="button"
          className="intel-accordion-trigger"
          onClick={() => setEnvOpen((prev) => !prev)}
          aria-expanded={envOpen}
        >
          <h3>Environmental conditions</h3>
          <span className="intel-chevron" aria-hidden="true">{envOpen ? "−" : "+"}</span>
        </button>
        {envOpen && (
          <>
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
              Wind and current at the slick centroid from the local drift fields used on the map.
            </p>
          </>
        )}
      </div>

      <div className={`intel-card ${sourcesOpen ? "is-open" : "is-collapsed"}`}>
        <button
          type="button"
          className="intel-accordion-trigger"
          onClick={() => setSourcesOpen((prev) => !prev)}
          aria-expanded={sourcesOpen}
        >
          <h3>Possible sources</h3>
          <span className="intel-chevron" aria-hidden="true">{sourcesOpen ? "−" : "+"}</span>
        </button>
        {sourcesOpen && (
          ranked.length ? (
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
            <p className="intel-empty">No AIS candidates from the backend yet.</p>
          )
        )}
      </div>
    </aside>
  );
}
