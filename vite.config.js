import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // 5173 is in the backend's CORS allowlist (ALLOWED_ORIGINS).
    port: 5173,
    strictPort: true,
    proxy: {
      // The ML detection service sends no CORS headers, so the browser can't
      // call it directly. In dev, Vite proxies /ml-api/* to it server-side.
      // In production, either add CORS to the ML service or configure the
      // same rewrite on the static host (and/or set VITE_ML_BASE_URL).
      "/ml-api": {
        target: "https://vscimatic999--oiltrace-detection-web.modal.run",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ml-api/, ""),
      },
    },
  },
});
