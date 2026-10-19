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
- **Hunter runner panel**: a collapsible list of the active runner pairs, shown
  anonymously as `RUNNER 1 — 50 m`, sorted closest first and refreshed live.
  Hunters only ever see distances, **never** runners' live coordinates.
- **Periodic reveals**: every 10 minutes the server hands hunters the exact
  location of each active runner pair as a red pin. The pins are replaced at the
  next reveal.
- Hunter chat and game log (hunters post, everyone reads)
- **Mission codes and points**: runner pairs open the **Points** panel and enter
  the current 4-digit mission code (currently `1234`) to earn **1 point**.
  Each pair can claim a code once per game and the server validates every claim.
- **Leaderboard**: a **Ranks** button opens an anonymous leaderboard for both
  roles. Surviving pairs rank above eliminated pairs, then by points descending
  (`1. RUNNER 1 — Alive — 3 points`).
- Proximity catch: a hunter within reach gets a **Catch** button; catching a pair
  eliminates both of its runners, stops their tracking and shows them
  **RETURN TO BASE**
- **Pair revival**: a caught pair may rejoin **once per game** if at least one
  other pair is still running. Its members receive a private 4-digit revival code
  and enter it on the eliminated screen. A pair caught again after reviving is
  out permanently, and no revival is offered once every pair is caught.
- **Head start and game timers**: a `HEAD START — 15:00` countdown, then the main
  `TIME LEFT — 02:00:00` hunt timer. Both run on server-authoritative time.
- **Win / lose panels**: a green **RUNNERS WIN** panel if any pair survives to
  full time, or **HUNTERS WIN** if every pair is caught first. Timers and
  location updates stop when the game ends.
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
6. Runners can tap **Points** and enter the mission code to score. Everyone can
   tap **Ranks** to see the anonymous pair leaderboard.
7. If a pair is caught while another pair is still running, its members can use
   their private revival code on the eliminated screen. A pair gets one revival
   per game.

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
- **Mission codes and points are server-side.** The mission code is never sent
  to clients. The server checks the role, that the game is running, that the code
  is correct, and that the pair has not already claimed it before awarding a
  point.
- **Live GPS tracking.** Each player broadcasts their position every few seconds.
  A hunter's client receives **distances only** (the runner panel), never live
  coordinates — exact runner locations reach hunters only through the scheduled
  reveal. Your own dot is drawn with a heading cone. Hunter chat is posted by
  hunters and read by everyone. When a hunter within reach presses **Catch**, the
  target pair is eliminated (both runners stop being tracked) and the catch is
  logged to the chat. A caught pair with another pair still active is sent a
  private revival code; the server enforces the once-per-pair limit.
- **Leaderboard ordering is server-side.** Pairs that are currently alive rank
  first, followed by eliminated pairs; points sort each group in descending
  order. Pair numbers stay anonymous (`RUNNER 1`, `RUNNER 2`, …).
- **Timers and endings are server-authoritative.** The server sets the head-start
  and full-time timestamps and decides the winner; clients only render them. The
  main game timer does not run during the head start. Reveals fire every
  **10 minutes** (changeable with the optional `MANHUNT_REVEAL_MS` environment
  variable, used mainly by the tests).

## Not included (by design)

Accounts, registration, login, profiles, cosmetics, persistent user data, and
any paid-service dependency.
