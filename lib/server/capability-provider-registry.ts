import type { ServerProviderEntry } from './provider-config';

export const VIDEO_PROVIDER_ENV_MAP: Record<string, string> = {
  VIDEO_OPENROUTER: 'openrouter-video',
};

export const TTS_KEYLESS_CONFIG_PROVIDERS = ['openrouter-tts'];

export function applyTTSProviderConfig(
  tts: Record<string, ServerProviderEntry>,
): Record<string, ServerProviderEntry> {
  const entry = tts['openrouter-tts'];
  if (entry && process.env.TTS_OPENROUTER_ENABLED?.toLowerCase() === 'true') {
    entry.apiKey ||= process.env.OPENROUTER_API_KEY || '';
    entry.baseUrl ||= process.env.OPENROUTER_BASE_URL;
    const models = process.env.OPENROUTER_MODELS?.split(',')
      .map((model) => model.trim())
      .filter(Boolean);
    entry.models ||= models && models.length > 0 ? models : undefined;
  }
  return tts;
}
