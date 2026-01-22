// Path: src/routes.ts
// HTTP routes for Payara plugin - re-exports from modular routes
//
// This file maintains backwards compatibility while the actual implementation
// is now organized into separate modules under src/routes/

export { registerRoutes } from './routes/index.js';
export type { RouteContext } from './routes/index.js';
