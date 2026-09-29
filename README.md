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

## Limits

- Calls are a peer-to-peer mesh, which is best for 2–6 people. There's no TURN relay, so
  a few strict networks (some campus or corporate Wi-Fi) may fail to connect
  voice/video. The fix is adding Cloudflare Realtime TURN credentials.
- Screen sharing works in desktop Chrome, Edge, Firefox and Safari, not on phones.
- Some YouTube videos block embedding; those show an error on the stage.
