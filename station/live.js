// SOLANG Vision QC — live view of the phone's camera on the review tablet: WebRTC, peer to peer, LOCAL NETWORK ONLY.
// Signaling rides on the Realtime link (link.js): tablet rtc-want{req} → phone rtc-offer{req,sdp} → tablet rtc-answer{req,sdp};
// candidates found later travel as rtc-ice{req,cand}; rtc-fail{req,reason} when the phone cannot stream (no camera, no WebRTC).
// No STUN / TURN on purpose, and both sides exchange ONLY private / link-local / mDNS addresses (privateCandidate / privateSdp drop
// everything else from what is sent and from what is accepted): a peer outside the local network cannot complete ICE even with a
// public address of its own — a stranger holding the public demo key can ask for the stream but cannot receive it.
// The phone keeps its camera track at full capture size for the stills and sends a light encode (~960 px, ≤15 fps, ≤0.8 Mbit/s).
// Binding spec: station/CONTRACTS.md §8.

import { t } from './i18n.js'

const RTC_CONFIG = { iceServers: [] }
const MAX_VIEWERS = 3
const GATHER_MS = 1200                           // host candidates arrive within a few ms; do not wait for the full gathering timeout

export const supported = () => typeof RTCPeerConnection === 'function'
const PRIVATE_RE = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|::1$)/i
export function isPrivateAddr(a) { a = String(a || '').toLowerCase().replace(/^\[|\]$/g, ''); return a.endsWith('.local') || PRIVATE_RE.test(a) }
// an RTCIceCandidateInit, an RTCIceCandidate or an SDP line → true only for a private address (see the header)
export function privateCandidate(c) {
  const s = typeof c === 'string' ? c : (c && c.candidate) || ''
  const m = s.match(/^(?:a=)?candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ/i)
  return !!m && isPrivateAddr(m[1])
}
// a session description with every non-private a=candidate line removed (what we send and what we accept)
export function privateSdp(desc) {
  if (!desc || typeof desc.sdp !== 'string') return desc
  return { type: desc.type, sdp: desc.sdp.split(/\r?\n/).filter(line => !/^a=candidate:/i.test(line) || privateCandidate(line)).join('\r\n') }
}
const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36)
const gatheredOrTimeout = (pc, ms) => new Promise((res) => {
  if (pc.iceGatheringState === 'complete') { res(); return }
  const t = setTimeout(res, ms)
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res() } })
})
async function tune(sender, track) {
  try {
    const p = sender.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}]
    const w = (track.getSettings && track.getSettings().width) || 1280
    Object.assign(p.encodings[0], { maxBitrate: 800000, maxFramerate: 15, scaleResolutionDownBy: Math.max(1, w / 960) })
    await sender.setParameters(p)
  } catch (e) { /* older engines: default encoding */ }
}

// ── phone side: one connection per asking tablet (a tablet that reloads simply asks again; the oldest viewer goes beyond MAX_VIEWERS)
export function makeSender({ send, getStream, onState }) {
  const peers = new Map()                        // req → { pc, pending: [remote candidates before the answer], early: [own candidates before the offer went out], sent }
  const state = (req, s) => { try { onState && onState(req, s) } catch (e) { console.warn('live state handler failed', e) } }
  function drop(req) { const v = peers.get(req); if (!v) return; peers.delete(req); try { v.pc.close() } catch (e) { /* ignore */ } state(req, 'closed') }
  return {
    async makeOffer(req) {
      if (!req) return
      if (!supported()) { send('rtc-fail', { req, reason: t('الموبايل ما بيدعم البث (WebRTC)') }); return }
      const stream = getStream()
      if (!stream || !stream.getVideoTracks().length) { send('rtc-fail', { req, reason: t('الكاميرا مش شغّالة عالموبايل') }); return }
      drop(req)
      if (peers.size >= MAX_VIEWERS) drop(peers.keys().next().value)
      const pc = new RTCPeerConnection(RTC_CONFIG), v = { pc, pending: [], early: [], sent: false }
      peers.set(req, v)
      for (const tr of stream.getVideoTracks()) { const s = pc.addTrack(tr, stream); tune(s, tr) }
      pc.onicecandidate = (e) => { if (!e.candidate || !privateCandidate(e.candidate)) return; const c = e.candidate.toJSON(); if (v.sent) send('rtc-ice', { req, cand: c }); else v.early.push(c) }
      pc.onconnectionstatechange = () => { state(req, pc.connectionState); if (pc.connectionState === 'failed' || pc.connectionState === 'closed') drop(req) }
      try {
        await pc.setLocalDescription(await pc.createOffer())
        await gatheredOrTimeout(pc, GATHER_MS)
        if (peers.get(req) !== v) return         // replaced while gathering
        send('rtc-offer', { req, sdp: privateSdp(pc.localDescription.toJSON()) })
        v.sent = true; v.early.forEach((c) => send('rtc-ice', { req, cand: c })); v.early = []
      } catch (e) { send('rtc-fail', { req, reason: t('ما قدرت جهّز البث: ') + ((e && e.message) || e) }); drop(req) }
    },
    async onAnswer(req, sdp) {
      const v = peers.get(req); if (!v || !sdp || v.pc.signalingState !== 'have-local-offer') return
      try {
        await v.pc.setRemoteDescription(privateSdp(sdp))
        for (const c of v.pending) { try { await v.pc.addIceCandidate(c) } catch (e) { /* unreachable candidate */ } }
        v.pending = []
      } catch (e) { drop(req) }
    },
    async onIce(req, cand) {
      const v = peers.get(req); if (!v || !cand || !privateCandidate(cand)) return
      if (!v.pc.remoteDescription) { v.pending.push(cand); return }
      try { await v.pc.addIceCandidate(cand) } catch (e) { /* unreachable candidate */ }
    },
    // the camera was restarted (flip / revived): every viewer gets the new track, no renegotiation
    replaceTrack(track) { if (!track) return; for (const v of peers.values()) for (const s of v.pc.getSenders()) if (s.track && s.track.kind === 'video') { s.replaceTrack(track).catch(() => {}); tune(s, track) } },
    viewers() { let n = 0; for (const v of peers.values()) if (v.pc.connectionState === 'connected') n++; return n },
    closeAll() { for (const req of [...peers.keys()]) drop(req) },
  }
}

// ── tablet side: asks, answers, shows. live() is true only while frames are actually arriving.
export function makeViewer({ send, video, onState }) {
  let pc = null, req = null, askedAt = 0, pending = [], track = null, lastReason = '', fails = 0, tl = {}   // tl: when the offer / answer / connection / first frame happened
  const state = (s) => { try { onState && onState(s) } catch (e) { console.warn('live state handler failed', e) } }
  function teardown() {
    if (pc) { try { pc.close() } catch (e) { /* ignore */ } }
    pc = null; track = null; pending = []
    try { video.srcObject = null } catch (e) { /* ignore */ }
  }
  return {
    supported,
    ask() {
      if (!supported()) return
      if (askedAt) fails++                       // every ask after the first one means the previous attempt never showed a frame
      teardown(); req = newId(); askedAt = Date.now(); tl = {}; send('rtc-want', { req }); state('asked')
    },
    askedAt: () => askedAt,
    // seconds since the ask, and at which second the offer / answer / connection / first frame arrived (null = not yet)
    timeline: () => ({ since: askedAt ? (Date.now() - askedAt) / 1000 : 0, offer: tl.offer ? (tl.offer - askedAt) / 1000 : null, answer: tl.answer ? (tl.answer - askedAt) / 1000 : null, connected: tl.connected ? (tl.connected - askedAt) / 1000 : null, track: tl.track ? (tl.track - askedAt) / 1000 : null }),
    // a specific failure, or — after a silent attempt — the one thing that usually fixes it
    reason: () => lastReason || (fails >= 1 ? t('البث ما وصل بعد — الجهازين لازم يكونوا على نفس الواي فاي') : ''),
    async onOffer(r, sdp) {
      if (!r || r !== req || !sdp) return
      tl.offer = Date.now()
      teardown()
      const mine = new RTCPeerConnection(RTC_CONFIG); pc = mine
      mine.ontrack = (e) => { if (pc !== mine) return; track = e.track; video.srcObject = (e.streams && e.streams[0]) || new MediaStream([e.track]); video.play().catch(() => {}); fails = 0; lastReason = ''; tl.track = Date.now(); state('track') }
      mine.onicecandidate = (e) => { if (e.candidate && pc === mine && privateCandidate(e.candidate)) send('rtc-ice', { req: r, cand: e.candidate.toJSON() }) }
      mine.onconnectionstatechange = () => { if (pc !== mine) return; if (mine.connectionState === 'connected') tl.connected = Date.now(); state(mine.connectionState); if (mine.connectionState === 'failed') { lastReason = t('الشبكة ما سمحت بالاتصال المباشر بين الجهازين (واي فاي منفصل أو عزل بين الأجهزة)'); teardown() } }
      try {
        await mine.setRemoteDescription(privateSdp(sdp))
        for (const c of pending) { try { await mine.addIceCandidate(c) } catch (e) { /* unreachable candidate */ } }
        pending = []
        await mine.setLocalDescription(await mine.createAnswer())
        if (pc !== mine) return
        send('rtc-answer', { req: r, sdp: privateSdp(mine.localDescription.toJSON()) }); tl.answer = Date.now()
      } catch (e) { lastReason = t('ما قدرت أفتح البث: ') + ((e && e.message) || e); if (pc === mine) teardown(); state('failed') }
    },
    async onIce(r, cand) {
      if (r !== req || !cand || !privateCandidate(cand)) return
      if (!pc || !pc.remoteDescription) { pending.push(cand); return }
      try { await pc.addIceCandidate(cand) } catch (e) { /* unreachable candidate */ }
    },
    onFail(r, reason) { if (r !== req) return; lastReason = reason || t('الموبايل ما قدر يبعت البث'); teardown(); state('failed') },
    live() { return !!(pc && pc.connectionState === 'connected' && track && track.readyState === 'live' && !track.muted && video.readyState >= 2) },
    connecting() { return !!pc || (!!req && Date.now() - askedAt < 8000) },
    close() { teardown(); req = null; askedAt = 0; fails = 0; lastReason = ''; state('closed') },
  }
}
