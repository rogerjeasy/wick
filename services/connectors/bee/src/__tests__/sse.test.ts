import { describe, it, expect, vi } from 'vitest';
import { BeeSseConsumer, parseSseFrames } from '../sse.js';
import type { BeeStreamEvent } from '../types.js';

describe('parseSseFrames', () => {
  it('parses a single complete frame and returns no remainder', () => {
    const frame = `data: ${JSON.stringify({ type: 'fact', data: { id: 'f1' } })}\n\n`;
    const { events, remainder } = parseSseFrames(frame);
    expect(events).toEqual([{ type: 'fact', data: { id: 'f1' } }]);
    expect(remainder).toBe('');
  });

  it('holds an incomplete trailing frame as remainder rather than dropping it', () => {
    const complete = `data: ${JSON.stringify({ type: 'todo', data: { id: 't1' } })}\n\n`;
    const incomplete = 'data: {"type":"fact"';
    const { events, remainder } = parseSseFrames(complete + incomplete);
    expect(events).toHaveLength(1);
    expect(remainder).toBe(incomplete);
  });

  it('treats a bare comment/heartbeat frame as zero events, not an error', () => {
    const { events, remainder } = parseSseFrames(': ping\n\n');
    expect(events).toEqual([]);
    expect(remainder).toBe('');
  });

  it('drops a frame whose data is not valid JSON instead of throwing', () => {
    expect(() => parseSseFrames('data: {not json\n\n')).not.toThrow();
    expect(parseSseFrames('data: {not json\n\n').events).toEqual([]);
  });

  it('joins multiple data: lines within one frame before parsing (multi-line SSE payloads)', () => {
    const { events } = parseSseFrames('data: {"type":"fact",\ndata: "data":{"id":"f1"}}\n\n');
    expect(events).toEqual([{ type: 'fact', data: { id: 'f1' } }]);
  });
});

/** A minimal fetch stand-in whose body streams pre-chunked SSE text. */
function streamingFetch(chunks: readonly string[], status = 200): typeof fetch {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe('BeeSseConsumer', () => {
  it('delivers events parsed from the streamed response body', async () => {
    const frame = `data: ${JSON.stringify({ type: 'fact', data: { id: 'f1' } })}\n\n`;
    const fetchImpl = streamingFetch([frame]);
    const consumer = new BeeSseConsumer({ fetchImpl, idleTimeoutMs: 5_000 });

    const received: BeeStreamEvent[] = [];
    consumer.onEvent((e) => received.push(e));
    consumer.start();

    await vi.waitFor(() => expect(received).toHaveLength(1));
    consumer.stop();
    expect(received[0]).toEqual({ type: 'fact', data: { id: 'f1' } });
  });

  it('reconnects on backoff after the stream closes', async () => {
    const frame = `data: ${JSON.stringify({ type: 'todo', data: { id: 't1' } })}\n\n`;
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(streamingFetch([]))
      .mockImplementationOnce(streamingFetch([frame])) as unknown as typeof fetch;

    const consumer = new BeeSseConsumer({ fetchImpl, idleTimeoutMs: 5_000, backoffMs: [5] });
    const received: BeeStreamEvent[] = [];
    consumer.onEvent((e) => received.push(e));
    consumer.start();

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000 });
    consumer.stop();
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('never throws out of start() on a fetch rejection', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const consumer = new BeeSseConsumer({ fetchImpl, backoffMs: [10_000] });
    expect(() => consumer.start()).not.toThrow();
    consumer.stop();
  });
});
