import { initLiveStatus } from "./live";
import { initDashboard } from "./dashboard";
import "./islands";

// Preact islands hydrate interactive parts; SSR pages come from Hono.
initLiveStatus();
const path = location.pathname;
if (path === "/") initDashboard();
