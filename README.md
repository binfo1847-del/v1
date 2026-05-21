# RideGo - PickMe/Uber-style live ride hailing demo

A self-contained ride-hailing web app with **passenger** and **driver** sides,
real-time matching via Socket.IO, and free OpenStreetMap maps (no API keys).

## Stack

| Layer | Tech |
|-------|------|
| Backend | Node.js + Express |
| Realtime | Socket.IO |
| Maps | Leaflet + OpenStreetMap tiles |
| Geocoding | Nominatim (free) |
| Storage | In-memory (demo) |

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Open the **driver** page first (`/driver.html`), register, drag the blue pin
on the map (or allow GPS), and tap **Go online**. Then open the **passenger**
page in another tab (`/passenger.html`), tap the map twice to set pickup &
drop, see the fare, and **Request ride**. Watch the driver come to you in
real-time.

## Flow

```
Passenger taps map (pickup, drop)
      |
      v
GET /api/estimate -> distance + ETA + LKR fare
      |
      v
socket.emit('passenger:request')
      |
      +--> server picks nearest online & idle driver (haversine)
      |
      v
Driver gets 'ride:request'  ->  accepts
      |
      v
Server links them; driver location streams to passenger
      |
      v
arrived -> start -> complete  (server finalizes fare)
```

## Pricing

`fare = max(150, 80 + 75 * km + 3 * minutes)` in LKR. Tweak in `server.js`.

## Project structure

```
server.js              # Express + Socket.IO matchmaker
public/
  index.html           # role select
  passenger.html       # passenger app
  driver.html          # driver app
  common.js            # shared client helpers
  styles.css           # PickMe-yellow dark theme
```

## Notes

- State is in memory. Restarting the server clears drivers, rides, etc.
  Plug in Redis or Postgres for persistence.
- Routing draws straight lines between pickup and drop. Wire OSRM or Mapbox
  Directions if you need real road routing.
- Auth is intentionally absent. Add JWT / OTP login before going public.
