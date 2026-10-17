'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const templates = require('./data/templates.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Active parties live only in memory. They are lost when the server restarts,
 * which is acceptable for this first version. Keyed by internal party id.
 * @type {Map<string, Party>}
 */
const parties = new Map();

app.get('/api/templates', (_req, res) => res.json(templates));
app.get('/api/health', (_req, res) => res.json({ ok: true, parties: parties.size }));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function codeInUse(code) {
  for (const party of parties.values()) {
    if (party.playerCode === code || party.seekerCode === code) return true;
  }
  return false;
}

/** 4-digit numeric code (1000-9999), unique across active parties. */
function makeNumericCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (codeInUse(code));
  return code;
}

function makePartyCodes() {
  const playerCode = makeNumericCode();
  let seekerCode = makeNumericCode();
  while (seekerCode === playerCode) seekerCode = makeNumericCode();
  return { playerCode, seekerCode };
}

function findByCode(code) {
  for (const party of parties.values()) {
    if (party.playerCode === code || party.seekerCode === code) return party;
  }
  return null;
}

function cleanName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 18);
}

function cleanGameName(value) {
  const name = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 32);
  return name || 'Manhunt';
}

function num(value, def, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function latLng(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** Accepts both {lat,lng} and [lat,lng] shapes. */
function toLatLng(value) {
  if (Array.isArray(value) && value.length >= 2) {
    return latLng({ lat: value[0], lng: value[1] });
  }
  return latLng(value);
}

function text(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

function toPoints(value) {
  if (!Array.isArray(value)) return [];
  return value.map(toLatLng).filter(Boolean);
}

function normalizeBoundary(input) {
  if (!input || typeof input !== 'object') return null;
  const areas = Array.isArray(input.areas)
    ? input.areas.map((a) => ({
      name: text(a && a.name, 60),
      vertices: toPoints(a && a.vertices),
    })).filter((a) => a.vertices.length >= 3)
    : [];
  const edges = Array.isArray(input.edges)
    ? input.edges.map((e) => ({
      name: text(e && e.name, 60),
      path: toPoints(e && e.path),
    })).filter((e) => e.path.length >= 2)
    : [];
  const permittedRoutes = Array.isArray(input.permittedRoutes)
    ? input.permittedRoutes.map((r) => ({
      name: text(r && r.name, 60),
      path: toPoints(r && r.path),
    })).filter((r) => r.path.length >= 2)
    : [];
  if (!areas.length && !edges.length && !permittedRoutes.length) return null;
  return { note: text(input.note, 240), areas, edges, permittedRoutes };
}

const ALLOWED_HUNTER_MOVES = ['walk', 'publicTransport', 'bike', 'esScooter'];
const ALLOWED_RUNNER_MOVES = ['walk', 'publicTransport'];

function pickMoves(list, allowed, fallback) {
  if (!Array.isArray(list)) return fallback.slice();
  const filtered = list.filter((m) => allowed.includes(m));
  return filtered.length ? filtered : fallback.slice();
}

function normalizeSettings(input = {}) {
  const s = input && typeof input === 'object' ? input : {};
  const area = s.area && typeof s.area === 'object' ? s.area : {};
  const movement = s.movement && typeof s.movement === 'object' ? s.movement : {};
  const missions = s.missions && typeof s.missions === 'object' ? s.missions : {};
  const boundary = s.boundary && typeof s.boundary === 'object' ? s.boundary : {};

  return {
    durationMin: num(s.durationMin, 120, 10, 720),
    hunterCount: num(s.hunterCount, 3, 1, 20),
    escapeMin: num(s.escapeMin, 15, 0, 180),
    area: {
      name: String(area.name || '').slice(0, 80),
      radiusM: num(area.radiusM, 2000, 200, 20000),
      center: latLng(area.center),
      boundary: normalizeBoundary(area.boundary),
    },
    base: latLng(s.base),
    runnerPairs: s.runnerPairs !== false,
    movement: {
      hunters: pickMoves(movement.hunters, ALLOWED_HUNTER_MOVES, ALLOWED_HUNTER_MOVES),
      runners: pickMoves(movement.runners, ALLOWED_RUNNER_MOVES, ALLOWED_RUNNER_MOVES),
    },
    catchMethod: s.catchMethod === 'tag' ? 'tag' : 'touch',
    boundary: {
      warningEnabled: boundary.warningEnabled !== false,
      returnMin: num(boundary.returnMin, 10, 1, 60),
    },
    missions: {
      enabled: !!missions.enabled,
      pointsEnabled: !!missions.pointsEnabled,
      eliminationEnabled: !!missions.eliminationEnabled,
      returnMissionEnabled: !!missions.returnMissionEnabled,
      notes: String(missions.notes || '').slice(0, 240),
    },
  };
}

/** Recompute anonymous numbered runner pairs from join order. */
function recomputePairs(party) {
  let pair = 0;
  let inPair = 0;
  for (const player of party.players.values()) {
    if (player.role === 'runner') {
      if (inPair === 0) pair += 1;
      player.pair = pair;
      inPair = (inPair + 1) % 2;
    } else {
      player.pair = null;
    }
  }
}

function countRoles(party) {
  const out = { hunter: 0, runner: 0, unassigned: 0 };
  for (const player of party.players.values()) {
    if (player.role === 'hunter') out.hunter += 1;
    else if (player.role === 'runner') out.runner += 1;
    else out.unassigned += 1;
  }
  return out;
}

function sanitize(party) {
  return {
    id: party.id,
    name: party.name,
    hostId: party.hostId,
    status: party.status,
    templateId: party.templateId,
    playerCode: party.playerCode,
    seekerCode: party.seekerCode,
    settings: party.settings,
    counts: countRoles(party),
    createdAt: party.createdAt,
    startedAt: party.startedAt,
    // Server-authoritative schedule. Clients derive every countdown from
    // these timestamps plus `serverTime`, never from their own clock alone.
    huntStartsAt: party.huntStartsAt || null,
    huntEndsAt: party.huntEndsAt || null,
    winner: party.winner || null,
    endedAt: party.endedAt || null,
    serverTime: Date.now(),
    chat: (party.chat || []).slice(-60),
    players: [...party.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      pair: p.pair,
      connected: p.connected,
      caught: !!p.caught,
      caughtBy: p.caughtBy || null,
    })),
  };
}

function broadcast(party) {
  io.to(party.id).emit('party:update', sanitize(party));
}

/** Append a message to the party's rolling chat/log history. */
function pushChat(party, message) {
  if (!Array.isArray(party.chat)) party.chat = [];
  party.chat.push(message);
  if (party.chat.length > 60) party.chat.splice(0, party.chat.length - 60);
  return message;
}

// How close a hunter must be to a runner to be allowed to catch them.
// A little tolerance is added on top because GPS jitters and positions are
// only refreshed every few seconds.
const CATCH_RADIUS_M = 15;
const CATCH_TOLERANCE_M = 10;

/** Great-circle distance in metres between two {lat,lng} points, or null. */
function geoDistance(a, b) {
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

/* ------------------------------------------------------------------ */
/* Runner tracking, location reveals and win conditions                */
/* ------------------------------------------------------------------ */

// Hunters are handed exact runner coordinates only on this interval. The
// default is 10 minutes; the environment override exists so the cadence can be
// tuned (or shortened in tests) without touching the game rules.
const REVEAL_INTERVAL_MS = Math.max(
  200,
  Number(process.env.MANHUNT_REVEAL_MS) || 10 * 60 * 1000,
);

/**
 * Active (not yet eliminated) runner pairs, keyed by pair number.
 * A pair is eliminated as soon as any of its members is caught.
 */
function activePairs(party) {
  const pairs = new Map();
  for (const p of party.players.values()) {
    if (p.role !== 'runner' || !p.pair) continue;
    if (!pairs.has(p.pair)) pairs.set(p.pair, []);
    pairs.get(p.pair).push(p);
  }
  for (const [pair, members] of [...pairs]) {
    if (members.some((m) => m.caught)) pairs.delete(pair);
  }
  return pairs;
}

/** Distance in metres from a point to the closest member of a pair, or null. */
function pairDistance(members, from) {
  let best = null;
  for (const m of members) {
    const d = geoDistance(from, m.pos);
    if (d != null && (best == null || d < best)) best = d;
  }
  return best;
}

/**
 * Sends each hunter the *distance* to every active runner pair — never a
 * coordinate. Distances are rounded so they cannot be triangulated into an
 * exact position between reveals.
 */
function sendPairDistances(party) {
  if (!party || party.status !== 'active') return;
  const pairs = activePairs(party);
  for (const hunter of party.players.values()) {
    if (hunter.role !== 'hunter' || !hunter.connected || !hunter.socketId) continue;
    const list = [];
    for (const [pair, members] of pairs) {
      const d = pairDistance(members, hunter.pos);
      if (d == null) continue;
      list.push({
        pair,
        distance: Math.round(d / 10) * 10,
        canCatch: d <= CATCH_RADIUS_M + CATCH_TOLERANCE_M,
      });
    }
    list.sort((a, b) => a.distance - b.distance);
    io.to(hunter.socketId).emit('runner:distances', { at: Date.now(), pairs: list });
  }
}

/** One coordinate per active pair: the centre of its members' positions. */
function revealPositions(party) {
  if (!party || party.status !== 'active') return;
  const pins = [];
  for (const [pair, members] of activePairs(party)) {
    const withPos = members.filter((m) => m.pos);
    if (!withPos.length) continue;
    pins.push({
      pair,
      lat: withPos.reduce((s, m) => s + m.pos.lat, 0) / withPos.length,
      lng: withPos.reduce((s, m) => s + m.pos.lng, 0) / withPos.length,
    });
  }
  party.revealed = pins;
  party.revealedAt = Date.now();
  party.nextRevealAt = party.revealedAt + REVEAL_INTERVAL_MS;
  sendReveal(party);
}

/** Sends the latest reveal to every hunter, or to a single reconnecting one. */
function sendReveal(party, socket) {
  const payload = {
    at: party.revealedAt || null,
    nextAt: party.nextRevealAt || null,
    pins: party.revealed || [],
  };
  if (socket) {
    io.to(socket.id).emit('party:reveal', payload);
    return;
  }
  for (const p of party.players.values()) {
    if (p.role === 'hunter' && p.connected && p.socketId) {
      io.to(p.socketId).emit('party:reveal', payload);
    }
  }
}

/** Clears the reveal and full-time timers for a party. */
function clearPartyTimers(party) {
  if (!party) return;
  if (party.revealKick) clearTimeout(party.revealKick);
  if (party.revealTimer) clearInterval(party.revealTimer);
  if (party.endTimer) clearTimeout(party.endTimer);
  party.revealKick = null;
  party.revealTimer = null;
  party.endTimer = null;
}

/**
 * Server-authoritative schedule: reveals every 10 minutes once the head start
 * is over, and full time when the game timer runs out.
 */
function scheduleParty(party) {
  clearPartyTimers(party);
  party.endTimer = setTimeout(() => {
    if (party.status !== 'active') return;
    endGame(party, activePairs(party).size ? 'runners' : 'hunters');
  }, Math.max(0, party.huntEndsAt - Date.now()));
  party.endTimer.unref?.();

  const firstRevealIn = Math.max(0, party.huntStartsAt + REVEAL_INTERVAL_MS - Date.now());
  party.revealKick = setTimeout(() => {
    if (party.status !== 'active') return;
    revealPositions(party);
    party.revealTimer = setInterval(() => {
      if (party.status !== 'active') return clearPartyTimers(party);
      revealPositions(party);
    }, REVEAL_INTERVAL_MS);
    party.revealTimer.unref?.();
  }, firstRevealIn);
  party.revealKick.unref?.();
}

/**
 * Ends the game server-side, decides the winner and stops every timer so no
 * further location updates are broadcast.
 */
function endGame(party, winner) {
  if (!party || party.status !== 'active') return;
  party.status = 'ended';
  party.winner = winner;
  party.endedAt = Date.now();
  clearPartyTimers(party);
  io.to(party.id).emit('party:ended', { winner, at: party.endedAt });
  broadcast(party);
}

/**
 * Starts the server-authoritative clock. The head start runs first and the
 * main game timer only begins once it is over.
 */
function beginGame(party) {
  party.status = 'active';
  party.startedAt = Date.now();
  party.huntStartsAt = party.startedAt + party.settings.escapeMin * 60 * 1000;
  party.huntEndsAt = party.huntStartsAt + party.settings.durationMin * 60 * 1000;
  party.winner = null;
  party.endedAt = null;
  party.revealed = [];
  party.revealedAt = null;
  party.nextRevealAt = party.huntStartsAt + REVEAL_INTERVAL_MS;
  for (const p of party.players.values()) {
    p.caught = false;
    p.caughtBy = null;
    p.pos = null;
  }
  scheduleParty(party);
}

/** Marks a whole runner pair as caught and stops tracking its members. */
function eliminatePair(members, hunterName) {
  const now = Date.now();
  for (const m of members) {
    m.caught = true;
    m.caughtAt = now;
    m.caughtBy = hunterName;
    m.pos = null;
  }
}

function getPartyForSocket(socket) {
  const id = socket.data.partyId;
  if (!id) return null;
  return parties.get(id) || null;
}

function isHost(party, socket) {
  return Boolean(party && socket.data.playerId && party.hostId === socket.data.playerId);
}

function ack(cb) {
  return typeof cb === 'function' ? cb : () => {};
}

/* ------------------------------------------------------------------ */
/* Socket.IO                                                           */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {
  socket.data.playerId = null;
  socket.data.partyId = null;

  socket.on('party:create', (payload = {}, done) => {
    const cb = ack(done);
    const playerId = String(payload.playerId || '').slice(0, 64);
    const hostName = cleanName(payload.playerName) || 'Host';
    if (!playerId) return cb({ ok: false, error: 'Missing player id.' });

    const { playerCode, seekerCode } = makePartyCodes();

    // A template can supply a boundary (street/river geometry) when the host
    // did not provide one of their own.
    const settingsInput = JSON.parse(JSON.stringify(payload.settings || {}));
    if (payload.templateId) {
      const tpl = templates.find((t) => t.id === payload.templateId);
      const tplArea = tpl && tpl.settings && tpl.settings.area;
      if (tplArea) {
        settingsInput.area = settingsInput.area || {};
        if (!settingsInput.area.boundary) settingsInput.area.boundary = tplArea.boundary;
        if (!settingsInput.area.name) settingsInput.area.name = tplArea.name;
      }
    }

    const party = {
      id: crypto.randomUUID(),
      playerCode,
      seekerCode,
      name: cleanGameName(payload.gameName),
      hostId: playerId,
      templateId: payload.templateId || null,
      status: 'lobby',
      settings: normalizeSettings(settingsInput),
      createdAt: Date.now(),
      startedAt: null,
      huntStartsAt: null,
      huntEndsAt: null,
      winner: null,
      endedAt: null,
      revealed: [],
      revealedAt: null,
      nextRevealAt: null,
      revealKick: null,
      revealTimer: null,
      endTimer: null,
      chat: [],
      players: new Map(),
    };
    party.players.set(playerId, {
      id: playerId,
      name: hostName,
      role: 'hunter',
      pair: null,
      connected: true,
      socketId: socket.id,
      joinedAt: Date.now(),
    });
    parties.set(party.id, party);

    socket.data.playerId = playerId;
    socket.data.partyId = party.id;
    socket.join(party.id);

    cb({ ok: true, id: party.id, state: sanitize(party) });
    broadcast(party);
  });

  socket.on('party:join', (payload = {}, done) => {
    const cb = ack(done);
    const code = String(payload.code || '').trim();
    const playerId = String(payload.playerId || '').slice(0, 64);
    const name = cleanName(payload.name);
    if (!playerId) return cb({ ok: false, error: 'Missing player id.' });

    const party = findByCode(code);
    if (!party) return cb({ ok: false, error: 'Invalid party code.' });
    if (party.status !== 'lobby') return cb({ ok: false, error: 'This game has already started.' });
    if (!name) return cb({ ok: false, error: 'Enter a display name.' });

    // The code used decides the starting role: players join as runners,
    // seekers (hunters) use the smaller code.
    const joinRole = code === party.seekerCode ? 'hunter' : 'runner';

    const existing = party.players.get(playerId);
    if (!existing && party.players.size >= 40) {
      return cb({ ok: false, error: 'This lobby is full.' });
    }
    if (existing) {
      existing.name = name;
      existing.connected = true;
      existing.socketId = socket.id;
    } else {
      party.players.set(playerId, {
        id: playerId,
        name,
        role: joinRole,
        pair: null,
        connected: true,
        socketId: socket.id,
        joinedAt: Date.now(),
      });
    }
    recomputePairs(party);

    socket.data.playerId = playerId;
    socket.data.partyId = party.id;
    socket.join(party.id);

    cb({ ok: true, id: party.id, state: sanitize(party) });
    broadcast(party);
    sendPairDistances(party);
    if (joinRole === 'hunter') sendReveal(party, socket);
  });

  socket.on('party:reconnect', (payload = {}, done) => {
    const cb = ack(done);
    const id = String(payload.partyId || '');
    const playerId = String(payload.playerId || '').slice(0, 64);
    const party = parties.get(id);
    if (!party) return cb({ ok: false, error: 'Party no longer exists.' });
    const player = party.players.get(playerId);
    if (!player) return cb({ ok: false, error: 'You are not part of this party.' });

    player.connected = true;
    player.socketId = socket.id;
    socket.data.playerId = playerId;
    socket.data.partyId = party.id;
    socket.join(party.id);

    cb({ ok: true, id: party.id, state: sanitize(party) });
    broadcast(party);
    sendPairDistances(party);
    if (player.role === 'hunter') sendReveal(party, socket);
  });

  socket.on('party:settings', (payload = {}, done) => {
    const cb = ack(done);
    const party = getPartyForSocket(socket);
    if (!party) return cb({ ok: false, error: 'Not in a party.' });
    if (!isHost(party, socket)) return cb({ ok: false, error: 'Only the host can change settings.' });
    party.settings = normalizeSettings(payload.settings);
    if (payload.gameName !== undefined) party.name = cleanGameName(payload.gameName);
    cb({ ok: true, state: sanitize(party) });
    broadcast(party);
  });

  socket.on('party:assign', (payload = {}, done) => {
    const cb = ack(done);
    const party = getPartyForSocket(socket);
    if (!party) return cb({ ok: false, error: 'Not in a party.' });
    if (!isHost(party, socket)) return cb({ ok: false, error: 'Only the host can assign roles.' });

    const target = party.players.get(String(payload.targetId || ''));
    const role = payload.role;
    if (!target) return cb({ ok: false, error: 'Player not found.' });
    if (!['unassigned', 'hunter', 'runner'].includes(role)) {
      return cb({ ok: false, error: 'Invalid role.' });
    }
    target.role = role;
    target.caught = false;
    target.caughtBy = null;
    recomputePairs(party);
    cb({ ok: true, state: sanitize(party) });
    broadcast(party);
    sendPairDistances(party);
  });

  socket.on('party:start', (_payload, done) => {
    const cb = ack(done);
    const party = getPartyForSocket(socket);
    if (!party) return cb({ ok: false, error: 'Not in a party.' });
    if (!isHost(party, socket)) return cb({ ok: false, error: 'Only the host can start the game.' });
    if (party.status !== 'lobby') return cb({ ok: false, error: 'The game already started.' });

    const counts = countRoles(party);
    if (counts.hunter < 1) return cb({ ok: false, error: 'Assign at least one hunter.' });
    if (counts.runner < 1) return cb({ ok: false, error: 'Assign at least one runner.' });

    beginGame(party);
    cb({ ok: true, state: sanitize(party) });
    io.to(party.id).emit('party:started', sanitize(party));
    broadcast(party);
    sendPairDistances(party);
    sendReveal(party);
  });

  socket.on('party:kick', (payload = {}, done) => {
    const cb = ack(done);
    const party = getPartyForSocket(socket);
    if (!party) return cb({ ok: false, error: 'Not in a party.' });
    if (!isHost(party, socket)) return cb({ ok: false, error: 'Only the host can kick players.' });
    if (party.status !== 'lobby') return cb({ ok: false, error: 'Players can only be kicked in the lobby.' });

    const targetId = String(payload.targetId || '');
    if (targetId === party.hostId) return cb({ ok: false, error: 'You cannot kick yourself.' });
    const target = party.players.get(targetId);
    if (!target) return cb({ ok: false, error: 'Player not found.' });

    if (target.socketId) {
      const kickedSocket = io.sockets.sockets.get(target.socketId);
      if (kickedSocket) {
        kickedSocket.leave(party.id);
        kickedSocket.data.partyId = null;
        kickedSocket.emit('party:kicked', { code: party.code });
      }
    }
    removePlayer(party, targetId);
    cb({ ok: true });
  });

  socket.on('party:leave', (_payload, done) => {
    const cb = ack(done);
    const party = getPartyForSocket(socket);
    if (party) {
      removePlayer(party, socket.data.playerId);
      socket.leave(party.id);
    }
    socket.data.partyId = null;
    cb({ ok: true });
  });

  // Hunters-only chat. Messages and game logs are broadcast to the whole
  // party so runners can follow what is happening.
  socket.on('chat:send', (payload = {}, done) => {
    const cb = ack(done);
    const party = getPartyForSocket(socket);
    if (!party) return cb({ ok: false, error: 'Not in a party.' });
    const player = party.players.get(socket.data.playerId);
    if (!player || player.role !== 'hunter') {
      return cb({ ok: false, error: 'Only hunters can chat.' });
    }
    const body = text(payload.text, 240).trim();
    if (!body) return cb({ ok: false, error: 'Type a message first.' });

    const message = pushChat(party, {
      id: crypto.randomUUID(),
      kind: 'chat',
      fromId: player.id,
      from: player.name,
      role: 'hunter',
      text: body,
      at: Date.now(),
    });
    io.to(party.id).emit('chat:message', message);
    cb({ ok: true });
  });

  // A hunter physically catches a runner pair. Only allowed when the hunter is
  // close to one of the pair's members according to the last known positions.
  // Catching a pair eliminates it: both members stop being tracked.
  socket.on('player:catch', (payload = {}, done) => {
    const cb = ack(done);
    const party = getPartyForSocket(socket);
    if (!party) return cb({ ok: false, error: 'Not in a party.' });
    if (party.status !== 'active') return cb({ ok: false, error: 'The game is not running.' });

    const hunter = party.players.get(socket.data.playerId);
    if (!hunter || hunter.role !== 'hunter') {
      return cb({ ok: false, error: 'Only hunters can catch runners.' });
    }

    const pair = Number(payload.pair);
    const members = activePairs(party).get(pair);
    if (!members) return cb({ ok: false, error: 'That runner pair is no longer active.' });

    const distance = pairDistance(members, hunter.pos);
    if (distance == null) {
      return cb({ ok: false, error: 'Waiting for the runners\u2019 locations.' });
    }
    if (distance > CATCH_RADIUS_M + CATCH_TOLERANCE_M) {
      return cb({ ok: false, error: 'Get closer to catch them.' });
    }

    eliminatePair(members, hunter.name);

    const message = pushChat(party, {
      id: crypto.randomUUID(),
      kind: 'log',
      fromId: hunter.id,
      from: hunter.name,
      role: 'hunter',
      text: `HUNTER ${hunter.name} just caught RUNNER ${pair}`,
      at: Date.now(),
    });
    io.to(party.id).emit('chat:message', message);
    broadcast(party);

    // Drop the caught pair from any markers currently on the hunters' maps.
    if (Array.isArray(party.revealed) && party.revealed.length) {
      party.revealed = party.revealed.filter((pin) => pin.pair !== pair);
      sendReveal(party);
    }

    if (!activePairs(party).size) endGame(party, 'hunters');
    else sendPairDistances(party);
    cb({ ok: true });
  });

  // Players share their position. Hunters receive distances only; exact runner
  // coordinates are never relayed until a scheduled reveal.
  socket.on('player:position', (payload = {}, done) => {
    const cb = ack(done);
    const party = getPartyForSocket(socket);
    if (!party) return cb({ ok: false, error: 'Not in a party.' });
    const player = party.players.get(socket.data.playerId);
    if (!player) return cb({ ok: false, error: 'Player not found.' });
    // Eliminated players are no longer tracked, and nothing is relayed once
    // the game has ended.
    if (player.caught || party.status !== 'active') return cb({ ok: true });

    const point = toLatLng(payload.position || payload);
    if (!point) return cb({ ok: false, error: 'Invalid position.' });
    const heading = Number(payload.heading);
    player.pos = {
      lat: point.lat,
      lng: point.lng,
      heading: Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : null,
      at: Date.now(),
    };
    sendPairDistances(party);
    cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const party = getPartyForSocket(socket);
    if (!party) return;
    const player = party.players.get(socket.data.playerId);
    if (player && player.socketId === socket.id) {
      player.connected = false;
    }
    // Hand host control to another connected player if the host dropped.
    if (party.hostId === socket.data.playerId) {
      const next = [...party.players.values()].find((p) => p.connected && p.id !== socket.data.playerId);
      if (next) party.hostId = next.id;
    }
    broadcast(party);
  });
});

function removePlayer(party, playerId) {
  if (!party.players.has(playerId)) return;
  party.players.delete(playerId);
  if (party.players.size === 0) {
    clearPartyTimers(party);
    parties.delete(party.id);
    return;
  }
  if (party.hostId === playerId) {
    const next = [...party.players.values()].find((p) => p.connected) || party.players.values().next().value;
    if (next) party.hostId = next.id;
  }
  recomputePairs(party);
  broadcast(party);

  // Losing the last runner ends the game in the hunters' favour.
  if (party.status === 'active') {
    if (!activePairs(party).size) endGame(party, 'hunters');
    else sendPairDistances(party);
  }
}

// Periodically drop empty parties.
setInterval(() => {
  for (const [id, party] of parties) {
    if (party.players.size === 0) {
      clearPartyTimers(party);
      parties.delete(id);
    }
  }
}, 60 * 1000).unref?.();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Manhunt server running on http://localhost:${PORT}`);
  });
}

// Exported for tests. The HTTP listener only starts when run directly.
module.exports = {
  app,
  server,
  io,
  parties,
  sanitize,
  normalizeSettings,
  activePairs,
  pairDistance,
  eliminatePair,
  beginGame,
  revealPositions,
  endGame,
  scheduleParty,
  clearPartyTimers,
  REVEAL_INTERVAL_MS,
};
