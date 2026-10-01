import { describe, it, expect } from 'vitest';
import { ffmpegArgs, playlistUrlFor, rtpSdp, segmentsInPlaylist, segmentsToUpload, PLAYLIST } from '../hls.js';

const PLAYLIST_TEXT = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-MEDIA-SEQUENCE:3',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXTINF:1.668,',
  'live3.ts',
  '#EXTINF:1.668,',
  'live4.ts',
  '',
].join('\n');

describe('segmentsInPlaylist', () => {
  it('lists the media segments the playlist references, in order', () => {
    expect(segmentsInPlaylist(PLAYLIST_TEXT)).toEqual(['live3.ts', 'live4.ts']);
  });

  it('never lets a playlist line escape the session directory', () => {
    expect(segmentsInPlaylist('#EXTM3U\n../../etc/passwd\nhttps://x/y.ts\nok.ts\n')).toEqual(['ok.ts']);
  });
});

describe('segmentsToUpload', () => {
  it('uploads only segments the playlist already lists — ffmpeg has finished writing those', () => {
    expect(segmentsToUpload(PLAYLIST_TEXT, new Set(['live3.ts']))).toEqual(['live4.ts']);
  });

  it('uploads nothing new when everything listed is already up', () => {
    expect(segmentsToUpload(PLAYLIST_TEXT, new Set(['live3.ts', 'live4.ts']))).toEqual([]);
  });
});

describe('rtpSdp — what ffmpeg reads the forwarded RTP with', () => {
  it('describes H.264 video and Opus audio on the local ports', () => {
    const sdp = rtpSdp({ videoPort: 5004, audioPort: 5006 });
    expect(sdp).toContain('m=video 5004 RTP/AVP 96');
    expect(sdp).toContain('a=rtpmap:96 H264/90000');
    expect(sdp).toContain('m=audio 5006 RTP/AVP 111');
    expect(sdp).toContain('a=rtpmap:111 opus/48000/2');
    expect(sdp).toContain('c=IN IP4 127.0.0.1');
  });
});

describe('ffmpegArgs', () => {
  const args = ffmpegArgs('/tmp/live/s1');

  it('copies the video untouched — the camera already sends H.264 — and makes AAC for the player', () => {
    expect(args.join(' ')).toContain('-c:v copy');
    expect(args.join(' ')).toContain('-c:a aac');
  });

  it('writes one-second MPEG-TS HLS segments the TV player accepts (SP-1)', () => {
    const joined = args.join(' ');
    expect(joined).toContain('-f hls');
    expect(joined).toContain('-hls_time 1');
    expect(joined).toContain('-hls_segment_type mpegts');
    expect(args.at(-1)).toBe(`/tmp/live/s1/${PLAYLIST}`);
  });

  it('only reads from the local SDP file and RTP — never an arbitrary protocol', () => {
    expect(args.join(' ')).toContain('-protocol_whitelist file,udp,rtp');
  });
});

describe('playlistUrlFor', () => {
  it('is the session playlist under the HTTPS live origin, however the base is written', () => {
    expect(playlistUrlFor('https://d1.cloudfront.net', 'abc')).toBe('https://d1.cloudfront.net/live/abc/live.m3u8');
    expect(playlistUrlFor('https://d1.cloudfront.net/', 'abc')).toBe('https://d1.cloudfront.net/live/abc/live.m3u8');
  });

  it('refuses a cleartext origin — the TV player drops http silently (FL-016)', () => {
    expect(() => playlistUrlFor('http://d1.cloudfront.net', 'abc')).toThrow('live_origin_must_be_https');
  });
});
