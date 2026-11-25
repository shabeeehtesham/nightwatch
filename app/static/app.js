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
  .htmlElement((d) => {
    if (d.kind === 'cam') return camThumb(d);
    if (d.kind === 'plane') return planeMarker(d);
    if (d.kind === 'airport') return airportMarker(d);
    return incidentMarker(d);
  });

world
  .arcStartLat((a) => a.from.lat)
  .arcStartLng((a) => a.from.lon)
  .arcEndLat((a) => a.to.lat)
  .arcEndLng((a) => a.to.lon)
  .arcColor(() => ['rgba(255,179,71,0.95)', 'rgba(57,255,136,0.95)'])
  .arcStroke(0.45)
  .arcDashLength(0.35)
  .arcDashGap(0.12)
  .arcDashAnimateTime(2500)
  .arcAltitudeAutoScale(0.3)
  .arcsTransitionDuration(0);

function airportMarker(d) {
  const el = document.createElement('div');
  el.className = `airport-marker ${d.role}`;
  el.innerHTML = `<i></i><span>${esc(d.code)}</span>`;
  el.title = d.name || d.code;
  return el;
}

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
  const t = state.tracked;
  const plane = t ? [t] : [];
  const airports = t?.route ? t.airportMarkers : [];
  world.htmlElementsData([...incidents, ...state.previewCams, ...airports, ...plane]);
  world.arcsData(t?.arc ? [t.arc] : []);
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
  const t = { ...f, kind: 'plane', trail: [[f.lat, f.lon]], follow: true, updated: Date.now() / 1000, lost: false, route: null, routeState: 'loading' };
  state.tracked = t;
  flyToWithCard(f.lat, f.lon, Math.min(world.pointOfView().altitude, 0.6));
  renderHtml();
  renderPaths();
  showFlight();
  state.trackTimer = setInterval(pollTracked, TRACK_MS);
  loadRoute(t);
}

async function loadRoute(t) {
  if (!t.callsign || !/^[A-Za-z0-9]{3,8}$/.test(t.callsign)) {
    t.routeState = 'unknown';
  } else {
    try {
      const { route } = await getJSON(`/api/live/flights/route?callsign=${encodeURIComponent(t.callsign)}`);
      t.route = route;
      t.routeState = route ? 'ok' : 'unknown';
    } catch {
      t.routeState = 'error';
    }
  }
  if (state.tracked !== t) return;
  if (t.route) {
    const { origin: o, destination: d } = t.route;
    t.arc = { from: o, to: d };
    t.airportMarkers = [
      { kind: 'airport', role: 'from', lat: o.lat, lon: o.lon, code: o.iata || o.icao, name: o.name },
      { kind: 'airport', role: 'to', lat: d.lat, lon: d.lon, code: d.iata || d.icao, name: d.name },
    ];
    // Show the whole journey first; "follow" is one tap away
    const span = distanceKm(o.lat, o.lon, d.lat, d.lon);
    const mid = midpoint(o, d);
    t.follow = false;
    // A phone is narrow, so pull the camera back further to fit both airports
    const narrow = window.innerWidth < 700 ? 2 : 1;
    flyToWithCard(mid.lat, mid.lon, Math.min(3.2, Math.max(0.35, (span / 4500) * narrow)));
  }
  renderHtml();
  if (isFlightCardOpen()) showFlight();
}

// Great-circle midpoint, so a route across the date line doesn't centre on the wrong side of the planet
function midpoint(a, b) {
  const r = Math.PI / 180;
  const [la1, lo1, la2, lo2] = [a.lat * r, a.lon * r, b.lat * r, b.lon * r];
  const bx = Math.cos(la2) * Math.cos(lo2 - lo1);
  const by = Math.cos(la2) * Math.sin(lo2 - lo1);
  const lat = Math.atan2(Math.sin(la1) + Math.sin(la2), Math.hypot(Math.cos(la1) + bx, by));
  const lon = lo1 + Math.atan2(by, Math.cos(la1) + bx);
  return { lat: lat / r, lon: (((lon / r) + 540) % 360) - 180 };
}

const AIRCRAFT_NAMES = {
  A319: 'Airbus A319', A320: 'Airbus A320', A20N: 'Airbus A320neo', A321: 'Airbus A321', A21N: 'Airbus A321neo',
  A332: 'Airbus A330-200', A333: 'Airbus A330-300', A339: 'Airbus A330-900neo', A359: 'Airbus A350-900',
  A35K: 'Airbus A350-1000', A388: 'Airbus A380', BCS1: 'Airbus A220-100', BCS3: 'Airbus A220-300',
  B737: 'Boeing 737-700', B738: 'Boeing 737-800', B739: 'Boeing 737-900', B38M: 'Boeing 737 MAX 8',
  B39M: 'Boeing 737 MAX 9', B744: 'Boeing 747-400', B748: 'Boeing 747-8', B752: 'Boeing 757-200',
  B763: 'Boeing 767-300', B772: 'Boeing 777-200', B77L: 'Boeing 777-200LR', B77W: 'Boeing 777-300ER',
  B788: 'Boeing 787-8', B789: 'Boeing 787-9', B78X: 'Boeing 787-10', AT72: 'ATR 72', AT75: 'ATR 72-500',
  AT76: 'ATR 72-600', DH8D: 'Dash 8-400', E190: 'Embraer E190', E195: 'Embraer E195', E75L: 'Embraer E175',
  CRJ9: 'Bombardier CRJ900',
};

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const compass = (deg) => COMPASS[Math.round((((deg || 0) % 360) + 360) % 360 / 45) % 8];

function flightPhase(t) {
  if (t.lost) return 'out of receiver range';
  if (t.climb > 60) return 'climbing';
  if (t.climb < -60) return 'descending';
  if (t.alt_m > 7000) return 'cruising';
  return t.alt_m < 3000 ? 'low altitude' : 'level flight';
}

// Where the plane is along the route, and whether that route is believable
function routeProgress(t) {
  const { origin: o, destination: d } = t.route;
  const flown = distanceKm(o.lat, o.lon, t.lat, t.lon);
  const left = distanceKm(t.lat, t.lon, d.lat, d.lon);
  const total = distanceKm(o.lat, o.lon, d.lat, d.lon);
  // Planes don't fly perfectly straight and circle before landing, so allow
  // some detour - but a plane far off the line means the database is stale
  const onRoute = (flown + left) / Math.max(total, 1) < 1.4 || left < 80;
  const kmh = t.speed_ms * 3.6;
  const minutes = kmh > 100 ? Math.round((left / kmh) * 60) : null;
  return { flown, left, total, pct: Math.min(100, (flown / Math.max(flown + left, 1)) * 100), onRoute, minutes };
}

const fmtDuration = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

function routeBlock(t) {
  if (t.routeState === 'loading') return '<p class="route-note">looking up the route…</p>';
  if (!t.route) {
    return `<p class="route-note">Route unknown - ${t.routeState === 'error'
      ? 'the route database is unreachable right now.'
      : "this flight isn't in the public route database (common for private, cargo and charter flights)."}</p>`;
  }
  const { origin: o, destination: d } = t.route;
  const p = routeProgress(t);
  return `
    <div class="route-viz">
      <div class="ap"><b>${esc(o.iata || o.icao)}</b><span>${esc(o.city || o.name)}</span></div>
      <div class="route-line" aria-hidden="true">
        <div class="route-done" style="width:${p.pct.toFixed(1)}%"></div>
        <div class="route-plane" style="left:${p.pct.toFixed(1)}%">${PLANE_SVG}</div>
      </div>
      <div class="ap to"><b>${esc(d.iata || d.icao)}</b><span>${esc(d.city || d.name)}</span></div>
    </div>
    <p class="route-stats">
      <b>${Math.round(p.pct)}%</b> of the way ·
      ${Math.round(p.flown).toLocaleString()} km flown ·
      ${Math.round(p.left).toLocaleString()} km to go${p.minutes != null ? ` · about <b>${fmtDuration(p.minutes)}</b> left` : ''}
    </p>
    ${p.onRoute ? '' : `<p class="route-warn">⚠ The plane is well off the line between ${esc(o.iata || o.icao)} and
      ${esc(d.iata || d.icao)}, so this database route may be out of date for today's flight.</p>`}`;
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
    t.prevAlt = t.alt_m;
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
    t.climb = f.alt_m - (t.prevAlt ?? f.alt_m);
    t.prevAlt = f.alt_m;
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
  const airline = t.route?.airline;
  const number = t.route?.flight_number;
  const title = [airline, number || t.callsign || t.icao24.toUpperCase()].filter(Boolean).join(' ');
  const aircraft = AIRCRAFT_NAMES[t.type] ? `${AIRCRAFT_NAMES[t.type]} (${t.type})` : (t.type || 'unknown');
  showDetail(`
    <h3>✈ ${esc(title)} ${number && t.callsign ? `<small class="muted">broadcasting as ${esc(t.callsign)}</small>` : ''}</h3>
    <span class="badge track">${t.lost ? 'signal lost' : 'tracking live'}</span>
    ${routeBlock(t)}
    <div class="flight-facts">
      <div><span>height</span><b>${ft.toLocaleString()} ft</b><small>${(t.alt_m / 1000).toFixed(1)} km up</small></div>
      <div><span>speed</span><b>${Math.round(t.speed_ms * 3.6).toLocaleString()} km/h</b><small>over the ground</small></div>
      <div><span>heading</span><b>${compass(t.heading)}</b><small>${esc(t.heading)}°</small></div>
      <div><span>status</span><b>${flightPhase(t)}</b><small>updated ${timeAgo(t.updated)}</small></div>
    </div>
    <p class="aircraft-line">${esc(aircraft)}${t.registration ? ` · ${esc(t.registration)}` : ''}</p>
    <div class="card-actions">
      <button type="button" data-act="follow" class="${t.follow ? 'on' : ''}">follow ${t.follow ? 'on' : 'off'}</button>
      <button type="button" data-act="stop">stop tracking</button>
    </div>
    <details class="more" ${state.flightMoreOpen ? 'open' : ''}>
      <summary>more details</summary>
      <dl>
        ${t.country ? `<dt>registered in</dt><dd>${esc(t.country)}</dd>` : ''}
        <dt>position</dt><dd>${t.lat.toFixed(3)}, ${t.lon.toFixed(3)}</dd>
        <dt>icao hex</dt><dd>${esc(t.icao24)}</dd>
        ${t.route ? `<dt>from</dt><dd>${esc(t.route.origin.name)}</dd><dt>to</dt><dd>${esc(t.route.destination.name)}</dd>` : ''}
      </dl>
      <a href="https://globe.adsb.fi/?icao=${encodeURIComponent(t.icao24)}" target="_blank" rel="noopener noreferrer">full flight history on adsb.fi</a>
      <p class="fineprint">Positions come from volunteer ADS-B receivers every ${TRACK_MS / 1000}s; gaps over oceans
      are normal.${t.route ? ' Route from the adsbdb.com community database. Time left = distance ÷ current speed, not the airline\'s ETA.' : ''}</p>
    </details>`);
  const card = $('#detail');
  card.querySelector('details.more').addEventListener('toggle', (e) => { state.flightMoreOpen = e.target.open; });
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
      const r = d.route;
      const known = r
        ? `<b>${esc(r.flight_number || r.callsign)}</b> is ${esc(r.airline || 'a flight')} from
           ${esc(r.origin.city || r.origin.name)} (${esc(r.origin.iata || r.origin.icao)}) to
           ${esc(r.destination.city || r.destination.name)} (${esc(r.destination.iata || r.destination.icao)}), but `
        : `${esc(q.toUpperCase())} `;
      out.innerHTML = `<li class="note">${known}it isn't visible right now. Usually that means it's not in the air
        (not departed yet, or already landed), or it's flying where there are no receivers - oceans and
        parts of Africa and Asia. Try again during the flight.</li>`;
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




