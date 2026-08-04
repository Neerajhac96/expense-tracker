/**
 * FlatSplit Service Worker — Production
 *
 * Strategy:
 *  - App shell: Cache-first on install, network revalidate on activate
 *  - Navigation requests: Network-first → cached index.html → offline.html
 *  - API / Firestore: NEVER cached (all firestore.googleapis.com skipped)
 *  - Cross-origin (Firebase SDK, Fonts): NEVER cached (opaque responses)
 *
 * Update flow:
 *  1. New SW detected → sends "SW_UPDATE_AVAILABLE" to all clients
 *  2. App shows update banner with "Update" button
 *  3. User clicks → app sends "SKIP_WAITING" → SW activates → app reloads
 *
 * BUMP THIS STRING on every deploy to invalidate the old cache:
 */
const CACHE_VERSION = "flatsplit-v3";
const OFFLINE_URL   = "./offline.html";

// ── Files that form the app shell ─────────────────────────────────────────────
// These are pre-cached on install. All paths are relative to the SW scope.
const APP_SHELL = [
  "./",
  "./index.html",
  "./offline.html",
  "./app.js",
  "./firebase.js",
  "./style.css",
  "./manifest.json",
  "./icons/favicon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./modules/state.js",
  "./modules/constants.js",
  "./modules/utils.js",
  "./modules/ui.js",
  "./modules/firestore.js",
  "./modules/auth.js",
  "./modules/expenses.js",
  "./modules/dashboard.js",
  "./modules/history.js",
  "./modules/analytics.js",
  "./modules/trash.js",
  "./modules/archive.js",
];

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Returns true when the URL should never be cached (Firestore, Firebase, Fonts). */
function isNeverCache(url) {
  return (
    url.includes("firestore.googleapis.com") ||
    url.includes("firebase.googleapis.com") ||
    url.includes("identitytoolkit.googleapis.com") ||
    url.includes("securetoken.googleapis.com") ||
    url.includes("googleapis.com") ||
    url.includes("gstatic.com") ||
    url.includes("fonts.gstatic.com") ||
    url.includes("fonts.googleapis.com")
  );
}

/** Sends a message object to all connected clients. */
async function broadcastToClients(data) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  clients.forEach((client) => client.postMessage(data));
}

// ── Install ────────────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => {
        // Do NOT call skipWaiting() here automatically.
        // The app controls activation via the SKIP_WAITING message
        // to avoid breaking open tabs mid-session.
        // However we DO skip waiting when no clients are open (fresh install).
        return self.clients.matchAll({ includeUncontrolled: true, type: "window" });
      })
      .then((clients) => {
        if (clients.length === 0) self.skipWaiting();
      })
  );
});

// ── Activate ───────────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_VERSION)
            .map((k) => caches.delete(k))
        )
      )
      .then(async () => {
        await self.clients.claim();
        // Notify all open tabs that a new version is now active
        await broadcastToClients({ type: "SW_ACTIVATED", version: CACHE_VERSION });
      })
  );
});

// ── Message handler (from app.js) ──────────────────────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// ── Fetch ──────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = request.url;

  // 1. Never intercept cross-origin requests we don't control
  if (!url.startsWith(self.location.origin)) return;

  // 2. Never intercept Firestore / Firebase API calls
  if (isNeverCache(url)) return;

  // 3. Never intercept non-GET requests (POST, PATCH, DELETE)
  if (request.method !== "GET") return;

  // 4. Navigation requests (page loads / hard refreshes)
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache the fresh navigation response
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(async () => {
          // Offline: serve cached index.html if available, else offline page
          const cached = await caches.match("./index.html");
          return cached ?? caches.match(OFFLINE_URL);
        })
    );
    return;
  }

  // 5. App-shell assets: cache-first (fast), revalidate in background
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
        }
        return response;
      });

      // Return cache immediately; update in background
      return cached ?? networkFetch;
    })
  );
});
