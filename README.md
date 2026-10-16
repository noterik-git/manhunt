# Manhunt

A real-world multiplayer chase game for a group of friends. One host creates a
lobby, everyone joins with a short party code, the host assigns hunters and
runner pairs, and then the hunt begins.

No accounts. No database. No paid services. Active games live in server memory
and are lost when the server restarts (acceptable for this first version).

## Tech stack

- HTML, CSS, vanilla JavaScript (no frontend framework)
- Node.js + Express
- Socket.IO for real-time multiplayer
- Leaflet + OpenStreetMap for the map

## Features

- Animated loading screen with the **Made by Headband Co.** credit
- Dashboard with **Create Game** / **Join Game** and saved templates
- Configurable game creation: duration, hunters, escape time, play area & base,
  movement rules, catch method, boundary return period, and missions
- Saved template **Ádi Manhunt** ("Ready to hunt.")
- Account-free joining via a short party code and display name
- Live lobby: copy-code button, player list, host role assignment, synced state
- Server-authoritative host actions (only the host can assign roles / start)
- Reconnect support using a session-scoped player id
- In-game view with role card, phase countdown, and a base/area map

## Getting started

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000 on your phone and computer. Phones must be on
the same network and should use your computer's LAN IP, for example
`http://192.168.1.20:3000`. You can set a different port with the `PORT`
environment variable.

## How to play

1. The host opens the app and taps **Create Game** (optionally starting from the
   **Ádi Manhunt** template), then **Create Lobby**.
2. Everyone else taps **Join Game** and enters the party code and a name.
3. The host taps each player's role button to cycle between Unassigned, Hunter,
   and Runner. Runners are grouped into anonymous numbered pairs automatically.
4. The host taps **Start Game**. The state syncs to every phone.

## Project structure

```
Manhunt/
├── server.js            # Express + Socket.IO server, in-memory party state
├── data/
│   └── templates.json   # Saved game templates
├── public/
│   ├── index.html       # All views (loading, dashboard, create, join, lobby, game)
│   ├── css/style.css    # Dark, mobile-first tactical UI
│   └── js/app.js        # Client logic, navigation, socket handling
└── package.json
```

## Configuration notes

- **Coordinates, mission locations, and exact boundary geometry are not
  invented.** The base location and area radius are set by the host on the map
  during game creation, and template coordinates are intentionally `null` until
  configured.
- **Live GPS tracking is not implemented yet.** The in-game map is for reference
  only and the UI states this clearly.

## Not included (by design)

Accounts, registration, login, profiles, cosmetics, persistent user data, and
any paid-service dependency.
