import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetStageRealmPresenceForTesting,
  bindStageRealmPresence,
  probeStageRealmPresence,
} from '@/lib/media/stage-realm-presence';

/**
 * A peer realm is modelled with its own channel: it answers presence probes the
 * way a second tab's bound module would.
 */
function peerHoldingStage(stageId: string): BroadcastChannel {
  const peer = new BroadcastChannel('maic-stage-presence');
  peer.onmessage = (event: MessageEvent) => {
    const message = event.data;
    if (message?.kind === 'probe' && message.stageId === stageId) {
      peer.postMessage({ kind: 'present', stageId, probeId: message.probeId });
    }
  };
  return peer;
}

describe('stage realm presence', () => {
  // Keep native channel delivery independent of the probe's deadline under load.
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => {
    __resetStageRealmPresenceForTesting();
    vi.useRealTimers();
  });

  it('reports a peer that has the same stage open', async () => {
    bindStageRealmPresence(() => 'stage-1');
    const peer = peerHoldingStage('stage-1');

    try {
      expect(await probeStageRealmPresence('stage-1')).toBe('present');
    } finally {
      peer.close();
    }
  });

  it('reports no peer when the other realm holds a different stage', async () => {
    bindStageRealmPresence(() => 'stage-1');
    const peer = peerHoldingStage('stage-other');

    try {
      const pending = probeStageRealmPresence('stage-1');
      await vi.runAllTimersAsync();
      expect(await pending).toBe('absent');
    } finally {
      peer.close();
    }
  });

  it('reports no peer when nobody answers', async () => {
    bindStageRealmPresence(() => 'stage-1');

    const pending = probeStageRealmPresence('stage-1');
    await vi.runAllTimersAsync();
    expect(await pending).toBe('absent');
  });

  it('reports unknown when the environment has no BroadcastChannel', async () => {
    const original = globalThis.BroadcastChannel;
    // @ts-expect-error - modelling an environment without the API
    delete globalThis.BroadcastChannel;
    try {
      expect(await probeStageRealmPresence('stage-1')).toBe('unknown');
    } finally {
      globalThis.BroadcastChannel = original;
    }
  });

  it('reports unknown before any realm has bound', async () => {
    // No bindStageRealmPresence call: the pool binds asynchronously at load.
    expect(await probeStageRealmPresence('stage-1')).toBe('unknown');
  });

  it('reports unknown when the channel constructor throws', async () => {
    const original = globalThis.BroadcastChannel;
    globalThis.BroadcastChannel = class {
      constructor() {
        throw new Error('channel unavailable');
      }
    } as unknown as typeof BroadcastChannel;
    try {
      bindStageRealmPresence(() => 'stage-1');
      expect(await probeStageRealmPresence('stage-1')).toBe('unknown');
    } finally {
      globalThis.BroadcastChannel = original;
    }
  });
});
