// Voice, camera and screen share over a peer-to-peer WebRTC mesh.
// The room's WebSocket relays offers, answers and ICE candidates.
// Each pair of peers uses the "perfect negotiation" pattern so either side
// can add or remove tracks at any time without glare.

const ICE = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

export function createCall({ send, onChange }) {
  const peers = new Map(); // peerId -> { pc, polite, makingOffer, ignoreOffer, senders, streams }
  const remoteStreams = new Map(); // streamId -> MediaStream
  let myId = null;
  let inCall = false;
  let mic = null; // MediaStream (audio)
  let cam = null; // MediaStream (video)
  let screen = null; // MediaStream (video [+ audio])
  let muted = false;

  const state = () => ({
    inCall, muted, hasMic: !!mic,
    cam: cam?.id || null, screen: screen?.id || null,
    camStream: cam, screenStream: screen, micStream: mic,
  });
  const announce = () => {
    send({ t: "call", on: inCall, muted: muted || !mic, mic: mic?.id || null, cam: cam?.id || null, screen: screen?.id || null });
    onChange();
  };

  function localTracks() {
    const out = [];
    for (const s of [mic, cam, screen]) if (s) for (const tr of s.getTracks()) out.push([tr, s]);
    return out;
  }

  function makePeer(peerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const peer = { pc, polite: myId > peerId, makingOffer: false, ignoreOffer: false, senders: new Map() };
    peers.set(peerId, peer);

    for (const [track, stream] of localTracks()) peer.senders.set(track.id, pc.addTrack(track, stream));
    // Always be ready to receive audio and video, even when sending nothing.
    if (!mic) pc.addTransceiver("audio", { direction: "recvonly" });

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        send({ t: "signal", to: peerId, data: { description: pc.localDescription } });
      } catch (e) {
        console.warn("negotiation failed", e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) send({ t: "signal", to: peerId, data: { candidate } });
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] || new MediaStream([track]);
      remoteStreams.set(stream.id, stream);
      track.addEventListener("unmute", onChange);
      track.addEventListener("ended", onChange);
      stream.addEventListener("removetrack", onChange);
      onChange();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") pc.restartIce();
      onChange();
    };
    return peer;
  }

  function closePeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    for (const r of peer.pc.getReceivers()) {
      for (const [sid, s] of remoteStreams) if (s.getTracks().includes(r.track)) remoteStreams.delete(sid);
    }
    peer.pc.close();
    peers.delete(peerId);
  }

  async function onSignal(from, data) {
    if (!inCall) return;
    const peer = peers.get(from) || makePeer(from);
    const { pc } = peer;
    try {
      if (data.description) {
        const offerCollision =
          data.description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === "offer") {
          await pc.setLocalDescription();
          send({ t: "signal", to: from, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (e) {
          if (!peer.ignoreOffer) throw e;
        }
      }
    } catch (e) {
      console.warn("signal error", e);
    }
  }

  // Keep the mesh in line with who is in the call right now.
  function syncMembers(members, you) {
    myId = you;
    const inCallIds = new Set(members.filter((m) => m.call && m.id !== myId).map((m) => m.id));
    for (const id of [...peers.keys()]) if (!inCall || !inCallIds.has(id)) closePeer(id);
    if (!inCall) return;
    for (const id of inCallIds) if (!peers.has(id)) makePeer(id);
  }

  function addStream(stream) {
    for (const peer of peers.values()) {
      for (const track of stream.getTracks()) peer.senders.set(track.id, peer.pc.addTrack(track, stream));
    }
  }
  function removeStream(stream) {
    for (const peer of peers.values()) {
      for (const track of stream.getTracks()) {
        const sender = peer.senders.get(track.id);
        if (sender) {
          try { peer.pc.removeTrack(sender); } catch {}
          peer.senders.delete(track.id);
        }
      }
    }
    stream.getTracks().forEach((t) => t.stop());
  }

  async function join() {
    if (inCall) return { ok: true };
    let error = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      mic = null;
      error = e.name === "NotAllowedError"
        ? "Microphone blocked. You joined to listen only; allow the mic in your browser's site settings to talk."
        : "No microphone found. You joined to listen only.";
    }
    inCall = true;
    muted = false;
    announce();
    return { ok: true, error };
  }

  function leave() {
    if (!inCall) return;
    inCall = false;
    for (const id of [...peers.keys()]) closePeer(id);
    for (const s of [mic, cam, screen]) s?.getTracks().forEach((t) => t.stop());
    mic = cam = screen = null;
    remoteStreams.clear();
    announce();
  }

  function toggleMute() {
    if (!mic) return;
    muted = !muted;
    mic.getAudioTracks().forEach((t) => (t.enabled = !muted));
    announce();
  }

  async function toggleCamera() {
    if (cam) {
      removeStream(cam);
      cam = null;
      announce();
      return {};
    }
    if (!inCall) await join();
    try {
      cam = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
      });
    } catch (e) {
      return { error: e.name === "NotAllowedError" ? "Camera blocked. Allow it in your browser's site settings." : "No camera found." };
    }
    addStream(cam);
    announce();
    return {};
  }

  async function toggleScreen() {
    if (screen) {
      removeStream(screen);
      screen = null;
      announce();
      return {};
    }
    if (!navigator.mediaDevices?.getDisplayMedia) return { error: "This browser can't share its screen. Try Chrome, Edge or Firefox on a computer." };
    if (!inCall) await join();
    try {
      screen = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true, // tab or system audio where the browser supports it
      });
    } catch (e) {
      return {}; // picker cancelled
    }
    const v = screen.getVideoTracks()[0];
    if (v) v.contentHint = "detail";
    v?.addEventListener("ended", () => {
      if (screen) {
        removeStream(screen);
        screen = null;
        announce();
      }
    });
    addStream(screen);
    announce();
    return {};
  }

  // Close everything that belonged to the old socket; we'll rebuild after reconnect.
  function resetConnections() {
    for (const id of [...peers.keys()]) closePeer(id);
    remoteStreams.clear();
  }

  return {
    state, join, leave, toggleMute, toggleCamera, toggleScreen,
    onSignal, syncMembers, resetConnections, announce,
    stream: (id) => remoteStreams.get(id) || null,
    streams: () => remoteStreams,
    peerState: (id) => peers.get(id)?.pc.connectionState || null,
  };
}
