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
  cctv: { label: 'CCTV (public cams)', color: '#ff6bd6', on: false },
  youtube: { label: 'YouTube live cams', color: '#ff2d55', on: false },
  cctvPreviews: { label: 'Camera previews', color: '#ff6bd6', on: true },
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
  flightSource: null,
  tracked: null,
  trackTimer: null,
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
  cameras: [],
  windyCams: new Map(),
  windyEnabled: false,
  windyFetchedAt: new Map(),
  camPoints: [],
  ytStreams: [],
  ytPoints: [],
  previewCams: [],
  media: null,
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

function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

// TfL and Caltrans overwrite the same image URL every few minutes, so a
// query-string stamp is needed to get past browser caching. Windy's terms
// say to use their URLs unmodified, and their URLs are tokenised anyway.
const freshImage = (cam) => (cam.source === 'Windy' || cam.source === 'YouTube'
  ? cam.image
  : `${cam.image}?t=${Math.floor(Date.now() / 60_000)}`);

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
  .particlesSizeAttenuation(false)
  // globe.gl's default hover label reads `.name` off an undefined particle and throws
  .particleLabel(() => '');

world
  .pointLat('lat')
  .pointLng('lon')
  .pointAltitude((q) => Math.max(0.01, (q.mag - 2) * 0.025))
  .pointRadius(0.2)
  .pointColor(() => '#ffd166')
  .pointsTransitionDuration(0)
  .pointLabel((q) => `<div class="globe-tip">M${esc(q.mag)} · ${esc(q.place)}</div>`)
  .onPointClick((q) => { flyToWithCard(q.lat, q.lon); showQuake(q); });

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
  .htmlElement((d) => (d.kind === 'cam' ? camThumb(d) : d.kind === 'plane' ? planeMarker(d) : incidentMarker(d)));

function incidentMarker(d) {
  const el = document.createElement('div');
  el.className = `marker ${d.confidence}`;
  el.title = d.place;
  el.addEventListener('click', (e) => { e.stopPropagation(); focusIncident(d); });
  return el;
}

const PLANE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c.8 0 1.3.9 1.3 2v5.2l7.7 4.5v2l-7.7-2.4v5l2.2 1.7V22L12 21l-3.5 1v-2l2.2-1.7v-5L3 16.7v-2l7.7-4.5V4c0-1.1.5-2 1.3-2z"/></svg>';

// The CSS2D renderer owns the marker's own transform (it positions it), so
// the heading rotation goes on the inner svg instead.
function planeMarker(d) {
  const el = document.createElement('div');
  el.className = 'plane-marker';
  el.title = d.callsign || d.icao24;
  el.innerHTML = PLANE_SVG;
  el.addEventListener('click', (e) => { e.stopPropagation(); showFlight(); });
  d.el = el;
  rotatePlane(d);
  return el;
}

function rotatePlane(d) {
  d.el?.querySelector('svg')?.style.setProperty('transform', `rotate(${d.heading || 0}deg)`);
}

function camThumb(cam) {
  const el = document.createElement('div');
  el.className = cam.source === 'YouTube' ? 'cam-thumb yt' : 'cam-thumb';
  const img = document.createElement('img');
  const src = cam.source === 'Windy' ? (cam.thumb || cam.image) : freshImage(cam);
  if (src) img.src = src; // Windy thumbs fill in once their details batch arrives
  img.alt = '';
  if (cam.source !== 'Windy') img.dataset.refresh = cam.image;
  img.addEventListener('error', () => el.classList.add('broken'));
  const label = document.createElement('span');
  label.textContent = cam.name;
  el.append(img, label);
  el.addEventListener('click', (e) => { e.stopPropagation(); focusCamera(cam); });
  return el;
}

world
  .pathPoints('coords')
  .pathPointLat((p) => p[0])
  .pathPointLng((p) => p[1])
  .pathPointAlt(0.0015)
  .pathColor((c) => hexA(c.color, c.kind === 'trail' ? 0.9 : 0.6))
  .pathStroke((c) => (c.kind === 'trail' ? 1.2 : null))
  .pathDashLength((c) => (c.kind === 'trail' ? 1 : 0.04))
  .pathDashGap((c) => (c.kind === 'trail' ? 0 : 0.015))
  .pathDashAnimateTime((c) => (c.kind === 'trail' ? 0 : 40_000))
  .pathTransitionDuration(0)
  .pathLabel((c) => `<div class="globe-tip">${esc(c.name)}</div>`);

world
  .polygonGeoJsonGeometry('geometry')
  .polygonCapColor(() => 'rgba(59,232,255,0.14)')
  .polygonSideColor(() => 'rgba(59,232,255,0.06)')
  .polygonStrokeColor(() => '#3be8ff')
  .polygonAltitude(0.005)
  .polygonsTransitionDuration(0)
  .polygonLabel((d) => `<div class="globe-tip">${esc(d.name)} · ${d.coverage === 'none' ? 'no AIS coverage' : `${d.total} ships`}</div>`)
  .onPolygonClick((d) => {
    const [la0, lo0, la1, lo1] = d.box;
    flyTo((la0 + la1) / 2, (lo0 + lo1) / 2, 0.35);
    openChokepoint(d.name);
  });

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

// ~4,000 cameras as clickable meshes would be heavy, so they're drawn as
// particles and a globe click picks the nearest camera within a
// zoom-dependent radius instead.
function handleMapClick(event) {
  const cam = cameraAtPixel(event);
  if (cam) return focusCamera(cam);
  const plane = flightAtPixel(event);
  if (plane) return startTracking(plane.row);
  hideDetail();
}

// A tap right on a camera dot hits the particle, not the globe surface
world.onGlobeClick((_coords, event) => handleMapClick(event));
world.onParticleClick((_particle, event) => handleMapClick(event));

// Windy's worldwide list arrives as locations only; cameras we've fetched
// full details for (images, player) live in windyCams and take precedence.
function allCameras() {
  const detailed = state.windyCams;
  return state.cameras.filter((c) => !detailed.has(c.id)).concat([...detailed.values()]);
}

// Windy image URLs carry a token that expires after ~10 minutes
const WINDY_IMAGE_TTL = 8 * 60_000;
const needsWindyImage = (c) => c.source === 'Windy'
  && (!c.image || Date.now() - (c.fetchedAt || 0) > WINDY_IMAGE_TTL);

async function ensureWindyImages(cams) {
  const ids = [...new Set(cams.filter(needsWindyImage).map((c) => c.id.split(':')[1]))].slice(0, 50);
  if (!ids.length) return;
  const fetchedAt = Date.now();
  try {
    for (const c of await getJSON(`/api/live/webcams/details?ids=${ids.join(',')}`)) {
      state.windyCams.set(c.id, { ...c, fetchedAt });
    }
  } catch {
    // leave them imageless; the card falls back to a link to windy.com
  }
}

const detailedCamera = (cam) => state.windyCams.get(cam.id) || cam;

// Everything a tap or a preview thumbnail can land on, respecting layer toggles
function pickableCameras() {
  return (LAYERS.cctv.on ? allCameras() : []).concat(LAYERS.youtube.on ? state.ytStreams : []);
}

function refreshCamPoints() {
  state.camPoints = allCameras().map((c) => ({ lat: c.lat, lng: c.lon, alt: 0.002 }));
  state.ytPoints = state.ytStreams.map((c) => ({ lat: c.lat, lng: c.lon, alt: 0.003 }));
}

// Only a tap within a few pixels of a dot counts. A distance in km would
// have to scale with zoom, and at world view it swallowed every click
// anywhere near London or California.
const TAP_PX = 14;

function cameraAtPixel(event) {
  const rect = world.renderer().domElement.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const center = world.toGlobeCoords(x, y);
  if (!center) return null;
  const { altitude } = world.pointOfView();
  const roughKm = altitude * 1500;
  let best = null;
  let bestPx = TAP_PX;
  for (const c of pickableCameras()) {
    if (distanceKm(center.lat, center.lng, c.lat, c.lon) > roughKm) continue;
    const s = world.getScreenCoords(c.lat, c.lon, 0.002);
    const px = Math.hypot(s.x - x, s.y - y);
    if (px < bestPx) { best = c; bestPx = px; }
  }
  return best;
}

function flightAtPixel(event) {
  if (!LAYERS.flights.on) return null;
  const rect = world.renderer().domElement.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const center = world.toGlobeCoords(x, y);
  if (!center) return null;
  const roughKm = world.pointOfView().altitude * 1500;
  let best = null;
  let bestPx = TAP_PX;
  for (const f of state.flights) {
    if (distanceKm(center.lat, center.lng, f.lat, f.lng) > roughKm) continue;
    const s = world.getScreenCoords(f.lat, f.lng, f.alt);
    const px = Math.hypot(s.x - x, s.y - y);
    if (px < bestPx) { best = f; bestPx = px; }
  }
  return best;
}

let zoomTimer;
world.onZoom((pov) => {
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    updatePreviews(pov);
    maybeFetchWindy(pov);
    renderLabels(pov);
    updateStreetTiles(pov);
  }, 350);
});

// The globe texture is a single ~5k image, which turns to mush at city zoom.
// Below this altitude, switch to Esri World Imagery tiles (street-level
// satellite photos). CARTO's dark tiles were tried first but now need a key.
const STREET_TILE_ALTITUDE = 0.18;
let streetTiles = false;

function updateStreetTiles(pov) {
  const want = pov.altitude < STREET_TILE_ALTITUDE;
  if (want === streetTiles) return;
  streetTiles = want;
  world.globeTileEngineUrl(want
    ? (x, y, l) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${l}/${y}/${x}`
    : null);
  $('#attribution').hidden = !want;
}

const PREVIEW_ALTITUDE = 0.3;
const PREVIEW_MAX = 14;

function updatePreviews(pov = world.pointOfView()) {
  const picked = [];
  if (LAYERS.cctvPreviews.on && pov.altitude < PREVIEW_ALTITUDE) {
    const radius = pov.altitude * 2500;
    const candidates = pickableCameras()
      .map((c) => ({ c, km: distanceKm(pov.lat, pov.lng, c.lat, c.lon) }))
      .filter((x) => x.km < radius)
      .sort((a, b) => a.km - b.km);
    // Greedy spacing: skip any camera whose thumbnail would overlap one
    // already placed, so a dense junction doesn't become a pile of cards.
    const placed = [];
    for (const { c } of candidates) {
      const s = world.getScreenCoords(c.lat, c.lon, 0.004);
      if (placed.some((p) => Math.abs(p.x - s.x) < 140 && Math.abs(p.y - s.y) < 100)) continue;
      placed.push(s);
      picked.push({ ...c, kind: 'cam' });
      if (picked.length >= PREVIEW_MAX) break;
    }
  }
  const changed = picked.map((c) => c.id + !!c.image).join() !== state.previewCams.map((c) => c.id + !!c.image).join();
  state.previewCams = picked;
  if (changed) renderHtml();

  // Worldwide Windy cams have no image until asked for; fetch the visible
  // ones in one batch, then redraw with real thumbnails.
  if (picked.some(needsWindyImage) && !state.windyLoading) {
    state.windyLoading = true;
    ensureWindyImages(picked).finally(() => {
      state.windyLoading = false;
      state.previewCams = state.previewCams.map((c) => ({ ...detailedCamera(c), kind: 'cam' }));
      renderHtml();
    });
  }
}

async function maybeFetchWindy(pov) {
  if (!state.windyEnabled || !LAYERS.cctv.on || pov.altitude > 0.8) return;
  const key = `${Math.round(pov.lat)},${Math.round(pov.lng)}`;
  // Windy's free-tier image tokens expire after ~10 minutes
  if (Date.now() - (state.windyFetchedAt.get(key) || 0) < 8 * 60_000) return;
  state.windyFetchedAt.set(key, Date.now());
  try {
    const cams = await getJSON(`/api/live/webcams?lat=${pov.lat.toFixed(2)}&lon=${pov.lng.toFixed(2)}`);
    const fetchedAt = Date.now();
    for (const c of cams) state.windyCams.set(c.id, { ...c, fetchedAt });
    refreshCamPoints();
    renderParticles();
    updatePreviews();
    updateCounts();
  } catch {
    state.windyFetchedAt.delete(key);
  }
}

function visibleIncidents() {
  return state.incidents.filter((i) => state.confidence.has(i.confidence));
}

function renderParticles() {
  const sets = [];
  if (LAYERS.flights.on) sets.push({ color: LAYERS.flights.color, size: 1.6, points: state.flights });
  if (LAYERS.ships.on) sets.push({ color: LAYERS.ships.color, size: 2.2, points: state.ships });
  if (LAYERS.satellites.on) sets.push({ color: LAYERS.satellites.color, size: 2.4, points: state.satPositions });
  if (LAYERS.cctv.on) sets.push({ color: LAYERS.cctv.color, size: 3, points: state.camPoints });
  if (LAYERS.youtube.on) sets.push({ color: LAYERS.youtube.color, size: 6, points: state.ytPoints });
  world.particlesData(sets);
}

// Labels are sized in degrees, so close in they swamp the screen - hide them
// below the zoom level where the chokepoint boxes themselves are obvious.
function renderLabels(pov = world.pointOfView()) {
  const show = LAYERS.chokepoints.on && pov.altitude > 0.2;
  world.labelsData(show
    ? state.chokepoints.map((c) => ({ name: c.name, lat: c.box[2] + 0.5, lng: (c.box[1] + c.box[3]) / 2 }))
    : []);
}

function renderHtml() {
  const incidents = LAYERS.incidents.on ? visibleIncidents() : [];
  const plane = state.tracked ? [state.tracked] : [];
  world.htmlElementsData([...incidents, ...state.previewCams, ...plane]);
}

function renderGlobe() {
  renderParticles();

  world.pointsData(LAYERS.earthquakes.on ? state.quakes : []);

  const incidents = LAYERS.incidents.on ? visibleIncidents() : [];
  updatePreviews();
  renderHtml();

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

  renderPaths();

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
  renderLabels();

  globeMaterial.uniforms.dayNight.value = LAYERS.daynight.on ? 1.0 : 0.0;
}

function renderPaths() {
  const paths = LAYERS.cables.on ? [...state.cables] : [];
  const t = state.tracked;
  if (t && t.trail.length > 1) paths.push({ kind: 'trail', color: LAYERS.flights.color, name: t.callsign || t.icao24, coords: t.trail });
  world.pathsData(paths);
}

// ---------- data loaders ----------

let flightsRetry;

async function loadFlights() {
  const d = await getJSON('/api/live/flights');
  state.flights = d.flights.map((f) => ({ lat: f[4], lng: f[3], alt: 0.012, row: f }));
  state.flightSource = d;
  // The fallback sweep fills in over a couple of minutes - poll faster until it has
  clearTimeout(flightsRetry);
  if (d.warming) {
    flightsRetry = setTimeout(async () => { await runSource('flights', loadFlights); renderAll(); }, 20_000);
    return `${d.count.toLocaleString()} aircraft so far · ${d.source} sweep warming up`;
  }
  const via = d.coverage === 'global' ? d.source : `${d.source}, ${d.coverage}`;
  $('#flight-source').textContent = d.coverage === 'global'
    ? `Live data: ${d.source}, worldwide.`
    : `Live data: ${d.source} ${d.coverage} of busy airspace - planes over open ocean may be missing.`;
  return `${d.count.toLocaleString()} aircraft airborne (${via})`;
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

async function loadYoutube() {
  const d = await getJSON('/api/live/youtube');
  state.ytStreams = d.streams.map((s) => ({
    id: `yt:${s.id}`,
    ytId: s.id,
    source: 'YouTube',
    name: s.name,
    place: s.place,
    channel: s.channel,
    lat: s.lat,
    lon: s.lon,
    image: `https://i.ytimg.com/vi/${s.id}/hqdefault.jpg`,
  }));
  refreshCamPoints();
  const dropped = d.curated - d.available;
  return `${d.available} live streams${dropped ? ` (${dropped} offline)` : ''}`;
}

async function loadCameras() {
  const d = await getJSON('/api/live/cameras');
  state.cameras = d.cameras.map((r) => ({
    id: r[0], source: r[1], name: r[2], lat: r[3], lon: r[4], image: r[5], video: r[6], videoKind: r[7],
  }));
  state.windyEnabled = d.windy_enabled;
  refreshCamPoints();
  const live = Object.values(d.counts).filter(Boolean).length;
  const windy = d.windy_enabled ? '' : ' (Windy offline: no key)';
  return `${state.cameras.length.toLocaleString()} cams from ${live} networks${windy}`;
}

const SOURCES = [
  ['flights', 'ADS-B receiver network', loadFlights],
  ['ships', 'AIS maritime feed', loadShips],
  ['satellites', 'orbital elements', loadSatellites],
  ['earthquakes', 'USGS seismic feed', loadQuakes],
  ['incidents', 'GDELT event stream', loadIncidents],
  ['news', 'wire headlines', loadNews],
  ['cables', 'submarine cable map', loadCables],
  ['cameras', 'public camera network', loadCameras],
  ['youtube', 'YouTube live cams', loadYoutube],
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

document.querySelector('.bulk').addEventListener('click', (e) => {
  const mode = e.target.dataset.bulk;
  if (!mode) return;
  const on = mode === 'all';
  for (const key of Object.keys(LAYERS)) LAYERS[key].on = on;
  document.querySelectorAll('#layers input[data-layer]').forEach((box) => { box.checked = on; });
  renderGlobe();
});

function updateCounts() {
  const counts = {
    flights: state.flights.length,
    ships: state.ships.length,
    satellites: state.satPositions.length,
    incidents: visibleIncidents().length,
    earthquakes: state.quakes.length,
    chokepoints: state.chokepoints.length,
    cables: state.cables.length,
    cctv: state.camPoints.length,
    youtube: state.ytStreams.length,
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
  focusIncident(visibleIncidents()[+btn.dataset.incident]);
});

function focusIncident(i) {
  flyToWithCard(i.lat, i.lon);
  showIncident(i);
}

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
    <p class="fineprint"><b>Coverage matters:</b> AIS comes from volunteer coastal receivers. A chokepoint marked
    <span class="badge low">no coverage</span> shows 0 because nobody is reporting from that region, not because
    the water is empty.</p>
    ${state.chokepoints.map((c) => {
      const dirs = Object.entries(c.directions);
      const moving = Math.max(c.moving, 1);
      const cov = {
        none: '<span class="badge low">no coverage</span>',
        sparse: `<span class="badge medium">sparse · ${c.region_ships} in region</span>`,
        ok: `<span class="badge ok">covered · ${c.region_ships} in region</span>`,
      }[c.coverage] || '';
      const big = c.coverage === 'none' ? '<span class="big muted">no data</span>' : `<span class="big">${c.total}</span>`;
      return `<div class="cp" id="cp-${esc(c.name.replace(/\W+/g, '-'))}">
        <header><h3>${esc(c.name)}</h3>${big}</header>
        ${st?.connected ? cov : ''}
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

// Aim a little south of the target so it lands above the detail card,
// which covers the bottom of the screen.
function flyToWithCard(lat, lng, altitude = 0.9) {
  flyTo(Math.max(-85, lat - altitude * 8), lng, altitude);
}

function showDetail(html) {
  stopMedia();
  const el = $('#detail');
  el.innerHTML = `<button class="close" aria-label="Close">×</button>${html}`;
  delete el.dataset.flight;
  el.classList.remove('hidden');
  el.querySelector('.close').addEventListener('click', hideDetail);
}

function hideDetail() {
  stopMedia();
  $('#detail').classList.add('hidden');
}

// A live HLS stream keeps downloading until it's destroyed, so every card
// change tears down whatever the previous camera started.
function stopMedia() {
  if (!state.media) return;
  state.media.hls?.destroy();
  clearInterval(state.media.timer);
  state.media = null;
}

function focusCamera(cam) {
  flyToWithCard(cam.lat, cam.lon, Math.min(world.pointOfView().altitude, 0.12));
  showCamera(cam);
}

// Embedded players are restricted to the hosts we expect, so a tampered
// feed can't drop an arbitrary page into the iframe.
const embedUrl = (u, host) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname === host ? esc(url.href) : null;
  } catch {
    return null;
  }
};

function cameraMedia(cam) {
  if (cam.source === 'YouTube') {
    const id = /^[\w-]{11}$/.test(cam.ytId) ? cam.ytId : '';
    return `<iframe class="cam-embed" src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&playsinline=1"
        title="${esc(cam.name)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>
      <p class="fineprint"><span class="badge high">● live</span> ${esc(cam.channel)} on YouTube ·
        <a href="https://www.youtube.com/watch?v=${id}" target="_blank" rel="noopener noreferrer">open on YouTube</a></p>`;
  }
  if (cam.source === 'Windy') {
    const player = embedUrl(cam.player, 'webcams.windy.com');
    const isLive = /\/live$/.test(cam.player || '');
    const media = player
      ? `<iframe class="cam-embed" src="${player}" title="${esc(cam.name)}" allow="autoplay; fullscreen" allowfullscreen></iframe>
         <p class="fineprint">${isLive ? '<span class="badge high">● live</span>' : 'Timelapse of today (this webcam has no live player on our tier)'}
           · <a href="${safeUrl(cam.detail_url)}" target="_blank" rel="noopener noreferrer">view on windy.com</a></p>`
      : `<a href="${safeUrl(cam.detail_url)}" target="_blank" rel="noopener noreferrer">
           <img class="cam-still" src="${safeUrl(cam.image)}" alt="Webcam image: ${esc(cam.name)}"></a>`;
    return `${media}
      <p class="fineprint">Webcams provided by <a href="https://www.windy.com/" target="_blank" rel="noopener noreferrer">Windy.com</a>
      - <a href="https://www.windy.com/webcams/add" target="_blank" rel="noopener noreferrer">add a webcam</a></p>`;
  }
  if (cam.videoKind) {
    const note = cam.videoKind === 'hls' ? 'live stream' : '~10s clip, refreshed by TfL every few minutes';
    return `<video class="cam-video" id="cam-video" autoplay muted playsinline controls ${cam.videoKind === 'mp4' ? 'loop' : ''}
        poster="${safeUrl(freshImage(cam))}"></video>
      <p class="fineprint">${cam.videoKind === 'hls' ? '<span class="badge high">● live</span> ' : ''}${note}</p>`;
  }
  return `<img class="cam-still" id="cam-still" src="${safeUrl(freshImage(cam))}" alt="Camera image: ${esc(cam.name)}">
    <p class="fineprint">Still image, refreshes every 30s.</p>`;
}

const SOURCE_REGION = {
  TfL: 'London, UK',
  Caltrans: 'California, US',
  DriveBC: 'British Columbia, Canada',
  Fintraffic: 'Finland',
  NZTA: 'New Zealand',
  'HK Transport Dept': 'Hong Kong',
  'LTA Singapore': 'Singapore',
};

async function showCamera(cam) {
  if (needsWindyImage(cam)) {
    await ensureWindyImages([cam]);
    cam = detailedCamera(cam);
  }
  const place = cam.place || SOURCE_REGION[cam.source] || '';
  showDetail(`
    <h3>${esc(cam.name)}</h3>
    <span class="badge ok">${esc(cam.source)}</span> <span class="fineprint">${esc(place)}</span>
    <div class="cam-media">${cameraMedia(cam)}</div>`);
  state.media = {};

  const still = document.getElementById('cam-still');
  if (still) {
    state.media.timer = setInterval(() => { still.src = `${cam.image}?t=${Date.now()}`; }, 30_000);
  }
  const video = document.getElementById('cam-video');
  if (!video) return;
  if (cam.videoKind === 'mp4') {
    video.src = `${cam.video}?t=${Math.floor(Date.now() / 60_000)}`;
    return;
  }
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = cam.video; // Safari plays HLS natively
    return;
  }
  const media = state.media;
  const { default: Hls } = await import('hls.js');
  if (state.media !== media) return; // user moved on while hls.js loaded
  if (!Hls.isSupported()) return;
  const hls = new Hls({ liveDurationInfinity: true });
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (data.fatal) {
      hls.destroy();
      video.replaceWith(Object.assign(document.createElement('img'), { className: 'cam-still', src: freshImage(cam), alt: '' }));
    }
  });
  hls.loadSource(cam.video);
  hls.attachMedia(video);
  media.hls = hls;
}

// ---------- aircraft tracking ----------

const TRACK_MS = 10_000;
const FLIGHT_QUERY = /^[A-Za-z0-9-]{2,10}$/;

const rowToFlight = (r) => ({
  icao24: r[0], callsign: r[1], country: r[2], lon: r[3], lat: r[4],
  alt_m: r[5], speed_ms: r[6], heading: r[7], registration: r[8], type: r[9],
});

function startTracking(row) {
  stopTracking();
  const f = rowToFlight(row);
  state.tracked = { ...f, kind: 'plane', trail: [[f.lat, f.lon]], follow: true, updated: Date.now() / 1000, lost: false };
  flyToWithCard(f.lat, f.lon, Math.min(world.pointOfView().altitude, 0.6));
  renderHtml();
  renderPaths();
  showFlight();
  state.trackTimer = setInterval(pollTracked, TRACK_MS);
}

function stopTracking() {
  clearInterval(state.trackTimer);
  state.trackTimer = null;
  state.tracked = null;
  renderHtml();
  renderPaths();
}

async function pollTracked() {
  const t = state.tracked;
  if (!t) return;
  try {
    const d = await getJSON(`/api/live/flights/position?icao24=${t.icao24}`);
    if (state.tracked !== t) return; // switched planes while waiting
    const f = rowToFlight(d.flight);
    const [lastLat, lastLon] = t.trail[t.trail.length - 1];
    if (f.lat !== lastLat || f.lon !== lastLon) t.trail.push([f.lat, f.lon]);
    Object.assign(t, {
      ...f,
      registration: f.registration || t.registration,
      type: f.type || t.type,
      country: f.country || t.country,
      updated: Date.now() / 1000,
      lost: false,
    });
    rotatePlane(t);
    if (t.follow) {
      const { altitude } = world.pointOfView();
      world.pointOfView({ lat: Math.max(-85, t.lat - altitude * 8), lng: t.lon, altitude }, 1000);
    }
    renderHtml();
    renderPaths();
  } catch {
    t.lost = true; // out of receiver range (oceans) or landed
  }
  if (isFlightCardOpen()) showFlight();
}

const isFlightCardOpen = () => !$('#detail').classList.contains('hidden')
  && $('#detail').dataset.flight === state.tracked?.icao24;

function showFlight() {
  const t = state.tracked;
  if (!t) return;
  const ft = Math.round(t.alt_m / 0.3048);
  const kt = Math.round(t.speed_ms / 0.514444);
  showDetail(`
    <h3>✈ ${esc(t.callsign || t.icao24.toUpperCase())}</h3>
    <span class="badge track">${t.lost ? 'signal lost' : 'tracking live'}</span>
    <dl>
      <dt>registration</dt><dd>${esc(t.registration || 'unknown')}</dd>
      <dt>aircraft</dt><dd>${esc(t.type || 'unknown')}</dd>
      ${t.country ? `<dt>registered in</dt><dd>${esc(t.country)}</dd>` : ''}
      <dt>altitude</dt><dd>${ft.toLocaleString()} ft (${Math.round(t.alt_m).toLocaleString()} m)</dd>
      <dt>speed</dt><dd>${kt} kt (${Math.round(t.speed_ms * 3.6)} km/h)</dd>
      <dt>heading</dt><dd>${esc(t.heading)}°</dd>
      <dt>position</dt><dd>${t.lat.toFixed(3)}, ${t.lon.toFixed(3)}</dd>
      <dt>icao hex</dt><dd>${esc(t.icao24)}</dd>
      <dt>updated</dt><dd>${timeAgo(t.updated)}</dd>
    </dl>
    <div class="card-actions">
      <button type="button" data-act="follow" class="${t.follow ? 'on' : ''}">follow ${t.follow ? 'on' : 'off'}</button>
      <button type="button" data-act="stop">stop tracking</button>
    </div>
    <a href="https://globe.adsb.fi/?icao=${encodeURIComponent(t.icao24)}" target="_blank" rel="noopener noreferrer">full flight history on adsb.fi</a>
    <p class="fineprint">Positions come from volunteer ADS-B receivers and refresh every ${TRACK_MS / 1000}s.
    Gaps over oceans and remote areas are normal.</p>`);
  const card = $('#detail');
  card.dataset.flight = t.icao24;
  card.querySelector('[data-act="follow"]').addEventListener('click', () => {
    t.follow = !t.follow;
    if (t.follow) flyToWithCard(t.lat, t.lon, world.pointOfView().altitude);
    showFlight();
  });
  card.querySelector('[data-act="stop"]').addEventListener('click', () => { stopTracking(); hideDetail(); });
}

// Dragging the globe means the user wants to look elsewhere - stop snapping back
document.getElementById('globe').addEventListener('pointerdown', () => {
  if (state.tracked?.follow) {
    state.tracked.follow = false;
    if (isFlightCardOpen()) showFlight();
  }
});

function flightResultLine(r) {
  const f = rowToFlight(r);
  const bits = [f.type, f.registration, `${Math.round(f.alt_m / 0.3048).toLocaleString()} ft`].filter(Boolean);
  return `<b>${esc(f.callsign || f.icao24.toUpperCase())}</b> · ${esc(bits.join(' · '))}`;
}

$('#flight-search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#flight-q').value.trim();
  const out = $('#flight-results');
  if (!FLIGHT_QUERY.test(q)) {
    out.innerHTML = '<li class="note">Use a flight number (BAW1), registration (G-EUYS) or 6-character hex.</li>';
    return;
  }
  out.innerHTML = '<li class="note">searching…</li>';
  try {
    const d = await getJSON(`/api/live/flights/search?q=${encodeURIComponent(q)}`);
    if (!d.results.length) {
      out.innerHTML = `<li class="note">${esc(q.toUpperCase())} isn't airborne or visible to receivers right now.</li>`;
      return;
    }
    out.innerHTML = d.results.map((r, i) => `<li><button type="button" data-i="${i}">${flightResultLine(r)}</button></li>`).join('');
    out.onclick = (ev) => {
      const btn = ev.target.closest('button[data-i]');
      if (!btn) return;
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('open')); // mobile: reveal the map
      startTracking(d.results[+btn.dataset.i]);
    };
    if (d.results.length === 1) out.querySelector('button').click();
  } catch {
    out.innerHTML = '<li class="note">Search is unavailable right now - try again in a minute.</li>';
  }
});

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
  setInterval(() => {
    for (const img of document.querySelectorAll('.cam-thumb img[data-refresh]')) {
      img.src = `${img.dataset.refresh}?t=${Date.now()}`;
    }
  }, 60_000);
}

$('#boot').addEventListener('click', () => $('#boot').classList.add('done'));

setInterval(() => {
  $('#utc').textContent = new Date().toISOString().slice(11, 19);
}, 1000);

boot();




