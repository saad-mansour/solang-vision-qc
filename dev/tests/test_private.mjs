// live.js address filters (pure, no WebRTC needed). Run: node dev/tests/test_private.mjs
import { isPrivateAddr, privateCandidate, privateSdp } from '../../station/live.js'

let fail = 0
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fail++ }

for (const a of ['192.168.1.20', '10.0.0.5', '172.16.4.1', '172.31.255.9', '169.254.3.3', '127.0.0.1', 'fe80::1c2b:3d4e', 'fd12:3456::1', 'FC00::1', 'a1b2c3d4-1234-5678-9abc-def012345678.local', '[fe80::1]']) check(isPrivateAddr(a), `private: ${a}`)
for (const a of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '2a00:1450:4001::1', 'example.com', '', null, '193.0.14.129']) check(!isPrivateAddr(a), `public / not private: ${a}`)

const host = 'candidate:842163049 1 udp 1677729535 192.168.1.20 54400 typ host generation 0 ufrag abcd network-id 1'
const pub = 'candidate:842163049 1 udp 1677729535 193.0.14.129 54400 typ host generation 0 ufrag abcd network-id 1'
const mdns = 'candidate:1 1 udp 2113937151 b3a1d2c4-0000-1111-2222-333344445555.local 61234 typ host generation 0 ufrag abcd'
const srflx = 'candidate:2 1 udp 1686052607 85.1.2.3 61234 typ srflx raddr 192.168.1.20 rport 61234 generation 0'
check(privateCandidate({ candidate: host, sdpMid: '0' }), 'host candidate on 192.168.x as RTCIceCandidateInit')
check(privateCandidate('a=' + host), 'host candidate as an SDP line')
check(privateCandidate(mdns), 'mDNS .local host candidate')
check(!privateCandidate(pub), 'public host candidate is dropped')
check(!privateCandidate(srflx), 'server-reflexive candidate with a public address is dropped')
check(!privateCandidate(null) && !privateCandidate({}) && !privateCandidate('garbage'), 'malformed candidates are dropped')

const sdp = ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=' + host, 'a=' + pub, 'a=' + mdns, 'a=end-of-candidates'].join('\r\n')
const out = privateSdp({ type: 'offer', sdp })
check(out.type === 'offer' && out.sdp.includes('a=' + host) && out.sdp.includes('a=' + mdns) && !out.sdp.includes('193.0.14.129') && out.sdp.includes('a=end-of-candidates'), 'privateSdp keeps private + mDNS lines, drops the public one, keeps the rest')
check(privateSdp(null) === null && privateSdp({ type: 'answer' }).type === 'answer', 'privateSdp tolerates missing sdp')

console.log(fail ? `\n${fail} check(s) failed` : '\nall private-address checks passed')
process.exit(fail ? 1 : 0)
