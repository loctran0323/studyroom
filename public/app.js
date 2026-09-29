import * as sound from "/sound.js";
import { createCall } from "/call.js";

// ---------- small helpers ----------
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const NS = "http://www.w3.org/2000/svg";

const store = {
  get(k) { try { return localStorage.getItem("lamplight:" + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("lamplight:" + k, v); } catch {} },
};

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}
function icon(name) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("class", "i");
  const u = document.createElementNS(NS, "use");
  u.setAttribute("href", "#i-" + name);
  s.append(u);
  return s;
}
const setIcon = (btn, name) => btn.querySelector("use").setAttribute("href", "#i-" + name);
const initial = (name) => ([...(name || "?").trim()][0] || "?").toUpperCase();
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const clockTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function relTime(ts) {
  const s = (Date.now() + S.offset - ts) / 1000;
  if (s < 45) return "just now";
  if (s < 90) return "1 min ago";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  const h = Math.round(s / 3600);
  return `${h} hr ago`;
}

function toast(text, kind) {
  const t = el("div", { class: "toast" + (kind ? " " + kind : "") }, text);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), kind === "error" ? 6500 : 3200);
}

// ---------- theme ----------
const currentTheme = () =>
  document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
function paintThemeButtons() {
  const dark = currentTheme() === "dark";
  for (const b of $$(".theme-toggle")) {
    setIcon(b, dark ? "sun" : "moon");
    b.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  }
}
$$(".theme-toggle").forEach((b) =>
  b.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
    paintThemeButtons();
  })
);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintThemeButtons);
paintThemeButtons();

// ---------- identity ----------
const COLORS = ["#2f7d5b", "#b0772b", "#3f6fb5", "#b44c6e", "#7a5bb5", "#2b8a93", "#a4532d", "#5f7a2a"];
const me = {
  key: store.get("key") || (() => { const k = rid(); store.set("key", k); return k; })(),
  name: store.get("name") || "",
  color: COLORS.includes(store.get("color")) ? store.get("color") : COLORS[Math.floor(Math.random() * COLORS.length)],
  status: store.get("status") || "",
};

const ADJ = ["quiet", "amber", "velvet", "misty", "cedar", "golden", "late", "hushed", "paper", "willow", "copper", "silver", "slow", "moss", "lunar", "gentle"];
const NOUN = ["maple", "library", "lantern", "harbor", "attic", "orchard", "meadow", "atlas", "comet", "fern", "study", "garden", "quill", "window", "tide", "cabin"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const randomRoom = () => `${pick(ADJ)}-${pick(NOUN)}-${10 + Math.floor(Math.random() * 90)}`;
const ROOM_RE = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
function parseRoom(v) {
  v = v.trim();
  try {
    const u = new URL(v);
    const m = u.pathname.match(/\/r\/([A-Za-z0-9-]+)/);
    if (m) v = m[1];
  } catch {}
  v = v.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return ROOM_RE.test(v) ? v : null;
}

// ---------- routing ----------
const route = location.pathname.match(/^\/r\/([A-Za-z0-9-]+)\/?$/);
const S = {
  room: null, you: null, offset: 0, entered: false,
  timer: null, tasks: [], chat: [], sound: {}, video: {}, members: [],
  filter: store.get("filter") || "all",
  soundMuted: store.get("soundMuted") === "1",
  pinned: null, tab: "focus", unread: 0, editing: null, tasksDirty: false,
};


// ================= Landing =================
function showLanding() {
  $("#landing").hidden = false;
  $("#create-name").value = me.name;
  $("#create-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#create-name").value.trim();
    if (!name) return;
    store.set("name", name);
    location.href = "/r/" + randomRoom();
  });
  $("#join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = parseRoom($("#join-code").value);
    const err = $("#join-error");
    if (!code) {
      err.textContent = "That doesn't look like a room. Paste the full invite link or a name like quiet-maple-42.";
      err.hidden = false;
      return;
    }
    location.href = "/r/" + code;
  });
}

// ================= Room =================
let ws = null;
let retry = 0;
let wantHello = false;
const send = (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
const sendHello = () => send({ t: "hello", name: me.name, color: me.color, key: me.key, status: me.status });

const call = createCall({
  send,
  onChange: () => { renderCall(); renderStage(); renderAudio(); },
});

function enterRoom(room) {
  S.room = room;
  $("#room").hidden = false;
  $("#room-name").textContent = room;
  document.title = `Lamplight · ${room}`;
  wireRoom();
  connect();
  openJoinDialog();
  setInterval(() => renderTimer(false), 250);
  setInterval(() => renderTimer(true), 30000);
  setInterval(pollVideo, 1000);
  setInterval(speakingLoop, 150);
  setInterval(() => { if (ws?.readyState === 1) ws.send('{"t":"ping"}'); }, 25000);
}

function setConn(state) {
  const c = $("#conn");
  c.dataset.state = state;
  c.textContent = { live: "Connected", connecting: "Connecting", reconnecting: "Reconnecting…" }[state];
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/api/room/${S.room}/ws`);
  ws.onopen = () => {
    retry = 0;
    setConn("live");
    if (wantHello) sendHello();
    else send({ t: "peek" });
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    handle(m);
  };
  ws.onclose = () => {
    setConn("reconnecting");
    call.resetConnections();
    renderStage();
    setTimeout(connect, Math.min(8000, 400 * 2 ** retry++));
  };
}

function handle(m) {
  switch (m.t) {
    case "peek": renderPeek(m.names || []); break;
    case "init":
      S.you = m.you;
      S.offset = m.now - Date.now();
      S.timer = m.timer;
      S.tasks = m.tasks;
      S.chat = m.chat;
      S.members = m.members;
      S.video = m.video;
      call.syncMembers(S.members, S.you);
      if (call.state().inCall) call.announce();
      renderTimer(true);
      renderTasks();
      renderChat();
      renderPeople();
      renderCall();
      applySound(m.sound);
      applyVideo();
      break;
    case "members":
      diffMembers(m.members);
      S.members = m.members;
      call.syncMembers(S.members, S.you);
      renderPeople();
      renderCall();
      renderStage();
      renderAudio();
      break;
    case "timer":
      S.offset = m.now - Date.now();
      S.timer = m.timer;
      renderTimer(true);
      break;
    case "timer:done": onTimerDone(m); break;
    case "tasks": S.tasks = m.tasks; renderTasks(); break;
    case "chat":
      S.chat.push(m.msg);
      if (S.chat.length > 200) S.chat.shift();
      appendChat(m.msg, false);
      break;
    case "sound": applySound(m.sound); break;
    case "video":
      S.offset = m.now - Date.now();
      S.video = m.video;
      applyVideo();
      break;
    case "signal": call.onSignal(m.from, m.data); break;
  }
}

// ---------- join dialog ----------
function openJoinDialog() {
  const d = $("#join-dialog");
  $("#join-room-name").textContent = S.room;
  $("#join-name").value = me.name;
  const sw = $("#swatches");
  for (const c of COLORS) {
    sw.append(el("label", { style: `--c:${c}`, title: c },
      el("input", { type: "radio", name: "color", value: c, checked: c === me.color, "aria-label": `Color ${c}` })));
  }
  d.addEventListener("cancel", (e) => e.preventDefault());
  $("#join-dialog-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#join-name").value.trim();
    if (!name) return;
    me.name = name;
    me.color = $("input[name=color]:checked", sw)?.value || me.color;
    store.set("name", me.name);
    store.set("color", me.color);
    S.entered = true;
    sound.audioContext(); // unlock audio with this click
    sound.setVolume(Number($("#sound-vol").value) / 100);
    d.close();
    wantHello = true;
    sendHello();
  });
  d.showModal();
}
function renderPeek(names) {
  const who = $("#join-who");
  if (!names.length) who.textContent = "Nobody else is here yet. Copy the link once you're in and send it to a friend.";
  else if (names.length === 1) who.textContent = `${names[0]} is here.`;
  else if (names.length === 2) who.textContent = `${names[0]} and ${names[1]} are here.`;
  else who.textContent = `${names.slice(0, 2).join(", ")} and ${names.length - 2} more are here.`;
}

// ---------- members ----------
const leaveTimers = new Map();
function diffMembers(next) {
  const byKey = (list) => new Map(list.map((m) => [m.key, m]));
  const before = byKey(S.members);
  const after = byKey(next);
  for (const [k, m] of after) {
    if (k === me.key) continue;
    if (leaveTimers.has(k)) { clearTimeout(leaveTimers.get(k)); leaveTimers.delete(k); continue; }
    if (!before.has(k)) toast(`${m.name} joined`);
  }
  for (const [k, m] of before) {
    if (k === me.key || after.has(k)) continue;
    leaveTimers.set(k, setTimeout(() => {
      leaveTimers.delete(k);
      if (!S.members.some((x) => x.key === k)) toast(`${m.name} left`);
    }, 4000));
  }
  for (const m of next) {
    const prev = S.members.find((p) => p.id === m.id);
    if (m.id !== S.you && m.screen && !prev?.screen) {
      toast(`${m.name} is sharing their screen`);
      badgeStage();
    }
  }
}

function uniqueMembers() {
  // Several tabs from the same person show once; prefer the one in the call.
  const map = new Map();
  for (const m of S.members) {
    const cur = map.get(m.key);
    if (!cur || (m.call && !cur.call) || m.id === S.you) map.set(m.key, m);
  }
  return [...map.values()].sort((a, b) => (a.key === me.key ? -1 : b.key === me.key ? 1 : a.name.localeCompare(b.name)));
}

function renderPeople() {
  const list = $("#people-list");
  list.replaceChildren();
  const people = uniqueMembers();
  for (const m of people) {
    const mine = m.key === me.key;
    const icons = el("span", { class: "person-icons" });
    if (m.call) {
      const mic = icon(m.muted ? "mic-off" : "mic");
      if (m.muted) mic.classList.add("off");
      icons.append(mic);
    }
    if (m.cam) icons.append(icon("cam"));
    if (m.screen) icons.append(icon("screen"));
    list.append(el("li", { class: "person" },
      el("span", { class: "avatar", style: `--c:${m.color}`, "data-speaker": m.id }, initial(m.name)),
      el("div", {},
        el("div", { class: "person-name" }, m.name, mine ? el("small", {}, " (you)") : null),
        el("div", { class: "person-status" }, m.status || (mine ? "Add what you're working on below" : "Studying"))),
      icons));
  }
  const inCall = people.filter((m) => m.call).length;
  $("#people-count").textContent = `${people.length} here` + (inCall ? ` · ${inCall} in call` : "");
}

// ---------- timer ----------
const PHASE = { focus: "Focus", short: "Short break", long: "Long break" };
const serverNow = () => Date.now() + S.offset;
function remainingSec() {
  const t = S.timer;
  if (!t) return 0;
  return t.running ? Math.max(0, (t.endsAt - serverNow()) / 1000) : t.remaining;
}
function fmt(sec) {
  sec = Math.ceil(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h ? `${h}:${String(m).padStart(2, "0")}` : String(m).padStart(2, "0");
  return `${mm}:${String(s).padStart(2, "0")}`;
}
let lastClock = "";
function renderTimer(full) {
  const t = S.timer;
  if (!t) return;
  const card = $("#timer-card");
  const dur = t.durations[t.phase];
  if (full) {
    card.dataset.phase = t.phase;
    card.dataset.running = String(t.running);
    for (const b of $$(".phase-tabs button")) b.setAttribute("aria-selected", String(b.dataset.phase === t.phase));
    for (const s of $$("[data-dur]")) s.textContent = Math.round(t.durations[s.dataset.dur] / 60);
    const toggle = $("#timer-toggle");
    const label = t.running ? "Pause" : t.remaining < dur ? "Resume" : "Start";
    toggle.querySelector("span").textContent = label;
    setIcon(toggle, t.running ? "pause" : "play");

    const every = t.longEvery;
    const done = t.phase === "long" ? every : t.cycle % every;
    const round = t.phase === "focus" ? done + 1 : Math.max(done, 1);
    const dots = $("#dots");
    dots.replaceChildren();
    for (let i = 0; i < every; i++) {
      dots.append(el("i", { class: i < done ? "full" : i === done && t.phase === "focus" ? "now" : "" }));
    }
    $("#round-label").textContent = `Round ${round} of ${every}`;
    const mins = Math.round(dur / 60);
    $("#ruler").style.setProperty("--ticks", Math.min(mins, 60));
    $("#ruler-end").textContent = `${mins} min`;
    $("#timer-last").textContent = lastText(t);
  }
  const rem = remainingSec();
  const str = fmt(rem);
  if (str !== lastClock) {
    lastClock = str;
    const clock = $("#clock");
    clock.replaceChildren(...[...str].map((c) => el("span", { class: c === ":" ? "colon" : "d" }, c)));
    clock.setAttribute("aria-label", `${str} left in ${PHASE[t.phase].toLowerCase()}`);
  }
  $("#ruler").style.setProperty("--done", Math.min(1, Math.max(0, 1 - rem / dur)).toFixed(4));
  document.title = t.running ? `${str} · ${PHASE[t.phase]} · Lamplight` : `Lamplight · ${S.room}`;
}
function lastText(t) {
  const l = t.last;
  if (!l) return "Anyone in the room can start or pause the timer.";
  const who = l.by === me.name ? "You" : l.by;
  const ph = PHASE[t.phase].toLowerCase();
  const text = {
    started: `${who} started ${ph}`,
    paused: `${who} paused ${ph}`,
    reset: `${who} reset the timer`,
    "skipped to": `${who} skipped to ${ph}`,
    "switched to": `${who} switched to ${ph}`,
    "changed the timer": `${who} changed the timer`,
    finished: t.running ? `${PHASE[t.phase]} started on its own` : "Last session finished",
  }[l.action] || "";
  return `${text} · ${relTime(l.at)}`;
}
function onTimerDone(m) {
  sound.chime();
  const msg = m.ended === "focus" ? "Focus session done. Time for a break." : "Break's over. Back to it.";
  toast(msg);
  try {
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      new Notification("Lamplight", { body: msg, icon: "/favicon.svg" });
    }
  } catch {}
}

// ---------- tasks ----------
function renderTasks() {
  if (S.editing) { S.tasksDirty = true; return; }
  const list = $("#task-list");
  list.replaceChildren();
  let items = S.tasks;
  if (S.filter === "mine") items = items.filter((t) => t.key === me.key);
  if (S.filter === "open") items = items.filter((t) => !t.done);
  for (const task of items) list.append(taskItem(task));
  const done = S.tasks.filter((t) => t.done).length;
  $("#task-count").textContent = S.tasks.length ? `${done} of ${S.tasks.length} done` : "";
  const empty = $("#task-empty");
  empty.hidden = items.length > 0;
  empty.textContent = !S.tasks.length
    ? "No tasks yet. Add the first thing you want to get through this session."
    : S.filter === "mine" ? "You haven't added any tasks yet." : "Everything's done. Nice work.";
  $("#clear-done").hidden = done === 0;
  for (const b of $$("[data-filter]")) b.setAttribute("aria-selected", String(b.dataset.filter === S.filter));
}
function taskItem(task) {
  const mine = task.key === me.key;
  const text = el("div", { class: "task-text", title: "Double-click to edit" }, task.text);
  const doneNote = task.done && task.doneBy && task.doneBy !== task.by ? ` · checked off by ${task.doneBy === me.name ? "you" : task.doneBy}` : "";
  const body = el("div", {}, text,
    el("div", { class: "task-meta" }, el("span", { class: "dot", style: `--c:${task.color}` }), mine ? "You" : task.by, doneNote));
  text.addEventListener("dblclick", () => editTask(task, body, text));
  return el("li", { class: "task" + (task.done ? " done" : "") },
    el("button", { class: "task-check", type: "button", "aria-label": task.done ? "Mark as not done" : "Mark as done",
      onclick: () => send({ t: "task:toggle", id: task.id }) }, icon("check")),
    body,
    el("button", { class: "task-del", type: "button", "aria-label": "Delete task",
      onclick: () => send({ t: "task:delete", id: task.id }) }, icon("x")));
}
function editTask(task, body, text) {
  S.editing = task.id;
  const input = el("input", { class: "task-edit", maxlength: "200", value: task.text, "aria-label": "Edit task" });
  text.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const v = input.value.trim();
    if (save && v && v !== task.text) send({ t: "task:edit", id: task.id, text: v });
    S.editing = null;
    S.tasksDirty = false;
    renderTasks();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

// ---------- chat ----------
let lastMsg = null;
function renderChat() {
  const log = $("#chat-log");
  log.replaceChildren();
  lastMsg = null;
  if (!S.chat.length) log.append(el("li", { class: "chat-empty" }, "Say hi. Messages stay in the room for the next person who joins."));
  for (const m of S.chat) appendChat(m, true);
  log.scrollTop = log.scrollHeight;
}
function parseYouTube(s) {
  s = (s || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(/^https?:\/\//.test(s) ? s : "https://" + s);
    const h = u.hostname.replace(/^(www|m|music)\./, "");
    const ok = (v) => (/^[\w-]{11}$/.test(v || "") ? v : null);
    if (h === "youtu.be") return ok(u.pathname.slice(1, 12));
    if (h === "youtube.com" || h === "youtube-nocookie.com") {
      if (u.searchParams.get("v")) return ok(u.searchParams.get("v"));
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}
function linkify(text) {
  const out = [];
  const re = /\bhttps?:\/\/[^\s<>"]+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const url = m[0].replace(/[),.!?]+$/, "");
    out.push(text.slice(last, m.index));
    out.push(el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url));
    const vid = parseYouTube(url);
    if (vid) out.push(el("button", { class: "inline-btn", type: "button", onclick: () => loadVideo(vid) }, "Play on stage"));
    last = m.index + url.length;
  }
  out.push(text.slice(last));
  return out;
}
function appendChat(m, bulk) {
  const log = $("#chat-log");
  $(".chat-empty", log)?.remove();
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  let li;
  if (m.sys) {
    li = el("li", { class: "msg sys" }, m.text, el("time", {}, clockTime(m.at)));
    lastMsg = null;
  } else {
    const first = !(lastMsg && lastMsg.key === m.key && m.at - lastMsg.at < 5 * 60e3);
    const mine = m.key === me.key;
    li = el("li", { class: "msg" + (first ? " first" : "") },
      el("span", { class: "avatar", style: `--c:${m.color}` }, initial(m.name)),
      first ? el("div", { class: "msg-head" }, el("b", {}, mine ? "You" : m.name), el("time", { datetime: new Date(m.at).toISOString() }, clockTime(m.at))) : null,
      el("div", { class: "msg-text" }, ...linkify(m.text)));
    lastMsg = m;
  }
  log.append(li);
  if (bulk) return;
  if (nearBottom || m.key === me.key) log.scrollTop = log.scrollHeight;
  if (!m.sys && m.key !== me.key && isPhone() && S.tab !== "chat") {
    S.unread++;
    const b = $("#chat-badge");
    b.textContent = S.unread > 9 ? "9+" : S.unread;
    b.hidden = false;
  }
}

// ---------- sound ----------
const TRACK_NAME = { lofi: "Lo-fi beats", rain: "Rain", fire: "Fireplace", brown: "Brown noise" };
function applySound(snd) {
  S.sound = snd || {};
  if (S.entered) {
    const want = S.sound.playing && S.sound.track && !S.soundMuted ? S.sound.track : null;
    if (want) sound.play(want);
    else sound.stop();
  }
  renderSound();
}
function renderSound() {
  const { track, playing, by } = S.sound;
  for (const b of $$("#tracks button")) b.setAttribute("aria-pressed", String(!!playing && track === b.dataset.track));
  $("#sound-stop").hidden = !playing;
  const mute = $("#sound-mute");
  setIcon(mute, S.soundMuted ? "vol-x" : "vol");
  mute.dataset.off = String(S.soundMuted);
  mute.setAttribute("aria-label", S.soundMuted ? "Unmute for me" : "Mute for me");
  $("#sound-by").textContent = playing
    ? `${TRACK_NAME[track]}, put on by ${by === me.name ? "you" : by}.${S.soundMuted ? " Muted for you only." : " Volume is just for you."}`
    : "Pick a sound to play for the room. Volume is just for you.";
}

// ---------- watch together (YouTube) ----------
const yt = { player: null, ready: false, api: null, loadedId: null, suppressUntil: 0, lastCur: 0, lastWall: 0, pending: null, blocked: false };
function loadYTApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (!yt.api) {
    yt.api = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = resolve;
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.onerror = () => { yt.api = null; toast("Couldn't load YouTube. An ad or script blocker may be stopping it.", "error"); };
      document.head.append(s);
    });
  }
  return yt.api;
}
function expectedPos() {
  const v = S.video;
  return v.playing ? v.pos + (serverNow() - v.at) / 1000 : v.pos;
}
function loadVideo(videoId) {
  send({ t: "video:load", videoId });
  if (isPhone()) setTab("stage");
}
function destroyPlayer() {
  try { yt.player?.destroy(); } catch {}
  yt.player = null;
  yt.ready = false;
  yt.loadedId = null;
  yt.blocked = false;
  yt.failed = false;
}
async function applyVideo() {
  renderStage();
  const v = S.video;
  if (!v?.videoId || !S.entered) return;
  await loadYTApi();
  if (!S.video.videoId) return;
  if (!yt.player) {
    const mount = $("#yt-mount");
    if (!mount) return;
    yt.loadedId = v.videoId;
    yt.ready = false;
    yt.player = new YT.Player(mount, {
      videoId: v.videoId,
      width: "100%",
      height: "100%",
      playerVars: { autoplay: v.playing ? 1 : 0, start: Math.floor(expectedPos()), playsinline: 1, rel: 0 },
      events: {
        onReady: () => { yt.ready = true; syncPlayer(); reportTitle(); },
        onStateChange: onYTState,
        onError: () => { yt.blocked = false; yt.failed = true; renderBlocked(); toast("YouTube won't play this video here. Its owner may have turned off embedding.", "error"); },
      },
    });
    return;
  }
  if (!yt.ready) return;
  if (yt.loadedId !== S.video.videoId) {
    yt.loadedId = S.video.videoId;
    yt.failed = false;
    yt.suppressUntil = Date.now() + 2000;
    yt.player.loadVideoById({ videoId: S.video.videoId, startSeconds: expectedPos() });
    setTimeout(() => { syncPlayer(); reportTitle(); }, 1500);
    return;
  }
  syncPlayer();
}
function syncPlayer() {
  const p = yt.player;
  if (!p || !yt.ready || !S.video.videoId) return;
  const v = S.video;
  const exp = expectedPos();
  const cur = p.getCurrentTime?.() || 0;
  const st = p.getPlayerState?.();
  yt.suppressUntil = Date.now() + 1200;
  if (Math.abs(cur - exp) > (v.playing ? 1.5 : 0.75)) p.seekTo(exp, true);
  if (v.playing && st !== 1 && st !== 3) p.playVideo();
  if (!v.playing && (st === 1 || st === 3)) p.pauseVideo();
  yt.lastCur = exp;
  yt.lastWall = Date.now();
  if (v.playing) setTimeout(checkBlocked, 2500);
  else if (yt.blocked) { yt.blocked = false; renderBlocked(); }
}
function checkBlocked() {
  const p = yt.player;
  if (!p || !yt.ready || !S.video.playing || yt.failed) return;
  const st = p.getPlayerState();
  yt.blocked = st !== 1 && st !== 3;
  renderBlocked();
}
function renderBlocked() {
  const cover = $("#yt-cover");
  if (cover) cover.hidden = !yt.blocked;
}
function reportTitle() {
  if (S.video.title) return;
  const t = yt.player?.getVideoData?.()?.title;
  if (t) send({ t: "video:title", videoId: S.video.videoId, title: t });
}
// A page that's closing or reloading tears the player down, which fires a
// "paused" event. Never broadcast that to the room.
let leaving = false;
addEventListener("pagehide", () => { leaving = true; });
addEventListener("beforeunload", () => { leaving = true; });
function sendVideoState(playing, pos) {
  if (leaving) return;
  S.video = { ...S.video, playing, pos, at: serverNow() };
  send({ t: "video:state", videoId: S.video.videoId, playing, pos });
}
function onYTState(e) {
  if (e.data === 1 && yt.blocked) { yt.blocked = false; renderBlocked(); }
  if (Date.now() < yt.suppressUntil) return;
  if (e.data !== 1 && e.data !== 2) return;
  clearTimeout(yt.pending);
  yt.pending = setTimeout(() => {
    const p = yt.player;
    if (!p || Date.now() < yt.suppressUntil) return;
    const st = p.getPlayerState();
    if (st === 0) return;
    const playing = st === 1 || st === 3;
    const cur = p.getCurrentTime();
    if (playing !== S.video.playing || Math.abs(cur - expectedPos()) > 2) sendVideoState(playing, cur);
    yt.lastCur = cur;
    yt.lastWall = Date.now();
  }, 350);
}
function pollVideo() {
  const p = yt.player;
  if (!p || !yt.ready || !S.video.videoId) return;
  const now = Date.now();
  const cur = p.getCurrentTime?.() || 0;
  if (now < yt.suppressUntil) { yt.lastCur = cur; yt.lastWall = now; return; }
  const st = p.getPlayerState();
  if (st === 1 && S.video.playing) {
    const predicted = yt.lastCur + (now - yt.lastWall) / 1000;
    if (Math.abs(cur - predicted) > 2) sendVideoState(true, cur); // someone scrubbed here
    else if (Math.abs(cur - expectedPos()) > 2.5) syncPlayer(); // drifted
  } else if (st === 2 && !S.video.playing && Math.abs(cur - S.video.pos) > 1.5) {
    sendVideoState(false, cur); // scrubbed while paused
  }
  yt.lastCur = cur;
  yt.lastWall = now;
}

// ---------- stage (video, screens, cameras) ----------
const tileEls = new Map();
function stageTiles() {
  const tiles = [];
  if (S.video?.videoId) tiles.push({ key: "yt", type: "yt" });
  const cs = call.state();
  for (const m of S.members) {
    if (!m.call) continue;
    const self = m.id === S.you;
    if (m.screen) tiles.push({ key: "screen:" + m.id, type: "screen", m, self, stream: self ? cs.screenStream : call.stream(m.screen) });
  }
  for (const m of S.members) {
    if (!m.call) continue;
    const self = m.id === S.you;
    if (m.cam) tiles.push({ key: "cam:" + m.id, type: "cam", m, self, stream: self ? cs.camStream : call.stream(m.cam) });
  }
  return tiles;
}
function chooseSpot(tiles) {
  if (S.pinned && tiles.some((t) => t.key === S.pinned)) return S.pinned;
  return (tiles.find((t) => t.type === "screen" && !t.self) || tiles.find((t) => t.type === "yt") ||
    tiles.find((t) => t.type === "screen") || tiles.find((t) => t.type === "cam" && !t.self) || tiles[0])?.key;
}
function makeTile(t) {
  if (t.type === "yt") {
    return el("div", { class: "tile yt", "data-key": "yt" },
      el("div", { id: "yt-mount", class: "yt-mount" }),
      el("div", { class: "tile-cover", id: "yt-cover", hidden: true },
        el("button", { type: "button", onclick: () => { yt.blocked = false; renderBlocked(); syncPlayer(); yt.player?.playVideo(); } }, icon("play"), "Start watching")));
  }
  const video = el("video", { autoplay: true, playsinline: true });
  video.muted = true; // audio plays through the call's audio elements
  const node = el("div", { class: `tile ${t.type}${t.self ? " self" : ""}`, "data-key": t.key },
    video,
    el("div", { class: "tile-wait" }, "Connecting…"),
    el("span", { class: "tile-label" }),
    el("div", { class: "tile-tools" },
      el("button", { type: "button", "aria-label": "Full screen", onclick: () => node.requestFullscreen?.().catch(() => {}) }, icon("expand"))));
  node.addEventListener("click", (e) => {
    if (e.target.closest(".tile-tools") || node.classList.contains("spot")) return;
    S.pinned = t.key;
    renderStage();
  });
  return node;
}
function updateTile(node, t) {
  if (t.type === "yt") return;
  const who = t.self ? "You" : t.m.name;
  node.querySelector(".tile-label").textContent = t.type === "screen" ? (t.self ? "Your screen" : `${who}'s screen`) : who;
  if (t.type === "cam") node.dataset.speaker = t.m.id;
  const video = node.querySelector("video");
  if (t.stream && video.srcObject !== t.stream) {
    video.srcObject = t.stream;
    video.play().catch(() => {});
  }
  const live = t.stream?.getVideoTracks().some((tr) => tr.readyState === "live");
  node.querySelector(".tile-wait").hidden = !!live;
}
function renderStage() {
  const grid = $("#stage-grid");
  if (!grid) return;
  const tiles = stageTiles();
  const keys = new Set(tiles.map((t) => t.key));
  for (const [k, node] of tileEls) {
    if (keys.has(k)) continue;
    if (k === "yt") destroyPlayer();
    node.remove();
    tileEls.delete(k);
  }
  const spot = chooseSpot(tiles);
  for (const t of tiles) {
    let node = tileEls.get(t.key);
    if (!node) {
      node = makeTile(t);
      tileEls.set(t.key, node);
      grid.append(node);
    }
    updateTile(node, t);
    node.classList.toggle("spot", t.key === spot);
  }
  grid.classList.toggle("split", tiles.length > 1);
  grid.style.setProperty("--rows", Math.max(1, tiles.length - 1));
  $("#stage").classList.toggle("live", tiles.length > 0);
  $("#stage-empty").hidden = tiles.length > 0 || !$("#yt-form").hidden;

  const v = S.video;
  $("#yt-bar").hidden = !v?.videoId;
  if (v?.videoId) {
    const title = $("#yt-title");
    title.replaceChildren(el("b", {}, v.title || "YouTube video"), ` · put on by ${v.by === me.name ? "you" : v.by}`);
  }
  const cs = call.state();
  const scr = $("#stage-screen");
  scr.setAttribute("aria-pressed", String(!!cs.screen));
  scr.querySelector("span").textContent = cs.screen ? "Stop sharing" : "Share screen";
  const cam = $("#stage-cam");
  cam.setAttribute("aria-pressed", String(!!cs.cam));
  cam.querySelector("span").textContent = cs.cam ? "Camera off" : "Camera";
  if (!tiles.length) $("#stage-badge").hidden = true;
}
function badgeStage() {
  if (!isPhone() || S.tab === "stage") return;
  const b = $("#stage-badge");
  b.textContent = "!";
  b.hidden = false;
}

// ---------- call ----------
function renderCall() {
  const cs = call.state();
  $("#call-join").hidden = cs.inCall;
  $("#call-controls").hidden = !cs.inCall;
  const others = S.members.filter((m) => m.call && m.id !== S.you).length;
  $("#call-join").title = others ? `${others} in the call now` : "Nobody's in the call yet";
  const mic = $("#call-mic");
  const micOff = cs.muted || !cs.hasMic;
  setIcon(mic, micOff ? "mic-off" : "mic");
  mic.dataset.off = String(micOff);
  mic.setAttribute("aria-label", !cs.hasMic ? "No microphone" : cs.muted ? "Unmute microphone" : "Mute microphone");
  mic.title = mic.getAttribute("aria-label");
  const cam = $("#call-cam");
  setIcon(cam, cs.cam ? "cam" : "cam-off");
  cam.dataset.on = String(!!cs.cam);
  cam.setAttribute("aria-label", cs.cam ? "Turn camera off" : "Turn camera on");
  cam.title = cam.getAttribute("aria-label");
  const scr = $("#call-screen");
  scr.dataset.on = String(!!cs.screen);
  scr.setAttribute("aria-label", cs.screen ? "Stop sharing screen" : "Share screen");
  scr.title = scr.getAttribute("aria-label");
}
async function joinCall() {
  const r = await call.join();
  if (r.error) toast(r.error, "error");
}
async function toggleCam() {
  const r = await call.toggleCamera();
  if (r.error) toast(r.error, "error");
  else if (isPhone() && call.state().cam) setTab("stage");
}
async function toggleScreen() {
  const r = await call.toggleScreen();
  if (r.error) toast(r.error, "error");
}

// Remote audio (voices and shared-tab sound) plays through hidden <audio> elements.
const audioEls = new Map();
function renderAudio() {
  const sink = $("#audio-sink");
  const want = new Map();
  for (const m of S.members) {
    if (!m.call || m.id === S.you) continue;
    for (const sid of [m.mic, m.screen]) {
      const st = sid && call.stream(sid);
      if (st && st.getAudioTracks().length) want.set(sid, st);
    }
  }
  for (const [sid, a] of audioEls) {
    if (want.has(sid)) continue;
    a.srcObject = null;
    a.remove();
    audioEls.delete(sid);
  }
  for (const [sid, st] of want) {
    let a = audioEls.get(sid);
    if (!a) {
      a = el("audio", { autoplay: true });
      sink.append(a);
      audioEls.set(sid, a);
    }
    if (a.srcObject !== st) {
      a.srcObject = st;
      a.play().catch(() => {});
    }
  }
}

// Light up whoever is talking.
const meters = new Map();
function speakingLoop() {
  if (!S.entered) return;
  const cs = call.state();
  const seen = new Set();
  for (const m of S.members) {
    let speaking = false;
    const stream = m.call && !m.muted ? (m.id === S.you ? cs.micStream : call.stream(m.mic)) : null;
    if (stream && stream.getAudioTracks().length) {
      seen.add(stream.id);
      let meter = meters.get(stream.id);
      if (!meter) {
        try {
          const ac = sound.audioContext();
          const an = ac.createAnalyser();
          an.fftSize = 512;
          ac.createMediaStreamSource(stream).connect(an);
          meter = { an, buf: new Float32Array(an.fftSize) };
          meters.set(stream.id, meter);
        } catch { meter = null; }
      }
      if (meter) {
        meter.an.getFloatTimeDomainData(meter.buf);
        let sum = 0;
        for (const x of meter.buf) sum += x * x;
        speaking = Math.sqrt(sum / meter.buf.length) > 0.035;
      }
    }
    for (const node of $$(`[data-speaker="${m.id}"]`)) node.classList.toggle("speaking", speaking);
  }
  for (const id of meters.keys()) if (!seen.has(id)) meters.delete(id);
}

// ---------- tabs (phones) ----------
const isPhone = () => matchMedia("(max-width: 760px)").matches;
function setTab(tab) {
  S.tab = tab;
  $("#grid").dataset.tab = tab;
  for (const b of $$("#tabbar button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  if (tab === "chat") {
    S.unread = 0;
    $("#chat-badge").hidden = true;
    const log = $("#chat-log");
    requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
  }
  if (tab === "stage") $("#stage-badge").hidden = true;
}

// ---------- wiring ----------
function wireRoom() {
  $("#copy-link").addEventListener("click", async () => {
    const url = `${location.origin}/r/${S.room}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Invite link copied. Send it to a friend.");
    } catch {
      toast(url);
    }
  });

  // timer
  $("#timer-toggle").addEventListener("click", () => {
    if (!S.timer) return;
    send({ t: S.timer.running ? "timer:pause" : "timer:start" });
    try {
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    } catch {}
  });
  $("#timer-reset").addEventListener("click", () => send({ t: "timer:reset" }));
  $("#timer-skip").addEventListener("click", () => send({ t: "timer:skip" }));
  for (const b of $$(".phase-tabs button")) b.addEventListener("click", () => {
    if (S.timer?.phase !== b.dataset.phase) send({ t: "timer:phase", phase: b.dataset.phase });
  });
  const settings = $("#timer-settings");
  const settingsBtn = $("#timer-settings-btn");
  const closeSettings = () => { settings.hidden = true; settingsBtn.setAttribute("aria-expanded", "false"); };
  settingsBtn.addEventListener("click", () => {
    if (!settings.hidden) return closeSettings();
    const t = S.timer;
    if (!t) return;
    $("#set-focus").value = Math.round(t.durations.focus / 60);
    $("#set-short").value = Math.round(t.durations.short / 60);
    $("#set-long").value = Math.round(t.durations.long / 60);
    $("#set-every").value = t.longEvery;
    $("#set-auto").checked = t.autoStart;
    settings.hidden = false;
    settingsBtn.setAttribute("aria-expanded", "true");
  });
  $("#timer-settings-cancel").addEventListener("click", closeSettings);
  settings.addEventListener("submit", (e) => {
    e.preventDefault();
    send({
      t: "timer:config",
      focus: $("#set-focus").value, short: $("#set-short").value, long: $("#set-long").value,
      longEvery: $("#set-every").value, autoStart: $("#set-auto").checked,
    });
    closeSettings();
    toast("Timer updated for everyone.");
  });

  // sound
  for (const b of $$("#tracks button")) b.addEventListener("click", () => {
    const on = S.sound.playing && S.sound.track === b.dataset.track;
    send({ t: "sound:set", track: on ? null : b.dataset.track });
  });
  $("#sound-stop").addEventListener("click", () => send({ t: "sound:set", track: null }));
  $("#sound-mute").addEventListener("click", () => {
    S.soundMuted = !S.soundMuted;
    store.set("soundMuted", S.soundMuted ? "1" : "0");
    applySound(S.sound);
  });
  const vol = $("#sound-vol");
  vol.value = store.get("vol") ?? 60;
  vol.addEventListener("input", () => {
    sound.setVolume(Number(vol.value) / 100);
    store.set("vol", vol.value);
  });

  // status
  const status = $("#status-input");
  status.value = me.status;
  let statusTimer;
  const pushStatus = () => {
    clearTimeout(statusTimer);
    me.status = status.value.trim();
    store.set("status", me.status);
    send({ t: "profile", status: me.status });
  };
  status.addEventListener("input", () => { clearTimeout(statusTimer); statusTimer = setTimeout(pushStatus, 700); });
  $("#status-form").addEventListener("submit", (e) => { e.preventDefault(); pushStatus(); status.blur(); });

  // tasks
  $("#task-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#task-input");
    const text = input.value.trim();
    if (!text) return;
    send({ t: "task:add", text });
    input.value = "";
  });
  for (const b of $$("[data-filter]")) b.addEventListener("click", () => {
    S.filter = b.dataset.filter;
    store.set("filter", S.filter);
    renderTasks();
  });
  $("#clear-done").addEventListener("click", () => send({ t: "task:clear-done" }));

  // chat
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text) return;
    send({ t: "chat", text });
    input.value = "";
  });

  // stage
  const ytForm = $("#yt-form");
  $("#stage-yt").addEventListener("click", () => {
    ytForm.hidden = !ytForm.hidden;
    $("#yt-error").hidden = true;
    renderStage();
    if (!ytForm.hidden) $("#yt-url").focus();
  });
  ytForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = parseYouTube($("#yt-url").value);
    if (!id) {
      const err = $("#yt-error");
      err.textContent = "Paste a YouTube video link, like youtube.com/watch?v=… or youtu.be/…";
      err.hidden = false;
      return;
    }
    loadVideo(id);
    $("#yt-url").value = "";
    ytForm.hidden = true;
  });
  $("#yt-close").addEventListener("click", () => send({ t: "video:close" }));
  $("#stage-screen").addEventListener("click", toggleScreen);
  $("#stage-cam").addEventListener("click", toggleCam);

  // call
  $("#call-join").addEventListener("click", joinCall);
  $("#call-mic").addEventListener("click", () => {
    if (!call.state().hasMic) return toast("No microphone is connected, so you're listening only.", "error");
    call.toggleMute();
  });
  $("#call-cam").addEventListener("click", toggleCam);
  $("#call-screen").addEventListener("click", toggleScreen);
  $("#call-leave").addEventListener("click", () => call.leave());

  // tabs
  for (const b of $$("#tabbar button")) b.addEventListener("click", () => setTab(b.dataset.tab));

  renderSound();
  renderCall();
}

// ---------- start ----------
if (route && ROOM_RE.test(route[1].toLowerCase())) enterRoom(route[1].toLowerCase());
else showLanding();
