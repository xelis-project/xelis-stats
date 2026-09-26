import { initLiveStatus } from "./live";
import { initSortableTables } from "./sortable";
import { initStorage } from "./storage";
import { initFilterPops } from "./filters";
import { initSettings } from "./settings";
import { initFormatDisplay } from "./format-display";

initLiveStatus();
initSortableTables();
initStorage();
initFilterPops();
initSettings();
initFormatDisplay();

// Heavy modules (uPlot, flatpickr) are loaded only on pages that use them so
// list/detail pages do not download the whole charting stack.
const path = location.pathname;
const needsIslands = path === "/charts" || path === "/market" || path.startsWith("/miner/")
  || path.startsWith("/asset/")
  || document.querySelector("[data-datepicker]") !== null;
if (path === "/dashboard") {
  void import("./dashboard").then((m) => m.initDashboard()).catch(() => { /* dashboard unavailable */ });
} else if (path === "/dag") {
  void import("./dag").then((m) => m.initDag()).catch(() => { /* dag viewer unavailable */ });
} else if (path === "/") {
  void import("./live-dashboard").then((m) => m.initLiveDashboard()).catch(() => { /* live page unavailable */ });
} else if (needsIslands) {
  void import("./islands");
}
