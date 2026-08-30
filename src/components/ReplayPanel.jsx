import { useMemo } from "react";
import "./ReplayPanel.css";

function ReplayPanel({
  vessels = [],
  onClose,
  isPlaying = false,
  setIsPlaying,
  replayProgress = 0,
  setReplayProgress,
  replaySpeed = 1,
  setReplaySpeed,
  totalPoints = 1,
  timeLabel,
  currentFieldDesc = "SIMULATED CURRENT (WESTWARD 0.3 m/s)",
  windFieldDesc = "SIMULATED WIND (NNW 5.2 m/s)",
}) {
  const START_MINUTES = 10 * 60; // 10:00
  const END_MINUTES = 11 * 60 + 15; // 11:15

  const maxProgress = Math.max(1, totalPoints - 1);
  const normalizedProgress = Math.max(0, Math.min(replayProgress, maxProgress));
  const progressPercent = (normalizedProgress / maxProgress) * 100;

  const replayMinutes =
    START_MINUTES + ((END_MINUTES - START_MINUTES) * normalizedProgress) / maxProgress;

  const formatTime = (minutes) => {
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
  };

  const computedTime = useMemo(() => timeLabel || formatTime(replayMinutes), [timeLabel, replayMinutes]);

  const togglePlaying = () => {
    if (normalizedProgress >= maxProgress) {
      setReplayProgress?.(0);
      setIsPlaying?.(true);
      return;
    }

    setIsPlaying?.((current) => !current);
  };

  const resetReplay = () => {
    setIsPlaying?.(false);
    setReplayProgress?.(0);
  };

  const handleSliderChange = (event) => {
    const nextProgress = Number(event.target.value);
    setIsPlaying?.(false);
    setReplayProgress?.(nextProgress);
  };

  return (
    <aside className="oiltrace-replay-panel">
      <div className="replay-panel-header">
        <div>
          <span className="replay-kicker">TEMPORAL ANALYSIS</span>
          <h2>Replay & Transport</h2>
          <p>Reconstruct vessel tracks & time-dependent oil drift over time.</p>
        </div>

        <button
          className="replay-close"
          type="button"
          onClick={onClose}
          aria-label="Close replay"
        >
          ×
        </button>
      </div>

      <div className="replay-time-card">
        <div className="replay-current-time">
          <span className="replay-time-label">REPLAY / SIMULATION TIME</span>
          <strong>{computedTime} UTC</strong>
        </div>

        <div className="replay-status">
          <span className={`replay-status-dot ${isPlaying ? "playing" : ""}`} />
          {isPlaying ? "Playing" : "Paused"}
        </div>
      </div>

      <div className="replay-timeline-section">
        <div className="replay-timeline-labels">
          <span>10:00 (T-45m)</span>
          <span>10:45 (Spill)</span>
          <span>11:15 (T+30m)</span>
        </div>

        <input
          className="replay-slider"
          type="range"
          min={0}
          max={maxProgress}
          step={0.01}
          value={normalizedProgress}
          style={{
            "--replay-progress": `${progressPercent}%`,
          }}
          onChange={handleSliderChange}
          aria-label="Replay timeline"
        />

        <div className="replay-timeline-markers">
          <span>START</span>
          <span>{computedTime}</span>
          <span>RELEASE</span>
          <span>DETECTED</span>
        </div>
      </div>

      <div className="replay-controls">
        <button
          type="button"
          className="replay-reset-button"
          onClick={resetReplay}
          title="Reset replay"
          aria-label="Reset replay"
        >
          ↻
        </button>

        <button
          type="button"
          className="replay-play-button"
          onClick={togglePlaying}
          title={isPlaying ? "Pause replay" : "Play replay"}
          aria-label={isPlaying ? "Pause replay" : "Play replay"}
        >
          {isPlaying ? "Ⅱ" : "▶"}
        </button>

        <button
          type="button"
          className="replay-reset-text"
          onClick={resetReplay}
        >
          Reset replay
        </button>
      </div>

      <div className="replay-speed-section">
        <div className="replay-speed-heading">
          <span className="replay-speed-title">Playback Speed</span>
          <span className="replay-speed-value">{replaySpeed}×</span>
        </div>

        <div className="replay-speed-buttons">
          {[0.5, 1, 2, 4].map((value) => (
            <button
              key={value}
              type="button"
              className={`speed-button ${replaySpeed === value ? "active" : ""}`}
              onClick={() => setReplaySpeed?.(value)}
            >
              {value}×
            </button>
          ))}
        </div>
      </div>

      {/* METEOROLOGICAL & CURRENT DRIFT FACTORS */}
      <div className="replay-vessel-summary" style={{ marginBottom: "1rem" }}>
        <div className="replay-summary-header">
          <span>DRIFT FORCING FIELDS</span>
          <span className="demo-text" style={{ fontSize: "0.7rem", opacity: 0.8 }}>SIMULATED</span>
        </div>

        <div className="replay-vessel-row" style={{ fontSize: "0.78rem" }}>
          <span className="replay-vessel-dot" style={{ backgroundColor: "#3b82f6" }} />
          <span className="replay-vessel-name">{currentFieldDesc}</span>
        </div>

        <div className="replay-vessel-row" style={{ fontSize: "0.78rem" }}>
          <span className="replay-vessel-dot" style={{ backgroundColor: "#06b6d4" }} />
          <span className="replay-vessel-name">{windFieldDesc}</span>
        </div>
      </div>

      <div className="replay-vessel-summary">
        <div className="replay-summary-header">
          <span>VESSEL TRACKS</span>
          <strong>{vessels.length}</strong>
        </div>

        {vessels.length > 0 ? (
          vessels.slice(0, 6).map((vessel) => (
            <div className="replay-vessel-row" key={vessel.id}>
              <span className="replay-vessel-dot" />
              <span className="replay-vessel-name">{vessel.name}</span>
              <span className="replay-vessel-rank">#{vessel.candidateRank}</span>
            </div>
          ))
        ) : (
          <div className="replay-empty">No vessel tracks available.</div>
        )}
      </div>

      <div className="replay-analysis-note">
        <span className="replay-note-icon">i</span>
        <p>
          Replay reconstructs vessel movement alongside particle drift.
          Ocean current and wind vectors drive the modelled oil transport.
        </p>
      </div>
    </aside>
  );
}

export default ReplayPanel;