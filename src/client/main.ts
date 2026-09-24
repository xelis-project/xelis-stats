import { initLiveStatus } from "./live";
import { initDashboard } from "./dashboard";
import { initSortableTables } from "./sortable";
import { initFilterPops } from "./filters";
import { initSettings } from "./settings";
import { initFormatDisplay } from "./format-display";
import "./islands";

initLiveStatus();
initSortableTables();
initFilterPops();
initSettings();
initFormatDisplay();
const path = location.pathname;
if (path === "/") initDashboard();
