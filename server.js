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
    players: [...party.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      pair: p.pair,
      connected: p.connected,
    })),
  };
}

function broadcast(party) {
  io.to(party.id).emit('party:update', sanitize(party));
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
    recomputePairs(party);
    cb({ ok: true, state: sanitize(party) });
    broadcast(party);
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

    party.status = 'active';
    party.startedAt = Date.now();
    cb({ ok: true, state: sanitize(party) });
    io.to(party.id).emit('party:started', sanitize(party));
    broadcast(party);
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
    parties.delete(party.id);
    return;
  }
  if (party.hostId === playerId) {
    const next = [...party.players.values()].find((p) => p.connected) || party.players.values().next().value;
    if (next) party.hostId = next.id;
  }
  recomputePairs(party);
  broadcast(party);
}

// Periodically drop empty parties.
setInterval(() => {
  for (const [id, party] of parties) {
    if (party.players.size === 0) parties.delete(id);
  }
}, 60 * 1000).unref?.();

server.listen(PORT, () => {
  console.log(`Manhunt server running on http://localhost:${PORT}`);
});
