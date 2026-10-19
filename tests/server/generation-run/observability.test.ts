import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inGenerationRun,
  inGenerationStage,
  generationReason,
  generationRequestId,
} from '@/lib/server/generation/run/observability';
import { withRouteRetry } from '@/lib/server/generation/run/retry';
import { StepTimeoutError, withDeadline } from '@/lib/server/generation/run/deadline';

const runId = 'run-abcdefghijklmnop';
const secret = 'SECRET prompt slide credential https://private.test Authorization';
const options = {
  label: secret,
  maxRetries: 2,
  refusalStatus: 500 as const,
  sleep: async () => {},
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
function capture() {
  vi.stubEnv('LOG_FORMAT', 'json');
  vi.stubEnv('LOG_LEVEL', 'info');
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  return () => spy.mock.calls.map(([line]) => JSON.parse(JSON.parse(line).message));
}

describe('generation observability', () => {
  it('correlates background stages and actual retries without logging inputs, results or errors', async () => {
    const records = capture();
    let calls = 0;
    await inGenerationRun(runId, async () => {
      await inGenerationStage('scene:0:content', () =>
        withRouteRetry(async () => {
          if (++calls === 1)
            throw Object.assign(new Error(secret), {
              statusCode: 429,
              headers: secret,
              responseBody: secret,
            });
          return { content: secret };
        }, options),
      );
      await Promise.resolve().then(() => inGenerationStage('actions', async () => secret));
    });
    expect(calls).toBe(2);
    expect(records().every((record) => record.requestId === runId && record.runId === runId)).toBe(
      true,
    );
    expect(records().map((record) => [record.stage, record.outcome])).toEqual([
      ['content', 'started'],
      ['content', 'retry_scheduled'],
      ['content', 'retry_recovered'],
      ['content', 'succeeded'],
      ['actions', 'started'],
      ['actions', 'succeeded'],
    ]);
    expect(records()[1]).toMatchObject({ attempt: 1, reason: 'rate_limit', sceneIndex: 0 });
    expect(records()[2]).toMatchObject({ attempt: 2 });
    expect(records()[1].operationId).toBe(records()[2].operationId);
    expect(JSON.stringify(records())).not.toContain('SECRET');
    expect(JSON.stringify(records())).not.toContain('private.test');
  });

  it('reports exhausted timeout retries and the failed stage, preserving the thrown error', async () => {
    const records = capture();
    const error = new StepTimeoutError(secret, 1);
    await expect(
      inGenerationRun(runId, () =>
        inGenerationStage('outline', () =>
          withRouteRetry(async () => {
            throw error;
          }, options),
        ),
      ),
    ).rejects.toBe(error);
    expect(records().filter((record) => record.outcome === 'retry_scheduled')).toHaveLength(2);
    expect(records().find((record) => record.outcome === 'retry_exhausted')).toMatchObject({
      stage: 'outline',
      attempt: 3,
      reason: 'timeout',
    });
    expect(records().at(-1)).toMatchObject({
      outcome: 'failed',
      stage: 'outline',
      reason: 'timeout',
    });
    expect(JSON.stringify(records())).not.toContain(secret);
  });

  it('does not claim an authorization refusal was retried or exhausted', async () => {
    const records = capture();
    const error = Object.assign(new Error(secret), { statusCode: 401 });
    await expect(
      inGenerationRun(runId, () =>
        withRouteRetry(async () => {
          throw error;
        }, options),
      ),
    ).rejects.toBe(error);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ outcome: 'failed', reason: 'authorization', attempt: 1 });
  });

  it('reports a real deadline even if an upstream ignores cancellation', async () => {
    vi.useFakeTimers();
    const records = capture();
    const result = inGenerationRun(runId, () =>
      inGenerationStage('research', () =>
        withDeadline(secret, 10, new AbortController().signal, () => new Promise(() => {})),
      ),
    ).catch((error) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBeInstanceOf(StepTimeoutError);
    expect(records().at(-1)).toMatchObject({ outcome: 'failed', reason: 'timeout', elapsedMs: 10 });
  });

  it('keeps concurrent runs isolated and rejects arbitrary stage and ID strings', async () => {
    const records = capture();
    await Promise.all([
      inGenerationRun(runId, () => inGenerationStage('content', async () => Promise.resolve())),
      inGenerationRun(secret, () => inGenerationStage(secret, async () => Promise.resolve())),
    ]);
    expect(new Set(records().map((record) => record.requestId)).size).toBe(2);
    expect(generationRequestId(secret)).toBe(generationRequestId(secret));
    expect(JSON.stringify(records())).not.toContain(secret);
    expect(records().filter((record) => record.requestId === runId)).toHaveLength(2);
  });

  it('uses only allowlisted reason categories', () => {
    expect(generationReason(new Error(secret))).toBe('unknown');
    expect(generationReason({ name: secret, code: secret, status: secret })).toBe('unknown');
    expect(generationReason({ name: 'InvalidSceneError' })).toBe('invalid_output');
    expect(generationReason({ code: 'ECONNRESET' })).toBe('network');
  });

  it('reports cancellation during backoff without a second attempt', async () => {
    const records = capture();
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      throw Object.assign(new Error(secret), { statusCode: 503 });
    });
    await expect(
      inGenerationRun(runId, () =>
        withRouteRetry(operation, {
          ...options,
          signal: controller.signal,
          sleep: async () => {
            controller.abort();
          },
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(records().at(-1)).toMatchObject({ outcome: 'cancelled', attempt: 1 });
    expect(records().some((record) => record.outcome === 'retry_exhausted')).toBe(false);
  });
});
