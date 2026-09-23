import { initLiveStatus } from "./live";
import { initDashboard } from "./dashboard";
import { initSortableTables } from "./sortable";
import { initFilterPops } from "./filters";
import "./islands";

initLiveStatus();
initSortableTables();
initFilterPops();
const path = location.pathname;
if (path === "/") initDashboard();
