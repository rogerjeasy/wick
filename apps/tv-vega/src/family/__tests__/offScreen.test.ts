import { describe, expect, it, vi } from 'vitest';
import { startOffScreenService } from '../offScreen.js';

describe('startOffScreenService — what waits, said while Wick is off the screen', () => {
  it('opens the way at the pairing service first, and only then starts the service that will take it', async () => {
    const order: string[] = [];
    const openWindow = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('window');
    });
    const launch = vi.fn(async () => void order.push('launch'));

    await startOffScreenService({ serviceUri: 'pkg://com.wick.tv.card.service', openWindow, launch });

    expect(order).toEqual(['window', 'launch']);
  });

  it('does neither where there is no service to start: on Fire OS nothing is said off the screen, and no way is opened for nobody', async () => {
    const openWindow = vi.fn(async () => undefined);
    const launch = vi.fn(async () => undefined);

    await startOffScreenService({ serviceUri: '', openWindow, launch });

    expect(openWindow).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('still starts the service when the way could not be opened: where the disk keeps a token, it needs none', async () => {
    const launch = vi.fn(async () => undefined);

    await startOffScreenService({
      serviceUri: 'pkg://com.wick.tv.card.service',
      openWindow: async () => {
        throw new Error('no network');
      },
      launch,
    });

    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('never throws', async () => {
    await expect(
      startOffScreenService({
        serviceUri: 'pkg://x',
        openWindow: async () => undefined,
        launch: async () => {
          throw new Error('no such component');
        },
      }),
    ).resolves.toBeUndefined();
  });
});
