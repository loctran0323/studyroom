# Lamplight

A study room you share with one link: a shared Pomodoro timer, a task list,
ambient sound (lo-fi, rain, fireplace, brown noise), chat, voice, cameras,
screen share, and YouTube that plays in sync for everyone.

- `src/index.js`: Cloudflare Worker plus one Durable Object per room. Holds the
  timer, tasks, chat, sound and video state, and relays WebRTC signaling.
- `public/`: the site. `sound.js` generates the ambient audio with Web Audio,
  `call.js` runs the peer-to-peer voice/camera/screen mesh, and `app.js` is everything else.

## Run locally

    npm install
    npm run dev        # http://localhost:8791

## Deploy (your own Cloudflare account)

These scripts keep this project's Cloudflare login in `~/.config/lamplight-cf`,
separate from any other wrangler login on this machine.

    npm run login      # opens the browser to sign in
    npm run deploy     # prints https://lamplight.<your-subdomain>.workers.dev

Rooms live at `/r/<room-name>`. Anyone with the link can join.

## Spotify

One person shares what's playing on their Spotify; anyone with Premium can
listen along (their own Spotify plays the same song at the same spot).

1. Create an app at https://developer.spotify.com/dashboard. Pick "Web API"
   and "Web Playback SDK", and add these redirect URIs:
   - `https://studyroom.loctran0323.workers.dev/spotify`
   - `http://127.0.0.1:8791/spotify` (local dev)
2. Put the app's Client ID in `wrangler.jsonc` under `vars.SPOTIFY_CLIENT_ID`
   (it's public; sign-in uses PKCE, so there's no secret). For local dev, put
   `SPOTIFY_CLIENT_ID=...` in `.dev.vars`.
3. New Spotify apps are in development mode: only accounts listed under the
   app's User Management can connect. Add your friends' Spotify emails there.

## Limits

- Calls are a peer-to-peer mesh, which is best for 2–6 people. There's no TURN relay, so
  a few strict networks (some campus or corporate Wi-Fi) may fail to connect
  voice/video. The fix is adding Cloudflare Realtime TURN credentials.
- Screen sharing works in desktop Chrome, Edge, Firefox and Safari, not on phones.
- Some YouTube videos block embedding; those show an error on the stage.
