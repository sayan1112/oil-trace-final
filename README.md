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

All analytical outputs are live from the OilTrace backend (`src/services/api.js`
+ `src/services/backendApi.js`). Axios tries
`https://vscimatic999--oiltrace-backend-web.modal.run`, then failovers to
`https://sih-oil-spill-26143-backend.onrender.com`.
"Run hindcast" executes hindcast (OpenDrift, 6 hours) → AIS query → attribution →
forward simulation → counterfactual. Override hosts with
`VITE_BACKEND_PRIMARY_URL` / `VITE_BACKEND_FALLBACK_URL` (see `.env.example`).

The ML detection service has no CORS headers, so the browser reaches it through
the `/ml-api` dev proxy (vite.config.js). In production, add CORS to the ML
service or replicate the rewrite on the static host (or set `VITE_ML_BASE_URL`).

The canonical SIH demo is Eastern Mediterranean / Cyprus (`incident-mediterranean-001`,
centroid 35.63533°N, 34.87040°E). The map is seeded from ML detection (Oil/00067);
source region, AIS ranking, forward drift, and replay come from the backend API.
Do not use Norway/Mumbai regression fixtures as the frontend demo.
