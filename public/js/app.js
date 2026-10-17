'use strict';

/* ================================================================== */
/* State                                                              */
/* ================================================================== */

const state = {
  view: 'loading',       // loading | dashboard | create | join | lobby | game
  playerId: null,
  party: null,
  partyId: null,
  templates: [],
  templateId: null,
  boundary: null,        // template boundary (raw or normalized)
  base: null,            // { lat, lng }
  createMap: null,
  baseMarker: null,
  areaCircle: null,
  createBoundaryGroup: null,
  gameMap: null,
  gameBaseMarker: null,
  gameAreaCircle: null,
  gameBoundaryGroup: null,
  gameFitted: false,
  timerHandle: null,
  // chat / game log
  chat: [],
  chatOpen: false,
  chatUnread: 0,
  // live location + heading
  watchId: null,
  userLatLng: null,
  compassHeading: null,
  gpsHeading: null,
  userMarker: null,
  userCone: null,
  followUser: false,
  userCentered: false,
  orientationBound: false,
  hasAbsoluteHeading: false,
  // shared player positions (hunters see runners)
  runnerPositions: {},
  runnerMarkers: {},
  positionTimer: null,
  catchTargetId: null,
  selfCaught: false,
  lastArrowUpdate: 0,
};

const MOVEMENT_LABELS = {
  walk: 'Walk',
  publicTransport: 'Public transport',
  bike: 'Bike',
  esScooter: 'E-scooter',
};

const DEFAULT_CENTER = [47.4979, 19.0402]; // Budapest city centre (host adjusts)

// View cone drawn around the player's live location.
const USER_CONE_RADIUS_M = 70;
const USER_CONE_SPREAD_DEG = 55;
const USER_LOCATION_COLOR = '#22d3ee';

// How close a hunter must be (using last reported positions) to catch.
const CATCH_RADIUS_M = 15;

/* ================================================================== */
/* Small helpers                                                      */
/* ================================================================== */

const $ = (id) => document.getElementById(id);

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getPlayerId() {
  let id = null;
  try { id = sessionStorage.getItem('manhunt.playerId'); } catch (_) {}
  if (!id) {
    id = uid();
    try { sessionStorage.setItem('manhunt.playerId', id); } catch (_) {}
  }
  return id;
}

function getSession() {
  try {
    const raw = sessionStorage.getItem('manhunt.session');
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function setSession(partyId) {
  try {
    if (partyId) sessionStorage.setItem('manhunt.session', JSON.stringify({ partyId }));
    else sessionStorage.removeItem('manhunt.session');
  } catch (_) {}
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('toast--show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('toast--show'), 2200);
}

function showError(id, message) {
  const el = $(id);
  if (!message) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = message;
}

function roleLabel(role) {
  if (role === 'hunter') return 'Hunter';
  if (role === 'runner') return 'Runner';
  return 'Unassigned';
}

/* ================================================================== */
/* Navigation                                                        */
/* ================================================================== */

function showView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('view--active'));
  const el = $('view-' + name);
  if (el) el.classList.add('view--active');
  window.scrollTo(0, 0);

  if (name === 'create') ensureCreateMap();
  if (name === 'game' && state.gameMap) setTimeout(() => state.gameMap.invalidateSize(), 160);
}

/* ================================================================== */
/* Socket                                                             */
/* ================================================================== */

const socket = io();

socket.on('connect', () => {
  if (!state.playerId) state.playerId = getPlayerId();
  const session = getSession();
  if (session && session.partyId) {
    socket.emit('party:reconnect', { partyId: session.partyId, playerId: state.playerId }, (res) => {
      if (res && res.ok) {
        state.party = res.state;
        state.partyId = res.id;
        renderParty();
      } else {
        setSession(null);
      }
    });
  }
});

socket.on('party:update', (party) => {
  state.party = party;
  state.partyId = party.id;
  renderParty();
});

socket.on('party:started', () => {
  toast('The game has started');
});

socket.on('chat:message', (msg) => {
  if (!msg || !msg.id) return;
  state.chat = mergeChat(state.chat, [msg]);
  renderChatLog();
  if (!state.chatOpen) {
    state.chatUnread += 1;
    renderChatBadge();
    if (msg.kind === 'log') toast(msg.text);
  }
});

// Runner positions, relayed to hunters only.
socket.on('player:positions', (payload) => {
  if (!payload || !Array.isArray(payload.positions)) return;
  const next = {};
  payload.positions.forEach((pos) => {
    if (pos && pos.id) next[pos.id] = pos;
  });
  state.runnerPositions = next;
  renderRunnerMarkers();
  updateCatchButton();
});

socket.on('party:kicked', () => {
  state.party = null;
  state.partyId = null;
  state.gameFitted = false;
  clearInterval(state.timerHandle);
  resetChat();
  stopLocationTracking();
  stopPositionBroadcast();
  clearUserLayer();
  clearRunnerMarkers();
  setSession(null);
  closeRules();
  showView('dashboard');
  toast('You were removed from the lobby');
});

/* ================================================================== */
/* Templates                                                          */
/* ================================================================== */

async function loadTemplates() {
  try {
    const res = await fetch('/api/templates');
    state.templates = await res.json();
  } catch (_) {
    state.templates = [];
  }
  renderTemplates();
}

function openTemplateModal() { $('template-modal').hidden = false; }
function closeTemplateModal() { $('template-modal').hidden = true; }
function openRules() { $('rules-modal').hidden = false; }
function closeRules() { $('rules-modal').hidden = true; }

function renderTemplates() {
  const list = $('template-list');
  list.innerHTML = '';

  const custom = document.createElement('button');
  custom.type = 'button';
  custom.className = 'template-card';
  custom.innerHTML = `
    <span class="template-card__badge">&#8734;</span>
    <span class="template-card__body">
      <p class="template-card__name">Custom</p>
      <p class="template-card__desc">Just a radius circle around your base.</p>
    </span>
    <span class="template-card__arrow">&#8250;</span>`;
  custom.addEventListener('click', useCustomArea);
  list.appendChild(custom);

  state.templates.forEach((tpl) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'template-card';
    card.innerHTML = `
      <span class="template-card__badge">${escapeHtml(tpl.name.charAt(0))}</span>
      <span class="template-card__body">
        <p class="template-card__name">${escapeHtml(tpl.name)}</p>
        <p class="template-card__tag">${escapeHtml(tpl.tagline || '')}</p>
        <p class="template-card__desc">${escapeHtml(tpl.description || '')}</p>
      </span>
      <span class="template-card__arrow">&#8250;</span>`;
    card.addEventListener('click', () => {
      applyTemplate(tpl.id);
      closeTemplateModal();
    });
    list.appendChild(card);
  });
}

function applyTemplate(id) {
  const tpl = state.templates.find((t) => t.id === id);
  if (!tpl) return;
  const s = tpl.settings;
  state.templateId = id;
  state.boundary = (s.area && s.area.boundary) || null;
  $('gameName').value = tpl.name;
  $('templateChosen').textContent = tpl.name;
  $('durationMin').value = s.durationMin;
  $('hunterCount').value = s.hunterCount;
  $('escapeMin').value = s.escapeMin;
  $('areaRadius').value = s.area.radiusM;
  $('radiusOut').textContent = s.area.radiusM;
  $('returnMin').value = s.boundary.returnMin;
  $('catchMethod').value = s.catchMethod;

  const setCheck = (elId, on) => { $(elId).checked = !!on; };
  setCheck('hv-walk', s.movement.hunters.includes('walk'));
  setCheck('hv-publicTransport', s.movement.hunters.includes('publicTransport'));
  setCheck('hv-bike', s.movement.hunters.includes('bike'));
  setCheck('hv-esScooter', s.movement.hunters.includes('esScooter'));
  setCheck('rv-walk', s.movement.runners.includes('walk'));
  setCheck('rv-publicTransport', s.movement.runners.includes('publicTransport'));
  setCheck('ms-enabled', s.missions.enabled);
  setCheck('ms-points', s.missions.pointsEnabled);
  setCheck('ms-elimination', s.missions.eliminationEnabled);
  setCheck('ms-return', s.missions.returnMissionEnabled);

  if (s.base) setBase(s.base.lat, s.base.lng, ''); else clearBase();
  refreshCreateBoundary(true);
}

function useCustomArea() {
  state.boundary = null;
  state.templateId = null;
  $('templateChosen').textContent = 'Custom';
  refreshCreateBoundary(false);
  closeTemplateModal();
}

/* ================================================================== */
/* Map helpers                                                        */
/* ================================================================== */

function toLL(v) {
  if (Array.isArray(v)) return [Number(v[0]), Number(v[1])];
  return [Number(v.lat), Number(v.lng)];
}

/** Ray-casting point-in-polygon test for a single ring of [lat, lng] points. */
function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0];
    const xi = ring[i][1];
    const yj = ring[j][0];
    const xj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Playable-area check. Returns true when the point falls inside any boundary
 * area; a boundary with no areas (or no boundary at all) plays everywhere.
 * Shares the same geometry that drawBoundaryGroup renders.
 */
function isPlayablePoint(lat, lng, boundary = state.boundary) {
  if (!boundary || !Array.isArray(boundary.areas) || !boundary.areas.length) return true;
  return boundary.areas.some((area) => {
    const ring = (area.vertices || []).map(toLL);
    return ring.length >= 3 && pointInRing(lat, lng, ring);
  });
}

/** Draws boundary polygons, labelled barrier streets and permitted routes. */
function drawBoundaryGroup(group, boundary, opts = {}) {
  group.clearLayers();
  if (!boundary) return null;
  const bounds = L.latLngBounds([]);

  (boundary.areas || []).forEach((area) => {
    const pts = (area.vertices || []).map(toLL);
    if (pts.length < 3) return;
    pts.forEach((p) => bounds.extend(p));
    const poly = L.polygon(pts, {
      color: '#5b9bff', weight: 2, opacity: 0.95,
      fillColor: '#2f6fed', fillOpacity: opts.fillOpacity == null ? 0.14 : opts.fillOpacity,
    });
    if (area.name) {
      poly.bindTooltip(area.name, { permanent: true, direction: 'center', className: 'map-label map-label--area' });
    }
    group.addLayer(poly);
  });

  (boundary.edges || []).forEach((edge) => {
    const pts = (edge.path || []).map(toLL);
    if (pts.length < 2) return;
    pts.forEach((p) => bounds.extend(p));
    const line = L.polyline(pts, { color: '#8fb2ef', weight: 3, opacity: 0.9, lineCap: 'round' });
    if (edge.name) {
      line.bindTooltip(edge.name, { permanent: true, direction: 'center', className: 'map-label map-label--edge' });
    }
    group.addLayer(line);
  });

  (boundary.permittedRoutes || []).forEach((route) => {
    const pts = (route.path || []).map(toLL);
    if (pts.length < 2) return;
    pts.forEach((p) => bounds.extend(p));
    const line = L.polyline(pts, { color: '#2fbf71', weight: 5, opacity: 0.9, dashArray: '12 7', lineCap: 'round' });
    if (route.name) {
      line.bindTooltip(route.name, { permanent: true, direction: 'center', className: 'map-label map-label--route' });
    }
    group.addLayer(line);
  });

  return bounds.isValid() ? bounds : null;
}

/* ================================================================== */
/* Create map                                                         */
/* ================================================================== */

function ensureCreateMap() {
  if (state.createMap || !window.L) return;
  const map = L.map('create-map', { zoomControl: false, attributionControl: true })
    .setView(DEFAULT_CENTER, 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  map.on('click', (e) => setBase(e.latlng.lat, e.latlng.lng));
  state.createMap = map;
  state.createBoundaryGroup = L.layerGroup().addTo(map);
  setTimeout(() => { map.invalidateSize(); refreshCreateBoundary(!!state.boundary); }, 150);
}

function refreshCreateBoundary(fit) {
  if (!state.createMap || !state.createBoundaryGroup) return;
  const bounds = drawBoundaryGroup(state.createBoundaryGroup, state.boundary, { fillOpacity: 0.16 });
  if (bounds && fit) state.createMap.fitBounds(bounds, { padding: [18, 18] });
  updateRadiusCircle();
}

function setBase(lat, lng, source) {
  // When a template boundary is active the base must sit inside the playable
  // area, so the check and the drawn overlay share the same geometry.
  if (state.boundary && !isPlayablePoint(lat, lng, state.boundary)) {
    toast('That point is outside the playable area');
    return;
  }
  state.base = { lat, lng };
  $('baseCoords').textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
  if (state.createMap) {
    if (!state.baseMarker) {
      state.baseMarker = L.marker([lat, lng]).addTo(state.createMap);
    } else {
      state.baseMarker.setLatLng([lat, lng]);
    }
    if (source !== 'silent') state.createMap.panTo([lat, lng]);
  }
  updateRadiusCircle();
}

function clearBase() {
  state.base = null;
  $('baseCoords').textContent = 'No base set';
  if (state.baseMarker && state.createMap) {
    state.createMap.removeLayer(state.baseMarker);
    state.baseMarker = null;
  }
  updateRadiusCircle();
}

function updateRadiusCircle() {
  if (!state.createMap) return;
  const show = state.base && !state.boundary;
  if (!show) {
    if (state.areaCircle) {
      state.createMap.removeLayer(state.areaCircle);
      state.areaCircle = null;
    }
    return;
  }
  const radius = Number($('areaRadius').value);
  if (!state.areaCircle) {
    state.areaCircle = L.circle([state.base.lat, state.base.lng], {
      radius, color: '#5b9bff', weight: 1.5, fillColor: '#2f6fed', fillOpacity: 0.08,
    }).addTo(state.createMap);
  } else {
    state.areaCircle.setLatLng([state.base.lat, state.base.lng]);
    state.areaCircle.setRadius(radius);
  }
}

/* ================================================================== */
/* Create form                                                        */
/* ================================================================== */

function collectSettings() {
  const checked = (id) => $(id).checked;
  return {
    durationMin: Number($('durationMin').value) || 120,
    hunterCount: Number($('hunterCount').value) || 3,
    escapeMin: Number($('escapeMin').value) || 0,
    area: {
      name: state.boundary ? 'Template area' : 'Custom area',
      radiusM: Number($('areaRadius').value) || 2000,
      center: state.base ? { lat: state.base.lat, lng: state.base.lng } : null,
      boundary: state.boundary,
    },
    base: state.base,
    runnerPairs: true,
    movement: {
      hunters: ['walk', 'publicTransport', 'bike', 'esScooter'].filter((m) => checked('hv-' + m)),
      runners: ['walk', 'publicTransport'].filter((m) => checked('rv-' + m)),
    },
    catchMethod: $('catchMethod').value,
    boundary: {
      warningEnabled: true,
      returnMin: Number($('returnMin').value) || 10,
    },
    missions: {
      enabled: checked('ms-enabled'),
      pointsEnabled: checked('ms-points'),
      eliminationEnabled: checked('ms-elimination'),
      returnMissionEnabled: checked('ms-return'),
      notes: '',
    },
  };
}

function submitCreate(e) {
  e.preventDefault();
  showError('create-error', '');
  const hostName = $('hostName').value.trim();
  if (!hostName) return showError('create-error', 'Enter your name.');
  const gameName = $('gameName').value.trim() || 'Manhunt';
  const payload = {
    playerId: state.playerId,
    playerName: hostName,
    gameName,
    templateId: state.templateId || null,
    settings: collectSettings(),
  };
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  socket.emit('party:create', payload, (res) => {
    btn.disabled = false;
    if (res && res.ok) {
      state.party = res.state;
      state.partyId = res.id;
      setSession(res.id);
      renderParty();
    } else {
      showError('create-error', (res && res.error) || 'Could not create the game.');
    }
  });
}

/* ================================================================== */
/* Join form                                                          */
/* ================================================================== */

function submitJoin(e) {
  e.preventDefault();
  showError('join-error', '');
  const code = $('joinCode').value.trim();
  const name = $('joinName').value.trim();
  if (code.length !== 4) return showError('join-error', 'Enter the 4-digit code.');
  if (!name) return showError('join-error', 'Enter a display name.');

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  socket.emit('party:join', { code, name, playerId: state.playerId }, (res) => {
    btn.disabled = false;
    if (res && res.ok) {
      state.party = res.state;
      state.partyId = res.id;
      setSession(res.id);
      renderParty();
    } else {
      showError('join-error', (res && res.error) || 'Could not join the game.');
    }
  });
}

/* ================================================================== */
/* Lobby rendering                                                    */
/* ================================================================== */

function isHost() {
  return state.party && state.party.hostId === state.playerId;
}

function renderParty() {
  const party = state.party;
  if (!party) return;
  if (party.status === 'active') {
    showView('game');
    renderGame(party);
  } else {
    showView('lobby');
    renderLobby(party);
  }
}

function renderLobby(party) {
  $('playerCode').textContent = party.playerCode;
  $('seekerCode').textContent = party.seekerCode;
  $('lobbyGameName').textContent = party.name;
  $('lobbyStatus').textContent = 'Lobby';
  $('lobbyStatus').className = 'pill pill--muted';

  const host = isHost();
  $('assignHint').hidden = !host;
  $('playerCount').textContent = party.players.length;

  const list = $('lobby-players');
  list.innerHTML = '';
  party.players.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'player player--' + p.role + (p.connected ? '' : ' player--offline');
    const initial = escapeHtml((p.name || '?').charAt(0).toUpperCase());
    const isMe = p.id === state.playerId;
    let sub = roleLabel(p.role);
    if (p.role === 'runner' && p.pair) sub = 'Runner pair ' + p.pair;
    if (!p.connected) sub += ' · offline';
    const hostTag = p.id === party.hostId ? '<span class="player__host-tag">Host</span>' : '';

    li.innerHTML = `
      <span class="player__avatar">${initial}</span>
      <span class="player__body">
        <p class="player__name">${escapeHtml(p.name)}${isMe ? ' (you)' : ''} ${hostTag}</p>
        <p class="player__sub">${escapeHtml(sub)}</p>
      </span>`;

    if (host) {
      const actions = document.createElement('span');
      actions.className = 'player__actions';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'role-btn';
      btn.dataset.role = p.role;
      btn.textContent = roleLabel(p.role);
      btn.addEventListener('click', () => cycleRole(p.id, p.role));
      actions.appendChild(btn);

      if (p.id !== party.hostId) {
        const kick = document.createElement('button');
        kick.type = 'button';
        kick.className = 'kick-btn';
        kick.textContent = '\u00d7';
        kick.setAttribute('aria-label', 'Kick ' + p.name);
        kick.title = 'Kick';
        kick.addEventListener('click', () => kickPlayer(p.id, p.name));
        actions.appendChild(kick);
      }
      li.appendChild(actions);
    }
    list.appendChild(li);
  });

  renderSettings($('lobby-settings'), party.settings);

  const counts = party.counts;
  const startBtn = $('startBtn');
  startBtn.hidden = !host;
  const canStart = counts.hunter >= 1 && counts.runner >= 1;
  startBtn.disabled = !canStart;
  $('startHint').textContent = host
    ? (canStart
      ? `${counts.hunter} hunter${counts.hunter === 1 ? '' : 's'} · ${counts.runner} runner${counts.runner === 1 ? '' : 's'} · ${party.settings.durationMin} min`
      : 'Assign at least one hunter and one runner to start.')
    : 'Waiting for the host to start the game.';
}

function cycleRole(playerId, current) {
  const order = ['unassigned', 'hunter', 'runner'];
  const next = order[(order.indexOf(current) + 1) % order.length];
  socket.emit('party:assign', { targetId: playerId, role: next }, (res) => {
    if (res && !res.ok) toast(res.error || 'Could not assign role.');
  });
}

function kickPlayer(playerId, name) {
  socket.emit('party:kick', { targetId: playerId }, (res) => {
    if (res && !res.ok) toast(res.error || 'Could not kick player.');
    else toast((name || 'Player') + ' removed');
  });
}

function renderSettings(container, s) {
  const rows = [
    ['Duration', s.durationMin + ' min'],
    ['Hunters requested', String(s.hunterCount)],
    ['Escape time', s.escapeMin + ' min'],
    ['Runner pairs', s.runnerPairs ? 'On' : 'Off'],
    ['Hunter movement', s.movement.hunters.map((m) => MOVEMENT_LABELS[m]).join(', ') || '—'],
    ['Runner movement', s.movement.runners.map((m) => MOVEMENT_LABELS[m]).join(', ') || '—'],
    ['Catch method', s.catchMethod === 'touch' ? 'Physical touch' : 'Tag'],
    ['Boundary return', s.boundary.warningEnabled ? s.boundary.returnMin + ' min warning' : 'Off'],
    ['Missions', s.missions.enabled ? 'On' : 'Off'],
    ['Area', s.area.name || '—'],
    ['Base location', s.base ? s.base.lat.toFixed(4) + ', ' + s.base.lng.toFixed(4) : 'Not set'],
  ];
  container.innerHTML = rows.map(([k, v]) => `
    <div class="settings-row">
      <span class="settings-row__key">${escapeHtml(k)}</span>
      <span class="settings-row__val">${escapeHtml(v)}</span>
    </div>`).join('');
}

/* ================================================================== */
/* Game rendering (full-screen map)                                   */
/* ================================================================== */

function myPlayer(party) {
  return party.players.find((p) => p.id === state.playerId) || null;
}

function renderGame(party) {
  const me = myPlayer(party);
  const role = me ? me.role : 'unassigned';

  $('roleName').textContent = roleLabel(role).toUpperCase();
  let detail = '';
  if (role === 'hunter') {
    detail = party.settings.catchMethod === 'touch' ? 'Catch pairs by touch.' : 'Catch pairs by tagging.';
  } else if (role === 'runner') {
    detail = me && me.pair ? 'Runner pair ' + me.pair : 'Escape and survive.';
  } else {
    detail = 'No role assigned yet.';
  }
  $('roleDetail').textContent = detail;

  renderSettings($('game-settings'), party.settings);
  ensureGameMap(party);
  startGameTimer(party);
  renderChat(party);
  startLocationTracking();
  startPositionBroadcast();
  renderElimination(me);
  renderRunnerMarkers();
  updateCatchButton();
  updateAreaWarning();
}

function startGameTimer(party) {
  clearInterval(state.timerHandle);
  const tick = () => {
    if (!state.party || state.party.status !== 'active') return;
    const startedAt = party.startedAt || Date.now();
    const escapeMs = party.settings.escapeMin * 60 * 1000;
    const endMs = startedAt + party.settings.durationMin * 60 * 1000;
    const now = Date.now();
    const escapeEnds = startedAt + escapeMs;

    let phase, target, sub;
    if (now < escapeEnds) {
      phase = 'Escape';
      target = escapeEnds;
      sub = 'Head start for the runners.';
    } else if (now < endMs) {
      phase = 'Hunt';
      target = endMs;
      sub = 'The hunt is on.';
    } else {
      phase = 'Time is up';
      target = now;
      sub = 'The game has ended.';
    }
    $('phaseLabel').textContent = phase;
    $('timer').textContent = formatClock(Math.max(0, target - now));
    $('phaseSub').textContent = sub;
  };
  tick();
  state.timerHandle = setInterval(tick, 1000);
}

function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function ensureGameMap(party) {
  if (!window.L) return;
  const base = party.settings.base;
  const boundary = party.settings.area && party.settings.area.boundary;

  if (!state.gameMap) {
    const center = base ? [base.lat, base.lng] : DEFAULT_CENTER;
    const map = L.map('game-map', { zoomControl: false }).setView(center, 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.on('dragstart', () => { state.followUser = false; });
    state.gameBoundaryGroup = L.layerGroup().addTo(map);
    state.gameMap = map;
  }
  const map = state.gameMap;

  if (state.gameBaseMarker) { map.removeLayer(state.gameBaseMarker); state.gameBaseMarker = null; }
  if (state.gameAreaCircle) { map.removeLayer(state.gameAreaCircle); state.gameAreaCircle = null; }

  if (base) state.gameBaseMarker = L.marker([base.lat, base.lng]).addTo(map);

  if (boundary) {
    const bounds = drawBoundaryGroup(state.gameBoundaryGroup, boundary, { fillOpacity: 0.14 });
    if (!state.gameFitted) {
      if (bounds) map.fitBounds(bounds, { padding: [40, 40] });
      else if (base) map.setView([base.lat, base.lng], 14);
      state.gameFitted = true;
    }
  } else {
    state.gameBoundaryGroup.clearLayers();
    if (base) {
      state.gameAreaCircle = L.circle([base.lat, base.lng], {
        radius: party.settings.area.radiusM, color: '#5b9bff', weight: 1.5,
        fillColor: '#2f6fed', fillOpacity: 0.08,
      }).addTo(map);
      if (!state.gameFitted) { map.setView([base.lat, base.lng], 14); state.gameFitted = true; }
    }
  }
  setTimeout(() => map.invalidateSize(), 160);
}

/* ================================================================== */
/* Copy code                                                          */
/* ================================================================== */

async function copyText(t) {
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    toast('Code copied');
  } catch (_) {
    const input = document.createElement('input');
    input.value = t;
    document.body.appendChild(input);
    input.select();
    try { document.execCommand('copy'); toast('Code copied'); }
    catch (__) { toast(t); }
    input.remove();
  }
}

/* ================================================================== */
/* Leave                                                              */
/* ================================================================== */

function leaveParty() {
  socket.emit('party:leave', {}, () => {
    state.party = null;
    state.partyId = null;
    state.gameFitted = false;
    clearInterval(state.timerHandle);
    resetChat();
    stopLocationTracking();
    stopPositionBroadcast();
    clearUserLayer();
    clearRunnerMarkers();
    setSession(null);
    showView('dashboard');
  });
}

/* ================================================================== */
/* Hunter chat + game log                                            */
/* ================================================================== */

function normalizeRole(party, playerId) {
  const p = party && party.players ? party.players.find((x) => x.id === playerId) : null;
  return p ? p.role : null;
}

function amHunter() {
  return normalizeRole(state.party, state.playerId) === 'hunter';
}

/** Merge two chat histories by message id, oldest first. */
function mergeChat(a, b) {
  const byId = new Map();
  (a || []).concat(b || []).forEach((m) => {
    if (m && m.id) byId.set(m.id, m);
  });
  return [...byId.values()].sort((x, y) => (x.at || 0) - (y.at || 0)).slice(-80);
}

function resetChat() {
  state.chat = [];
  state.chatUnread = 0;
  closeChat();
}

function renderChat(party) {
  if (!party) return;
  state.chat = mergeChat(state.chat, party.chat || []);

  const hunter = amHunter();
  const input = $('chatInput');
  const send = $('chatSend');
  input.disabled = !hunter;
  send.disabled = !hunter;
  input.placeholder = hunter ? 'Message the hunters' : 'Only hunters can chat';
  $('chatRoleHint').textContent = hunter
    ? 'You can post here.'
    : 'Read-only — only hunters can post.';

  renderChatLog();
  renderChatBadge();
}

function renderChatLog() {
  const log = $('chat-log');
  if (!log) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;

  if (!state.chat.length) {
    log.innerHTML = '<li class="chat__empty">No messages yet.</li>';
    return;
  }
  log.innerHTML = state.chat.map((m) => {
    const time = new Date(m.at || Date.now())
      .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (m.kind === 'log') {
      return `<li class="chat__msg chat__msg--log">${escapeHtml(m.text)}`
        + `<span class="chat__time">${time}</span></li>`;
    }
    return '<li class="chat__msg chat__msg--chat">'
      + `<span class="chat__from">${escapeHtml(m.from || 'Hunter')}</span>`
      + `<span class="chat__text">${escapeHtml(m.text)}</span>`
      + `<span class="chat__time">${time}</span></li>`;
  }).join('');

  if (atBottom) log.scrollTop = log.scrollHeight;
}

function renderChatBadge() {
  const badge = $('chatUnread');
  if (!badge) return;
  if (state.chatUnread > 0) {
    badge.hidden = false;
    badge.textContent = state.chatUnread > 9 ? '9+' : String(state.chatUnread);
  } else {
    badge.hidden = true;
  }
}

function openChat() {
  state.chatOpen = true;
  state.chatUnread = 0;
  $('chat-panel').hidden = false;
  $('chatBtn').setAttribute('aria-expanded', 'true');
  renderChatBadge();
  renderChatLog();
  updateCatchButton();
  const log = $('chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

function closeChat() {
  state.chatOpen = false;
  const panel = $('chat-panel');
  if (panel) panel.hidden = true;
  const btn = $('chatBtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  updateCatchButton();
}

function toggleChat() {
  if (state.chatOpen) closeChat();
  else openChat();
}

function sendChat(event) {
  if (event) event.preventDefault();
  const input = $('chatInput');
  const body = input.value.trim();
  if (!body) return;
  if (!amHunter()) return toast('Only hunters can chat');
  socket.emit('chat:send', { text: body }, (res) => {
    if (res && res.ok) input.value = '';
    else toast((res && res.error) || 'Could not send message');
  });
}

function doCatch() {
  if (!amHunter() || !state.catchTargetId) return;
  const targetId = state.catchTargetId;
  socket.emit('player:catch', { targetId }, (res) => {
    if (res && !res.ok) toast(res.error || 'Could not catch them');
  });
}

/* ================================================================== */
/* Live location + heading (view cone)                               */
/* ================================================================== */

function startLocationTracking() {
  if (!navigator.geolocation || state.watchId != null) return;
  state.watchId = navigator.geolocation.watchPosition(
    onPosition,
    () => {},
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
  );
  bindOrientation();
}

function stopLocationTracking() {
  if (state.watchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(state.watchId);
  }
  state.watchId = null;
}

function onPosition(pos) {
  if (!pos || !pos.coords) return;
  state.userLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  if (Number.isFinite(pos.coords.heading)) state.gpsHeading = pos.coords.heading;
  updateUserLayer();
  updateAreaWarning();

  const map = state.gameMap;
  if (!map) return;
  const target = [state.userLatLng.lat, state.userLatLng.lng];
  if (!state.userCentered) {
    state.userCentered = true;
    map.setView(target, 16);
  } else if (state.followUser) {
    map.panTo(target);
  }
}

/** Big red banner while the player's live position is outside the play area. */
function updateAreaWarning() {
  const banner = $('areaWarning');
  const view = $('view-game');
  if (!banner) return;
  if (!state.userLatLng) {
    banner.hidden = true;
    if (view) view.classList.remove('is-out');
    return;
  }
  const inside = isPlayable(state.userLatLng.lat, state.userLatLng.lng);
  banner.hidden = inside;
  if (view) view.classList.toggle('is-out', !inside);
}

/** True when a point is inside the running game's play area. */
function isPlayable(lat, lng) {
  const s = state.party && state.party.settings;
  const boundary = (s && s.area && s.area.boundary) || null;
  if (boundary) return isPlayablePoint(lat, lng, boundary);
  const base = s && s.base;
  const radius = s && s.area && s.area.radiusM;
  if (base && radius) return distanceM({ lat, lng }, base) <= radius;
  return true;
}

function clearAreaWarning() {
  const banner = $('areaWarning');
  if (banner) banner.hidden = true;
  const view = $('view-game');
  if (view) view.classList.remove('is-out');
}

/** Listen for the phone's compass so the view cone follows rotation. */
function bindOrientation() {
  if (state.orientationBound) return;
  const handler = (e) => onDeviceOrientation(e);
  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', handler, true);
  }
  window.addEventListener('deviceorientation', handler, true);
  state.orientationBound = true;
}

function onDeviceOrientation(event) {
  let heading = null;
  const absolute = event.absolute === true;
  if (typeof event.webkitCompassHeading === 'number'
    && Number.isFinite(event.webkitCompassHeading)) {
    heading = event.webkitCompassHeading; // iOS compass heading
  } else if (typeof event.alpha === 'number' && Number.isFinite(event.alpha)) {
    // Prefer absolute orientation; ignore relative fallback once we have it.
    if (absolute) state.hasAbsoluteHeading = true;
    else if (state.hasAbsoluteHeading) return;
    heading = 360 - event.alpha; // alpha turns counter-clockwise from north
  }
  if (heading == null) return;
  state.compassHeading = ((heading % 360) + 360) % 360;

  // Compass events fire very often; throttle the redraw to ~12 fps.
  const now = Date.now();
  if (now - state.lastArrowUpdate < 80) return;
  state.lastArrowUpdate = now;
  updateUserLayer();
}

/** iOS 13+ needs a user gesture before orientation events are delivered. */
function requestCompass() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    DOE.requestPermission().then((res) => {
      if (res === 'granted') bindOrientation();
      else toast('Compass permission denied');
    }).catch(() => {});
  } else {
    bindOrientation();
  }
}

function currentHeading() {
  if (state.compassHeading != null) return state.compassHeading;
  if (state.gpsHeading != null) return state.gpsHeading;
  return 0;
}

/** Point at `distM` metres from (lat, lng) on the given bearing. */
function destinationPoint(lat, lng, bearingDeg, distM) {
  const R = 6371000;
  const d = distM / R;
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lng * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d)
    + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lon2 = lon1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
  );
  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

/** Build a closed wedge polygon for the field-of-view cone. */
function conePoints(lat, lng, headingDeg, radiusM, spreadDeg) {
  const start = headingDeg - spreadDeg / 2;
  const steps = 14;
  const points = [[lat, lng]];
  for (let i = 0; i <= steps; i += 1) {
    points.push(destinationPoint(lat, lng, start + (spreadDeg * i) / steps, radiusM));
  }
  points.push([lat, lng]);
  return points;
}

function updateUserLayer() {
  const map = state.gameMap;
  if (!map || !state.userLatLng) return;
  const { lat, lng } = state.userLatLng;

  if (!state.userMarker) {
    state.userMarker = L.circleMarker([lat, lng], {
      radius: 7, color: '#ffffff', weight: 2,
      fillColor: USER_LOCATION_COLOR, fillOpacity: 1,
    }).addTo(map);
  } else {
    state.userMarker.setLatLng([lat, lng]);
  }

  const points = conePoints(lat, lng, currentHeading(), USER_CONE_RADIUS_M, USER_CONE_SPREAD_DEG);
  if (!state.userCone) {
    state.userCone = L.polygon(points, {
      color: USER_LOCATION_COLOR, weight: 1, opacity: 0.9,
      fillColor: USER_LOCATION_COLOR, fillOpacity: 0.25, interactive: false,
    }).addTo(map);
  } else {
    state.userCone.setLatLngs(points);
  }

  updateRunnerArrows();
  updateCatchButton();
}

function clearUserLayer() {
  const map = state.gameMap;
  if (map) {
    if (state.userMarker) map.removeLayer(state.userMarker);
    if (state.userCone) map.removeLayer(state.userCone);
  }
  state.userMarker = null;
  state.userCone = null;
  state.userLatLng = null;
  state.userCentered = false;
  clearAreaWarning();
}

function locateMe() {
  requestCompass();
  startLocationTracking();
  if (state.userLatLng && state.gameMap) {
    state.followUser = true;
    state.gameMap.setView([state.userLatLng.lat, state.userLatLng.lng], 16);
  } else {
    toast('Waiting for your location…');
  }
}

/* ================================================================== */
/* Runner tracking (hunters): markers, distance + direction arrows    */
/* ================================================================== */

function startPositionBroadcast() {
  if (state.positionTimer) return;
  const send = () => {
    if (!state.userLatLng) return;
    socket.emit('player:position', {
      position: { lat: state.userLatLng.lat, lng: state.userLatLng.lng },
      heading: currentHeading(),
    });
  };
  send();
  state.positionTimer = setInterval(send, 3000);
}

function stopPositionBroadcast() {
  clearInterval(state.positionTimer);
  state.positionTimer = null;
}

/** Great-circle distance in metres between two {lat,lng} points. */
function distanceM(a, b) {
  if (!a || !b) return null;
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing (degrees from north) from point a to point b. */
function bearingDeg(a, b) {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Tidy distance label, rounded to hide GPS jitter. */
function formatDistance(m) {
  if (m == null) return '? m';
  if (m >= 1000) return (m / 1000).toFixed(1) + ' km';
  if (m >= 100) return '~' + (Math.round(m / 10) * 10) + ' m';
  return '~' + (Math.round(m / 5) * 5) + ' m';
}

function renderRunnerMarkers() {
  const map = state.gameMap;
  if (!map) return;

  const active = Object.keys(state.runnerPositions);

  // Drop markers for runners that vanished or were caught.
  Object.keys(state.runnerMarkers).forEach((id) => {
    const pos = state.runnerPositions[id];
    if (!pos || pos.caught) {
      map.removeLayer(state.runnerMarkers[id].marker);
      delete state.runnerMarkers[id];
    }
  });

  active.forEach((id) => {
    const pos = state.runnerPositions[id];
    if (!pos || pos.caught) return;
    if (!state.runnerMarkers[id]) {
      const icon = L.divIcon({
        className: 'runner-pin-wrap',
        html: '<div class="runner-pin">'
          + '<div class="runner-pin__arrow"></div>'
          + '<div class="runner-pin__body">'
          + '<span class="runner-pin__dot"></span>'
          + '<span class="runner-pin__name"></span>'
          + '<span class="runner-pin__dist"></span>'
          + '</div></div>',
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });
      const marker = L.marker([pos.lat, pos.lng], { icon, interactive: false, zIndexOffset: 500 })
        .addTo(map);
      const el = marker.getElement();
      state.runnerMarkers[id] = {
        marker,
        arrow: el ? el.querySelector('.runner-pin__arrow') : null,
        name: el ? el.querySelector('.runner-pin__name') : null,
        dist: el ? el.querySelector('.runner-pin__dist') : null,
      };
    }
    state.runnerMarkers[id].marker.setLatLng([pos.lat, pos.lng]);
  });

  updateRunnerArrows();
}

function updateRunnerArrows() {
  const me = state.userLatLng;
  const heading = currentHeading();
  Object.keys(state.runnerMarkers).forEach((id) => {
    const pos = state.runnerPositions[id];
    const view = state.runnerMarkers[id];
    if (!pos || !view) return;

    const player = playerById(id);
    if (view.name) view.name.textContent = (player ? player.name : 'Runner') + ' ';

    if (me) {
      const dist = distanceM(me, { lat: pos.lat, lng: pos.lng });
      if (view.dist) view.dist.textContent = formatDistance(dist);
      const rel = bearingDeg(me, { lat: pos.lat, lng: pos.lng }) - heading;
      if (view.arrow) {
        view.arrow.style.transform = 'rotate(' + Math.round(rel) + 'deg)';
        view.arrow.style.display = '';
      }
    } else if (view.dist) {
      view.dist.textContent = '? m';
    }
  });
}

function clearRunnerMarkers() {
  const map = state.gameMap;
  if (map) {
    Object.keys(state.runnerMarkers).forEach((id) => {
      map.removeLayer(state.runnerMarkers[id].marker);
    });
  }
  state.runnerMarkers = {};
  state.runnerPositions = {};
  state.catchTargetId = null;
  const btn = $('catchRunnerBtn');
  if (btn) btn.hidden = true;
}

function playerById(id) {
  if (!state.party || !state.party.players) return null;
  return state.party.players.find((p) => p.id === id) || null;
}

/** Show the Catch button when a live runner is within reach. */
function updateCatchButton() {
  const btn = $('catchRunnerBtn');
  if (!btn) return;

  let best = null;
  if (amHunter() && state.userLatLng) {
    Object.keys(state.runnerPositions).forEach((id) => {
      const pos = state.runnerPositions[id];
      if (!pos || pos.caught) return;
      const dist = distanceM(state.userLatLng, { lat: pos.lat, lng: pos.lng });
      if (dist != null && dist <= CATCH_RADIUS_M && (!best || dist < best.dist)) {
        best = { id, dist };
      }
    });
  }

  if (best && !state.chatOpen) {
    state.catchTargetId = best.id;
    const player = playerById(best.id);
    btn.textContent = 'Catch ' + (player ? player.name : 'runner');
    btn.hidden = false;
  } else {
    state.catchTargetId = null;
    btn.hidden = true;
  }
}

function renderElimination(me) {
  const caught = Boolean(me && me.caught);
  const overlay = $('eliminated');
  const banner = $('elimBanner');
  if (!overlay || !banner) return;

  banner.hidden = !caught;
  if (!caught) {
    overlay.hidden = true;
    state.selfCaught = false;
    return;
  }
  if (state.selfCaught) return; // already acknowledged; keep the banner only
  state.selfCaught = true;
  $('eliminatedBy').textContent = me.caughtBy
    ? 'Caught by ' + me.caughtBy + '.'
    : 'You were caught.';
  overlay.hidden = false;
  updateCatchButton();
  renderRunnerMarkers();
}

function dismissEliminated() {
  $('eliminated').hidden = true;
  const base = state.party && state.party.settings && state.party.settings.base;
  if (base && state.gameMap) {
    state.followUser = false;
    state.gameMap.setView([base.lat, base.lng], 16);
  }
}

/* ================================================================== */
/* Event wiring                                                       */
/* ================================================================== */

function wire() {
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => showView(el.dataset.nav));
  });
  document.querySelectorAll('[data-back]').forEach((el) => {
    el.addEventListener('click', () => showView(el.dataset.back));
  });
  document.querySelectorAll('[data-close-modal]').forEach((el) => {
    el.addEventListener('click', closeTemplateModal);
  });
  document.querySelectorAll('[data-close-rules]').forEach((el) => {
    el.addEventListener('click', closeRules);
  });
  document.querySelectorAll('[data-copy]').forEach((el) => {
    el.addEventListener('click', () => {
      if (!state.party) return;
      copyText(el.dataset.copy === 'seeker' ? state.party.seekerCode : state.party.playerCode);
    });
  });

  $('chooseTemplate').addEventListener('click', openTemplateModal);
  $('rulesBtn').addEventListener('click', openRules);
  $('create-form').addEventListener('submit', submitCreate);
  $('join-form').addEventListener('submit', submitJoin);

  $('joinCode').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
  });

  $('areaRadius').addEventListener('input', (e) => {
    $('radiusOut').textContent = e.target.value;
    updateRadiusCircle();
  });

  $('clearBase').addEventListener('click', clearBase);

  $('locateBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Location is not available');
    navigator.geolocation.getCurrentPosition(
      (pos) => setBase(pos.coords.latitude, pos.coords.longitude),
      () => toast('Could not get your location')
    );
  });

  $('startBtn').addEventListener('click', () => {
    socket.emit('party:start', {}, (res) => {
      if (res && !res.ok) toast(res.error || 'Could not start the game.');
    });
  });
  $('leaveBtn').addEventListener('click', leaveParty);

  // In-game HUD: chat, live location and catching.
  $('chatBtn').addEventListener('click', toggleChat);
  $('chatClose').addEventListener('click', closeChat);
  $('chat-form').addEventListener('submit', sendChat);
  $('locateMeBtn').addEventListener('click', locateMe);
  $('catchRunnerBtn').addEventListener('click', doCatch);
  $('eliminatedClose').addEventListener('click', dismissEliminated);
}

/* ================================================================== */
/* Boot                                                               */
/* ================================================================== */

function boot() {
  state.playerId = getPlayerId();
  wire();
  loadTemplates();

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => {
    if (state.view === 'loading') showView('dashboard');
  }, reduced ? 400 : 2400);
}

document.addEventListener('DOMContentLoaded', boot);
