import { DurableObject } from "cloudflare:workers";

const ROOM_RE = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const MAX_TASKS = 150;
const MAX_CHAT = 200;
const MIN = 60;

const DEFAULT_TIMER = {
  phase: "focus",
  durations: { focus: 25 * MIN, short: 5 * MIN, long: 15 * MIN },
  longEvery: 4,
  autoStart: true,
  running: false,
  endsAt: 0,
  remaining: 25 * MIN,
  cycle: 0,
  last: null, // { by, action, at }
};

const DEFAULT_SOUND = { track: null, playing: false, by: null };
const DEFAULT_VIDEO = { videoId: null, title: "", playing: false, pos: 0, at: 0, by: null };

const TRACKS = new Set(["lofi", "rain", "fire", "brown"]);
const PHASES = new Set(["focus", "short", "long"]);
const PHASE_LABEL = { focus: "Focus", short: "Short break", long: "Long break" };

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const id = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/api\/room\/([^/]+)\/ws$/);
    if (m) {
      const name = decodeURIComponent(m[1]).toLowerCase();
      if (!ROOM_RE.test(name)) return new Response("Room names use 3–48 letters, digits or dashes.", { status: 400 });
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket upgrade.", { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};

export class StudyRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get(["timer", "tasks", "chat", "sound", "video"]);
      this.timer = { ...structuredClone(DEFAULT_TIMER), ...(s.get("timer") || {}) };
      this.tasks = s.get("tasks") || [];
      this.chat = s.get("chat") || [];
      this.sound = s.get("sound") || { ...DEFAULT_SOUND };
      this.video = s.get("video") || { ...DEFAULT_VIDEO };
    });
  }

  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: id(), joined: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- helpers ----------
  sockets() {
    return this.ctx.getWebSockets().map((ws) => [ws, ws.deserializeAttachment() || {}]);
  }
  members() {
    return this.sockets()
      .filter(([, a]) => a.joined)
      .map(([, a]) => ({
        id: a.id, key: a.key, name: a.name, color: a.color, status: a.status || "",
        call: !!a.call, muted: !!a.muted, mic: a.mic || null, cam: a.cam || null, screen: a.screen || null,
      }));
  }
  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const [ws, a] of this.sockets()) {
      if (!a.joined) continue;
      try { ws.send(s); } catch {}
    }
  }
  pushMembers() { this.broadcast({ t: "members", members: this.members() }); }
  pushTimer() { this.broadcast({ t: "timer", timer: this.timer, now: Date.now() }); }
  pushTasks() { this.broadcast({ t: "tasks", tasks: this.tasks }); }
  pushSound() { this.broadcast({ t: "sound", sound: this.sound }); }
  pushVideo() { this.broadcast({ t: "video", video: this.video, now: Date.now() }); }

  async addChat(entry) {
    const msg = { id: id(), at: Date.now(), ...entry };
    this.chat.push(msg);
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
    this.broadcast({ t: "chat", msg });
    await this.ctx.storage.put("chat", this.chat);
  }
  sys(text) { return this.addChat({ sys: true, text }); }

  async saveTimer() {
    await this.ctx.storage.put("timer", this.timer);
    if (this.timer.running) await this.ctx.storage.setAlarm(this.timer.endsAt);
    else await this.ctx.storage.deleteAlarm();
  }

  advance(keepRunning) {
    const t = this.timer;
    if (t.phase === "focus") {
      t.cycle += 1;
      t.phase = t.cycle % t.longEvery === 0 ? "long" : "short";
    } else {
      t.phase = "focus";
    }
    t.remaining = t.durations[t.phase];
    t.running = keepRunning;
    t.endsAt = keepRunning ? Date.now() + t.remaining * 1000 : 0;
  }

  async alarm() {
    const t = this.timer;
    if (!t.running) return;
    if (Date.now() < t.endsAt - 250) {
      await this.ctx.storage.setAlarm(t.endsAt);
      return;
    }
    const ended = t.phase;
    this.advance(t.autoStart);
    t.last = { by: null, action: "finished", at: Date.now() };
    await this.saveTimer();
    this.pushTimer();
    this.broadcast({ t: "timer:done", ended, next: t.phase });
    await this.sys(
      ended === "focus"
        ? `Focus session done. ${PHASE_LABEL[t.phase]} ${t.running ? "started" : "is up next"}.`
        : `Break's over. Focus ${t.running ? "started" : "is up next"}.`
    );
  }

  // ---------- socket events ----------
  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 64000) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const me = ws.deserializeAttachment() || {};
    const setMe = (patch) => { Object.assign(me, patch); ws.serializeAttachment(me); };

    if (msg.t === "hello") {
      const name = str(msg.name, 32) || "Guest";
      const color = /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : "#4a7c63";
      setMe({ joined: true, name, color, key: str(msg.key, 40), status: str(msg.status, 80), call: false, muted: false, mic: null, cam: null, screen: null });
      this.send(ws, {
        t: "init", you: me.id, now: Date.now(),
        timer: this.timer, tasks: this.tasks, chat: this.chat, sound: this.sound, video: this.video,
        members: this.members(),
      });
      this.pushMembers();
      return;
    }
    if (msg.t === "peek") {
      const names = [...new Map(this.members().map((m) => [m.key, m.name])).values()];
      this.send(ws, { t: "peek", names });
      return;
    }
    if (!me.joined) return;
    const who = me.name;

    switch (msg.t) {
      case "profile": {
        const patch = {};
        if ("name" in msg) patch.name = str(msg.name, 32) || me.name;
        if ("status" in msg) patch.status = str(msg.status, 80);
        if ("color" in msg && /^#[0-9a-f]{6}$/i.test(msg.color)) patch.color = msg.color;
        setMe(patch);
        this.pushMembers();
        return;
      }

      case "chat": {
        const text = str(msg.text, 1000);
        if (!text) return;
        await this.addChat({ name: who, color: me.color, key: me.key, text });
        return;
      }

      // ----- tasks -----
      case "task:add": {
        const text = str(msg.text, 200);
        if (!text || this.tasks.length >= MAX_TASKS) return;
        this.tasks.push({ id: id(), text, done: false, by: who, key: me.key, color: me.color, at: Date.now() });
        break;
      }
      case "task:toggle": {
        const task = this.tasks.find((x) => x.id === msg.id);
        if (!task) return;
        task.done = !task.done;
        task.doneBy = task.done ? who : null;
        break;
      }
      case "task:edit": {
        const task = this.tasks.find((x) => x.id === msg.id);
        const text = str(msg.text, 200);
        if (!task || !text) return;
        task.text = text;
        break;
      }
      case "task:delete":
        this.tasks = this.tasks.filter((x) => x.id !== msg.id);
        break;
      case "task:clear-done":
        this.tasks = this.tasks.filter((x) => !x.done);
        break;

      // ----- timer -----
      case "timer:start": {
        const t = this.timer;
        if (t.running) return;
        t.running = true;
        t.endsAt = Date.now() + t.remaining * 1000;
        t.last = { by: who, action: "started", at: Date.now() };
        await this.saveTimer();
        this.pushTimer();
        return;
      }
      case "timer:pause": {
        const t = this.timer;
        if (!t.running) return;
        t.remaining = Math.max(1, Math.ceil((t.endsAt - Date.now()) / 1000));
        t.running = false;
        t.endsAt = 0;
        t.last = { by: who, action: "paused", at: Date.now() };
        await this.saveTimer();
        this.pushTimer();
        return;
      }
      case "timer:reset": {
        const t = this.timer;
        t.running = false;
        t.endsAt = 0;
        t.remaining = t.durations[t.phase];
        t.last = { by: who, action: "reset", at: Date.now() };
        await this.saveTimer();
        this.pushTimer();
        return;
      }
      case "timer:skip": {
        this.advance(this.timer.running);
        this.timer.last = { by: who, action: "skipped to", at: Date.now() };
        await this.saveTimer();
        this.pushTimer();
        return;
      }
      case "timer:phase": {
        if (!PHASES.has(msg.phase)) return;
        const t = this.timer;
        t.phase = msg.phase;
        t.running = false;
        t.endsAt = 0;
        t.remaining = t.durations[t.phase];
        t.last = { by: who, action: "switched to", at: Date.now() };
        await this.saveTimer();
        this.pushTimer();
        return;
      }
      case "timer:config": {
        const t = this.timer;
        const mins = (v, lo, hi, fallback) => {
          const n = Math.round(Number(v));
          return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) * MIN : fallback;
        };
        t.durations = {
          focus: mins(msg.focus, 1, 180, t.durations.focus),
          short: mins(msg.short, 1, 60, t.durations.short),
          long: mins(msg.long, 1, 90, t.durations.long),
        };
        const every = Math.round(Number(msg.longEvery));
        if (every >= 2 && every <= 10) t.longEvery = every;
        if (typeof msg.autoStart === "boolean") t.autoStart = msg.autoStart;
        if (!t.running) t.remaining = t.durations[t.phase];
        t.last = { by: who, action: "changed the timer", at: Date.now() };
        await this.saveTimer();
        this.pushTimer();
        return;
      }

      // ----- ambient sound -----
      case "sound:set": {
        if (msg.track !== null && !TRACKS.has(msg.track)) return;
        this.sound = { track: msg.track, playing: !!msg.track && msg.playing !== false, by: who };
        await this.ctx.storage.put("sound", this.sound);
        this.pushSound();
        return;
      }

      // ----- watch together -----
      case "video:load": {
        if (!/^[\w-]{11}$/.test(msg.videoId || "")) return;
        this.video = { videoId: msg.videoId, title: str(msg.title, 140), playing: true, pos: 0, at: Date.now(), by: who };
        await this.ctx.storage.put("video", this.video);
        this.pushVideo();
        await this.sys(`${who} put on a video.`);
        return;
      }
      case "video:title": {
        if (msg.videoId !== this.video.videoId || this.video.title) return;
        this.video.title = str(msg.title, 140);
        await this.ctx.storage.put("video", this.video);
        this.pushVideo();
        return;
      }
      case "video:state": {
        if (!this.video.videoId || msg.videoId !== this.video.videoId) return;
        const pos = Number(msg.pos);
        if (!Number.isFinite(pos) || pos < 0) return;
        this.video = { ...this.video, playing: !!msg.playing, pos, at: Date.now(), by: who };
        await this.ctx.storage.put("video", this.video);
        this.pushVideo();
        return;
      }
      case "video:close": {
        this.video = { ...DEFAULT_VIDEO };
        await this.ctx.storage.put("video", this.video);
        this.pushVideo();
        return;
      }

      // ----- call (voice, camera, screen) -----
      case "call": {
        const sid = (v) => (typeof v === "string" && /^[\w{}-]{1,64}$/.test(v) ? v : null);
        setMe({ call: !!msg.on, muted: !!msg.muted, mic: msg.on ? sid(msg.mic) : null, cam: msg.on ? sid(msg.cam) : null, screen: msg.on ? sid(msg.screen) : null });
        this.pushMembers();
        return;
      }
      case "signal": {
        for (const [peer, a] of this.sockets()) {
          if (a.id === msg.to && a.joined) {
            this.send(peer, { t: "signal", from: me.id, data: msg.data });
            break;
          }
        }
        return;
      }
      default:
        return;
    }

    // task mutations fall through to here
    await this.ctx.storage.put("tasks", this.tasks);
    this.pushTasks();
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch {}
    ws.serializeAttachment({ ...(ws.deserializeAttachment() || {}), joined: false });
    this.pushMembers();
  }

  async webSocketError(ws) {
    ws.serializeAttachment({ ...(ws.deserializeAttachment() || {}), joined: false });
    this.pushMembers();
  }
}
