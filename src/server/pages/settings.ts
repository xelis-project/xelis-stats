import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";

export const settings = new Hono<{ Bindings: Env }>();

function toggleRow(id: string, name: string, desc: string): string {
  return `<div class="setting-row">
    <div class="setting-info">
      <div class="setting-name">${name}</div>
      <div class="setting-desc">${desc}</div>
    </div>
    <label class="switch"><input type="checkbox" id="${id}" /><span class="switch-track"><span class="switch-thumb"></span></span></label>
  </div>`;
}

settings.get("/settings", (c) => {
  const content = `<div class="settings-page">
    <div class="settings-head">
      <h2>Settings</h2>
      <p class="settings-note">Preferences are stored in this browser only and apply across the site.</p>
    </div>

    <div class="panel settings-group">
      <h3 class="sub-h">Content</h3>
      ${toggleRow("pref-reveal-flags", "Show filtered names and tags", "Reveal names and tags hidden by the bad-word filter.")}
    </div>

    <div class="panel settings-group">
      <h3 class="sub-h">Display</h3>
      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">Density</div>
          <div class="setting-desc">Compact tightens table and panel spacing to fit more rows on screen.</div>
        </div>
        <select id="pref-density" aria-label="Display density">
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </div>
      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">Number format</div>
          <div class="setting-desc">Compact abbreviates large values (1.23M); full shows every digit with separators (1,234,567).</div>
        </div>
        <select id="pref-number-format" aria-label="Number format">
          <option value="compact">Compact</option>
          <option value="plain">Full</option>
        </select>
      </div>
      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">Time zone</div>
          <div class="setting-desc">Show timestamps in UTC or your browser's local time zone.</div>
        </div>
        <select id="pref-timezone" aria-label="Time zone">
          <option value="utc">UTC</option>
          <option value="local">Local</option>
        </select>
      </div>
      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">Time style</div>
          <div class="setting-desc">Show the clock in 24-hour time or 12-hour time with AM/PM.</div>
        </div>
        <select id="pref-time-style" aria-label="Time style">
          <option value="24">24-hour</option>
          <option value="12">12-hour</option>
        </select>
      </div>
      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">Time format</div>
          <div class="setting-desc">Tables show a relative age (2m ago) by default; hover for the exact timestamp. Both shows the relative age and the clock together.</div>
        </div>
        <select id="pref-time-format" aria-label="Time format">
          <option value="relative">Relative</option>
          <option value="absolute">Exact time</option>
          <option value="both">Both</option>
        </select>
      </div>
      ${toggleRow("pref-reduce-motion", "Reduce motion", "Disable animations and transitions for a calmer, lower-motion interface.")}
    </div>

    <div class="panel settings-group">
      <h3 class="sub-h">Live data</h3>
      ${toggleRow("pref-live", "Live updates", "Stream new blocks over a websocket and keep the dashboard height current. Turn off to stay idle.")}
    </div>

    <div class="panel settings-group">
      <h3 class="sub-h">Reset</h3>
      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">Reset preferences</div>
          <div class="setting-desc">Restore all settings on this browser to their defaults.</div>
        </div>
        <button class="btn ghost" type="button" id="pref-reset">Reset</button>
      </div>
    </div>
  </div>`;

  return c.html(layout("Settings", content, "/settings"));
});
