/**
 * NWR Station Lookup — Cloudflare Worker
 * Deploy: wrangler deploy  (or paste into the Workers dashboard)
 *
 * Routes:
 *   GET /              → full HTML app
 *   GET /api/ccl       → proxies CCL.js from weather.gov and returns JSON
 *   GET /api/zip?cs=XX → proxies the hi-res shapefile ZIP for callsign XX
 *   GET /api/site?cs=XX→ proxies the NWS site HTML page (for county/SAME data)
 */

// ─── CORS / proxy helper ────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

async function proxyFetch(url, extra = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 NWR-Worker",
      "Referer": "https://www.weather.gov/",
    },
    ...extra,
  });
  return res;
}

// ─── CCL.js parser (runs on the Worker, returns JSON) ───────────────────────

function parseCCL(js) {
  // Fields present in CCL.js
  const fields = ["CALLSIGN","FREQ","LAT","LON","SITESTATE","STATUS","SITENAME","PWR"];
  const pat = new RegExp(
    `(${fields.join("|")})\\[(\\d+)\\]\\s*=\\s*"([^"]*)"`, "g"
  );
  const raw = {};
  let m;
  while ((m = pat.exec(js)) !== null) {
    const [, field, idx, val] = m;
    if (!raw[idx]) raw[idx] = {};
    raw[idx][field] = val;
  }
  const out = {};
  const seen = new Set();
  for (const idx of Object.keys(raw).sort((a, b) => +a - +b)) {
    const rec = raw[idx];
    const cs = (rec.CALLSIGN || "").trim().toUpperCase();
    if (!cs || seen.has(cs)) continue;
    seen.add(cs);
    out[cs] = {
      callsign: cs,
      freq:   (rec.FREQ      || "").trim(),
      lat:    (rec.LAT       || "").trim(),
      lon:    (rec.LON       || "").trim(),
      state:  (rec.SITESTATE || "").trim(),
      status: (rec.STATUS    || "").trim(),
      name:   (rec.SITENAME  || "").trim(),
      pwr:    (rec.PWR       || "").trim(),
    };
  }
  return out;
}

// ─── Main HTML (the whole app lives here) ───────────────────────────────────

const HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>NWR Station Lookup</title>

<!-- Leaflet -->
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<!-- Leaflet.heat for propagation dots -->
<script src="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"></script>
<!-- shp.js for reading shapefiles in-browser -->
<script src="https://unpkg.com/shapefile@0.6.6/dist/shapefile.js"></script>

<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:      #0d1117;
  --bg2:     #161b22;
  --bg3:     #21262d;
  --border:  #30363d;
  --fg:      #e6edf3;
  --fg2:     #8b949e;
  --fg3:     #3d444d;
  --accent:  #58a6ff;
  --green:   #3fb950;
  --red:     #f85149;
  --yellow:  #d29922;
  --font:    'Courier New', monospace;
}

body { background: var(--bg); color: var(--fg); font-family: var(--font); height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }

/* ── top bar ── */
#topbar {
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  padding: 8px 16px;
  display: flex; align-items: center; gap: 12px; flex-shrink: 0;
  flex-wrap: wrap;
}
#topbar h1 { font-size: 13px; color: var(--accent); letter-spacing: .08em; white-space: nowrap; }

#search-wrap {
  display: flex; align-items: center; gap: 0; flex: 1; min-width: 220px; max-width: 400px;
  border: 1px solid var(--border); background: var(--bg3);
  position: relative;
}
#search-wrap label { font-size: 9px; color: var(--fg3); padding: 0 8px; white-space: nowrap; letter-spacing: .1em; }
#cs-input {
  flex: 1; background: transparent; border: none; outline: none;
  color: var(--fg); font: 700 15px var(--font); padding: 7px 4px;
  caret-color: var(--accent); text-transform: uppercase;
}
#lookup-btn {
  background: var(--accent); color: #0d1117; border: none; font: 700 10px var(--font);
  padding: 0 14px; height: 100%; cursor: pointer; letter-spacing: .08em; white-space: nowrap;
}
#lookup-btn:hover { filter: brightness(1.15); }

#suggest {
  display: none; position: absolute; top: 100%; left: 0; right: 0; z-index: 9999;
  background: var(--bg3); border: 1px solid var(--border); border-top: none;
  max-height: 220px; overflow-y: auto;
}
.sug-item {
  padding: 6px 10px; font-size: 11px; cursor: pointer; white-space: nowrap;
  display: flex; gap: 8px; align-items: center;
}
.sug-item:hover, .sug-item.active { background: var(--accent); color: #0d1117; }
.sug-dot { font-size: 9px; }

#status { font-size: 10px; color: var(--fg2); margin-left: auto; white-space: nowrap; }

/* ── layer toggles (mimic NWS legend) ── */
#legend {
  background: rgba(255,255,255,.96); border: 2px solid #888; border-radius: 4px;
  padding: 8px 12px; font-family: Arial, sans-serif; font-size: 12px; color: #333;
  position: absolute; top: 10px; right: 10px; z-index: 800; min-width: 140px;
}
#legend .leg-title { font-weight: 700; margin-bottom: 6px; }
#legend label { display: flex; align-items: center; gap: 6px; margin: 3px 0; cursor: pointer; }
#legend input[type=radio], #legend input[type=checkbox] { cursor: pointer; }

/* ── main layout ── */
#main { display: flex; flex: 1; overflow: hidden; }

/* ── sidebar ── */
#sidebar {
  width: 260px; min-width: 220px; flex-shrink: 0;
  background: var(--bg2); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; overflow-y: auto;
}
#cs-header { font-size: 22px; font-weight: 700; padding: 14px 14px 8px; color: var(--fg); border-bottom: 1px solid var(--border); }

#info-grid { padding: 10px 14px; display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 11px; }
.info-key { color: var(--fg3); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; padding-top: 2px; white-space: nowrap; }
.info-val { color: var(--fg); word-break: break-word; }

#county-section { padding: 10px 14px; border-top: 1px solid var(--border); flex: 1; overflow-y: auto; }
#county-title { font-size: 9px; color: var(--fg3); letter-spacing: .08em; margin-bottom: 6px; }
#county-body { font-size: 10px; color: var(--fg2); line-height: 1.6; }

#nws-link-btn {
  margin: 10px 14px; padding: 7px; background: var(--bg3); border: 1px solid var(--border);
  color: var(--fg2); font: 10px var(--font); cursor: pointer; text-align: center; text-decoration: none;
  display: block; flex-shrink: 0;
}
#nws-link-btn:hover { color: var(--accent); border-color: var(--accent); }

/* ── map ── */
#map-wrap { flex: 1; position: relative; }
#map { width: 100%; height: 100%; }

/* ── freq pill ── */
.freq-pill {
  display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px;
}

/* ── map info box (hover tooltip area below map header) ── */
#map-hover-box {
  position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
  background: rgba(255,255,255,.95); border: 1px solid #888;
  border-radius: 4px; padding: 6px 14px; font-family: Arial, sans-serif;
  font-size: 13px; color: #222; z-index: 700; pointer-events: none;
  white-space: nowrap; display: none;
}
#map-hover-box.visible { display: block; }

/* scrollbar */
::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: var(--bg2); }
::-webkit-scrollbar-thumb { background: var(--border); }
</style>
</head>
<body>

<!-- ── top bar ── -->
<div id="topbar">
  <h1>⬡ NWR STATION LOOKUP</h1>
  <div id="search-wrap">
    <label>CALLSIGN</label>
    <input id="cs-input" type="text" placeholder="e.g. WNG539" autocomplete="off" spellcheck="false"/>
    <button id="lookup-btn">LOOKUP →</button>
    <div id="suggest"></div>
  </div>
  <span id="status">Loading station list…</span>
</div>

<!-- ── main ── -->
<div id="main">

  <!-- sidebar -->
  <div id="sidebar">
    <div id="cs-header">—</div>
    <div id="info-grid">
      <span class="info-key">Site Name</span>  <span class="info-val" id="i-name">—</span>
      <span class="info-key">State</span>       <span class="info-val" id="i-state">—</span>
      <span class="info-key">Frequency</span>   <span class="info-val" id="i-freq">—</span>
      <span class="info-key">Power</span>        <span class="info-val" id="i-pwr">—</span>
      <span class="info-key">Status</span>       <span class="info-val" id="i-status">—</span>
      <span class="info-key">Latitude</span>    <span class="info-val" id="i-lat">—</span>
      <span class="info-key">Longitude</span>   <span class="info-val" id="i-lon">—</span>
      <span class="info-key">Coverage</span>    <span class="info-val" id="i-cov">—</span>
    </div>
    <div id="county-section">
      <div id="county-title">COUNTIES / SAME SERVED</div>
      <div id="county-body">Select a station to view coverage details.</div>
    </div>
    <a id="nws-link-btn" href="#" target="_blank" rel="noopener">Open NWS Page ↗</a>
  </div>

  <!-- map -->
  <div id="map-wrap">
    <div id="map"></div>
    <div id="map-hover-box">Mouse over counties to view county name and SAME code</div>

    <!-- NWS-style legend -->
    <div id="legend">
      <div class="leg-title">Base Map</div>
      <label><input type="radio" name="basemap" value="topo" checked> TopoMap</label>
      <label><input type="radio" name="basemap" value="streets"> Streets</label>
      <label><input type="radio" name="basemap" value="satellite"> Satellite</label>
      <label><input type="radio" name="basemap" value="terrain"> Terrain</label>

      <div class="leg-title" style="margin-top:8px">Overlays</div>
      <label><input type="checkbox" id="tog-prop" checked> Propagation</label>
      <label><input type="checkbox" id="tog-counties" checked> Counties</label>
      <label><input type="checkbox" id="tog-alert" checked> Alerting Area</label>
      <label><input type="checkbox" id="tog-same"> SAME Labels</label>
    </div>
  </div>
</div>

<script>
// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

const FREQ_COLORS = {
  "162.400": "#ff595e",
  "162.425": "#ff924c",
  "162.450": "#ffca3a",
  "162.475": "#b57bee",
  "162.500": "#4fa8e8",
  "162.525": "#8ac926",
  "162.550": "#36cfb1",
};

const POWER_LABELS = {
  "1000": "1,000 W (High Power)",
  "300":  "300 W (Medium Power)",
  "100":  "100 W (Low Power)",
  "10":   "10 W (Very Low Power)",
  "5":    "5 W (Micro)",
};

// ────────────────────────────────────────────────────────────────────────────
// Leaflet map setup
// ────────────────────────────────────────────────────────────────────────────

const baseLayers = {
  topo: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    { attribution: "Powered by Esri", maxZoom: 18 }
  ),
  streets: L.tileLayer(
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    { attribution: "© OpenStreetMap contributors", maxZoom: 19 }
  ),
  satellite: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: "Powered by Esri", maxZoom: 18 }
  ),
  terrain: L.tileLayer(
    "https://stamen-tiles.a.ssl.fastly.net/terrain/{z}/{x}/{y}.jpg",
    { attribution: "Map tiles by Stamen Design", maxZoom: 18 }
  ),
};

const map = L.map("map", {
  center: [40, -90],
  zoom: 5,
  layers: [baseLayers.topo],
  zoomControl: true,
});

// County borders layer (US Census tiles via ArcGIS)
const countyLayer = L.tileLayer(
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Census_Counties/MapServer/tile/{z}/{y}/{x}",
  { opacity: 0.35, maxZoom: 18 }
);

// Overlay groups
let propagationLayer = null;  // heat/dot layer built from shapefile
let alertingLayer    = null;  // solid filled polygon from shapefile
let sameLabels       = L.layerGroup();
let stationMarker    = null;

// County toggle
const togCounties = document.getElementById("tog-counties");
const togProp     = document.getElementById("tog-prop");
const togAlert    = document.getElementById("tog-alert");
const togSame     = document.getElementById("tog-same");

togCounties.addEventListener("change", () => {
  if (togCounties.checked) map.addLayer(countyLayer);
  else map.removeLayer(countyLayer);
});
if (togCounties.checked) map.addLayer(countyLayer);

togProp.addEventListener("change", () => {
  if (propagationLayer) {
    if (togProp.checked) map.addLayer(propagationLayer);
    else map.removeLayer(propagationLayer);
  }
});
togAlert.addEventListener("change", () => {
  if (alertingLayer) {
    if (togAlert.checked) map.addLayer(alertingLayer);
    else map.removeLayer(alertingLayer);
  }
});
togSame.addEventListener("change", () => {
  if (togSame.checked) map.addLayer(sameLabels);
  else map.removeLayer(sameLabels);
});

// Basemap radio
document.querySelectorAll("input[name=basemap]").forEach(r => {
  r.addEventListener("change", () => {
    Object.values(baseLayers).forEach(l => map.removeLayer(l));
    map.addLayer(baseLayers[r.value]);
    // re-add county layer on top if active
    if (togCounties.checked) { map.removeLayer(countyLayer); map.addLayer(countyLayer); }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Station data
// ────────────────────────────────────────────────────────────────────────────

let stations = {};

async function loadStations() {
  try {
    const r = await fetch("/api/ccl");
    stations = await r.json();
    document.getElementById("status").textContent =
      "✓  " + Object.keys(stations).length.toLocaleString() + " transmitters · source: weather.gov";
    document.getElementById("status").style.color = "#3fb950";
  } catch(e) {
    document.getElementById("status").textContent = "⚠ " + e.message;
    document.getElementById("status").style.color = "#f85149";
  }
}

loadStations();

// ────────────────────────────────────────────────────────────────────────────
// Search / suggest
// ────────────────────────────────────────────────────────────────────────────

const csInput  = document.getElementById("cs-input");
const sugBox   = document.getElementById("suggest");
let sugList    = [];
let sugIdx     = -1;

csInput.addEventListener("input", () => {
  const q = csInput.value.trim().toUpperCase();
  sugBox.innerHTML = "";
  sugList = [];
  if (q.length < 2 || !Object.keys(stations).length) { sugBox.style.display="none"; return; }

  sugList = Object.keys(stations)
    .filter(cs => cs.startsWith(q) || cs.includes(q))
    .sort().slice(0, 12);

  if (!sugList.length) { sugBox.style.display="none"; return; }

  sugList.forEach((cs, i) => {
    const st = stations[cs];
    const el = document.createElement("div");
    el.className = "sug-item";
    el.innerHTML = \`<span class="sug-dot" style="color:\${FREQ_COLORS[st.freq]||'#888'}">●</span>
      <b>\${cs}</b> &nbsp; \${st.freq} MHz &nbsp;— \${st.name}, \${st.state}\`;
    el.addEventListener("click", () => pick(i));
    sugBox.appendChild(el);
  });
  sugIdx = -1;
  sugBox.style.display = "block";
});

csInput.addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { sugIdx = Math.min(sugIdx+1, sugList.length-1); highlight(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { sugIdx = Math.max(sugIdx-1, 0); highlight(); e.preventDefault(); }
  else if (e.key === "Enter") { sugIdx >= 0 ? pick(sugIdx) : lookup(); }
  else if (e.key === "Escape") { sugBox.style.display="none"; }
});

document.addEventListener("click", e => {
  if (!sugBox.contains(e.target) && e.target !== csInput) sugBox.style.display="none";
});

function highlight() {
  sugBox.querySelectorAll(".sug-item").forEach((el,i) =>
    el.classList.toggle("active", i===sugIdx));
}
function pick(i) {
  csInput.value = sugList[i];
  sugBox.style.display="none";
  lookup();
}

document.getElementById("lookup-btn").addEventListener("click", lookup);

// ────────────────────────────────────────────────────────────────────────────
// Lookup + map rendering
// ────────────────────────────────────────────────────────────────────────────

async function lookup() {
  const q = csInput.value.trim().toUpperCase();
  sugBox.style.display = "none";
  if (!q) return;

  let st = stations[q];
  if (!st) {
    const m = Object.keys(stations).filter(cs => cs.startsWith(q));
    if (m.length === 1) { st = stations[m[0]]; csInput.value = m[0]; }
    else {
      setStatus(\`⚠ '\${q}' not found (\${m.length} prefix matches)\`, "#f85149");
      return;
    }
  }

  populateInfo(st);
  setStatus(\`Loading coverage for \${st.callsign}…\`, "#d29922");
  await loadMap(st);
}

function populateInfo(st) {
  document.getElementById("cs-header").textContent = st.callsign;
  document.getElementById("i-name").textContent   = st.name  || "—";
  document.getElementById("i-state").textContent  = st.state || "—";

  const fc = FREQ_COLORS[st.freq] || "#e6edf3";
  document.getElementById("i-freq").innerHTML =
    \`<span class="freq-pill" style="background:\${fc}22;color:\${fc};">\${st.freq} MHz</span>\`;

  const pwrLabel = POWER_LABELS[st.pwr] || (st.pwr ? st.pwr + " W" : "—");
  document.getElementById("i-pwr").textContent = pwrLabel;

  const scolor = /operational/i.test(st.status) ? "#3fb950"
               : /service/i.test(st.status)      ? "#f85149" : "#d29922";
  document.getElementById("i-status").style.color = scolor;
  document.getElementById("i-status").textContent = st.status || "—";

  document.getElementById("i-lat").textContent  = st.lat || "—";
  document.getElementById("i-lon").textContent  = st.lon || "—";
  document.getElementById("i-cov").textContent  = "Loading…";

  const nwsUrl = \`https://www.weather.gov/nwr/sites?site=\${st.callsign}\`;
  document.getElementById("nws-link-btn").href = nwsUrl;
  document.getElementById("county-body").textContent = "Loading coverage details…";

  // place station marker
  if (stationMarker) map.removeLayer(stationMarker);
  if (st.lat && st.lon) {
    stationMarker = L.circleMarker([+st.lat, +st.lon], {
      radius: 7, color: "#fff", weight: 2,
      fillColor: FREQ_COLORS[st.freq] || "#58a6ff",
      fillOpacity: 1
    }).bindTooltip(\`\${st.callsign} — \${st.freq} MHz\`).addTo(map);
  }
}

async function loadMap(st) {
  // clear previous overlays
  [propagationLayer, alertingLayer].forEach(l => { if (l) map.removeLayer(l); });
  sameLabels.clearLayers();
  propagationLayer = alertingLayer = null;

  try {
    const res = await fetch(\`/api/zip?cs=\${encodeURIComponent(st.callsign)}\`);
    if (!res.ok) throw new Error("No shapefile (HTTP " + res.status + ")");
    const buf = await res.arrayBuffer();
    await renderShapefile(buf, st);
  } catch(e) {
    document.getElementById("i-cov").textContent = "No coverage data";
    setStatus(\`⚠ \${e.message}\`, "#f85149");
  }

  // also fetch county/SAME text from NWS
  fetchCountyData(st.callsign);
}

// ── Shapefile rendering ──────────────────────────────────────────────────────

async function renderShapefile(zipBuf, st) {
  // shapefile.js can open a zip with a .shp inside
  const source = await shapefile.openShp(zipBuf);
  const freq   = st.freq;
  const fcolor = FREQ_COLORS[freq] || "#3fb950";

  const allCoords = [];
  const polygons  = [];

  let result;
  while (!(result = await source.read()).done) {
    const geom = result.value;
    if (!geom || !geom.coordinates) continue;
    // Could be Polygon or MultiPolygon
    const rings = geom.type === "Polygon" ? [geom.coordinates]
                : geom.type === "MultiPolygon" ? geom.coordinates : [];
    rings.forEach(poly => {
      poly.forEach(ring => {
        const latlngs = ring.map(([lon, lat]) => [lat, lon]);
        polygons.push(latlngs);
        latlngs.forEach(ll => allCoords.push(ll));
      });
    });
  }

  if (!polygons.length) {
    document.getElementById("i-cov").textContent = "No polygon data in ZIP";
    setStatus(\`⚠ No polygons in shapefile\`, "#d29922");
    return;
  }

  // ── Alerting area (solid-ish green, like NWS) ──
  alertingLayer = L.layerGroup(
    polygons.map(pts =>
      L.polygon(pts, {
        color: fcolor, weight: 1.5,
        fillColor: fcolor, fillOpacity: 0.25,
        className: "alerting-poly"
      })
    )
  );
  if (togAlert.checked) map.addLayer(alertingLayer);

  // ── Propagation dots (scatter heat) ──
  // Sample random points inside bounding box for the dot cloud effect
  const heatPts = [];
  polygons.forEach(ring => {
    // take every Nth point and add jitter for the "dots" look
    for (let i = 0; i < ring.length; i += 2) {
      const [lat, lon] = ring[i];
      // scatter multiple dots around each vertex
      for (let j = 0; j < 6; j++) {
        heatPts.push([
          lat + (Math.random() - .5) * 0.08,
          lon + (Math.random() - .5) * 0.08,
          0.4
        ]);
      }
    }
  });
  propagationLayer = L.heatLayer(heatPts, {
    radius: 8, blur: 10, minOpacity: 0.3,
    gradient: { 0: "transparent", 0.5: fcolor + "88", 1: fcolor }
  });
  if (togProp.checked) map.addLayer(propagationLayer);

  // fit map
  if (allCoords.length) {
    map.fitBounds(L.latLngBounds(allCoords), { padding: [40, 40] });
  }

  // update coverage field
  const lats = allCoords.map(c => c[0]);
  const lons = allCoords.map(c => c[1]);
  document.getElementById("i-cov").textContent =
    \`Lon \${Math.min(...lons).toFixed(2)}→\${Math.max(...lons).toFixed(2)}\\n\` +
    \`Lat \${Math.min(...lats).toFixed(2)}→\${Math.max(...lats).toFixed(2)}\`;

  setStatus(\`✓ \${st.callsign} loaded · \${polygons.length} polygon(s)\`, "#3fb950");
}

// ── County / SAME data ───────────────────────────────────────────────────────

async function fetchCountyData(cs) {
  try {
    const r = await fetch(\`/api/site?cs=\${encodeURIComponent(cs)}\`);
    const html = await r.text();
    // Parse county info from NWS HTML
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    // NWS tables with county/SAME data
    const rows = [...doc.querySelectorAll("table tr")].slice(1);
    const items = rows.map(r => {
      const cells = r.querySelectorAll("td");
      return cells.length >= 2 ? cells[0].textContent.trim() + " — " + cells[1].textContent.trim() : null;
    }).filter(Boolean);

    if (items.length) {
      document.getElementById("county-body").textContent = items.slice(0, 60).join("\\n");

      // add SAME label markers
      sameLabels.clearLayers();
      rows.forEach(r => {
        const cells = r.querySelectorAll("td");
        if (cells.length >= 4) {
          const latEl = cells[2] ? cells[2].textContent.trim() : "";
          const lonEl = cells[3] ? cells[3].textContent.trim() : "";
          const same  = cells[1] ? cells[1].textContent.trim() : "";
          if (latEl && lonEl) {
            L.marker([+latEl, +lonEl], {
              icon: L.divIcon({ className:"", html:\`<span style="font:bold 9px Arial;background:#ffffffcc;padding:1px 3px;border-radius:2px;color:#333">\${same}</span>\` })
            }).addTo(sameLabels);
          }
        }
      });
      if (togSame.checked) map.addLayer(sameLabels);
    } else {
      document.getElementById("county-body").textContent =
        \`weather.gov/nwr/sites?site=\${cs}\\nUse 'Open NWS Page ↗' for live county data.\`;
    }
  } catch(e) {
    document.getElementById("county-body").textContent =
      \`Use 'Open NWS Page ↗' to view county/SAME data.\\n(\${e.message})\`;
  }
}

// ── Hover tooltip ──────────────────────────────────────────────────────────

const hoverBox = document.getElementById("map-hover-box");
hoverBox.classList.add("visible");   // show the NWS-style hint initially

map.on("mousemove", () => {
  hoverBox.style.display = "none";   // hide once interacting
});

// ── Util ───────────────────────────────────────────────────────────────────

function setStatus(msg, color="#8b949e") {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.style.color = color;
}
</script>
</body>
</html>`;

// ─── Worker fetch handler ────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // ── /api/ccl  →  fetch CCL.js and return as JSON ────────────────────────
    if (path === "/api/ccl") {
      const CCL_URL = "https://www.weather.gov/source/nwr/JS/CCL.js";

      // Use KV cache if bound (optional) — falls through if not
      let cacheKey = "ccl_json";
      if (env.NWR_KV) {
        const cached = await env.NWR_KV.get(cacheKey);
        if (cached) {
          return new Response(cached, {
            headers: { ...CORS, "Content-Type": "application/json" },
          });
        }
      }

      const res = await proxyFetch(CCL_URL);
      if (!res.ok) {
        return new Response(JSON.stringify({ error: "CCL fetch failed" }), {
          status: 502, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
      const js   = await res.text();
      const data = parseCCL(js);
      const json = JSON.stringify(data);

      if (env.NWR_KV) {
        // cache for 6 hours
        ctx.waitUntil(env.NWR_KV.put(cacheKey, json, { expirationTtl: 21600 }));
      }

      return new Response(json, {
        headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public,max-age=3600" },
      });
    }

    // ── /api/zip?cs=XXXX  →  proxy shapefile ZIP ────────────────────────────
    if (path === "/api/zip") {
      const cs = (url.searchParams.get("cs") || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
      if (!cs) return new Response("Missing cs param", { status: 400, headers: CORS });

      const zipUrl = `https://www.weather.gov/source/nwr/hires/${cs}.zip`;
      const res = await proxyFetch(zipUrl);

      if (res.status === 404) {
        return new Response("Not found", { status: 404, headers: CORS });
      }
      if (!res.ok) {
        return new Response("Upstream error " + res.status, { status: 502, headers: CORS });
      }

      const body = await res.arrayBuffer();
      return new Response(body, {
        status: 200,
        headers: {
          ...CORS,
          "Content-Type": "application/zip",
          "Cache-Control": "public,max-age=86400",
        },
      });
    }

    // ── /api/site?cs=XXXX  →  proxy NWS site page (for county data) ─────────
    if (path === "/api/site") {
      const cs = (url.searchParams.get("cs") || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
      if (!cs) return new Response("Missing cs param", { status: 400, headers: CORS });

      const nwsUrl = `https://www.weather.gov/nwr/sites?site=${cs}`;
      const res = await proxyFetch(nwsUrl);
      const text = await res.text();

      return new Response(text, {
        headers: {
          ...CORS,
          "Content-Type": "text/html;charset=utf-8",
          "Cache-Control": "public,max-age=3600",
        },
      });
    }

    // ── /  →  serve the HTML app ─────────────────────────────────────────────
    if (path === "/" || path === "") {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html;charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
