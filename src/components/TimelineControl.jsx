import React from "react";
import "./TimelineControl.css";

/**
 * TimelineControl component
 * Provides Play/Pause, manual time slider scrubbing, timestamp stepping,
 * and live replay status for AIS trajectory investigation.
 */
export function TimelineControl({
  timestamps = [],
  currentIndex = 0,
  isPlaying = false,
  onPlayPause,
  onSeek,
  onStepBack,
  onStepForward,
  playbackSpeed = 1,
  onSpeedChange,
  timelineEvents = []
}) {
  const currentTimestamp = timestamps[currentIndex] || "10:00";
  const startTime = timestamps[0] || "10:00";
  const endTime = timestamps[timestamps.length - 1] || "11:15";

  // Find if current timestamp has an associated event milestone label from incident.json
  const currentEvent = timelineEvents.find((e) => e.time === currentTimestamp);

  const progressPercent =
    timestamps.length > 1
      ? (currentIndex / (timestamps.length - 1)) * 100
      : 0;

  return (
    <div
      className="timeline-card"
      role="region"
      aria-label="Investigation Replay Timeline"
    >
      {/* Top Header: Status Indicator & Current Timestamp */}
      <div className="timeline-header">
        <div className="timeline-status-group">
          <div className={`status-pill ${isPlaying ? "active" : "paused"}`}>
            <span className="status-indicator"></span>
            <span className="status-label">
              {isPlaying ? "REPLAY ACTIVE" : "LIVE / REPLAY"}
            </span>
          </div>
          <span className="timeline-sub-tag">Trajectory Replay</span>
        </div>

        <div className="current-timestamp-badge">
          <span className="timestamp-clock-icon">⏱</span>
          <span className="timestamp-text">{currentTimestamp} UTC</span>
          {currentEvent && (
            <span className="timeline-event-chip" title={currentEvent.label}>
              {currentEvent.label}
            </span>
          )}
        </div>

        <div className="speed-toggle-group">
          <button
            type="button"
            className={`speed-btn ${playbackSpeed === 1 ? "active" : ""}`}
            onClick={() => onSpeedChange && onSpeedChange(1)}
            title="1x Replay Speed"
          >
            1x
          </button>
          <button
            type="button"
            className={`speed-btn ${playbackSpeed === 2 ? "active" : ""}`}
            onClick={() => onSpeedChange && onSpeedChange(2)}
            title="2x Replay Speed"
          >
            2x
          </button>
        </div>
      </div>

      {/* Middle: Slider Track & Milestone Ticks */}
      <div className="slider-wrapper">
        <span className="time-endpoint-label start">{startTime}</span>

        <div className="slider-track-container">
          <div
            className="slider-progress-fill"
            style={{ width: `${progressPercent}%` }}
          />

          <input
            type="range"
            min={0}
            max={Math.max(0, timestamps.length - 1)}
            step={1}
            value={currentIndex}
            onChange={(e) => onSeek && onSeek(Number(e.target.value))}
            className="time-slider"
            aria-label="Replay time slider"
          />

          {/* Milestone Ticks */}
          <div className="timeline-ticks">
            {timestamps.map((time, idx) => {
              const hasEvent = timelineEvents.some((e) => e.time === time);
              const isSelected = idx === currentIndex;
              const percent =
                timestamps.length > 1
                  ? (idx / (timestamps.length - 1)) * 100
                  : 0;

              return (
                <button
                  key={time}
                  type="button"
                  className={`tick-point ${isSelected ? "selected" : ""} ${
                    hasEvent ? "has-event" : ""
                  }`}
                  style={{ left: `${percent}%` }}
                  onClick={() => onSeek && onSeek(idx)}
                  title={`Seek to ${time}${
                    hasEvent
                      ? ` (${
                          timelineEvents.find((e) => e.time === time)?.label
                        })`
                      : ""
                  }`}
                >
                  <span className="tick-dot"></span>
                  <span className="tick-label">{time}</span>
                </button>
              );
            })}
          </div>
        </div>

        <span className="time-endpoint-label end">{endTime}</span>
      </div>

      {/* Bottom: Play/Pause and Step Controls */}
      <div className="timeline-footer">
        <div className="playback-controls">
          <button
            type="button"
            className="control-btn step-btn"
            onClick={onStepBack}
            title="Step backward (previous timestamp)"
            aria-label="Previous timestamp"
          >
            <svg
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="currentColor"
            >
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
            </svg>
          </button>

          <button
            type="button"
            className={`control-btn play-pause-btn ${
              isPlaying ? "is-playing" : ""
            }`}
            onClick={onPlayPause}
            title={isPlaying ? "Pause Replay" : "Play Replay"}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <>
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="currentColor"
                >
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
                <span>Pause</span>
              </>
            ) : (
              <>
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="currentColor"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span>Play Replay</span>
              </>
            )}
          </button>

          <button
            type="button"
            className="control-btn step-btn"
            onClick={onStepForward}
            title="Step forward (next timestamp)"
            aria-label="Next timestamp"
          >
            <svg
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="currentColor"
            >
              <path d="m6 18 8.5-6L6 6v12zM16 6v12h2V6h-2z" />
            </svg>
          </button>
        </div>

        <div className="timeline-counter">
          Point {currentIndex + 1} of {timestamps.length}
        </div>
      </div>
    </div>
  );
}
