# Manhunt

A real-world multiplayer chase game for a group of friends. One host creates a
lobby, which generates two 4-digit codes: a large **players** code to join as a
runner and a smaller **seekers** code to join as a hunter. The host assigns
runner pairs, then the hunt begins.

No accounts. No database. No paid services. Active games live in server memory
and are lost when the server restarts (acceptable for this first version).

## Tech stack

- HTML, CSS, vanilla JavaScript (no frontend framework)
- Node.js + Express
- Socket.IO for real-time multiplayer
- Leaflet + OpenStreetMap for the map

## Features

- Loading screen that transitions smoothly into the dashboard
- Dashboard with **Create Game** / **Join Game**
- Create flow with host name, game name, and a **Choose Template** button
  (templates are picked here, including **Ádi Manhunt**)
- Two auto-generated 4-digit codes per lobby: big players code (runner) and
  small seekers code (hunter)
- Configurable game creation: duration, hunters, escape time, play area & base,
  movement rules, catch method, boundary return period, and missions
- Saved template **Ádi Manhunt** ("Ready to hunt.")
- Account-free joining via code and display name; the code used sets the role
- The host is a **seeker (hunter)** by default
- Live lobby: copy buttons for both codes, player list, host role assignment,
  and host-only **kick** while in the lobby
- Server-authoritative host actions (only the host can assign roles, kick, start)
- Reconnect support using a session-scoped player id
- In-game full-screen map with pinch/zoom, a compact top-right timer, a role HUD,
  boundary streets with labels, and permitted-route lines (no leave button once
  the game starts)
- Live location: your own dot and a heading cone that rotates with the phone
  compass, plus a **Locate** button
- Hunters see every runner's live position on the map, labelled with the distance
  and a direction arrow that turns with the hunter's heading
- Hunter chat and game log (hunters post, everyone reads)
- Proximity catch: a hunter within reach gets a **Catch** button; the runner is
  eliminated and sees a "return to base" notice
- Big red **out-of-area** banner (caps) whenever your live location leaves the
  play area
- Templates can define the play area as a street/river boundary (polygon) instead
  of a simple radius circle

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

1. The host taps **Create Game**, enters their own name, and optionally taps
   **Choose Template** to start from **Ádi Manhunt**, then **Create Lobby**. The
   host joins as a seeker (hunter).
2. The lobby shows two codes: the big **players** code (join as a runner) and the
   smaller **seekers** code (join as a hunter). Each has a copy button.
3. Everyone else taps **Join Game**, enters one of the codes and a name. The code
   they use sets their starting role.
4. The host can tap a player's role button to cycle Unassigned / Hunter / Runner,
   and tap **×** to kick a player (lobby only). Runners are grouped into
   anonymous numbered pairs.
5. The host taps **Start Game**. The state syncs to every phone and the
   full-screen map takes over.

## Project structure

```
Manhunt/
├── server.js            # Express + Socket.IO server, in-memory party state
├── data/
│   └── templates.json   # Saved game templates
├── public/
│   ├── index.html       # All views (loading, dashboard, create, join, lobby, game)
│   ├── css/style.css    # Dark, mobile-first responsive UI
│   └── js/app.js        # Client logic, navigation, socket handling
└── package.json
```

## Configuration notes

- **Gameplay boundaries.** A custom game draws a simple radius circle around the
  base the host sets on the map. A template can instead define a real boundary:
  filled **blue** polygons for each area, labelled **barrier streets/edges**, and
  **permitted route** lines (bridges/transit). These render on both the create
  map (as a preview) and the full-screen in-game map. When a player's live
  position falls outside the playable area, a red **"out of area — return
  immediately"** banner appears at the top of their screen until they return.
- **Ádi Manhunt area.** The template highlights a hard closed loop: the whole of
  **Margitsziget** (island outline from OpenStreetMap) plus **Újlipótváros**,
  plus **Margit híd** up to the island entrance. The loop is bounded by
  **Szent István körút** (south), **Váci út** up to **Dózsa György út** (east),
  **Dráva utca** (north) and the **Duna rakpart** (west); the area north of
  Dráva utca (towards Árpád híd) and the Buda side are excluded. Barrier streets
  are labelled. Kept in `data/templates.json` so it can be refined.
- **Mission locations are not invented** and remain host-configurable.
- **Live GPS tracking.** Each player broadcasts their position every few seconds.
  Hunters see the live position of every runner on the map, each labelled with the
  distance and a direction arrow that rotates as the hunter turns their phone.
  Your own dot is drawn with a heading cone. Hunter chat is posted by hunters and
  read by everyone; a runner is eliminated when a hunter within reach presses
  **Catch**, which is logged to the chat.

## Not included (by design)

Accounts, registration, login, profiles, cosmetics, persistent user data, and
any paid-service dependency.
