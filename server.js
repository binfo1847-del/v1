/**
 * Ride-hailing server (PickMe/Uber-style demo)
 *
 * Real-time flow:
 *  - Drivers connect via Socket.IO, go online, broadcast their location.
 *  - Passengers request a ride -> server finds nearest online driver.
 *  - Driver accepts -> both sides get realtime status & location updates.
 *  - On complete, fare is finalized and trip is archived.
 *
 * Storage is in-memory. Restarting the server clears state. That keeps
 * the demo dependency-free; swap in Redis/Postgres for production.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- In-memory stores ----------
/** @type {Map<string, Driver>} */
const drivers = new Map();      // socketId -> driver
/** @type {Map<string, Ride>}   */
const rides = new Map();        // rideId -> ride
/** @type {Map<string, string>} */
const passengerSockets = new Map(); // passengerId -> socketId

let rideCounter = 1000;

// ---------- Pricing ----------
const FARE = {
  base: 80,        // LKR
  perKm: 75,
  perMin: 3,
  minFare: 150,
};

// ---------- Helpers ----------
function haversineKm(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function estimateFare(distanceKm, durationMin = distanceKm * 2.5) {
  const raw = FARE.base + distanceKm * FARE.perKm + durationMin * FARE.perMin;
  return Math.max(FARE.minFare, Math.round(raw));
}

function findNearestDriver(pickup) {
  let best = null;
  let bestDist = Infinity;
  for (const driver of drivers.values()) {
    if (!driver.online || driver.busyRideId) continue;
    if (!driver.location) continue;
    const d = haversineKm(driver.location, pickup);
    if (d < bestDist) {
      bestDist = d;
      best = driver;
    }
  }
  return best ? { driver: best, distanceKm: bestDist } : null;
}

function broadcastDriverList() {
  const list = Array.from(drivers.values())
    .filter((d) => d.online)
    .map((d) => ({
      id: d.id,
      name: d.name,
      vehicle: d.vehicle,
      plate: d.plate,
      location: d.location,
      busy: !!d.busyRideId,
    }));
  io.emit('drivers:update', list);
}

// ---------- REST: fare estimate ----------
app.get('/api/estimate', (req, res) => {
  const pickup = { lat: parseFloat(req.query.plat), lng: parseFloat(req.query.plng) };
  const drop = { lat: parseFloat(req.query.dlat), lng: parseFloat(req.query.dlng) };
  if ([pickup.lat, pickup.lng, drop.lat, drop.lng].some(Number.isNaN)) {
    return res.status(400).json({ error: 'invalid coords' });
  }
  const distanceKm = haversineKm(pickup, drop);
  const durationMin = distanceKm * 2.5;
  res.json({
    distanceKm: +distanceKm.toFixed(2),
    durationMin: +durationMin.toFixed(1),
    fare: estimateFare(distanceKm, durationMin),
    currency: 'LKR',
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, drivers: drivers.size, rides: rides.size }));

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  console.log('connect', socket.id);

  // ===== DRIVER =====
  socket.on('driver:register', (payload, ack) => {
    const driver = {
      id: socket.id,
      name: payload?.name || 'Driver',
      vehicle: payload?.vehicle || 'Car',
      plate: payload?.plate || 'XX-0000',
      online: false,
      location: payload?.location || null,
      busyRideId: null,
    };
    drivers.set(socket.id, driver);
    socket.join('drivers');
    ack?.({ ok: true, driver });
    broadcastDriverList();
  });

  socket.on('driver:online', (online) => {
    const d = drivers.get(socket.id);
    if (!d) return;
    d.online = !!online;
    broadcastDriverList();
  });

  socket.on('driver:location', (loc) => {
    const d = drivers.get(socket.id);
    if (!d) return;
    d.location = loc;
    // If driver is on a trip, push location to that passenger
    if (d.busyRideId) {
      const ride = rides.get(d.busyRideId);
      if (ride) {
        const passengerSock = passengerSockets.get(ride.passengerId);
        if (passengerSock) {
          io.to(passengerSock).emit('ride:driverLocation', { rideId: ride.id, location: loc });
        }
      }
    }
    broadcastDriverList();
  });

  socket.on('driver:accept', ({ rideId }, ack) => {
    const d = drivers.get(socket.id);
    const ride = rides.get(rideId);
    if (!d || !ride) return ack?.({ ok: false, error: 'unknown' });
    if (ride.status !== 'pending') return ack?.({ ok: false, error: 'already_taken' });
    if (d.busyRideId) return ack?.({ ok: false, error: 'busy' });

    ride.status = 'accepted';
    ride.driverId = d.id;
    ride.acceptedAt = Date.now();
    d.busyRideId = ride.id;

    ack?.({ ok: true, ride });

    const passengerSock = passengerSockets.get(ride.passengerId);
    if (passengerSock) {
      io.to(passengerSock).emit('ride:accepted', {
        ride,
        driver: { name: d.name, vehicle: d.vehicle, plate: d.plate, location: d.location },
      });
    }
    // Tell other drivers this ride is gone
    socket.to('drivers').emit('ride:cancelledForDrivers', { rideId: ride.id });
    broadcastDriverList();
  });

  socket.on('driver:reject', ({ rideId }) => {
    // For demo we just log; real systems would re-dispatch.
    console.log('driver rejected', socket.id, rideId);
  });

  socket.on('driver:arrived', ({ rideId }) => {
    const ride = rides.get(rideId);
    if (!ride) return;
    ride.status = 'arrived';
    const ps = passengerSockets.get(ride.passengerId);
    if (ps) io.to(ps).emit('ride:arrived', { rideId });
  });

  socket.on('driver:start', ({ rideId }) => {
    const ride = rides.get(rideId);
    if (!ride) return;
    ride.status = 'in_progress';
    ride.startedAt = Date.now();
    const ps = passengerSockets.get(ride.passengerId);
    if (ps) io.to(ps).emit('ride:started', { rideId });
  });

  socket.on('driver:complete', ({ rideId }) => {
    const ride = rides.get(rideId);
    const d = drivers.get(socket.id);
    if (!ride || !d) return;
    ride.status = 'completed';
    ride.completedAt = Date.now();
    const distance = haversineKm(ride.pickup, ride.drop);
    const durationMin = ride.startedAt ? (ride.completedAt - ride.startedAt) / 60000 : distance * 2.5;
    ride.finalFare = estimateFare(distance, durationMin);
    d.busyRideId = null;
    const ps = passengerSockets.get(ride.passengerId);
    if (ps) io.to(ps).emit('ride:completed', { rideId, fare: ride.finalFare });
    broadcastDriverList();
  });

  // ===== PASSENGER =====
  socket.on('passenger:register', ({ passengerId, name }, ack) => {
    const pid = passengerId || socket.id;
    passengerSockets.set(pid, socket.id);
    socket.data.passengerId = pid;
    socket.data.passengerName = name || 'Passenger';
    ack?.({ ok: true, passengerId: pid });
    // send current driver list snapshot
    socket.emit(
      'drivers:update',
      Array.from(drivers.values())
        .filter((d) => d.online)
        .map((d) => ({
          id: d.id, name: d.name, vehicle: d.vehicle, plate: d.plate,
          location: d.location, busy: !!d.busyRideId,
        })),
    );
  });

  socket.on('passenger:request', ({ pickup, drop, pickupLabel, dropLabel }, ack) => {
    const passengerId = socket.data.passengerId || socket.id;
    const distance = haversineKm(pickup, drop);
    const fare = estimateFare(distance);

    const ride = {
      id: 'R' + ++rideCounter,
      passengerId,
      passengerName: socket.data.passengerName || 'Passenger',
      pickup, drop, pickupLabel, dropLabel,
      distanceKm: +distance.toFixed(2),
      estimateFare: fare,
      status: 'pending',
      createdAt: Date.now(),
      driverId: null,
    };
    rides.set(ride.id, ride);

    const match = findNearestDriver(pickup);
    if (!match) {
      ride.status = 'no_drivers';
      return ack?.({ ok: false, ride, error: 'no_drivers_available' });
    }

    ride.dispatchedTo = match.driver.id;
    ack?.({ ok: true, ride });

    io.to(match.driver.id).emit('ride:request', {
      ride,
      pickupDistanceKm: +match.distanceKm.toFixed(2),
    });

    // Auto-timeout pending ride after 30s -> mark expired
    setTimeout(() => {
      const r = rides.get(ride.id);
      if (r && r.status === 'pending') {
        r.status = 'expired';
        const ps = passengerSockets.get(r.passengerId);
        if (ps) io.to(ps).emit('ride:expired', { rideId: r.id });
      }
    }, 30000);
  });

  socket.on('passenger:cancel', ({ rideId }) => {
    const ride = rides.get(rideId);
    if (!ride) return;
    if (ride.status === 'completed') return;
    ride.status = 'cancelled';
    if (ride.driverId) {
      io.to(ride.driverId).emit('ride:cancelledByPassenger', { rideId });
      const d = drivers.get(ride.driverId);
      if (d) d.busyRideId = null;
    } else if (ride.dispatchedTo) {
      io.to(ride.dispatchedTo).emit('ride:cancelledByPassenger', { rideId });
    }
    broadcastDriverList();
  });

  // ===== Cleanup =====
  socket.on('disconnect', () => {
    const d = drivers.get(socket.id);
    if (d) {
      drivers.delete(socket.id);
      // Notify any active passenger
      if (d.busyRideId) {
        const ride = rides.get(d.busyRideId);
        if (ride) {
          const ps = passengerSockets.get(ride.passengerId);
          if (ps) io.to(ps).emit('ride:driverDisconnected', { rideId: ride.id });
        }
      }
      broadcastDriverList();
    }
    if (socket.data.passengerId) {
      passengerSockets.delete(socket.data.passengerId);
    }
    console.log('disconnect', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Ride-hailing server running on http://localhost:${PORT}`);
});
