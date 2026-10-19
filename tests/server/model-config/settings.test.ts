import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import yaml from 'js-yaml';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoredWorkspaceConfig } from '@/lib/server/model-config/settings';

import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';
import {
  applyModelSettingsChange,
  importModelSettings,
  modelSettingsView,
  ModelSettingsError,
} from '@/lib/server/model-config/settings';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import { assertDeploymentModelAuthorized } from '@/lib/server/model-config/model-authorization';
import {
  tokenPlanAssignments,
  tokenPlanConflicts,
  tokenPlanRecommendation,
} from '@/lib/model-settings/token-plan';

const deployment = (config: ModelConfigLayer['config']) =>
  setDeploymentConfigForTests({
    layer: { source: 'deployment', config },
    legacy: false,
    notices: [],
  });

beforeEach(() => {
  vi.stubEnv('ALLOW_LOCAL_NETWORKS', '');
  deployment({
    providers: {
      operator: {
        preset: 'deepseek',
        apiKey: 'sk-operator-secret-0001',
        models: ['deepseek-v4-pro', 'deepseek-flash'],
      },
    },
    // llm is a server default the workspace may change; video is locked off.
    slots: { llm: 'operator:deepseek-v4-pro', video: null },
    lock: ['video'],
  });
});

afterEach(() => {
  setDeploymentConfigForTests();
  vi.unstubAllEnvs();
});

describe('modelSettingsView', () => {
  it('offers only deployment slot models when the provider has no model list', async () => {
    const config: ModelConfigLayer['config'] = {
      providers: {
        operator: { preset: 'openai', apiKey: 'operator-key' },
        other: { preset: 'openai', apiKey: 'other-key' },
      },
      slots: {
        llm: 'operator:gpt-5.6',
        classroom: { model: 'operator:gpt-5.6', fallback: 'operator:custom:regional' },
        agent: 'other:other-model',
      },
    };
    deployment(config);
    const view = modelSettingsView({
      config: { slots: { 'course.outline': 'operator:workspace-only-model' } },
      revision: 1,
      unreadableSecrets: [],
    });
    const models = view.providers.find((provider) => provider.id === 'operator')!.capabilities.chat!
      .models;
    expect(models.map((model) => model.id)).toEqual(['gpt-5.6', 'custom:regional']);
    expect(models[0]).toMatchObject({ name: expect.stringContaining('GPT-5.6') });
    expect(view.slots.find((slot) => slot.slot === 'course.outline')!.effective.status).toBe(
      'invalid',
    );
    for (const model of models) {
      expect(() => assertDeploymentModelAuthorized(config, 'operator', model.id)).not.toThrow();
      await expect(
        applyModelSettingsChange(null, {
          kind: 'slots',
          set: { classroom: `operator:${model.id}` },
        }),
      ).resolves.toMatchObject({ slots: { classroom: `operator:${model.id}` } });
    }
  });

  it('offers an empty chat list without authorization and keeps workspace model catalogues', () => {
    deployment({ providers: { operator: { preset: 'openai', apiKey: 'operator-key' } } });
    const view = modelSettingsView({
      config: { providers: { mine: { preset: 'openai', apiKey: 'own-key' } } },
      revision: 1,
      unreadableSecrets: [],
    });
    expect(
      view.providers.find((provider) => provider.id === 'operator')!.capabilities.chat!.models,
    ).toEqual([]);
    expect(
      view.providers.find((provider) => provider.id === 'mine')!.capabilities.chat!.models.length,
    ).toBeGreaterThan(0);
    expect(
      view.presets.find((preset) => preset.id === 'openai')!.capabilities.chat!.models.length,
    ).toBeGreaterThan(0);
  });

  it('offers the union of listed models and deployment primary/fallback models', () => {
    deployment({
      providers: {
        operator: { preset: 'openai', apiKey: 'operator-key', models: ['listed', 'primary'] },
      },
      slots: { llm: { model: 'operator:primary', fallback: 'operator:backup' } },
    });
    const view = modelSettingsView(null);
    expect(view.providers[0].capabilities.chat!.models.map((model) => model.id)).toEqual([
      'listed',
      'primary',
      'backup',
    ]);
  });

  it('shows the tree with effective models, locks and masked keys, and no secrets', () => {
    const view = modelSettingsView({
      config: {
        providers: { mine: { preset: 'openai', apiKey: 'sk-workspace-secret-9876' } },
        slots: { 'course.content': 'mine:gpt-5.6' },
      },
      revision: 3,
      unreadableSecrets: [],
    });
    const json = JSON.stringify(view);
    expect(json).not.toContain('sk-operator-secret');
    expect(json).not.toContain('sk-workspace-secret');
    expect(view.revision).toBe(3);
    expect(view.providers.map(({ capabilities: _capabilities, ...rest }) => rest)).toEqual([
      {
        id: 'operator',
        models: ['deepseek-v4-pro', 'deepseek-flash'],
        preset: 'deepseek',
        presetName: 'DeepSeek',
        presetKind: 'single',
        source: 'deployment',
      },
      {
        id: 'mine',
        preset: 'openai',
        presetName: 'OpenAI',
        presetKind: 'single',
        source: 'workspace',
        key: { set: true, mask: '…9876' },
      },
      {
        id: 'builtin',
        preset: 'builtin',
        presetName: 'Built-in reader',
        presetKind: 'single',
        source: 'deployment',
      },
    ]);
    // Each provider lists the models it serves per capability, for the pickers.
    expect(view.providers[0].capabilities.chat?.models).toContainEqual(
      expect.objectContaining({ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }),
    );
    // With what the registry knows of each model, and the entry that serves it.
    expect(view.providers[0].capabilities.chat?.registryId).toBe('deepseek');
    expect(
      view.providers[0].capabilities.chat?.models.find((model) => model.id === 'deepseek-v4-pro')
        ?.capabilities,
    ).toMatchObject({ tools: true });
    const slot = (id: string) => view.slots.find((entry) => entry.slot === id)!;
    expect(view.allowUserKeys).toBe(true);
    expect(view).not.toHaveProperty('policy');
    expect(slot('llm')).toMatchObject({
      locked: false,
      source: { kind: 'default' },
      serverDefault: 'operator:deepseek-v4-pro',
      effective: { source: 'default' },
    });
    expect(slot('video')).toMatchObject({
      locked: true,
      source: { kind: 'locked' },
      effective: { status: 'disabled', source: 'locked' },
    });
    expect(slot('course.content.slide')).toMatchObject({
      locked: false,
      source: { kind: 'inherited', from: 'course.content' },
      effective: { status: 'assigned', resolvedAt: 'course.content', modelId: 'gpt-5.6' },
    });
    expect(slot('course.content')).toMatchObject({
      assignment: 'mine:gpt-5.6',
      source: { kind: 'workspace' },
    });
    expect(slot('course.content')).not.toHaveProperty('serverDefault');
    // Unset, web fetch uses the built-in reader, offered as the server default.
    expect(slot('webFetch')).toMatchObject({
      source: { kind: 'default' },
      serverDefault: 'builtin',
      effective: { status: 'assigned', providerId: 'builtin' },
    });
    expect(slot('image')).toMatchObject({ locked: false, source: { kind: 'unconfigured' } });
    expect(slot('agent.title')).toMatchObject({ configOnly: true });
  });

  it('leaves dormant workspace providers and their assignments out without user keys', () => {
    deployment({
      providers: {
        operator: {
          preset: 'deepseek',
          apiKey: 'sk-operator-secret-0001',
          models: ['deepseek-v4-pro', 'deepseek-flash'],
        },
      },
      slots: { llm: 'operator:deepseek-v4-pro' },
      allowUserKeys: false,
    });
    const view = modelSettingsView({
      config: {
        providers: { mine: { preset: 'openai', apiKey: 'sk-workspace-secret-9876' } },
        slots: { llm: 'mine:gpt-5.6', 'course.outline': 'operator:deepseek-flash' },
      },
      revision: 2,
      unreadableSecrets: [],
    });
    expect(view.providers.map((provider) => provider.id)).toEqual(['operator', 'builtin']);
    const slot = (id: string) => view.slots.find((entry) => entry.slot === id)!;
    // The dormant llm choice is neither shown nor used: the server default is.
    expect(slot('llm')).not.toHaveProperty('assignment');
    expect(slot('llm')).toMatchObject({ source: { kind: 'default' } });
    // A choice among the deployment's providers stays.
    expect(slot('course.outline')).toMatchObject({
      assignment: 'operator:deepseek-flash',
      source: { kind: 'workspace' },
    });
  });

  it('lists the presets a workspace may add, without deployment-only ones', () => {
    const presets = modelSettingsView(null).presets;
    const ids = presets.map((preset) => preset.id);
    expect(ids).toContain('openai');
    expect(ids).toContain('tavily');
    for (const deploymentOnly of [
      'bedrock',
      'searxng',
      'mineru',
      'comfyui-image',
      'funasr-asr',
      'alidocmind',
    ]) {
      expect(ids).not.toContain(deploymentOnly);
    }
    const compatible = presets.find((preset) => preset.id === 'openai-compatible')!;
    expect(compatible).toMatchObject({ requiresBaseUrl: true, customEndpoint: true });
    expect(presets.find((preset) => preset.id === 'tavily')).toMatchObject({
      customEndpoint: false,
    });

    deployment({ allowUserKeys: false });
    expect(modelSettingsView(null).presets).toEqual([]);
  });

  it('names no deployment endpoint anywhere in the view', () => {
    deployment({
      providers: {
        operator: {
          preset: 'openai-compatible',
          apiKey: 'sk-operator',
          baseUrl: 'https://gateway.internal.example/v1?token=endpoint-secret',
          models: ['m1', 'm2'],
        },
      },
      slots: { llm: { model: 'operator:m1', fallback: 'operator:m2' } },
    });
    const json = JSON.stringify(modelSettingsView(null));
    expect(json).not.toContain('gateway.internal');
    expect(json).not.toContain('endpoint-secret');
  });

  it("offers an OpenAI-compatible deployment provider's listed models for chat", () => {
    deployment({
      providers: {
        gateway: {
          preset: 'openai-compatible',
          apiKey: 'sk-operator',
          baseUrl: 'https://gateway.example/v1',
          models: ['gpt-5.1', 'gpt-5.4-mini', 'deepseek-v4-flash-0731'],
        },
      },
    });
    const gateway = modelSettingsView(null).providers.find((entry) => entry.id === 'gateway')!;
    expect(gateway).toMatchObject({ source: 'deployment', preset: 'openai-compatible' });
    expect(gateway.capabilities.chat?.models.map((model) => model.id)).toEqual([
      'gpt-5.1',
      'gpt-5.4-mini',
      'deepseek-v4-flash-0731',
    ]);
  });

  it('never shows credentials a stored endpoint carries', () => {
    const view = modelSettingsView({
      config: {
        providers: {
          oc: {
            preset: 'openai-compatible',
            apiKey: 'sk-k',
            baseUrl: 'https://u:hunter2@1.1.1.1/v1',
          },
        },
        slots: { llm: 'oc:m1' },
      },
      revision: 1,
      unreadableSecrets: [],
    });
    expect(JSON.stringify(view)).not.toContain('hunter2');
  });

  it("offers a workspace provider's models only where the calls can reach them", () => {
    const view = modelSettingsView({
      config: {
        providers: {
          mm: { preset: 'minimax', apiKey: 'sk-k', baseUrl: 'https://1.1.1.1/v1' },
          oc: { preset: 'openai-compatible', apiKey: 'sk-k', baseUrl: 'https://1.1.1.1/v1' },
        },
      },
      revision: 1,
      unreadableSecrets: [],
    });
    const provider = (id: string) => view.providers.find((entry) => entry.id === id)!;
    // Its own endpoint serves chat only.
    expect(Object.keys(provider('mm').capabilities)).toEqual(['chat']);
    // An OpenAI-compatible server's models are the ones the provider lists.
    expect(provider('oc').capabilities.chat?.models).toEqual([]);
  });

  it('neither offers nor accepts a provider the operator switched off', async () => {
    vi.stubEnv('TTS_OPENAI_ENABLED', 'false');
    vi.stubEnv('TTS_MINIMAX_ENABLED', 'false');
    // The switch is read once per module load.
    vi.resetModules();
    const { modelSettingsView, applyModelSettingsChange } =
      await import('@/lib/server/model-config/settings');
    (await import('@/lib/server/model-config/runtime')).setDeploymentConfigForTests({
      layer: null,
      legacy: false,
      notices: [],
    });
    const view = modelSettingsView(null);
    expect(
      view.presets.find((preset) => preset.id === 'openai-tts')?.capabilities.tts,
    ).toBeUndefined();
    // Nor does a plan recommend a capability it no longer offers.
    for (const preset of view.presets) {
      if (!preset.capabilities.tts) expect(preset.recommended).not.toHaveProperty('tts');
    }
    const withProvider = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'voice',
      preset: 'openai-tts',
      apiKey: 'sk-k',
    });
    await expect(
      applyModelSettingsChange(withProvider, { kind: 'slots', set: { tts: 'voice' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENT' });
  });

  it('lists the models of a search provider that searches through a model', () => {
    const search = modelSettingsView(null).presets.find((preset) => preset.id === 'claude');
    expect(search?.capabilities.webSearch?.models.length).toBeGreaterThan(0);
  });

  it('flags a key that no longer opens', () => {
    const view = modelSettingsView({
      config: { providers: { mine: { preset: 'openai' } } },
      revision: 1,
      unreadableSecrets: ['mine'],
    });
    expect(view.providers.find((provider) => provider.id === 'mine')?.key).toEqual({
      set: true,
      unreadable: true,
    });
  });
});

describe('environment configuration through runtime and serialized model settings', () => {
  let dir: string;
  let runtime: typeof import('@/lib/server/model-config/runtime');
  let settings: typeof import('@/lib/server/model-config/settings');
  const fetch = vi.fn(() => {
    throw new Error('Unexpected upstream request');
  });
  const chatSlots = ['llm', 'course.outline', 'course.content', 'course.actions'] as const;
  const chatProviders = [
    { preset: 'openai', model: 'gpt-5.6', prefixes: ['OPENAI'] },
    { preset: 'azure', model: 'test-gpt-deployment', prefixes: ['AZURE_OPENAI'] },
    { preset: 'atlascloud', model: 'deepseek-ai/deepseek-v4-pro', prefixes: ['ATLASCLOUD'] },
    { preset: 'anthropic', model: 'claude-sonnet-4-6', prefixes: ['ANTHROPIC'] },
    { preset: 'bedrock', model: 'us.anthropic.claude-sonnet-4-6', prefixes: ['BEDROCK'] },
    { preset: 'google', model: 'gemini-3.5-flash', prefixes: ['GOOGLE'] },
    { preset: 'deepseek', model: 'deepseek-v4-pro', prefixes: ['DEEPSEEK'] },
    { preset: 'qwen', model: 'qwen3.7-plus', prefixes: ['QWEN'] },
    { preset: 'kimi', model: 'kimi-k2.7-code', prefixes: ['KIMI'] },
    { preset: 'minimax', model: 'MiniMax-M3', prefixes: ['MINIMAX'] },
    { preset: 'glm', model: 'glm-5.2', prefixes: ['GLM'] },
    { preset: 'siliconflow', model: 'deepseek-ai/DeepSeek-V3.2', prefixes: ['SILICONFLOW'] },
    { preset: 'doubao', model: 'doubao-seed-2-1-pro-260628', prefixes: ['DOUBAO'] },
    { preset: 'openrouter', model: 'deepseek/deepseek-v4-pro', prefixes: ['OPENROUTER'] },
    { preset: 'grok', model: 'grok-4.6', prefixes: ['GROK'] },
    { preset: 'tencent-hunyuan', model: 'hy3-preview', prefixes: ['TENCENT', 'TENCENT_HUNYUAN'] },
    { preset: 'xiaomi', model: 'mimo-v2.6-pro', prefixes: ['XIAOMI', 'MIMO'] },
    { preset: 'tokendance', model: 'cogevol-base', prefixes: ['TOKENDANCE'] },
    { preset: 'ollama', model: 'llama3.3', prefixes: ['OLLAMA'] },
    { preset: 'lemonade', model: 'Gemma-4-26B-A4B-it-GGUF', prefixes: ['LEMONADE'] },
    { preset: 'openai-compatible', model: 'gpt-5.4-mini', prefixes: [] },
    { preset: 'volcengine-ark', model: 'doubao-seed-2.1-turbo', prefixes: [] },
    { preset: 'kimi-coding-plan', model: 'kimi-for-coding', prefixes: [] },
  ];
  const upstream = vi.fn(() => {
    throw new Error('Unexpected Node upstream connection');
  });
  const workspace: StoredWorkspaceConfig = {
    config: {
      providers: { mine: { preset: 'openai', apiKey: 'test-workspace-key-9876' } },
      slots: { llm: 'mine:gpt-5.6' },
    },
    revision: 7,
    unreadableSecrets: [],
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmaic-settings-env-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    for (const name of Object.keys(process.env)) {
      if (
        /(?:_API_KEY|_BASE_URL|_MODELS|_ENABLED|_PROXY)$/.test(name) ||
        /^(?:AWS_|BEDROCK_|ALIDOCMIND_)/.test(name) ||
        [
          'OPENMAIC_CONFIG',
          'DEFAULT_MODEL',
          'DEFAULT_IMAGE_PROVIDER',
          'MODEL_ROUTES',
          'MODEL_FALLBACK',
          'DATABASE_URL',
        ].includes(name)
      ) {
        vi.stubEnv(name, '');
      }
    }
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key-1234');
    vi.stubEnv('ANTHROPIC_MODELS', 'claude-sonnet-4-6');
    vi.stubEnv('DEFAULT_MODEL', 'anthropic:claude-sonnet-4-6');
    fetch.mockClear();
    upstream.mockClear();
    vi.spyOn(http, 'request').mockImplementation(upstream);
    vi.spyOn(http, 'get').mockImplementation(upstream);
    vi.spyOn(https, 'request').mockImplementation(upstream);
    vi.spyOn(https, 'get').mockImplementation(upstream);
    vi.spyOn(net, 'connect').mockImplementation(upstream);
    vi.spyOn(net, 'createConnection').mockImplementation(upstream);
    vi.spyOn(tls, 'connect').mockImplementation(upstream);
    vi.stubGlobal('fetch', fetch);
    vi.resetModules();
    runtime = await import('@/lib/server/model-config/runtime');
    runtime.setDeploymentConfigForTests();
    settings = await import('@/lib/server/model-config/settings');
  });

  afterEach(() => {
    try {
      expect(fetch).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      runtime?.setDeploymentConfigForTests();
      runtime?.setWorkspaceLayerLoaderForTests();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.resetModules();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function serializedView(stored: StoredWorkspaceConfig | null) {
    const json = JSON.stringify(settings.modelSettingsView(stored));
    expect(json).not.toContain('test-anthropic-key-1234');
    expect(json).not.toContain('test-workspace-key-9876');
    expect(json).not.toContain('${ANTHROPIC_API_KEY}');
    return JSON.parse(json) as ReturnType<typeof settings.modelSettingsView>;
  }

  async function expectChat(
    stored: StoredWorkspaceConfig | null,
    target: { providerId: string; modelId: string; source: string; providerSource: string },
    locked = false,
  ) {
    runtime.setWorkspaceLayerLoaderForTests(async (ownerId) => {
      expect(ownerId).toBe('test-owner');
      return stored ? { source: 'workspace', config: stored.config } : null;
    });
    const view = serializedView(stored);
    for (const slot of chatSlots) {
      expect(view.slots.find((entry) => entry.slot === slot)).toMatchObject({
        locked,
        effective: { status: 'assigned', resolvedAt: 'llm', ...target },
      });
      await expect(runtime.lookupSlot(slot, stored ? 'test-owner' : null)).resolves.toMatchObject({
        status: 'assigned',
        resolvedAt: 'llm',
        locked,
        ...target,
      });
      expect(view.slots.find((entry) => entry.slot === slot)!.effective).not.toHaveProperty(
        'fallback',
      );
    }
    return view;
  }

  function writeYaml(locked: boolean) {
    fs.writeFileSync(
      path.join(dir, 'study.yml'),
      `providers:
  study:
    preset: anthropic
    apiKey: \${ANTHROPIC_API_KEY}
    models: [claude-sonnet-4-6]
slots:
  llm: study:claude-sonnet-4-6
  tts: null
${locked ? 'lock: [llm, tts]\nallowUserKeys: false\n' : ''}`,
    );
    vi.stubEnv('OPENMAIC_CONFIG', './study.yml');
    vi.stubEnv('DEFAULT_MODEL', 'anthropic:claude-opus-4-6');
  }

  it('covers every chat preset, registry provider and legacy env prefix', async () => {
    const { PROVIDER_PRESETS, presetModels } = await import('@/lib/config/provider-presets');
    const { PROVIDERS } = await import('@/lib/ai/providers');
    const { LLM_ENV_MAP } = await import('@/lib/server/provider-config');
    expect(new Set(chatProviders.map(({ preset }) => preset))).toEqual(
      new Set(PROVIDER_PRESETS.filter((preset) => preset.capabilities.chat).map(({ id }) => id)),
    );
    expect(
      new Set(chatProviders.filter(({ prefixes }) => prefixes.length).map(({ preset }) => preset)),
    ).toEqual(new Set(Object.keys(PROVIDERS)));
    expect(
      Object.fromEntries(
        chatProviders.flatMap(({ preset, prefixes }) => prefixes.map((prefix) => [prefix, preset])),
      ),
    ).toEqual(LLM_ENV_MAP);
    for (const { preset, model } of chatProviders) {
      if (['azure', 'openai-compatible'].includes(preset)) continue;
      expect(
        presetModels(PROVIDER_PRESETS.find(({ id }) => id === preset)!, 'chat').map(({ id }) => id),
      ).toContain(model);
    }
  });

  function configureChat(preset: string, model: string, prefix?: string, locked = false) {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_MODELS', '');
    vi.stubEnv('TEST_CHAT_API_KEY', 'test-matrix-secret-1234');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-aws-access-id');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-aws-secret-value');
    vi.stubEnv('AWS_SESSION_TOKEN', 'test-aws-session-value');
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true');
    vi.stubEnv('BEDROCK_REGION', preset === 'bedrock' ? 'us-east-1' : '');
    const keyless = keylessPreset(preset);
    const baseUrl =
      preset === 'azure'
        ? 'https://test-resource.openai.azure.com/openai'
        : preset === 'ollama'
          ? 'http://127.0.0.1:11434/v1'
          : preset === 'lemonade'
            ? 'http://127.0.0.1:13305/v1'
            : preset === 'openai-compatible'
              ? 'https://gateway.example.invalid/v1'
              : undefined;
    if (prefix) {
      vi.stubEnv(`${prefix}_API_KEY`, keyless ? '' : 'test-matrix-secret-1234');
      vi.stubEnv(`${prefix}_MODELS`, ` ${model}, , `);
      if (baseUrl) vi.stubEnv(`${prefix}_BASE_URL`, baseUrl);
      vi.stubEnv('DEFAULT_MODEL', `${preset}:${model}`);
      return preset;
    }
    const id = 'study';
    fs.writeFileSync(
      path.join(dir, 'matrix.yml'),
      yaml.dump({
        providers: {
          [id]: {
            preset,
            ...(!keyless ? { apiKey: '${TEST_CHAT_API_KEY}' } : {}),
            ...(baseUrl ? { baseUrl } : {}),
            models: [model],
          },
        },
        slots: { llm: `${id}:${model}` },
        ...(locked ? { lock: ['llm'] } : {}),
      }),
    );
    vi.stubEnv('OPENMAIC_CONFIG', './matrix.yml');
    vi.stubEnv('DEFAULT_MODEL', 'openai:competing-legacy-model');
    return id;
  }

  const chatCases = chatProviders.flatMap((provider) => [
    ...provider.prefixes.flatMap((prefix) =>
      ['default', 'workspace'].map((mode) => ({ ...provider, prefix, mode })),
    ),
    ...['default', 'workspace', 'locked'].map((mode) => ({ ...provider, prefix: undefined, mode })),
  ]);

  it.each(chatCases)(
    '$preset via $prefix ($mode) resolves the exact chat provider and model',
    async ({ preset, model, prefix, mode }) => {
      const id = configureChat(preset, model, prefix, mode === 'locked');
      const stored = mode === 'default' ? null : workspace;
      const overridden = mode === 'workspace';
      const view = await expectChat(
        stored,
        {
          providerId: overridden ? 'mine' : id,
          modelId: overridden ? 'gpt-5.6' : model,
          source: overridden ? 'workspace' : mode === 'locked' ? 'locked' : 'default',
          providerSource: overridden ? 'workspace' : 'deployment',
        },
        mode === 'locked',
      );
      expect(runtime.deploymentConfig().legacy).toBe(!!prefix);
      expect(runtime.deploymentConfig().layer?.config.providers?.[id]).toMatchObject({
        preset,
        models: [model],
        ...(!keylessPreset(preset) ? { apiKey: 'test-matrix-secret-1234' } : {}),
      });
      expect(view.providers.find((provider) => provider.id === id)).toMatchObject({
        preset,
        source: 'deployment',
      });
      expect(view.slots.find((slot) => slot.slot === 'llm')!.serverDefault).toBe(`${id}:${model}`);
      const json = JSON.stringify(view);
      for (const secret of [
        'test-matrix-secret-1234',
        'test-aws-access-id',
        'test-aws-secret-value',
        'test-aws-session-value',
        '${TEST_CHAT_API_KEY}',
        'gateway.example.invalid',
        '127.0.0.1',
      ]) {
        expect(json).not.toContain(secret);
      }
      const target = await runtime.lookupSlot('llm', null);
      expect(target).toMatchObject({ providerId: id, presetId: preset, modelId: model });
      if (keylessPreset(preset)) expect(target).not.toHaveProperty('apiKey');
    },
  );

  type MediaCapability = 'tts' | 'asr' | 'image' | 'video' | 'webSearch' | 'document';
  type MediaProvider = {
    preset: string;
    capability: MediaCapability;
    model: string | null;
    prefix: string | null;
  };
  const mediaProviders: MediaProvider[] = (
    [
      [
        'tts',
        [
          ['openai-tts', 'gpt-4o-mini-tts', 'TTS_OPENAI'],
          ['openrouter-tts', 'google/gemini-3.8-flash-lite-tts', 'TTS_OPENROUTER'],
          ['azure-tts', null, 'TTS_AZURE'],
          ['glm-tts', 'glm-tts', 'TTS_GLM'],
          ['qwen-tts', 'qwen3-tts-flash', 'TTS_QWEN'],
          ['minimax-tts', 'speech-2.8-hd', 'TTS_MINIMAX'],
          ['voxcpm-tts', 'voxcpm2', 'TTS_VOXCPM'],
          ['doubao-tts', null, 'TTS_DOUBAO'],
          ['elevenlabs-tts', 'eleven_multilingual_v2', 'TTS_ELEVENLABS'],
          ['google-tts', 'gemini-3.1-flash-tts-preview', 'TTS_GOOGLE'],
          ['browser-native-tts', null, null],
          ['lemonade-tts', 'kokoro-v1', 'TTS_LEMONADE'],
        ],
      ],
      [
        'asr',
        [
          ['openai-whisper', 'gpt-4o-mini-transcribe', 'ASR_OPENAI'],
          ['qwen-asr', 'qwen3-asr-flash', 'ASR_QWEN'],
          ['azure-asr', null, 'ASR_AZURE'],
          ['browser-native', null, null],
          ['funasr-asr', 'sensevoice', 'ASR_FUNASR'],
          ['lemonade-asr', 'Whisper-Base', 'ASR_LEMONADE'],
        ],
      ],
      [
        'image',
        [
          ['seedream', 'doubao-seedream-5-0-260128', 'IMAGE_SEEDREAM'],
          ['openai-image', 'gpt-image-2', 'IMAGE_OPENAI'],
          ['qwen-image', 'qwen-image-2.0-pro', 'IMAGE_QWEN_IMAGE'],
          ['nano-banana', 'gemini-3.1-flash-image-preview', 'IMAGE_NANO_BANANA'],
          ['minimax-image', 'image-01', 'IMAGE_MINIMAX'],
          ['grok-image', 'grok-imagine-image', 'IMAGE_GROK'],
          ['glm-image', 'cogview-3-flash', 'IMAGE_GLM'],
          ['comfyui-image', null, null],
          ['lemonade-image', 'Qwen-Image-GGUF', 'IMAGE_LEMONADE'],
          ['openrouter-image', 'google/gemini-2.5-flash-image', 'IMAGE_OPENROUTER'],
        ],
      ],
      [
        'video',
        [
          ['seedance', 'doubao-seedance-2-0-260128', 'VIDEO_SEEDANCE'],
          ['kling', 'kling-v2-6', 'VIDEO_KLING'],
          ['veo', 'veo-3.1-fast-generate-preview', 'VIDEO_VEO'],
          ['minimax-video', 'MiniMax-Hailuo-2.3', 'VIDEO_MINIMAX'],
          ['grok-video', 'grok-imagine-video', 'VIDEO_GROK'],
          ['happyhorse', 'happyhorse-1.0-t2v', 'VIDEO_HAPPYHORSE'],
          ['openrouter-video', 'google/veo-3.1', 'VIDEO_OPENROUTER'],
        ],
      ],
      [
        'webSearch',
        [
          ['tavily', null, 'TAVILY'],
          ['exa', null, 'EXA'],
          ['bocha', null, 'BOCHA'],
          ['brave', null, 'BRAVE'],
          ['baidu', null, 'BAIDU'],
          ['claude', 'claude-sonnet-5', 'WEB_SEARCH_CLAUDE'],
          ['minimax-search', null, 'WEB_SEARCH_MINIMAX'],
          ['doubao-search', null, 'WEB_SEARCH_DOUBAO'],
          ['searxng', null, 'SEARXNG'],
        ],
      ],
      [
        'document',
        [
          ['unpdf', null, 'PDF_UNPDF'],
          ['mineru', null, 'PDF_MINERU'],
          ['mineru-cloud', null, 'PDF_MINERU_CLOUD'],
          ['alidocmind', null, 'ALIDOCMIND'],
        ],
      ],
    ] satisfies [MediaCapability, [string, string | null, string | null][]][]
  ).flatMap(([capability, rows]) =>
    rows.map(([preset, model, prefix]) => ({ preset, capability, model, prefix })),
  );

  it('covers exactly every nonchat capability of every media-only preset and its catalog models', async () => {
    const { PROVIDER_PRESETS, presetModels } = await import('@/lib/config/provider-presets');
    const { providerModelsSetting } = await import('@/lib/server/provider-config');
    expect(
      mediaProviders.map(({ preset, capability }) => `${preset}/${capability}`).sort(),
    ).toEqual(
      PROVIDER_PRESETS.filter((preset) => !preset.capabilities.chat)
        .flatMap((preset) =>
          Object.keys(preset.capabilities).map((capability) => `${preset.id}/${capability}`),
        )
        .sort(),
    );
    for (const { preset, capability, model, prefix } of mediaProviders) {
      const entry = PROVIDER_PRESETS.find(({ id }) => id === preset)!;
      const models = presetModels(entry, capability).map(({ id }) => id);
      if (model === null) expect(models).toEqual([]);
      else expect(models).toContain(model);
      const registryId = entry.capabilities[capability]!.registryId;
      const setting = providerModelsSetting(
        capability === 'document' ? 'pdf' : capability,
        registryId,
      );
      if (prefix && preset !== 'alidocmind')
        expect(setting).toMatch(new RegExp(`^${prefix}_MODELS or `));
      else expect(setting).toMatch(/^server-providers\.yml /);
    }
  });

  const mediaCases = mediaProviders.flatMap((provider) => [
    ...['default', 'provider-default', 'workspace', 'locked'].map((mode) => ({
      ...provider,
      mode,
      legacy: false,
    })),
    ...(provider.prefix
      ? ['default', 'workspace'].map((mode) => ({ ...provider, mode, legacy: true }))
      : []),
  ]);

  it.each(mediaCases)(
    '$preset/$capability via legacy=$legacy ($mode) resolves the exact media provider and model',
    async ({ preset, capability, model, prefix, mode, legacy }) => {
      const { getProviderPreset, registryRequiresApiKey } =
        await import('@/lib/config/provider-presets');
      const entry = getProviderPreset(preset)!;
      const registryId = entry.capabilities[capability]!.registryId;
      const needsKey = !entry.requiresCredentials && registryRequiresApiKey(capability, registryId);
      const needsEndpoint =
        entry.requiresBaseUrl || (!needsKey && !entry.requiresCredentials && !!prefix);
      const endpoint = 'https://media.example.invalid/v1';
      const apiKey = 'test-media-secret-4321';
      const credentials = {
        accessKeyId: 'test-media-access-id',
        accessKeySecret: 'test-media-access-secret',
      };
      vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true');
      vi.stubEnv('TEST_MEDIA_API_KEY', apiKey);
      vi.stubEnv('TEST_MEDIA_BASE_URL', endpoint);
      vi.stubEnv('TEST_MEDIA_ACCESS_KEY_ID', credentials.accessKeyId);
      vi.stubEnv('TEST_MEDIA_ACCESS_KEY_SECRET', credentials.accessKeySecret);
      const provider = {
        preset,
        ...(needsKey ? { apiKey } : {}),
        ...(entry.requiresCredentials ? { credentials } : {}),
        ...(needsEndpoint ? { baseUrl: endpoint } : {}),
        ...(model && mode !== 'provider-default' ? { models: [model] } : {}),
      };
      const id = legacy ? preset : 'media';
      const ref = (providerId: string) =>
        providerId + (model && mode !== 'provider-default' ? `:${model}` : '');
      if (legacy) {
        if (needsKey) vi.stubEnv(`${prefix}_API_KEY`, apiKey);
        if (needsEndpoint) vi.stubEnv(`${prefix}_BASE_URL`, endpoint);
        if (model) vi.stubEnv(`${prefix}_MODELS`, ` ${model}, , `);
        if (entry.requiresCredentials) {
          vi.stubEnv('ALIDOCMIND_ACCESS_KEY_ID', credentials.accessKeyId);
          vi.stubEnv('ALIDOCMIND_ACCESS_KEY_SECRET', credentials.accessKeySecret);
        }
      } else {
        fs.writeFileSync(
          path.join(dir, 'media.yml'),
          yaml.dump({
            providers: {
              [id]: {
                ...provider,
                ...(needsKey ? { apiKey: '${TEST_MEDIA_API_KEY}' } : {}),
                ...(needsEndpoint ? { baseUrl: '${TEST_MEDIA_BASE_URL}' } : {}),
                ...(entry.requiresCredentials
                  ? {
                      credentials: {
                        accessKeyId: '${TEST_MEDIA_ACCESS_KEY_ID}',
                        accessKeySecret: '${TEST_MEDIA_ACCESS_KEY_SECRET}',
                      },
                    }
                  : {}),
              },
            },
            slots: { [capability]: ref(id) },
            ...(mode === 'locked' ? { lock: [capability] } : {}),
          }),
        );
        vi.stubEnv('OPENMAIC_CONFIG', './media.yml');
      }
      const stored: StoredWorkspaceConfig | null = ['workspace', 'locked'].includes(mode)
        ? {
            config: {
              slots: { [capability]: ref('alternative') },
              providers: { alternative: { ...provider, baseUrl: undefined } },
            },
            revision: 8,
            unreadableSecrets: [],
          }
        : null;
      runtime.setWorkspaceLayerLoaderForTests(async (ownerId) => {
        expect(ownerId).toBe('test-owner');
        return stored ? { source: 'workspace', config: stored.config } : null;
      });
      const view = serializedView(stored);
      const slot = view.slots.find(({ slot }) => slot === capability)!;
      const overridden = mode === 'workspace';
      const target = {
        status: 'assigned',
        resolvedAt: capability,
        providerId: overridden ? 'alternative' : id,
        providerSource: overridden ? 'workspace' : 'deployment',
        source: overridden ? 'workspace' : mode === 'locked' ? 'locked' : 'default',
        presetId: preset,
        registryId,
        ...(model ? { modelId: model } : {}),
      };
      expect(slot).toMatchObject({
        locked: mode === 'locked',
        serverDefault: ref(id),
        effective: target,
      });
      const resolved = await runtime.lookupSlot(capability, stored ? 'test-owner' : null);
      expect(resolved).toMatchObject({ ...target, locked: mode === 'locked' });
      if (model === null) {
        expect(slot.effective).not.toHaveProperty('modelId');
        expect(resolved).not.toHaveProperty('modelId');
      }
      expect(runtime.deploymentConfig().legacy).toBe(legacy);
      expect(runtime.deploymentConfig().layer?.config.providers?.[id]).toEqual(provider);
      expect(view.providers.find((provider) => provider.id === id)).toMatchObject({
        preset,
        source: 'deployment',
      });
      if (needsKey) expect(resolved).toMatchObject({ apiKey });
      else expect(resolved).not.toHaveProperty('apiKey');
      if (entry.requiresCredentials) expect(resolved).toMatchObject({ credentials });
      for (const secret of [apiKey, ...Object.values(credentials), endpoint, '${TEST_MEDIA_']) {
        expect(JSON.stringify(view)).not.toContain(secret);
      }
    },
  );

  function keylessPreset(preset: string) {
    return ['ollama', 'lemonade', 'bedrock'].includes(preset);
  }

  it('loads the legacy Anthropic env default for chat and inherited course slots', async () => {
    const view = await expectChat(null, {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      source: 'default',
      providerSource: 'deployment',
    });
    expect(runtime.deploymentConfig()).toMatchObject({
      legacy: true,
      layer: {
        config: {
          providers: {
            anthropic: {
              preset: 'anthropic',
              apiKey: 'test-anthropic-key-1234',
              models: ['claude-sonnet-4-6'],
            },
          },
          slots: { llm: 'anthropic:claude-sonnet-4-6' },
        },
      },
    });
    expect(view.slots.find((entry) => entry.slot === 'llm')!.serverDefault).toBe(
      'anthropic:claude-sonnet-4-6',
    );
    expect(view.slots.find((entry) => entry.slot === 'tts')!.effective.status).toBe('unassigned');
  });

  it('lets an unlocked workspace provider and model beat the legacy env default', async () => {
    const view = await expectChat(workspace, {
      providerId: 'mine',
      modelId: 'gpt-5.6',
      source: 'workspace',
      providerSource: 'workspace',
    });
    expect(runtime.deploymentConfig().legacy).toBe(true);
    expect(view.slots.find((entry) => entry.slot === 'llm')).toMatchObject({
      assignment: 'mine:gpt-5.6',
      serverDefault: 'anthropic:claude-sonnet-4-6',
    });
  });

  it('loads the locked study YAML with env interpolation instead of the competing legacy default', async () => {
    writeYaml(true);
    const competing: StoredWorkspaceConfig = {
      ...workspace,
      config: {
        ...workspace.config,
        slots: {
          llm: 'mine:gpt-5.6',
          'course.outline': 'study:claude-opus-4-6',
          'course.content': null,
          'course.actions': 'mine:gpt-5.6',
          tts: 'mine:gpt-5.6',
        },
      },
    };
    const view = await expectChat(
      competing,
      {
        providerId: 'study',
        modelId: 'claude-sonnet-4-6',
        source: 'locked',
        providerSource: 'deployment',
      },
      true,
    );
    expect(runtime.deploymentConfig()).toMatchObject({
      legacy: false,
      layer: {
        config: {
          providers: { study: { preset: 'anthropic', apiKey: 'test-anthropic-key-1234' } },
          slots: { llm: 'study:claude-sonnet-4-6', tts: null },
          lock: ['llm', 'tts'],
          allowUserKeys: false,
        },
      },
    });
    expect(view.allowUserKeys).toBe(false);
    expect(view.providers.map((provider) => provider.id)).toEqual(['study']);
    expect(view.presets).toEqual([]);
    expect(view.slots.find((entry) => entry.slot === 'tts')).toMatchObject({
      locked: true,
      effective: { status: 'disabled', resolvedAt: 'tts', source: 'locked' },
    });
    await expect(runtime.lookupSlot('tts', 'test-owner')).resolves.toMatchObject({
      status: 'disabled',
      resolvedAt: 'tts',
      source: 'locked',
      locked: true,
    });
  });

  it('lets a workspace override the same YAML default when it is not locked', async () => {
    writeYaml(false);
    const view = await expectChat(workspace, {
      providerId: 'mine',
      modelId: 'gpt-5.6',
      source: 'workspace',
      providerSource: 'workspace',
    });
    expect(runtime.deploymentConfig().legacy).toBe(false);
    expect(view.allowUserKeys).toBe(true);
    expect(view.slots.find((entry) => entry.slot === 'llm')!.serverDefault).toBe(
      'study:claude-sonnet-4-6',
    );
  });
});

describe('applyModelSettingsChange', () => {
  it('refuses a slot the deployment locks, and every slot below it', async () => {
    await expect(
      applyModelSettingsChange(null, { kind: 'slots', set: { video: 'operator:x' } }),
    ).rejects.toMatchObject({ code: 'SLOT_LOCKED' });
    deployment({
      providers: {
        operator: {
          preset: 'deepseek',
          apiKey: 'sk-operator-secret-0001',
          models: ['deepseek-v4-pro', 'deepseek-flash'],
        },
      },
      slots: { llm: 'operator:deepseek-v4-pro' },
      lock: ['llm'],
    });
    for (const slot of ['llm', 'course.content', 'course.content.slide', 'agent.title']) {
      await expect(
        applyModelSettingsChange(null, { kind: 'slots', set: { [slot]: null } }),
      ).rejects.toMatchObject({ code: 'SLOT_LOCKED' });
    }
    // Clearing a stale assignment made before the lock is allowed.
    expect(
      await applyModelSettingsChange(
        { slots: { 'course.outline': 'operator:deepseek-flash', image: null } },
        { kind: 'slots', clear: ['course.outline'] },
      ),
    ).toEqual({ slots: { image: null } });
    await expect(
      applyModelSettingsChange(null, {
        kind: 'slots',
        set: { 'course.content.slide': 'operator:deepseek-flash' },
      }),
    ).rejects.toMatchObject({
      code: 'SLOT_LOCKED',
      message: 'course.content.slide is fixed by the administrator (with llm)',
    });
    // Other trees stay the workspace's.
    expect(await applyModelSettingsChange(null, { kind: 'slots', set: { image: null } })).toEqual({
      slots: { image: null },
    });
    deployment({ lock: 'all' });
    await expect(
      applyModelSettingsChange(null, { kind: 'slots', set: { image: null } }),
    ).rejects.toMatchObject({ code: 'SLOT_LOCKED' });
  });

  it('lets the workspace replace a server default, and reset it by clearing', async () => {
    const changed = await applyModelSettingsChange(null, {
      kind: 'slots',
      set: { llm: 'operator:deepseek-flash' },
    });
    const view = modelSettingsView({ config: changed, revision: 1, unreadableSecrets: [] });
    expect(view.slots.find((slot) => slot.slot === 'llm')).toMatchObject({
      source: { kind: 'workspace' },
      serverDefault: 'operator:deepseek-v4-pro',
      effective: { modelId: 'deepseek-flash' },
    });
    const reset = await applyModelSettingsChange(changed, { kind: 'slots', clear: ['llm'] });
    expect(reset).toEqual({});
  });

  it('assigns, turns off and clears slots, over deployment providers too', async () => {
    const next = await applyModelSettingsChange(null, {
      kind: 'slots',
      set: { 'course.outline': 'operator:deepseek-flash', image: null },
    });
    expect(next).toEqual({
      slots: { 'course.outline': 'operator:deepseek-flash', image: null },
    });
    expect(await applyModelSettingsChange(next, { kind: 'slots', clear: ['image'] })).toEqual({
      slots: { 'course.outline': 'operator:deepseek-flash' },
    });
  });

  it('refuses a thinking effort on the agent slot, whatever else the change sets', async () => {
    await expect(
      applyModelSettingsChange(null, {
        kind: 'slots',
        set: {
          'course.outline': 'operator:deepseek-flash',
          agent: {
            model: 'operator:deepseek-flash',
            thinking: { mode: 'enabled', effort: 'high' },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_ASSIGNMENT',
      message: expect.stringContaining('slots.agent.thinking.effort'),
    });
    // The same effort on another slot, or no effort on the agent, is saved.
    expect(
      await applyModelSettingsChange(null, {
        kind: 'slots',
        set: {
          classroom: { model: 'operator:deepseek-flash', thinking: { effort: 'high' } },
          agent: { model: 'operator:deepseek-flash', thinking: { mode: 'enabled' } },
        },
      }),
    ).toMatchObject({ slots: { agent: { thinking: { mode: 'enabled' } } } });
  });

  it('refuses an assignment that does not resolve', async () => {
    await expect(
      applyModelSettingsChange(null, { kind: 'slots', set: { tts: 'operator' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENT' });
    await expect(
      applyModelSettingsChange(null, { kind: 'slots', set: { 'course.outline': 'ghost:m' } }),
    ).rejects.toBeInstanceOf(ModelSettingsError);
  });

  it('adds a provider, keeps its key when omitted and removes it when emptied', async () => {
    let config = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'mine',
      preset: 'openai',
      apiKey: 'sk-1',
    });
    config = await applyModelSettingsChange(config, {
      kind: 'provider',
      id: 'mine',
      preset: 'openai',
      models: ['gpt-5.6'],
    });
    expect(config.providers?.mine).toEqual({
      preset: 'openai',
      apiKey: 'sk-1',
      models: ['gpt-5.6'],
    });
    config = await applyModelSettingsChange(config, {
      kind: 'provider',
      id: 'mine',
      preset: 'openai',
      apiKey: '',
    });
    expect(config.providers?.mine).toEqual({ preset: 'openai', models: ['gpt-5.6'] });
  });

  it('keeps workspace providers out of what only the deployment may set', async () => {
    for (const [provider, message] of [
      [{ id: 'operator', preset: 'openai' }, /deployment declares this provider id/],
      [{ id: 'b', preset: 'bedrock' }, /Amazon Bedrock/],
      [
        { id: 'l', preset: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' },
        /Local\/private/,
      ],
      [{ id: 'z', preset: 'openai-compatible' }, /needs a base URL/],
      [{ id: 'c', preset: 'comfyui-image' }, /server's own network/],
      [{ id: 'o', preset: 'ollama' }, /needs a base URL/],
      [
        { id: 'u', preset: 'openai-compatible', baseUrl: 'https://user:pw@1.1.1.1/v1' },
        /not in the base URL/,
      ],
      [{ id: 'a', preset: 'alidocmind', apiKey: 'k' }, /key pair/],
      [{ id: 'bad_id', preset: 'openai', apiKey: 'sk-k' }, /lowercase letters/],
      [{ id: '__proto__', preset: 'openai', apiKey: 'sk-k' }, /lowercase letters/],
    ] as const) {
      await expect(
        applyModelSettingsChange(null, { kind: 'provider', ...provider }),
      ).rejects.toThrow(message);
    }
  });

  it('keeps custom endpoints to chat: media, search and document services use the preset', async () => {
    for (const provider of [
      { id: 's', preset: 'searxng', baseUrl: 'https://searx.example' },
      { id: 't', preset: 'tavily', apiKey: 'k', baseUrl: 'https://search.example' },
    ]) {
      await expect(
        applyModelSettingsChange(null, { kind: 'provider', ...provider }),
      ).rejects.toThrow(/can only be configured by the deployment/);
    }
    const plan = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'mm',
      preset: 'minimax',
      apiKey: 'k',
      baseUrl: 'https://1.1.1.1/v1',
    });
    await expect(
      applyModelSettingsChange(plan, { kind: 'slots', set: { 'course.content': 'mm:MiniMax-M2' } }),
    ).resolves.toBeTruthy();
    await expect(
      applyModelSettingsChange(plan, { kind: 'slots', set: { tts: 'mm:speech-2.8-turbo' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENT' });
  });

  it('refuses providers when the deployment policy does not allow them', async () => {
    deployment({ allowUserKeys: false });
    await expect(
      applyModelSettingsChange(null, { kind: 'provider', id: 'mine', preset: 'openai' }),
    ).rejects.toMatchObject({ code: 'PROVIDERS_NOT_ALLOWED' });
  });

  it('refuses an assignment to a kept workspace provider once the policy forbids them', async () => {
    const kept = {
      providers: { mine: { preset: 'openai', apiKey: 'sk-mine-0000000000' } },
      slots: { 'course.outline': 'mine:gpt-5.6' },
    };
    deployment({ allowUserKeys: false });
    await expect(
      applyModelSettingsChange(kept, { kind: 'slots', set: { llm: 'mine:gpt-5.6' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENT' });
    // A dormant assignment is not checked, even on a provider switched off since.
    vi.stubEnv('TAVILY_ENABLED', 'false');
    vi.resetModules();
    const fresh = await import('@/lib/server/model-config/settings');
    (await import('@/lib/server/model-config/runtime')).setDeploymentConfigForTests({
      layer: { source: 'deployment', config: { allowUserKeys: false } },
      legacy: false,
      notices: [],
    });
    const dormantSearch = {
      providers: { tv: { preset: 'tavily', apiKey: 'tvly-kept-000000' } },
      slots: { webSearch: 'tv' },
    };
    await expect(
      fresh.applyModelSettingsChange(dormantSearch, { kind: 'slots', set: { video: null } }),
    ).resolves.toMatchObject({ slots: { webSearch: 'tv', video: null } });
    // Other edits still save, leaving the dormant assignment as it is.
    await expect(
      applyModelSettingsChange(kept, { kind: 'slots', set: { video: null } }),
    ).resolves.toMatchObject({ slots: { 'course.outline': 'mine:gpt-5.6', video: null } });
  });

  it('drops the assignments a provider can no longer serve once its key is removed', async () => {
    const current = {
      providers: {
        plan: { preset: 'tokendance', apiKey: 'sk-plan-key-0001' },
        local: { preset: 'ollama', baseUrl: 'https://1.1.1.1/v1', models: ['llama4'] },
      },
      slots: {
        classroom: 'plan:cogevol-base',
        'course.outline': { model: 'operator:deepseek-v4-pro', fallback: 'plan:cogevol-base' },
        webSearch: 'plan',
        'agent.title': 'local:llama4',
        image: null,
      },
    };
    // A new key keeps them.
    await expect(
      applyModelSettingsChange(current, {
        kind: 'provider',
        id: 'plan',
        preset: 'tokendance',
        apiKey: 'sk-plan-key-0002',
      }),
    ).resolves.toMatchObject({ slots: current.slots });
    // No key: the slots that used the plan follow their parents again.
    const next = await applyModelSettingsChange(current, {
      kind: 'provider',
      id: 'plan',
      preset: 'tokendance',
      apiKey: '',
    });
    expect(next.providers?.plan).toEqual({ preset: 'tokendance' });
    expect(next.slots).toEqual({ 'agent.title': 'local:llama4', image: null });
    // A provider that needs no key keeps what it serves.
    const keyless = await applyModelSettingsChange(next, {
      kind: 'provider',
      id: 'local',
      preset: 'ollama',
      apiKey: '',
    });
    expect(keyless.slots).toEqual({ 'agent.title': 'local:llama4', image: null });
  });

  it("connecting a token plan applies the plan's recommendation over the workspace's own picks", async () => {
    // The workspace already picked its own models for some of the slots the plan recommends.
    let config = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'mine',
      preset: 'openai',
      apiKey: 'sk-mine-key-0001',
    });
    config = await applyModelSettingsChange(config, {
      kind: 'slots',
      set: {
        'course.content.slide': 'mine:gpt-5.6',
        'course.content.interactive': {
          model: 'mine:gpt-5.6',
          fallback: 'operator:deepseek-v4-pro',
        },
        webSearch: null,
        'course.outline': 'mine:gpt-5.6',
      },
    });
    config = await applyModelSettingsChange(config, {
      kind: 'provider',
      id: 'tokendance',
      preset: 'tokendance',
      apiKey: 'sk-plan-key-0001',
    });
    const view = modelSettingsView({ config, revision: 3, unreadableSecrets: [] });
    const preset = view.presets.find((entry) => entry.id === 'tokendance')!;
    const provider = view.providers.find((entry) => entry.id === 'tokendance')!;
    const recommendation = tokenPlanRecommendation(view, preset, provider);
    const planLlm = `tokendance:${preset.recommended.llm}`;
    // The locked video is not part of it; llm, a server default, is.
    expect(recommendation).toEqual({
      llm: planLlm,
      'course.content.slide': 'tokendance:cogevol-slide-0828',
      'course.content.interactive': 'tokendance:cogevol-interactive-0828',
      agent: 'tokendance:deepseek-v4.1-flash',
      tts: 'tokendance:minimax-speech-2.8-turbo',
      image: 'tokendance:seedream-5.0-lite',
      webSearch: 'tokendance',
    });
    // The server's default on llm is a current choice too: the user is asked about it.
    expect(tokenPlanConflicts(view, recommendation).map((c) => [c.slot.slot, c.from])).toEqual([
      ['llm', 'default'],
      ['course.content.slide', 'workspace'],
      ['course.content.interactive', 'workspace'],
      ['webSearch', 'workspace'],
    ]);

    const set = tokenPlanAssignments(view, recommendation, 'overwrite');
    expect(set).toEqual({
      llm: planLlm,
      'course.content.slide': 'tokendance:cogevol-slide-0828',
      // A replaced language-model assignment keeps its fallback.
      'course.content.interactive': {
        model: 'tokendance:cogevol-interactive-0828',
        fallback: 'operator:deepseek-v4-pro',
      },
      agent: 'tokendance:deepseek-v4.1-flash',
      tts: 'tokendance:minimax-speech-2.8-turbo',
      image: 'tokendance:seedream-5.0-lite',
      webSearch: 'tokendance',
    });
    const filled = await applyModelSettingsChange(config, { kind: 'slots', set });
    const after = modelSettingsView({ config: filled, revision: 4, unreadableSecrets: [] });
    const effective = (id: string) => after.slots.find((slot) => slot.slot === id)?.effective;
    expect(effective('webSearch')).toMatchObject({
      status: 'assigned',
      providerId: 'tokendance',
      registryId: 'bocha',
    });
    expect(effective('course.content.slide')).toMatchObject({
      providerId: 'tokendance',
      modelId: 'cogevol-slide-0828',
    });
    // A stage the plan does not name keeps the workspace's pick; the plan
    // replaces the server's default model; the locked video stays off.
    expect(effective('course.outline')).toMatchObject({ providerId: 'mine', modelId: 'gpt-5.6' });
    expect(effective('llm')).toMatchObject({ source: 'workspace', providerId: 'tokendance' });
    expect(effective('video')).toMatchObject({ status: 'disabled', source: 'locked' });

    // Keeping the current setup fills only the slots with no choice of their
    // own: the server's default llm stays.
    expect(tokenPlanAssignments(view, recommendation, 'keep')).toEqual({
      agent: 'tokendance:deepseek-v4.1-flash',
      tts: 'tokendance:minimax-speech-2.8-turbo',
      image: 'tokendance:seedream-5.0-lite',
    });

    // Disconnecting frees the slots that named the plan: they follow their parents again.
    const removed = await applyModelSettingsChange(filled, {
      kind: 'remove-provider',
      id: 'tokendance',
    });
    expect(removed.slots).toEqual({ 'course.outline': 'mine:gpt-5.6' });
  });

  it('connecting a token plan without a deployment applies the default model and the stages', async () => {
    deployment({});
    let config = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'ds',
      preset: 'deepseek',
      apiKey: 'sk-ds-key-0001',
    });
    config = await applyModelSettingsChange(config, {
      kind: 'slots',
      set: { llm: 'ds:deepseek-v4-pro', 'course.content.slide': 'ds:deepseek-flash' },
    });
    config = await applyModelSettingsChange(config, {
      kind: 'provider',
      id: 'tokendance',
      preset: 'tokendance',
      apiKey: 'sk-plan-key-0001',
    });
    const view = modelSettingsView({ config, revision: 3, unreadableSecrets: [] });
    const preset = view.presets.find((entry) => entry.id === 'tokendance')!;
    const provider = view.providers.find((entry) => entry.id === 'tokendance')!;
    const set = tokenPlanAssignments(
      view,
      tokenPlanRecommendation(view, preset, provider),
      'overwrite',
    );
    expect(set).toMatchObject({
      llm: 'tokendance:cogevol-base',
      'course.content.slide': 'tokendance:cogevol-slide-0828',
      'course.content.interactive': 'tokendance:cogevol-interactive-0828',
      video: 'tokendance:minimax-h3',
    });
    const filled = await applyModelSettingsChange(config, { kind: 'slots', set });
    expect(filled.slots).toMatchObject({
      llm: 'tokendance:cogevol-base',
      'course.content.slide': 'tokendance:cogevol-slide-0828',
    });
    // Removing the plan's key (rather than the plan) frees its slots as well.
    const keyless = await applyModelSettingsChange(filled, {
      kind: 'provider',
      id: 'tokendance',
      preset: 'tokendance',
      apiKey: '',
    });
    expect(keyless.slots).toBeUndefined();
  });

  it('drops the assignments of a removed provider', async () => {
    const next = await applyModelSettingsChange(
      {
        providers: { mine: { preset: 'openai', apiKey: 'k' } },
        slots: {
          classroom: 'mine:gpt-5.6',
          'course.outline': { model: 'operator:deepseek-v4-pro', fallback: 'mine:gpt-5.6' },
          image: null,
        },
      },
      { kind: 'remove-provider', id: 'mine' },
    );
    expect(next).toEqual({ slots: { image: null } });
  });
});

describe('importModelSettings', () => {
  it('imports a capability turned off, except where the deployment locks the slot', async () => {
    deployment({ slots: { video: 'operator-video' }, lock: ['video'] });
    const result = await importModelSettings(null, {
      slots: { tts: null, image: null, video: null },
    });
    expect(result.imported).toEqual([
      { kind: 'slot', id: 'tts' },
      { kind: 'slot', id: 'image' },
    ]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ kind: 'slot', id: 'video', code: 'SLOT_LOCKED' }),
    ]);
    expect(result.config.slots).toEqual({ tts: null, image: null });
  });

  it('names the kind of every item: a provider and a slot may share an id', async () => {
    // A provider called `tts` that the server refuses, beside the `tts` slot it takes.
    const result = await importModelSettings(null, {
      providers: { tts: { preset: 'azure-tts', apiKey: 'k', baseUrl: 'https://evil.com' } },
      slots: { tts: null },
    });
    expect(result.imported).toEqual([{ kind: 'slot', id: 'tts' }]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ kind: 'provider', id: 'tts', code: 'INVALID_PROVIDER' }),
    ]);
  });
});

it('exposes non-secret voice defaults for previewing an inactive deployment provider', async () => {
  deployment({
    providers: {
      active: { preset: 'openai-tts', apiKey: 'active-secret', models: ['tts-1'] },
      inactive: {
        preset: 'openai-tts',
        apiKey: 'inactive-secret',
        models: ['custom-tts'],
        options: { defaultVoice: 'vivian' },
      },
    },
    slots: { tts: 'active:tts-1' },
  });
  const view = modelSettingsView(null);
  const inactive = view.providers.find((p) => p.id === 'inactive')!;
  const { defaultVoiceFor } = await import('@/lib/audio/tts-selection');
  expect(defaultVoiceFor('openai-tts', 'custom-tts', inactive.options)).toBe('vivian');
  expect(JSON.stringify(inactive)).not.toContain('inactive-secret');
  expect(view.providers.find((p) => p.id === 'active')?.options).toBeUndefined();
});

it('also exposes imported workspace defaults for inactive provider previews', async () => {
  const view = modelSettingsView({
    config: {
      providers: {
        own: {
          preset: 'openai-tts',
          apiKey: 'workspace-secret',
          options: { defaultVoice: 'serena' },
        },
      },
    },
    revision: 1,
    unreadableSecrets: [],
  });
  const provider = view.providers.find((p) => p.id === 'own')!;
  const { defaultVoiceFor } = await import('@/lib/audio/tts-selection');
  expect(defaultVoiceFor('openai-tts', undefined, provider.options)).toBe('serena');
  expect(JSON.stringify(provider)).not.toContain('workspace-secret');
});

it('passes an inactive provider catalogue to previews when no default is configured', async () => {
  deployment({
    providers: {
      inactive: {
        preset: 'openai-tts',
        apiKey: 'secret',
        models: ['custom-tts'],
        voices: [{ id: 'vivian', name: 'Vivian' }],
      },
    },
  });
  const provider = modelSettingsView(null).providers.find((p) => p.id === 'inactive')!;
  const { defaultVoiceFor } = await import('@/lib/audio/tts-selection');
  expect(defaultVoiceFor('openai-tts', 'custom-tts', provider.options, provider.voices)).toBe(
    'vivian',
  );
});
