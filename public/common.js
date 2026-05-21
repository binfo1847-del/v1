/* Shared helpers used by passenger.html and driver.html */

// Default map center: Colombo, Sri Lanka
window.DEFAULT_CENTER = { lat: 6.9271, lng: 79.8612 };

window.toast = function (msg, ms = 2400) {
  let el = document.getElementById('__toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '__toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
};

window.makeIcon = function (label, kind) {
  return L.divIcon({
    className: '',
    html: `<div class="pin ${kind}">${label}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
};

window.fmtKm = (km) => `${km.toFixed(2)} km`;
window.fmtLKR = (n) => `LKR ${Math.round(n).toLocaleString()}`;

window.tryGetMyLocation = function (onOk) {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => onOk({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
    () => {},
    { enableHighAccuracy: true, timeout: 5000 },
  );
};

// Reverse-geocode via OpenStreetMap Nominatim (best-effort, free, public).
window.reverseGeocode = async function (lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`, {
      headers: { 'Accept-Language': 'en' },
    });
    const j = await r.json();
    return j.display_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
};
