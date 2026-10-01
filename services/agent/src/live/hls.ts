/**
 * The HLS half of the live bridge, measured in SP-3:
 *
 *   werift (WebRTC) → RTP over local UDP → ffmpeg -c:v copy → 1s MPEG-TS HLS
 *
 * First playlist at 6.0–6.8s after the start request. `-c:v copy` because
 * Ring already sends H.264 (1280x720, GOP ≈ 1.67s); transcoding would cost
 * latency and CPU for nothing. Audio is Opus over WebRTC, which MPEG-TS HLS
 * can't carry for this player, so that one track becomes AAC.
 *
 * Upload order is the correctness rule: a segment goes up before any
 * playlist that names it, and only once a playlist names it — which is
 * ffmpeg's own signal that the segment file is complete.
 */
export const PLAYLIST = 'live.m3u8';

/** Segment file names the playlist lists, refusing anything that isn't a plain local name. */
export function segmentsInPlaylist(playlist: string): string[] {
  return playlist
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .filter((l) => /^[A-Za-z0-9_-]+\.ts$/.test(l));
}

export function segmentsToUpload(playlist: string, uploaded: ReadonlySet<string>): string[] {
  return segmentsInPlaylist(playlist).filter((s) => !uploaded.has(s));
}

export function rtpSdp(ports: { readonly videoPort: number; readonly audioPort: number }): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=wick-live',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=video ${ports.videoPort} RTP/AVP 96`,
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 packetization-mode=1',
    `m=audio ${ports.audioPort} RTP/AVP 111`,
    'a=rtpmap:111 opus/48000/2',
    '',
  ].join('\n');
}

export const SDP_FILE = 'in.sdp';

export function ffmpegArgs(dir: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-protocol_whitelist', 'file,udp,rtp',
    '-fflags', '+genpts+nobuffer', '-flags', 'low_delay',
    '-i', `${dir}/${SDP_FILE}`,
    '-map', '0:v', '-map', '0:a?',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '64k',
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '6',
    '-hls_flags', 'independent_segments+omit_endlist',
    '-hls_segment_type', 'mpegts',
    `${dir}/${PLAYLIST}`,
  ];
}

/** The URL the television plays. HTTPS only: w3cmedia refuses cleartext HLS without a word (FL-016). */
export function playlistUrlFor(liveOrigin: string, sessionId: string): string {
  if (!liveOrigin.startsWith('https://')) throw new Error('live_origin_must_be_https');
  return `${liveOrigin.replace(/\/+$/, '')}/live/${sessionId}/${PLAYLIST}`;
}
