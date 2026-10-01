import { describe, it, expect } from 'vitest';
import { openWhepPeer } from '../peer.js';

describe('openWhepPeer — the offer Ring receives', () => {
  it('offers receive-only H.264 video and Opus audio, as Ring\'s WHEP docs require', async () => {
    const peer = await openWhepPeer({ videoPort: 15004, audioPort: 15006 }, { iceServers: [] });
    try {
      const sdp = peer.offer;
      expect(sdp).toMatch(/m=video \d+ UDP\/TLS\/RTP\/SAVPF 96/);
      expect(sdp).toContain('a=rtpmap:96 H264/90000');
      expect(sdp).toContain('packetization-mode=1');
      expect(sdp).toMatch(/m=audio \d+ UDP\/TLS\/RTP\/SAVPF 111/);
      expect(sdp).toContain('a=rtpmap:111 opus/48000/2');
      // Ring supports recvonly only; sendrecv fails negotiation.
      expect(sdp.match(/a=recvonly/g)).toHaveLength(2);
      expect(sdp).not.toContain('a=sendrecv');
    } finally {
      peer.close();
    }
  }, 15_000);

  it('settles ended once closed', async () => {
    const peer = await openWhepPeer({ videoPort: 15008, audioPort: 15010 }, { iceServers: [] });
    peer.close();
    await expect(peer.ended).resolves.toBeUndefined();
  }, 15_000);
});

describe('openWhepPeer — what it reports, so a stalled stream can be diagnosed in CloudWatch', () => {
  it('logs the ICE candidate types in its offer, never addresses', async () => {
    const lines: Record<string, unknown>[] = [];
    const peer = await openWhepPeer({ videoPort: 15012, audioPort: 15014 }, { iceServers: [], log: (l) => lines.push(l) });
    peer.close();

    const offer = lines.find((l) => l.msg === 'live_peer_offer')!;
    expect(offer.candidates).toEqual(expect.arrayContaining(['host']));
    expect(JSON.stringify(lines)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  }, 15_000);
});
