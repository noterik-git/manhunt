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
  base: null,            // { lat, lng }
  createMap: null,
  baseMarker: null,
  areaCircle: null,
  gameMap: null,
  gameBaseMarker: null,
  gameAreaCircle: null,
  timerHandle: null,
};

const MOVEMENT_LABELS = {
  walk: 'Walk',
  publicTransport: 'Public transport',
  bike: 'Bike',
  esScooter: 'E-scooter',
};

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

  if (name === 'create') {
    ensureCreateMap();
  }
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

function openTemplateModal() {
  $('template-modal').hidden = false;
}

function closeTemplateModal() {
  $('template-modal').hidden = true;
}

function renderTemplates() {
  const list = $('template-list');
  list.innerHTML = '';
  if (!state.templates.length) {
    list.innerHTML = '<p class="muted small">No templates available.</p>';
    return;
  }
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
  updateRadiusCircle();
}

/* ================================================================== */
/* Create map                                                         */
/* ================================================================== */

const DEFAULT_CENTER = [47.4979, 19.0402]; // Budapest city centre (host adjusts)

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
  setTimeout(() => map.invalidateSize(), 150);
}

function setBase(lat, lng, source) {
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
  if (!state.createMap || !state.base) {
    if (state.areaCircle && state.createMap) {
      state.createMap.removeLayer(state.areaCircle);
      state.areaCircle = null;
    }
    return;
  }
  const radius = Number($('areaRadius').value);
  if (!state.areaCircle) {
    state.areaCircle = L.circle([state.base.lat, state.base.lng], {
      radius, color: '#e03131', weight: 1.5, fillColor: '#e03131', fillOpacity: 0.08,
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
      name: 'Custom area',
      radiusM: Number($('areaRadius').value) || 2000,
      center: state.base ? { lat: state.base.lat, lng: state.base.lng } : null,
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
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'role-btn';
      btn.dataset.role = p.role;
      btn.textContent = roleLabel(p.role);
      btn.addEventListener('click', () => cycleRole(p.id, p.role));
      li.appendChild(btn);
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
    ['Base location', s.base ? s.base.lat.toFixed(4) + ', ' + s.base.lng.toFixed(4) : 'Not set'],
    ['Area', s.area.name || '—'],
  ];
  container.innerHTML = rows.map(([k, v]) => `
    <div class="settings-row">
      <span class="settings-row__key">${escapeHtml(k)}</span>
      <span class="settings-row__val">${escapeHtml(v)}</span>
    </div>`).join('');
}

/* ================================================================== */
/* Game rendering                                                     */
/* ================================================================== */

function myPlayer(party) {
  return party.players.find((p) => p.id === state.playerId) || null;
}

function renderGame(party) {
  const me = myPlayer(party);
  const role = me ? me.role : 'unassigned';
  const card = $('role-card');
  card.dataset.role = role;

  let name = roleLabel(role).toUpperCase();
  let detail = '';
  if (role === 'hunter') {
    detail = 'Catch runner pairs by ' + (party.settings.catchMethod === 'touch' ? 'physical touch.' : 'tagging them.');
  } else if (role === 'runner') {
    name = 'RUNNER';
    detail = me && me.pair ? 'You escape as part of runner pair ' + me.pair + '.' : 'Escape and survive.';
  } else {
    detail = 'The host has not assigned you a role yet.';
  }
  $('roleName').textContent = name;
  $('roleDetail').textContent = detail;

  renderSettings($('game-settings'), party.settings);
  ensureGameMap(party);
  startGameTimer(party);
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

    let phase, target;
    if (now < escapeEnds) {
      phase = 'Escape phase';
      target = escapeEnds;
      $('phaseSub').textContent = 'Head start for the runners.';
    } else if (now < endMs) {
      phase = 'Hunt phase';
      target = endMs;
      $('phaseSub').textContent = 'The hunt is on.';
    } else {
      phase = 'Time is up';
      target = now;
      $('phaseSub').textContent = 'The game has ended.';
    }
    $('phaseLabel').textContent = phase;
    $('timer').textContent = formatClock(Math.max(0, target - now));
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
  if (!state.gameMap) {
    const center = base ? [base.lat, base.lng] : DEFAULT_CENTER;
    const map = L.map('game-map', { zoomControl: false }).setView(center, base ? 14 : 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    state.gameMap = map;
  }
  const map = state.gameMap;
  if (state.gameBaseMarker) { map.removeLayer(state.gameBaseMarker); state.gameBaseMarker = null; }
  if (state.gameAreaCircle) { map.removeLayer(state.gameAreaCircle); state.gameAreaCircle = null; }
  if (base) {
    state.gameBaseMarker = L.marker([base.lat, base.lng]).addTo(map);
    state.gameAreaCircle = L.circle([base.lat, base.lng], {
      radius: party.settings.area.radiusM, color: '#e03131', weight: 1.5,
      fillColor: '#e03131', fillOpacity: 0.08,
    }).addTo(map);
    map.setView([base.lat, base.lng], 14);
  }
  setTimeout(() => map.invalidateSize(), 160);
}

/* ================================================================== */
/* Copy code                                                          */
/* ================================================================== */

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Code copied');
  } catch (_) {
    const input = document.createElement('input');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    try { document.execCommand('copy'); toast('Code copied'); }
    catch (__) { toast(text); }
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
    clearInterval(state.timerHandle);
    setSession(null);
    showView('dashboard');
  });
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
  document.querySelectorAll('[data-copy]').forEach((el) => {
    el.addEventListener('click', () => {
      if (!state.party) return;
      copyText(el.dataset.copy === 'seeker' ? state.party.seekerCode : state.party.playerCode);
    });
  });

  $('chooseTemplate').addEventListener('click', openTemplateModal);
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
  $('gameLeave').addEventListener('click', leaveParty);
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
