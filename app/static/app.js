import Globe from 'globe.gl';
import * as THREE from 'three';
import * as satellite from 'satellite.js';

const TEXTURES = {
  day: 'https://unpkg.com/three-globe@2.41.12/example/img/earth-blue-marble.jpg',
  night: 'https://unpkg.com/three-globe@2.41.12/example/img/earth-night.jpg',
};

const LAYERS = {
  flights: { label: 'Flights', color: '#ffb347', on: true },
  ships: { label: 'Ships (AIS)', color: '#3be8ff', on: true },
  satellites: { label: 'Satellites', color: '#e8fff2', on: true },
  incidents: { label: 'Reported incidents', color: '#ff4048', on: true },
  earthquakes: { label: 'Earthquakes', color: '#ffd166', on: true },
  chokepoints: { label: 'Chokepoints', color: '#3be8ff', on: true },
  cables: { label: 'Undersea cables', color: '#8f7bff', on: false },
  daynight: { label: 'Day / night', color: '#39ff88', on: true },
};

const REFRESH_MS = {
  flights: 120_000,
  ships: 30_000,
  earthquakes: 300_000,
  incidents: 600_000,
  news: 300_000,
};

const state = {
  flights: [],
  ships: [],
  shipStatus: null,
  chokepoints: [],
  history: [],
  satrecs: [],
  satPositions: [],
  quakes: [],
  incidents: [],
  funnel: null,
  news: [],
  cables: [],
  confidence: new Set(['high', 'medium']),
  status: {},
};

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// External feeds supply these URLs - never let a javascript: link through.
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');

function timeAgo(seconds) {
  if (!seconds) return '';
  const diff = Math.max(0, Date.now() / 1000 - seconds);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const gdeltSeconds = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)) / 1000;

function hexA(hex, alpha) {
  const h = (hex || '#8f7bff').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

async function getJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${resp.status}`);
  return resp.json();
}

// Subsolar point (where the sun is directly overhead), low-precision
// astronomical formulas - accurate to well under a degree, plenty for a
// day/night shadow.
function sunPosition(date) {
  const rad = Math.PI / 180;
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86_400_000;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) / rad;
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  let lng = ra - gmst * 15;
  lng = ((lng + 540) % 360) - 180;
  return { lat: dec, lng };
}

// ---------- globe ----------

const world = new Globe(document.getElementById('globe'), { animateIn: false })
  .backgroundColor('#010604')
  .showAtmosphere(true)
  .atmosphereColor('#39ff88')
  .atmosphereAltitude(0.15)
  .showGraticules(true)
  .pointOfView({ lat: 24, lng: 52, altitude: 2.3 });

const loader = new THREE.TextureLoader();
const globeMaterial = new THREE.ShaderMaterial({
  uniforms: {
    dayTexture: { value: loader.load(TEXTURES.day) },
    nightTexture: { value: loader.load(TEXTURES.night) },
    sunDir: { value: new THREE.Vector3(1, 0, 0) },
    dayNight: { value: 1.0 },
  },
  // Lighting is done in world space with the sun direction taken from
  // globe.getCoords(), so it stays correct whatever way the camera orbits.
  vertexShader: `
    varying vec3 vNormalW;
    varying vec2 vUv;
    void main() {
      vNormalW = normalize(mat3(modelMatrix) * normal);
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D dayTexture;
    uniform sampler2D nightTexture;
    uniform vec3 sunDir;
    uniform float dayNight;
    varying vec3 vNormalW;
    varying vec2 vUv;
    void main() {
      vec3 day = texture2D(dayTexture, vUv).rgb * vec3(0.42, 0.6, 0.52);
      vec3 night = texture2D(nightTexture, vUv).rgb * vec3(1.35, 1.05, 0.6);
      float light = dot(normalize(vNormalW), normalize(sunDir));
      float k = mix(1.0, smoothstep(-0.12, 0.12, light), dayNight);
      vec3 col = mix(night, day, k);
      float terminator = (1.0 - smoothstep(0.0, 0.035, abs(light))) * dayNight;
      col += vec3(0.22, 1.0, 0.53) * terminator * 0.22;
      gl_FragColor = vec4(col, 1.0);
    }`,
});
world.globeMaterial(globeMaterial);

function updateSun() {
  const { lat, lng } = sunPosition(new Date());
  const c = world.getCoords(lat, lng, 0);
  globeMaterial.uniforms.sunDir.value.set(c.x, c.y, c.z).normalize();
}

const controls = world.controls();
controls.autoRotate = true;
controls.autoRotateSpeed = 0.25;
const stopSpin = () => { controls.autoRotate = false; };
document.getElementById('globe').addEventListener('pointerdown', stopSpin, { once: true });

window.addEventListener('resize', () => world.width(window.innerWidth).height(window.innerHeight));

world
  .particlesList((set) => set.points)
  .particleLat('lat')
  .particleLng('lng')
  .particleAltitude('alt')
  .particlesColor((set) => set.color)
  .particlesSize((set) => set.size)
  .particlesSizeAttenuation(false);

world
  .pointLat('lat')
  .pointLng('lon')
  .pointAltitude((q) => Math.max(0.01, (q.mag - 2) * 0.025))
  .pointRadius(0.2)
  .pointColor(() => '#ffd166')
  .pointsTransitionDuration(0)
  .pointLabel((q) => `<div class="globe-tip">M${esc(q.mag)} · ${esc(q.place)}</div>`)
  .onPointClick(showQuake);

world
  .ringLat('lat')
  .ringLng('lng')
  .ringColor((r) => (t) => (r.kind === 'quake' ? `rgba(255,209,102,${1 - t})` : `rgba(255,64,72,${1 - t})`))
  .ringMaxRadius('maxR')
  .ringPropagationSpeed('speed')
  .ringRepeatPeriod('period');

world
  .htmlLat('lat')
  .htmlLng('lon')
  .htmlAltitude(0.004)
  .htmlTransitionDuration(0)
  .htmlElement((d) => {
    const el = document.createElement('div');
    el.className = `marker ${d.confidence}`;
    el.title = d.place;
    el.addEventListener('click', (e) => { e.stopPropagation(); showIncident(d); });
    return el;
  });

world
  .pathPoints('coords')
  .pathPointLat((p) => p[0])
  .pathPointLng((p) => p[1])
  .pathPointAlt(0.0015)
  .pathColor((c) => hexA(c.color, 0.6))
  .pathStroke(null)
  .pathDashLength(0.04)
  .pathDashGap(0.015)
  .pathDashAnimateTime(40_000)
  .pathTransitionDuration(0)
  .pathLabel((c) => `<div class="globe-tip">${esc(c.name)}</div>`);

world
  .polygonGeoJsonGeometry('geometry')
  .polygonCapColor(() => 'rgba(59,232,255,0.14)')
  .polygonSideColor(() => 'rgba(59,232,255,0.06)')
  .polygonStrokeColor(() => '#3be8ff')
  .polygonAltitude(0.005)
  .polygonsTransitionDuration(0)
  .polygonLabel((d) => `<div class="globe-tip">${esc(d.name)} · ${d.total} ships</div>`)
  .onPolygonClick((d) => openChokepoint(d.name));

world
  .labelLat('lat')
  .labelLng('lng')
  .labelText('name')
  .labelColor(() => '#3be8ff')
  .labelSize(0.28)
  .labelDotRadius(0.1)
  .labelAltitude(0.006)
  .labelResolution(2)
  .labelsTransitionDuration(0);

world.onGlobeClick(hideDetail);

function visibleIncidents() {
  return state.incidents.filter((i) => state.confidence.has(i.confidence));
}

function renderParticles() {
  const sets = [];
  if (LAYERS.flights.on) sets.push({ color: LAYERS.flights.color, size: 1.6, points: state.flights });
  if (LAYERS.ships.on) sets.push({ color: LAYERS.ships.color, size: 2.2, points: state.ships });
  if (LAYERS.satellites.on) sets.push({ color: LAYERS.satellites.color, size: 2.4, points: state.satPositions });
  world.particlesData(sets);
}

function renderGlobe() {
  renderParticles();

  world.pointsData(LAYERS.earthquakes.on ? state.quakes : []);

  const incidents = LAYERS.incidents.on ? visibleIncidents() : [];
  world.htmlElementsData(incidents);

  const rings = [];
  if (LAYERS.earthquakes.on) {
    for (const q of state.quakes.filter((q) => q.mag >= 4.5)) {
      rings.push({ kind: 'quake', lat: q.lat, lng: q.lon, maxR: q.mag * 0.9, speed: 2, period: 1600 });
    }
  }
  for (const i of incidents.filter((i) => i.confidence === 'high')) {
    rings.push({ kind: 'incident', lat: i.lat, lng: i.lon, maxR: 3, speed: 3, period: 1200 });
  }
  world.ringsData(rings);

  world.pathsData(LAYERS.cables.on ? state.cables : []);

  const cps = LAYERS.chokepoints.on ? state.chokepoints : [];
  world.polygonsData(cps.map((c) => {
    const [la0, lo0, la1, lo1] = c.box;
    // Clockwise ring: three-globe follows d3-geo's spherical winding, where a
    // counter-clockwise box means "the whole planet except this box".
    return {
      ...c,
      geometry: { type: 'Polygon', coordinates: [[[lo0, la0], [lo0, la1], [lo1, la1], [lo1, la0], [lo0, la0]]] },
    };
  }));
  world.labelsData(cps.map((c) => ({ name: c.name, lat: c.box[2] + 0.5, lng: (c.box[1] + c.box[3]) / 2 })));

  globeMaterial.uniforms.dayNight.value = LAYERS.daynight.on ? 1.0 : 0.0;
}

// ---------- data loaders ----------

async function loadFlights() {
  const d = await getJSON('/api/live/flights');
  state.flights = d.flights.map((f) => ({ lat: f[4], lng: f[3], alt: 0.012, callsign: f[1] }));
  return `${d.count.toLocaleString()} aircraft airborne`;
}

async function loadShips() {
  const d = await getJSON('/api/live/ships');
  state.shipStatus = d.status;
  state.chokepoints = d.chokepoints;
  state.history = d.history;
  state.ships = d.ships.map((s) => ({ lat: s[2], lng: s[3], alt: 0.003, name: s[1] }));
  if (!d.status.enabled) {
    const err = new Error('offline: no AISSTREAM_API_KEY');
    err.off = true;
    throw err;
  }
  return d.status.connected ? `${d.ships.length.toLocaleString()} vessels tracked` : 'connecting to AIS stream';
}

async function loadSatellites() {
  const d = await getJSON('/api/live/satellites');
  state.satrecs = d.satellites.map((s) => ({ name: s.name, rec: satellite.twoline2satrec(s.line1, s.line2) }));
  propagateSatellites();
  return `${d.count} orbital objects (${d.source})`;
}

// Real orbits run from ~400km (ISS) to ~36,000km (geostationary); at true
// scale the high ones would sit far behind the camera, so altitude is
// log-compressed for display.
function displayAltitude(km) {
  return 0.05 + 0.25 * Math.log10(1 + km / 400);
}

function propagateSatellites() {
  const now = new Date();
  const gmst = satellite.gstime(now);
  const out = [];
  for (const s of state.satrecs) {
    const pv = satellite.propagate(s.rec, now);
    if (!pv || !pv.position) continue;
    const geo = satellite.eciToGeodetic(pv.position, gmst);
    out.push({
      lat: satellite.degreesLat(geo.latitude),
      lng: satellite.degreesLong(geo.longitude),
      alt: displayAltitude(geo.height),
      name: s.name,
    });
  }
  state.satPositions = out;
}

async function loadQuakes() {
  state.quakes = await getJSON('/api/live/earthquakes');
  const big = state.quakes[0];
  return big ? `${state.quakes.length} events, largest M${big.mag}` : 'no events';
}

async function loadIncidents() {
  const d = await getJSON('/api/live/incidents');
  state.incidents = d.incidents;
  state.funnel = d.funnel;
  const high = d.incidents.filter((i) => i.confidence === 'high').length;
  return `${d.incidents.length} locations, ${high} high-confidence`;
}

async function loadNews() {
  const d = await getJSON('/api/live/news');
  state.news = d.items;
  const failed = d.outlets_failed.length ? `, ${d.outlets_failed.length} down` : '';
  return `${d.items.length} headlines from ${d.outlets_ok.length} outlets${failed}`;
}

async function loadCables() {
  state.cables = await getJSON('/api/live/cables');
  return `${state.cables.length.toLocaleString()} cable segments`;
}

const SOURCES = [
  ['flights', 'ADS-B receiver network', loadFlights],
  ['ships', 'AIS maritime feed', loadShips],
  ['satellites', 'orbital elements', loadSatellites],
  ['earthquakes', 'USGS seismic feed', loadQuakes],
  ['incidents', 'GDELT event stream', loadIncidents],
  ['news', 'wire headlines', loadNews],
  ['cables', 'submarine cable map', loadCables],
];

// ---------- status bar ----------

function setStatus(key, value) {
  state.status[key] = value;
  $('#status').innerHTML = SOURCES.map(([k]) =>
    `<span><i class="dot ${state.status[k] || 'wait'}"></i>${esc(k)}</span>`).join('');
}

async function runSource(key, fn) {
  setStatus(key, 'wait');
  try {
    const summary = await fn();
    setStatus(key, 'ok');
    return { ok: true, summary };
  } catch (err) {
    setStatus(key, err.off ? 'off' : 'fail');
    return { ok: false, off: !!err.off, summary: err.message };
  }
}

// ---------- panels ----------

function renderLayers() {
  $('#layers').innerHTML = Object.entries(LAYERS).map(([key, l]) => `
    <li><label>
      <input type="checkbox" data-layer="${key}" ${l.on ? 'checked' : ''}>
      <i class="swatch" style="background:${l.color}"></i>
      <span>${esc(l.label)}</span>
      <span class="count" id="count-${key}"></span>
    </label></li>`).join('');
  $('#layers').addEventListener('change', (e) => {
    const key = e.target.dataset.layer;
    if (!key) return;
    LAYERS[key].on = e.target.checked;
    renderGlobe();
  });
}

function updateCounts() {
  const counts = {
    flights: state.flights.length,
    ships: state.ships.length,
    satellites: state.satPositions.length,
    incidents: visibleIncidents().length,
    earthquakes: state.quakes.length,
    chokepoints: state.chokepoints.length,
    cables: state.cables.length,
  };
  for (const [k, v] of Object.entries(counts)) {
    const el = document.getElementById(`count-${k}`);
    if (el) el.textContent = v ? v.toLocaleString() : '';
  }
}

function renderConfidence() {
  $('#confidence').innerHTML = ['high', 'medium', 'low'].map((c) =>
    `<button class="chip ${c} ${state.confidence.has(c) ? 'on' : ''}" data-conf="${c}">${c}</button>`).join('');
}

$('#confidence').addEventListener('click', (e) => {
  const c = e.target.dataset.conf;
  if (!c) return;
  if (state.confidence.has(c)) state.confidence.delete(c); else state.confidence.add(c);
  renderConfidence();
  renderIncidents();
  renderGlobe();
  updateCounts();
});

function renderIncidents() {
  const list = visibleIncidents();
  const f = state.funnel;
  const funnel = f
    ? `<p class="fineprint">Last 6h: ${f.raw.toLocaleString()} events → ${f.strike_codes} strike-coded →
       ${f.city_level} city-level → ${f.keyword_match} keyword-confirmed → <b>${f.locations} places</b></p>`
    : '';
  $('#tab-incidents').innerHTML = `
    <div class="notice"><b>Reported, not verified.</b> Pins mark where news outlets placed an event, machine-coded by
    GDELT. Locations can be off - a story about missiles hitting Poland may be pinned to Moscow. Check the sources.</div>
    ${funnel}
    ${list.length ? '' : '<p class="fineprint">No incidents at the selected confidence levels.</p>'}
    ${list.map((i, idx) => `
      <button class="item" data-incident="${idx}">
        <span class="title">${esc(i.category.toUpperCase())} · ${esc(i.place)}</span>
        <span class="meta">
          <span><span class="badge ${i.confidence}">${i.confidence}</span> ${i.outlets} outlet${i.outlets > 1 ? 's' : ''}</span>
          <span>${timeAgo(gdeltSeconds(i.last_seen))}</span>
        </span>
      </button>`).join('')}`;
}

$('#tab-incidents').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-incident]');
  if (!btn) return;
  const i = visibleIncidents()[+btn.dataset.incident];
  flyTo(i.lat, i.lon);
  showIncident(i);
});

function renderNews() {
  $('#tab-news').innerHTML = state.news.map((n) => `
    <a class="item" href="${safeUrl(n.url)}" target="_blank" rel="noopener noreferrer">
      <span class="title">${esc(n.title)}</span>
      <span class="meta"><span>${esc(n.outlet)}</span><span>${timeAgo(n.published)}</span></span>
    </a>`).join('') || '<p class="fineprint">No headlines loaded.</p>';

  $('#ticker').innerHTML = state.news.slice(0, 30).map((n) =>
    `<a href="${safeUrl(n.url)}" target="_blank" rel="noopener noreferrer"><b>${esc(n.outlet)}</b>${esc(n.title)}</a>`).join('');
}

function sparkline(name) {
  const pts = state.history.map((h) => h.counts[name]?.total ?? 0);
  if (pts.length < 2) return '<p class="fineprint">Trend builds as snapshots come in (every 5 min).</p>';
  const max = Math.max(...pts, 1);
  const coords = pts.map((v, i) => `${(i / (pts.length - 1)) * 100},${30 - (v / max) * 28}`).join(' ');
  return `<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none">
    <line class="base" x1="0" y1="30" x2="100" y2="30" />
    <polyline points="${coords}" vector-effect="non-scaling-stroke" />
  </svg>`;
}

function renderChokepoints() {
  const st = state.shipStatus;
  let notice = '';
  if (!st?.enabled) {
    notice = `<div class="notice off"><b>AIS feed offline.</b> Add <code>AISSTREAM_API_KEY</code> to <code>.env</code>
      and restart. The boxes are shown, but the counts need the live feed.</div>`;
  } else if (!st.connected) {
    notice = `<div class="notice">Connecting to AIS stream${st.last_error ? `: ${esc(st.last_error)}` : '...'}</div>`;
  }
  $('#tab-chokepoints').innerHTML = `${notice}
    <p class="fineprint">Ships inside each box right now, split by heading. A rising Cape of Good Hope count while
    Hormuz / Bab-el-Mandeb fall means traffic is taking the long way round. Warships mostly don't broadcast AIS.</p>
    ${state.chokepoints.map((c) => {
      const dirs = Object.entries(c.directions);
      const moving = Math.max(c.moving, 1);
      return `<div class="cp" id="cp-${esc(c.name.replace(/\W+/g, '-'))}">
        <header><h3>${esc(c.name)}</h3><span class="big">${c.total}</span></header>
        ${dirs.map(([label, n]) => `
          <div class="bar"><span>${esc(label)}</span><span>${n}</span>
            <div class="track"><div class="fill" style="width:${(n / moving) * 100}%"></div></div></div>`).join('')}
        <p class="fineprint">${c.stationary} stationary / anchored ·
          ${Object.entries(c.by_category).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || 'no vessels'}</p>
        ${sparkline(c.name)}
        <button class="chip" data-fly="${c.box.join(',')}">fly to</button>
      </div>`;
    }).join('')}`;
}

$('#tab-chokepoints').addEventListener('click', (e) => {
  const box = e.target.dataset.fly;
  if (!box) return;
  const [la0, lo0, la1, lo1] = box.split(',').map(Number);
  flyTo((la0 + la1) / 2, (lo0 + lo1) / 2, 0.35);
});

function openChokepoint(name) {
  switchTab('chokepoints');
  document.getElementById(`cp-${name.replace(/\W+/g, '-')}`)?.scrollIntoView({ behavior: 'smooth' });
}

function switchTab(tab) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-body').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  if (e.target.dataset.tab) switchTab(e.target.dataset.tab);
});

document.querySelector('.mobile-toggles').addEventListener('click', (e) => {
  const id = e.target.dataset.toggle;
  if (!id) return;
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('open', p.id === id && !p.classList.contains('open')));
});

// ---------- detail card ----------

function flyTo(lat, lng, altitude = 0.9) {
  stopSpin();
  world.pointOfView({ lat, lng, altitude }, 1500);
}

function showDetail(html) {
  const el = $('#detail');
  el.innerHTML = `<button class="close" aria-label="Close">×</button>${html}`;
  el.classList.remove('hidden');
  el.querySelector('.close').addEventListener('click', hideDetail);
}

function hideDetail() {
  $('#detail').classList.add('hidden');
}

function showIncident(i) {
  const cats = Object.entries(i.categories).map(([k, v]) => `${k} (${v})`).join(', ');
  showDetail(`
    <h3>${esc(i.place)}</h3>
    <span class="badge ${i.confidence}">${i.confidence} confidence</span>
    <dl>
      <dt>reported as</dt><dd>${esc(cats)}</dd>
      <dt>outlets</dt><dd>${i.outlets} independent source${i.outlets > 1 ? 's' : ''}, ${i.mentions} mentions</dd>
      <dt>actors</dt><dd>${esc(i.actors.join(', ') || 'unspecified')}</dd>
      <dt>first seen</dt><dd>${timeAgo(gdeltSeconds(i.first_seen))}</dd>
      <dt>last seen</dt><dd>${timeAgo(gdeltSeconds(i.last_seen))}</dd>
    </dl>
    <p class="fineprint">SOURCES</p>
    <ul>${i.sources.map((s) => `<li><a href="${safeUrl(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.domain)}</a>
      ${s.state_affiliated ? '<span class="badge state">state-affiliated</span>' : ''}</li>`).join('')}</ul>
    <p class="fineprint">Machine-coded from news reports. The location is where the coverage placed the event, not a
    verified impact point.</p>`);
}

function showQuake(q) {
  showDetail(`
    <h3>M${esc(q.mag)} · ${esc(q.place)}</h3>
    <dl>
      <dt>depth</dt><dd>${esc(q.depth_km)} km</dd>
      <dt>time</dt><dd>${timeAgo(q.time / 1000)}</dd>
      <dt>tsunami flag</dt><dd>${q.tsunami ? '<span class="badge high">yes</span>' : 'no'}</dd>
    </dl>
    <a href="${safeUrl(q.url)}" target="_blank" rel="noopener noreferrer">USGS event page</a>`);
}

// ---------- boot ----------

const bootLog = $('#boot-log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function typeLine(text, cls = '') {
  const line = document.createElement('span');
  if (cls) line.className = cls;
  bootLog.appendChild(line);
  for (const ch of text) {
    line.textContent += ch;
    await sleep(6);
  }
  bootLog.appendChild(document.createTextNode('\n'));
}

function renderAll() {
  renderGlobe();
  renderIncidents();
  renderNews();
  renderChokepoints();
  updateCounts();
}

async function boot() {
  renderLayers();
  renderConfidence();
  updateSun();

  await typeLine('> establishing uplink...');

  // Print each source's line the moment it resolves, one line at a time
  let degraded = 0;
  let printing = Promise.resolve();
  const pending = SOURCES.map(([key, label, fn]) => runSource(key, fn).then((r) => {
    const tag = r.ok ? '[  OK  ]' : r.off ? '[ OFF  ]' : '[ FAIL ]';
    if (!r.ok) degraded++;
    printing = printing.then(() =>
      typeLine(`${tag} ${label.padEnd(24, '.')} ${r.summary}`, r.ok ? 'ok' : r.off ? 'warn' : 'fail'));
  }));
  await Promise.all(pending);
  await printing;
  await typeLine(degraded ? `> ${degraded} source(s) degraded - continuing` : '> all systems nominal', degraded ? 'warn' : 'ok');

  renderAll();
  await sleep(500);
  $('#boot').classList.add('done');

  schedule();
}

function schedule() {
  const loaders = { flights: loadFlights, ships: loadShips, earthquakes: loadQuakes, incidents: loadIncidents, news: loadNews };
  for (const [key, ms] of Object.entries(REFRESH_MS)) {
    setInterval(async () => {
      await runSource(key, loaders[key]);
      renderAll();
    }, ms);
  }
  setInterval(() => {
    propagateSatellites();
    if (LAYERS.satellites.on) renderParticles();
  }, 2000);
  setInterval(updateSun, 60_000);
}

$('#boot').addEventListener('click', () => $('#boot').classList.add('done'));

setInterval(() => {
  $('#utc').textContent = new Date().toISOString().slice(11, 19);
}, 1000);

boot();
