/**
 * OilTrace Detection Service API client
 * BASE: https://vscimatic999--oiltrace-detection-web.modal.run
 *
 * All coordinates are WGS84, [lon, lat] order in GeoJSON geometry,
 * but centroid property uses {lat, lon} named keys.
 *
 * Cold-start note: first request after ~5 quiet minutes takes 20–40 s extra.
 * Always call warmDetectionService() on app mount and before live demos.
 */

const BASE = "https://vscimatic999--oiltrace-detection-web.modal.run";

/**
 * Fire-and-forget liveness probe. Wakes the container so subsequent
 * calls don't pay the cold-start penalty. Swallows all errors silently.
 * @returns {Promise<void>}
 */
export async function warmDetectionService() {
  try {
    await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(60_000) });
  } catch {
    // Intentionally silent — warm-up failure must never surface to the user.
  }
}

/**
 * Fetch the pre-computed demo detection result (no inference, instant).
 * This is the recommended integration entry point — real slick in the
 * Eastern Mediterranean, identical schema to a live POST /detect response.
 *
 * @returns {Promise<GeoJSONFeatureCollection>}
 * @throws {Error} with a user-readable message
 */
export async function fetchDemoDetection() {
  const response = await fetch(`${BASE}/detect/demo`, {
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Demo detection failed (${response.status}): ${text || response.statusText}`
    );
  }

  return response.json();
}

/**
 * Run live inference on an uploaded GeoTIFF scene.
 *
 * @param {File} file       - GeoTIFF, exactly 2 bands (VV + VH), ≤ 80 MB
 * @param {number} [threshold] - Probability cutoff 0.05–0.95. Omit to use the
 *                               validated default (0.325).
 * @returns {Promise<GeoJSONFeatureCollection>}
 * @throws {Error} with a user-readable message
 */
export async function runLiveDetection(file, threshold) {
  const formData = new FormData();
  formData.append("file", file);

  const url = new URL(`${BASE}/detect`);
  if (threshold !== undefined) {
    url.searchParams.set("threshold", String(threshold));
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    body: formData,
    // 300 s as specified in the API docs (20–60 s inference + cold-start margin)
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const json = await response.json();
      detail = json?.detail ?? json?.message ?? "";
    } catch {
      detail = await response.text().catch(() => "");
    }

    if (response.status === 413) {
      throw new Error("Upload exceeds the 80 MB limit. Please use a smaller scene.");
    }
    if (response.status === 422) {
      throw new Error(`Invalid file: ${detail || "Not a valid 2-band georeferenced GeoTIFF."}`);
    }
    if (response.status === 504) {
      throw new Error(
        "The detection service timed out (cold start). Please try again — the container is now warming."
      );
    }

    throw new Error(
      `Detection failed (${response.status}): ${detail || response.statusText}`
    );
  }

  return response.json();
}

/**
 * Download the demo GeoTIFF scene (24 MB) — useful for round-trip testing
 * POST /detect end-to-end.
 * @returns {Promise<Blob>}
 */
export async function fetchDemoScene() {
  const response = await fetch(`${BASE}/demo/scene`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Could not download demo scene (${response.status})`);
  }
  return response.blob();
}
