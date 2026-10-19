import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerationObservability');
const context = new AsyncLocalStorage<{
  requestId: string;
  runId: string;
  stage: string;
  sceneIndex?: number;
}>();
const stages = new Set([
  'execution',
  'material-analysis',
  'research',
  'outline',
  'agents',
  'content',
  'actions',
  'narration',
  'image',
  'video',
  'media',
  'media-placement',
]);
export type GenerationOutcome =
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'retry_scheduled'
  | 'retry_recovered'
  | 'retry_exhausted'
  | 'cancelled'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'ended'
  | 'interrupted';

export function generationReason(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const value = error as {
    name?: unknown;
    code?: unknown;
    statusCode?: unknown;
    httpStatus?: unknown;
    status?: unknown;
  };
  if (
    value.name === 'StepTimeoutError' ||
    value.name === 'TimeoutError' ||
    value.code === 'ETIMEDOUT'
  )
    return 'timeout';
  if (value.name === 'AbortError') return 'cancelled';
  if (value.name === 'GenerationRunLeaseLostError') return 'lease_lost';
  if (
    value.name === 'StepRefusal' ||
    value.name === 'InvalidSceneError' ||
    value.name === 'SyntaxError'
  )
    return 'invalid_output';
  if (value.name === 'ModelConfigurationError') return 'configuration';
  const status = value.statusCode ?? value.httpStatus ?? value.status;
  if (status === 401 || status === 403) return 'authorization';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';
  if (typeof status === 'number' && status >= 500 && status <= 599) return 'upstream';
  if (typeof status === 'number' && status >= 400 && status <= 499) return 'request';
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE'].includes(String(value.code)))
    return 'network';
  return 'unknown';
}

export function generationRequestId(runId: string): string {
  return /^run-[A-Za-z0-9_-]{16}$/.test(runId)
    ? runId
    : `run-${createHash('sha256').update(runId).digest('hex').slice(0, 24)}`;
}

export function observeGeneration(
  outcome: GenerationOutcome,
  details: {
    attempt?: number;
    elapsedMs?: number;
    nextDelayMs?: number;
    error?: unknown;
    operationId?: string;
  } = {},
): void {
  const current = context.getStore();
  if (!current) return;
  const record: Record<string, string | number> = { event: 'generation', ...current, outcome };
  for (const key of ['attempt', 'elapsedMs', 'nextDelayMs'] as const) {
    const value = details[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
      record[key] = Math.floor(value);
  }
  if (details.operationId && /^[0-9a-f-]{36}$/.test(details.operationId))
    record.operationId = details.operationId;
  if (details.error !== undefined) record.reason = generationReason(details.error);
  try {
    log.info(record);
  } catch {}
}

export function inGenerationRun<T>(runId: string, operation: () => Promise<T>): Promise<T> {
  const id = generationRequestId(runId);
  return context.run({ requestId: id, runId: id, stage: 'execution' }, operation);
}

export function inGenerationStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  const current = context.getStore();
  if (!current) return operation();
  const scene = /^scene:(\d+):(content|actions|narration)$/.exec(stage);
  const kind = scene?.[2] ?? stage;
  return context.run(
    {
      ...current,
      stage: stages.has(kind) ? kind : 'media',
      ...(scene ? { sceneIndex: Number(scene[1]) } : {}),
    },
    async () => {
      const started = Date.now();
      const operationId = randomUUID();
      observeGeneration('started', { attempt: 1, operationId });
      try {
        const result = await operation();
        observeGeneration('succeeded', { elapsedMs: Date.now() - started, operationId });
        return result;
      } catch (error) {
        observeGeneration(generationReason(error) === 'cancelled' ? 'cancelled' : 'failed', {
          error,
          elapsedMs: Date.now() - started,
          operationId,
        });
        throw error;
      }
    },
  );
}

export function generationScopedLogger(tag: string) {
  const logger = createLogger(tag);
  return Object.fromEntries(
    Object.entries(logger).map(([level, emit]) => [
      level,
      (...args: unknown[]) => {
        if (!context.getStore()) emit(...args);
      },
    ]),
  ) as typeof logger;
}

export const quietGenerationLogger = {
  debug: (...args: unknown[]) => void args,
  info: (...args: unknown[]) => void args,
  warn: (...args: unknown[]) => void args,
  error: (...args: unknown[]) => void args,
};
