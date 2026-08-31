# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.


### Stability patch
The map camera and oil particle layer are isolated from vessel-selection UI state. Selecting a vessel must not animate, refit, resize, recreate, or transform the oil field.

## Backend integration (OilTrace)

All analytical outputs are live from the OilTrace backend (`src/services/backendApi.js`):
"Backtrack Oil" runs hindcast (OpenDrift) → AIS vessel query → attribution →
forward simulation → counterfactual, and every score/region/trajectory shown
afterwards comes from those responses. Configure the backend with
`VITE_BACKEND_BASE_URL` (see `.env.example`; defaults to `http://127.0.0.1:8000`).

The ML detection service has no CORS headers, so the browser reaches it through
the `/ml-api` dev proxy (vite.config.js). In production, add CORS to the ML
service or replicate the rewrite on the static host (or set `VITE_ML_BASE_URL`).

The demo incident (`src/data/incident.json`) is the Norway scenario — it must
stay inside the backend's forcing-data window (lon 4–6, lat 59–61,
20–22 Aug 2025) or OpenDrift has no currents/wind to work with.
