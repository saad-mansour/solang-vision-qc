// SOLANG Vision QC — two-device link (camera phone ⇄ review tablet) over Supabase Realtime *broadcast*.
// No table, no SQL, no client library: one WebSocket per device speaking the Phoenix protocol on the topic
// `realtime:vqc:<station>` of the demo project. Messages are fire-and-forget (at most once, nothing is stored):
// the sender shows «ما ردّ» when no answer comes back. Binding spec: station/CONTRACTS.md §7.
//
//   const link = openLink({ url, key, station, onMessage(event, payload), onStatus(status) })
//   link.send(event, payload) → true when the message left on a joined channel, false otherwise
//   link.connected() → boolean · link.close()
//   status: 'connecting' | 'joined' | 'offline' | 'error'   (the link reconnects by itself with backoff, 1 s … 15 s)

const HEARTBEAT_MS = 25000                     // Phoenix drops a socket that stays silent; each heartbeat expects a reply

export function openLink({ url, key, station, onMessage, onStatus }) {
  const topic = 'realtime:vqc:' + String(station || 'final-qc-1').replace(/[^\w.-]/g, '_')
  const wsUrl = String(url || '').replace(/\/+$/, '').replace(/^http/i, 'ws') + '/realtime/v1/websocket?apikey=' + encodeURIComponent(key) + '&vsn=1.0.0'
  const doc = typeof document !== 'undefined' ? document : null, win = typeof window !== 'undefined' ? window : null
  let ws = null, joined = false, closed = false, ref = 0, tries = 0, hbTimer = null, reTimer = null, pongMissed = 0
  const status = (s) => { try { onStatus && onStatus(s) } catch (e) { console.warn('link status handler failed', e) } }
  const push = (m) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true } return false }

  function connect() {
    if (closed) return
    clearTimeout(reTimer); clearInterval(hbTimer); joined = false; pongMissed = 0
    status('connecting')
    let sock
    try { sock = new WebSocket(wsUrl) } catch (e) { status('error'); retry(); return }
    ws = sock
    sock.onopen = () => {
      ref = 0                                    // join ref is always '1' on a fresh socket
      push({ topic, event: 'phx_join', payload: { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, postgres_changes: [], private: false }, access_token: key }, ref: String(++ref), join_ref: '1' })
      hbTimer = setInterval(() => {
        if (pongMissed >= 2) { try { sock.close() } catch (e) { /* ignore */ } return }   // two silent heartbeats = dead socket → reconnect
        pongMissed++; push({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) })
      }, HEARTBEAT_MS)
    }
    sock.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data) } catch (e) { return }
      if (d.topic === 'phoenix') { pongMissed = 0; return }
      if (d.event === 'phx_reply' && d.ref === '1' && !joined) {
        if (d.payload && d.payload.status === 'ok') { joined = true; tries = 0; status('joined') }
        else { status('error'); try { sock.close() } catch (e) { /* ignore */ } }
        return
      }
      if ((d.event === 'phx_error' || d.event === 'phx_close') && d.topic === topic) { try { sock.close() } catch (e) { /* ignore */ } return }   // the channel died: reconnect
      if (d.event === 'broadcast' && d.payload && onMessage) {
        try { onMessage(String(d.payload.event || ''), d.payload.payload || {}) } catch (e) { console.warn('link message handler failed', e) }
      }
    }
    sock.onerror = () => { /* onclose follows */ }
    sock.onclose = () => { if (ws !== sock) return; ws = null; joined = false; clearInterval(hbTimer); status('offline'); retry() }
  }
  function retry() { if (closed) return; clearTimeout(reTimer); reTimer = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(tries++, 4))) }
  // back from the background / network is back: do not wait for the backoff timer
  const wake = () => { if (!closed && !joined && !ws && (!doc || doc.visibilityState === 'visible')) { tries = 0; connect() } }
  if (doc) doc.addEventListener('visibilitychange', wake)
  if (win) win.addEventListener('online', wake)
  connect()

  return {
    send(event, payload) { return joined && push({ topic, event: 'broadcast', payload: { type: 'broadcast', event, payload: payload || {} }, ref: String(++ref) }) },
    connected() { return joined },
    close() {
      closed = true; clearTimeout(reTimer); clearInterval(hbTimer)
      if (doc) doc.removeEventListener('visibilitychange', wake)
      if (win) win.removeEventListener('online', wake)
      const s = ws; ws = null; joined = false
      if (s) { try { s.close() } catch (e) { /* ignore */ } }
    },
  }
}
