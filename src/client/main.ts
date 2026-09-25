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
  || path.startsWith("/asset/") || path.startsWith("/embed/")
  || document.querySelector("[data-datepicker]") !== null;
if (path === "/") {
  void import("./dashboard").catch(() => { /* dashboard unavailable */ });
} else if (needsIslands) {
  void import("./islands");
}
