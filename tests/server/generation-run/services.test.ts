/**
 * The production step wiring of a run: which model slot a scene's content
 * resolves through (an unknown type reaches the content step's own refusal),
 * and the media type narration clips are stored with.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  savedProviderTarget: vi.fn(),
  languageModelFor: vi.fn(),
  synthesizeNarration: vi.fn(),
  storeGeneratedAsset: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/server/model-config/llm', () => ({ languageModelFor: mocks.languageModelFor }));
vi.mock('@/lib/server/model-config/runtime', async (original) => ({
  ...(await original<typeof import('@/lib/server/model-config/runtime')>()),
  savedProviderTarget: mocks.savedProviderTarget,
}));
vi.mock('@/lib/server/generation/steps/narration', () => ({
  synthesizeNarration: mocks.synthesizeNarration,
}));
vi.mock('@/lib/server/store-generated-asset', () => ({
  storeGeneratedAsset: mocks.storeGeneratedAsset,
}));

import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  defaultRunStepServices,
  recoveryRunStepServices,
} from '@/lib/server/generation/run/services';
import type { MediaConnection } from '@/lib/server/model-config/media';
import type { SceneOutline } from '@/lib/types/generation';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

describe('run step services', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', '');
    mocks.savedProviderTarget.mockReset();
    mocks.languageModelFor.mockReset();
    mocks.resolveModel.mockReset().mockResolvedValue({
      model: { id: 'test-model' },
      modelInfo: {},
      modelString: 'test:model',
      serverManaged: true,
    });
  });

  const outline = (type: string): SceneOutline =>
    ({ id: 'o1', type, title: 'Scene', description: '', keyPoints: [], order: 1 }) as never;

  it("resolves a known type's content through its own slot", async () => {
    await expect(
      defaultRunStepServices.sceneContent('user:a', { outline: outline('slide') }, { log }),
    ).rejects.toBeDefined();
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      stage: 'scene-content:slide',
      workspaceId: 'user:a',
    });
  });

  it('resolves an unknown type through course.content and reaches the content refusal', async () => {
    const result = defaultRunStepServices.sceneContent(
      'user:a',
      { outline: outline('video') },
      { log },
    );
    await expect(result).rejects.toBeInstanceOf(StepRefusal);
    await expect(result).rejects.toMatchObject({ reason: 'generation-failed' });
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      stage: 'scene-content',
      workspaceId: 'user:a',
    });
  });

  it.each([
    ['mp3', 'audio/mpeg'],
    ['wav', 'audio/wav'],
    ['ogg', 'audio/ogg'],
    ['opus', 'audio/ogg'],
    ['aac', 'audio/aac'],
    ['flac', 'audio/flac'],
    ['webm', 'audio/webm'],
  ])('stores a %s clip as %s', async (format, mimeType) => {
    mocks.synthesizeNarration.mockResolvedValue({ audio: new Uint8Array([1]), format });
    mocks.storeGeneratedAsset.mockReset().mockResolvedValue({ status: 'stored', assetId: 'ast_1' });
    const id = await defaultRunStepServices.narrateClip(
      'user:a',
      {
        target: {
          connection: { providerId: 'openai-tts' } as MediaConnection,
          providerId: 'openai-tts',
        },
        stageId: 'stage-1',
        text: 'Hello',
        audioId: 'tts_s1_a',
        voice: 'alloy',
        speed: 1,
        fence: async () => undefined,
      },
      { log },
    );
    expect(id).toBe('ast_1');
    expect(mocks.storeGeneratedAsset).toHaveBeenCalledWith(expect.objectContaining({ mimeType }));
  });

  it('keeps ordinary runs on their existing services', () => {
    expect(recoveryRunStepServices(defaultRunStepServices, null)).toBe(defaultRunStepServices);
  });

  it.each<Record<string, string>>([
    {},
    { recoveryModel: 'openai:mittr-1-0-max' },
    { recoverySkipVoice: 'true' },
    { recoveryModel: 'openai:mittr-1-0-max', recoverySkipVoice: 'false' },
  ])('requires both trusted recovery attributes: %j', (attributes) => {
    expect(recoveryRunStepServices(defaultRunStepServices, attributes)).toBe(
      defaultRunStepServices,
    );
  });

  it('does not fall back to slots when recovery model resolution is refused', async () => {
    const refusal = new Error('Recovery model refused');
    mocks.savedProviderTarget.mockRejectedValue(refusal);
    const services = recoveryRunStepServices(defaultRunStepServices, {
      recoveryModel: 'openai:mittr-1-0-max',
      recoverySkipVoice: 'true',
    });
    await expect(
      services.sceneContent('user:a', { outline: outline('video') }, { log }),
    ).rejects.toBe(refusal);
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.languageModelFor).not.toHaveBeenCalled();
  });

  it('pins only recovery calls to the saved model without slot fallback', async () => {
    mocks.savedProviderTarget.mockResolvedValue({ providerId: 'openai', modelId: 'mittr-1-0-max' });
    mocks.languageModelFor.mockResolvedValue({ model: { id: 'mittr' }, modelInfo: {} });
    const services = recoveryRunStepServices(defaultRunStepServices, {
      recoveryModel: 'openai:mittr-1-0-max',
      recoverySkipVoice: 'true',
    });
    await expect(
      services.sceneContent('user:a', { outline: outline('video') }, { log }),
    ).rejects.toBeDefined();
    expect(mocks.savedProviderTarget).toHaveBeenCalledWith(
      'openai:mittr-1-0-max',
      'chat',
      'user:a',
    );
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    await expect(
      defaultRunStepServices.sceneContent('user:a', { outline: outline('video') }, { log }),
    ).rejects.toBeDefined();
    expect(mocks.resolveModel).toHaveBeenCalled();
  });

  it('skips narration and external media for scoped recovery', async () => {
    const services = recoveryRunStepServices(defaultRunStepServices, {
      recoveryModel: 'openai:mittr-1-0-max',
      recoverySkipVoice: 'true',
    });
    expect(await services.narrationTarget('user:a')).toBeNull();
    expect(await services.mediaConnections('user:a')).toEqual({
      image: { status: 'off' },
      video: { status: 'off' },
    });
    await expect(services.narrateClip('user:a', {} as never, { log })).rejects.toThrow();
  });

  it('refuses audio in a format it cannot serve', async () => {
    mocks.synthesizeNarration.mockResolvedValue({ audio: new Uint8Array([1]), format: 'pcm' });
    await expect(
      defaultRunStepServices.narrateClip(
        'user:a',
        {
          target: { connection: { providerId: 'x' } as MediaConnection, providerId: 'x' as never },
          stageId: 'stage-1',
          text: 'Hello',
          audioId: 'tts_s1_a',
          voice: 'v',
          speed: 1,
          fence: async () => undefined,
        },
        { log },
      ),
    ).rejects.toThrow(/unknown format: pcm/);
  });
});
