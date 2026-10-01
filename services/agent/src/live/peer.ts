/**
 * The receive-only WebRTC peer, on werift (pure TypeScript WebRTC — no
 * native module, so it runs in the arm64 runtime image unchanged).
 *
 * It forwards every RTP packet it receives to ffmpeg's local UDP ports and
 * asks for a keyframe each second (PLI): ffmpeg can only cut a 1s HLS
 * segment on one, and Ring's own GOP is ≈1.67s. Verbatim from SP-3, where
 * this produced the first playlist in 6.0–6.8s.
 */
import { createSocket } from 'node:dgram';
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';
import type { Peer, RtpPorts } from './bridge.js';

export interface PeerOptions {
  /** Ring's docs use Google's public STUN server; tests pass none. */
  readonly iceServers?: readonly { urls: string }[];
  /** Candidate types, connection states and first packets — never addresses. */
  readonly log?: (line: Record<string, unknown>) => void;
}

const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
const H264_PT = 96;
const OPUS_PT = 111;

export function peerConfiguration(options: PeerOptions = {}) {
  return {
    iceServers: [...(options.iceServers ?? STUN)],
    // A Lambda's only interface (vint_runtime) is link-local, 169.254.x.x;
    // werift skips those by default and would gather nothing — no host
    // candidate, so no socket to ask STUN from, so no srflx either.
    iceUseLinkLocalAddress: true,
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: 'video/H264',
          clockRate: 90000,
          payloadType: H264_PT,
          rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }],
          parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
        }),
      ],
      audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: OPUS_PT })],
    },
  };
}

export async function openWhepPeer(ports: RtpPorts, options: PeerOptions = {}): Promise<Peer> {
  const pc = new RTCPeerConnection(peerConfiguration(options));

  const videoOut = createSocket('udp4');
  const audioOut = createSocket('udp4');
  const timers: NodeJS.Timeout[] = [];
  const log = options.log ?? (() => {});
  const started = Date.now();
  const firstPacket = { video: false, audio: false };
  const noteFirst = (kind: 'video' | 'audio') => {
    if (firstPacket[kind]) return;
    firstPacket[kind] = true;
    log({ level: 'info', msg: 'live_peer_first_rtp', kind, ms: Date.now() - started });
  };

  let settle!: () => void;
  const ended = new Promise<void>((resolve) => {
    settle = resolve;
  });

  // Handlers before the offer: attaching them late is Ring's own top cause of "no video".
  const video = pc.addTransceiver('video', { direction: 'recvonly' });
  const audio = pc.addTransceiver('audio', { direction: 'recvonly' });

  video.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      noteFirst('video');
      rtp.header.payloadType = H264_PT;
      videoOut.send(rtp.serialize(), ports.videoPort, '127.0.0.1');
    });
    timers.push(setInterval(() => {
      if (track.ssrc) void video.receiver.sendRtcpPLI(track.ssrc);
    }, 1000));
  });
  audio.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      noteFirst('audio');
      rtp.header.payloadType = OPUS_PT;
      audioOut.send(rtp.serialize(), ports.audioPort, '127.0.0.1');
    });
  });

  pc.connectionStateChange.subscribe((state) => {
    log({ level: 'info', msg: 'live_peer_state', state, ms: Date.now() - started });
    if (state === 'closed' || state === 'failed') settle();
  });

  await pc.setLocalDescription(await pc.createOffer());
  const offer = pc.localDescription?.sdp;
  if (!offer) throw new Error('webrtc_no_local_description');
  // Field 8 of an a=candidate line is its type: host, srflx (STUN answered over UDP), relay.
  const candidates = [...offer.matchAll(/a=candidate:\S+ \S+ \S+ \S+ \S+ \S+ typ (\S+)/g)].map((m) => m[1]);
  log({ level: 'info', msg: 'live_peer_offer', candidates, ms: Date.now() - started });

  let closed = false;
  return {
    offer,
    accept: async (answerSdp) => {
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    },
    ended,
    close: () => {
      if (closed) return;
      closed = true;
      timers.forEach(clearInterval);
      void pc.close();
      videoOut.close();
      audioOut.close();
      settle();
    },
  };
}
