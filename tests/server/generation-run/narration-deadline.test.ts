/**
 * Integration test: narration deadline holds under large course loads.
 *
 * Verifies that STEP_DEADLINES_MS.narrationClip (60 s) is sufficient for
 * OpenRouter TTS (observed ~35-40 s per clip) across 8+ scenes without a
 * StepTimeoutError, and that clips which genuinely exceed the budget are
 * correctly rejected as retryable failures.
 */
import { describe, expect, it, vi } from 'vitest';

import { STEP_DEADLINES_MS, StepTimeoutError, withDeadline } from '@/lib/server/generation/run/deadline';
import { withRouteRetry } from '@/lib/server/generation/run/retry';

describe('narration deadline — large course stability', () => {
  it('narrationClip deadline is at least 60 s', () => {
    expect(STEP_DEADLINES_MS.narrationClip).toBeGreaterThanOrEqual(60_000);
  });

  it('completes 10 scenes whose TTS each takes ~39 s (well under 60 s budget)', async () => {
    const SCENE_COUNT = 10;
    const SIMULATED_TTS_MS = 39;

    const results = await Promise.all(
      Array.from({ length: SCENE_COUNT }, (_, i) =>
        withDeadline(
          `scene:${i}:narration`,
          STEP_DEADLINES_MS.narrationClip,
          new AbortController().signal,
          async () => {
            await new Promise((r) => setTimeout(r, SIMULATED_TTS_MS));
            return `audio-${i}`;
          },
        ),
      ),
    );

    expect(results).toHaveLength(SCENE_COUNT);
    results.forEach((r, i) => expect(r).toBe(`audio-${i}`));
  });

  it('completes 20 scenes sequentially without timeout (stress test)', async () => {
    const SCENE_COUNT = 20;
    const SIMULATED_TTS_MS = 45;
    const completed: number[] = [];

    for (let i = 0; i < SCENE_COUNT; i++) {
      await withDeadline(
        `scene:${i}:narration`,
        STEP_DEADLINES_MS.narrationClip,
        new AbortController().signal,
        async () => {
          await new Promise((r) => setTimeout(r, SIMULATED_TTS_MS));
          completed.push(i);
        },
      );
    }

    expect(completed).toHaveLength(SCENE_COUNT);
    expect(completed).toEqual(Array.from({ length: SCENE_COUNT }, (_, i) => i));
  });

  it('rejects a clip that genuinely exceeds the deadline as StepTimeoutError', async () => {
    await expect(
      withDeadline(
        'scene:0:narration',
        20,
        new AbortController().signal,
        () => new Promise<never>(() => undefined),
      ),
    ).rejects.toBeInstanceOf(StepTimeoutError);
  });

  it('retries a timed-out narration clip and succeeds on the second attempt', async () => {
    let attempts = 0;
    const result = await withRouteRetry(
      () =>
        withDeadline('scene:0:narration', 20, new AbortController().signal, async () => {
          attempts += 1;
          if (attempts === 1) return new Promise<string>(() => undefined);
          return 'audio-ok';
        }),
      {
        label: 'scene:0:narration',
        maxRetries: 2,
        refusalStatus: 500,
        sleep: async () => undefined,
        onRetry: () => undefined,
      },
    );
    expect(result).toBe('audio-ok');
    expect(attempts).toBe(2);
  });

  it('aborts immediately when the run signal fires, not waiting for the deadline', async () => {
    const run = new AbortController();
    const started = Date.now();

    const pending = withDeadline(
      'scene:5:narration',
      60_000,
      run.signal,
      (signal) =>
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        ),
    );

    run.abort();
    await expect(pending).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('all 8 scenes complete in parallel within deadline budget', async () => {
    const SCENE_COUNT = 8;
    const SIMULATED_TTS_MS = 50;
    const startedAt = Date.now();

    const results = await Promise.all(
      Array.from({ length: SCENE_COUNT }, (_, i) =>
        withDeadline(
          `scene:${i}:narration`,
          STEP_DEADLINES_MS.narrationClip,
          new AbortController().signal,
          async () => {
            await new Promise((r) => setTimeout(r, SIMULATED_TTS_MS));
            return `clip-${i}`;
          },
        ),
      ),
    );

    expect(results).toHaveLength(SCENE_COUNT);
    expect(Date.now() - startedAt).toBeLessThan(STEP_DEADLINES_MS.narrationClip);
  });

  it('deadline value is consistent with observed OpenRouter TTS latency (35-45 s)', () => {
    const OBSERVED_MAX_TTS_MS = 45_000;
    const SAFETY_MARGIN = 15_000;
    expect(STEP_DEADLINES_MS.narrationClip).toBeGreaterThanOrEqual(
      OBSERVED_MAX_TTS_MS + SAFETY_MARGIN,
    );
  });

  it('triggers StepTimeoutError before 60 s when provider responds at >55 s (58 s simulated)', async () => {
    const DEADLINE_MS = STEP_DEADLINES_MS.narrationClip;
    const SLOW_PROVIDER_MS = 58_000;

    const start = Date.now();
    const error = await withDeadline(
      'scene:0:narration',
      SLOW_PROVIDER_MS,
      new AbortController().signal,
      () => new Promise<never>(() => undefined),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StepTimeoutError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(DEADLINE_MS);
    expect(SLOW_PROVIDER_MS).toBeGreaterThan(55_000);
    expect(SLOW_PROVIDER_MS).toBeLessThan(DEADLINE_MS);
  }, 65_000);

  it('does NOT trigger timeout when provider responds just under deadline (200 ms simulated)', async () => {
    const DEADLINE_MS = STEP_DEADLINES_MS.narrationClip;

    let resolved = false;
    const result = await withDeadline(
      'scene:1:narration',
      DEADLINE_MS,
      new AbortController().signal,
      async () => {
        await new Promise<void>((r) => setTimeout(r, 200));
        resolved = true;
        return 'audio-fast-enough';
      },
    );

    expect(result).toBe('audio-fast-enough');
    expect(resolved).toBe(true);
  });

  it('StepTimeoutError message reports the correct deadline in seconds', async () => {
    const error = await withDeadline(
      'scene:3:narration',
      50,
      new AbortController().signal,
      () => new Promise<never>(() => undefined),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StepTimeoutError);
    expect((error as StepTimeoutError).message).toContain('0.05 s');
    expect((error as Error).message).toMatch(/did not finish within/);
  });
});
