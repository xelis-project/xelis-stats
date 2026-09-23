import { initLiveStatus } from "./live";
import { initDashboard } from "./dashboard";
import { initSortableTables } from "./sortable";
import "./islands";

initLiveStatus();
initSortableTables();
const path = location.pathname;
if (path === "/") initDashboard();
