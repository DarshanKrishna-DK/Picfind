import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAdaptivePoller } from '../../apps/api/src/processing-poller';

afterEach(() => vi.useRealTimers());

describe('cost-conscious processing polling', () => {
  it('backs off idle polls, wakes immediately, and never polls after stopping', async () => {
    vi.useFakeTimers();
    const operation = vi.fn(async () => false);
    const poller = startAdaptivePoller(operation, {
      minimumMs: 100,
      maximumMs: 800,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(399);
    expect(operation).toHaveBeenCalledTimes(2);
    poller.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(poller.status().lastSuccessAt).toBeTruthy();
    await poller.stop();
    poller.wake();
    await vi.advanceTimersByTimeAsync(5000);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('coalesces wakes during an active operation without overlap', async () => {
    vi.useFakeTimers();
    let finish!: (worked: boolean) => void;
    const operation = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const poller = startAdaptivePoller(operation);
    await vi.advanceTimersByTimeAsync(0);
    poller.wake();
    poller.wake();
    await vi.advanceTimersByTimeAsync(60000);
    expect(operation).toHaveBeenCalledTimes(1);
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(operation).toHaveBeenCalledTimes(2);
    const stopping = poller.stop();
    finish(false);
    await stopping;
    await vi.advanceTimersByTimeAsync(60000);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('reports failures without leaking provider details and recovers on wake', async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('private provider details'))
      .mockResolvedValue(false);
    const poller = startAdaptivePoller(operation);
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.status().error).toBe(
      'Background processing is temporarily unavailable.',
    );
    expect(poller.status().lastSuccessAt).toBeUndefined();
    poller.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.status().error).toBeUndefined();
    expect(poller.status().lastSuccessAt).toBeTruthy();
    await poller.stop();
  });
});
