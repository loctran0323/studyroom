// Spotify: sign-in (Authorization Code with PKCE, so no server secret),
// a few Web API calls, and an in-page player for listening along.

const TOKEN_KEY = "lamplight:spotify";
const AUTH_KEY = "lamplight:spotify-auth";
const SCOPES = [
  "user-read-private", "user-read-email",
  "user-read-playback-state", "user-read-currently-playing", "user-modify-playback-state",
  "streaming",
].join(" ");

let clientId = null;

export async function init() {
  try {
    const r = await fetch("/api/config");
    clientId = (await r.json()).spotifyClientId || null;
  } catch {
    clientId = null;
  }
  return !!clientId;
}

const redirectUri = () => location.origin + "/spotify";

function load() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY)); } catch { return null; }
}
function save(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}
export const connected = () => !!load()?.refresh;

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function login(returnTo) {
  // Spotify only accepts loopback IPs (not "localhost") as local redirect URIs.
  if (location.hostname === "localhost") {
    location.href = location.href.replace("//localhost", "//127.0.0.1");
    return;
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(AUTH_KEY, JSON.stringify({ verifier, state, returnTo }));
  const q = new URLSearchParams({
    client_id: clientId, response_type: "code", redirect_uri: redirectUri(),
    code_challenge_method: "S256", code_challenge: challenge, scope: SCOPES, state,
  });
  location.href = "https://accounts.spotify.com/authorize?" + q;
}

export async function handleCallback() {
  const q = new URLSearchParams(location.search);
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(AUTH_KEY)); } catch {}
  sessionStorage.removeItem(AUTH_KEY);
  const back = pending?.returnTo || "/";
  if (q.get("error") === "access_denied") return { back, error: "Spotify sign-in was cancelled." };
  if (!pending || !q.get("code") || q.get("state") !== pending.state) {
    return { back, error: "Spotify sign-in didn't finish. Try connecting again." };
  }
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: q.get("code"), redirect_uri: redirectUri(),
      client_id: clientId, code_verifier: pending.verifier,
    }),
  });
  if (!r.ok) return { back, error: "Spotify didn't accept the sign-in. Try connecting again." };
  const t = await r.json();
  save({ access: t.access_token, refresh: t.refresh_token, exp: Date.now() + (t.expires_in - 60) * 1000 });
  return { back };
}

let refreshing = null;
async function token() {
  const t = load();
  if (!t) throw new Error("not_connected");
  if (Date.now() < t.exp) return t.access;
  refreshing ||= (async () => {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: clientId }),
    });
    if (!r.ok) {
      save(null);
      throw new Error("expired");
    }
    const j = await r.json();
    const next = { access: j.access_token, refresh: j.refresh_token || t.refresh, exp: Date.now() + (j.expires_in - 60) * 1000 };
    save(next);
    return next.access;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function api(path, opts = {}) {
  const go = async () =>
    fetch("https://api.spotify.com/v1" + path, {
      ...opts,
      headers: { Authorization: "Bearer " + (await token()), ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    });
  let r = await go();
  if (r.status === 401) {
    const t = load();
    if (t) { t.exp = 0; save(t); }
    r = await go();
  }
  return r;
}

export function logout() {
  save(null);
  stopPlayer();
}

// { name, premium } or { error: "not_registered" | "failed" }
export async function profile() {
  try {
    const r = await api("/me");
    if (r.status === 403) return { error: "not_registered" };
    if (!r.ok) return { error: "failed" };
    const j = await r.json();
    return { name: j.display_name || j.id, premium: j.product ? j.product === "premium" : null };
  } catch {
    return { error: "failed" };
  }
}

// What's playing on this person's Spotify, on any device.
export async function nowPlaying() {
  const r = await api("/me/player?additional_types=episode");
  if (r.status === 204) return { track: null, playing: false, progressMs: 0 };
  if (!r.ok) throw Object.assign(new Error("http"), { status: r.status });
  const j = await r.json();
  const it = j.item;
  if (!it) return { track: null, playing: false, progressMs: 0 };
  const images = it.album?.images || it.images || it.show?.images || [];
  const art = (images.find((i) => i.width && i.width <= 320) || images[images.length - 1] || images[0])?.url || "";
  return {
    track: {
      uri: it.uri,
      name: it.name,
      artists: it.artists ? it.artists.map((a) => a.name).join(", ") : it.show?.name || "",
      art,
      url: it.external_urls?.spotify || "",
      durationMs: it.duration_ms || 0,
      local: !!it.is_local,
    },
    playing: !!j.is_playing,
    progressMs: j.progress_ms || 0,
  };
}

// ---------- listening along ----------
let sdk = null;
let player = null;
let deviceId = null;

function loadSdk() {
  if (window.Spotify?.Player) return Promise.resolve();
  sdk ||= new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    s.onerror = () => { sdk = null; reject(new Error("sdk")); };
    document.head.append(s);
  });
  return sdk;
}

// Turns this browser tab into a Spotify device. Resolves with its device id,
// or rejects with "premium", "unsupported" (phones) or "auth".
export async function startPlayer(onError) {
  if (deviceId) return deviceId;
  await loadSdk();
  player = new window.Spotify.Player({
    name: "Lamplight study room",
    getOAuthToken: (cb) => token().then(cb).catch(() => {}),
    volume: 0.8,
  });
  player.activateElement?.(); // lets the browser play audio from this click
  const ready = new Promise((resolve, reject) => {
    player.addListener("ready", ({ device_id }) => { deviceId = device_id; resolve(device_id); });
    player.addListener("initialization_error", () => reject(new Error("unsupported")));
    player.addListener("authentication_error", () => reject(new Error("auth")));
    player.addListener("account_error", () => reject(new Error("premium")));
    setTimeout(() => reject(new Error("unsupported")), 12000);
  });
  player.addListener("not_ready", () => { deviceId = null; });
  player.addListener("playback_error", ({ message }) => onError?.(message));
  const ok = await player.connect();
  if (!ok) throw new Error("unsupported");
  try {
    return await ready;
  } catch (e) {
    stopPlayer();
    throw e;
  }
}

export function stopPlayer() {
  try { player?.disconnect(); } catch {}
  player = null;
  deviceId = null;
}

// Without a device id this controls whatever Spotify app the person has open (phones).
export async function play(device, uri, positionMs) {
  const q = device ? `?device_id=${device}` : "";
  return api(`/me/player/play${q}`, {
    method: "PUT",
    body: JSON.stringify({ uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) }),
  });
}
export async function pause(device) {
  if (device && player) return player.pause();
  return api("/me/player/pause", { method: "PUT" });
}
export async function seek(ms) {
  if (player) return player.seek(Math.max(0, Math.round(ms)));
}
export async function localState() {
  if (!player) return null;
  const s = await player.getCurrentState();
  if (!s) return null;
  const cur = s.track_window?.current_track;
  return { position: s.position, paused: s.paused, uris: [cur?.uri, cur?.linked_from?.uri].filter(Boolean) };
}
