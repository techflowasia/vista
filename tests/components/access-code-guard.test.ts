// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const modal = vi.hoisted(() => ({ onSuccess: null as null | (() => void) }));
vi.mock('@/components/access-code-modal', () => ({
  AccessCodeModal: ({ onSuccess }: { onSuccess: () => void }) => {
    modal.onSuccess = onSuccess;
    return createElement('div', { 'data-testid': 'access-code-modal' });
  },
}));
vi.mock('@/components/model-settings-init', () => ({ importLegacyModelSettings: vi.fn() }));
vi.mock('@/lib/model-settings/client', () => ({ modelSettingsClient: { load: vi.fn() } }));
vi.mock('@/lib/orchestration/registry/store', () => ({ reloadAgentRegistry: vi.fn() }));
const legacyImport = vi.hoisted(() => ({ resume: vi.fn(async () => ({ status: 'complete' })) }));
vi.mock('@/lib/legacy-browser-import', () => ({
  resumeLegacyBrowserImportAfterAccess: legacyImport.resume,
}));

import { AccessCodeGuard, requestAccessCode } from '@/components/access-code-guard';
import { useGenerationRun } from '@/lib/generation-run-client/use-generation-run';
import { snapshot } from '../generation-run-client/fixtures';

let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  modal.onSuccess = null;
  legacyImport.resume.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubStatus(body: { enabled: boolean; authenticated: boolean }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body))),
  );
}

/** Counts mounts: each mount is one round of the page's on-mount requests. */
function renderGuardedPage() {
  const mounts = { count: 0 };
  function Page() {
    useEffect(() => {
      mounts.count += 1;
    }, []);
    return null;
  }
  const root = createRoot(host);
  return {
    root,
    mounts,
    render: () => root.render(createElement(AccessCodeGuard, null, createElement(Page))),
  };
}

it('mounts the page again once the access code is accepted, so its requests are resent', async () => {
  stubStatus({ enabled: true, authenticated: false });
  const { root, mounts, render } = renderGuardedPage();
  await act(async () => render());
  expect(mounts.count).toBe(1);
  expect(modal.onSuccess).not.toBeNull();

  await act(async () => modal.onSuccess!());
  expect(mounts.count).toBe(2);
  // The one-time import of this browser's earlier courses is resumed too.
  await vi.waitFor(() => expect(legacyImport.resume).toHaveBeenCalledTimes(1));
  await act(async () => root.unmount());
});

it('mounts the page once when no access code is required', async () => {
  stubStatus({ enabled: false, authenticated: false });
  const { root, mounts, render } = renderGuardedPage();
  await act(async () => render());
  expect(mounts.count).toBe(1);
  expect(modal.onSuccess).toBeNull();
  expect(legacyImport.resume).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it('reopens after authentication expires and clears the forced requirement on success', async () => {
  stubStatus({ enabled: true, authenticated: true });
  const { root, mounts, render } = renderGuardedPage();
  await act(async () => render());
  expect(host.querySelector('[data-testid="access-code-modal"]')).toBeNull();

  await act(async () => requestAccessCode());
  expect(host.querySelector('[data-testid="access-code-modal"]')).not.toBeNull();
  expect(mounts.count).toBe(1);

  await act(async () => modal.onSuccess!());
  expect(host.querySelector('[data-testid="access-code-modal"]')).toBeNull();
  expect(mounts.count).toBe(2);

  await act(async () => requestAccessCode());
  expect(host.querySelector('[data-testid="access-code-modal"]')).not.toBeNull();
  await act(async () => root.unmount());
});

it.each([
  { enabled: true, authenticated: true },
  { enabled: false, authenticated: false },
])('keeps forced authentication open when stale status resolves to %j', async (body) => {
  let resolveStatus!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => (resolveStatus = resolve))),
  );
  const { root, mounts, render } = renderGuardedPage();
  await act(async () => render());
  await act(async () => requestAccessCode());
  expect(host.querySelector('[data-testid="access-code-modal"]')).not.toBeNull();

  await act(async () => resolveStatus(new Response(JSON.stringify(body))));
  expect(host.querySelector('[data-testid="access-code-modal"]')).not.toBeNull();
  expect(mounts.count).toBe(1);

  await act(async () => modal.onSuccess!());
  expect(host.querySelector('[data-testid="access-code-modal"]')).toBeNull();
  expect(mounts.count).toBe(2);
  await act(async () => root.unmount());
});

it('coalesces repeated requests without remounting until access is granted', async () => {
  stubStatus({ enabled: false, authenticated: false });
  const { root, mounts, render } = renderGuardedPage();
  await act(async () => render());
  await act(async () => {
    requestAccessCode();
    requestAccessCode();
    requestAccessCode();
  });
  expect(host.querySelectorAll('[data-testid="access-code-modal"]')).toHaveLength(1);
  expect(mounts.count).toBe(1);
  await act(async () => modal.onSuccess!());
  expect(host.querySelector('[data-testid="access-code-modal"]')).toBeNull();
  expect(mounts.count).toBe(2);
  await act(async () => root.unmount());
});

it('removes the request listener on unmount and ignores late status responses', async () => {
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  let resolveStatus!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => (resolveStatus = resolve))),
  );
  const { root, render } = renderGuardedPage();
  await act(async () => render());
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  await act(async () => requestAccessCode());
  const event = dispatch.mock.calls[0]![0];
  expect(event).toBeInstanceOf(CustomEvent);
  const subscription = add.mock.calls.find(([type]) => type === event.type);
  expect(subscription).toBeDefined();

  await act(async () => root.unmount());
  expect(remove).toHaveBeenCalledWith(event.type, subscription![1]);
  await act(async () => {
    resolveStatus(new Response(JSON.stringify({ enabled: true, authenticated: false })));
    requestAccessCode();
  });
  expect(host.childElementCount).toBe(0);
});

it('resumes following the same run after a 401 and access-code success without replaying mutations', async () => {
  const run = snapshot({ state: 'completed', seq: 10 });
  let authorized = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET');
    if (url === '/api/access-code/status') {
      return new Response(JSON.stringify({ enabled: true, authenticated: true }));
    }
    expect(url).toBe(`/api/generation-runs/${run.id}`);
    return authorized
      ? new Response(JSON.stringify({ run }))
      : new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', undefined);
  const mounts = { count: 0, cleanups: 0 };
  function Page() {
    const followed = useGenerationRun(run.id);
    useEffect(() => {
      mounts.count += 1;
      return () => {
        mounts.cleanups += 1;
      };
    }, []);
    return createElement('div', null, followed.status, ':', followed.view?.runId);
  }
  const root = createRoot(host);
  await act(async () => root.render(createElement(AccessCodeGuard, null, createElement(Page))));
  expect(host.querySelector('[data-testid="access-code-modal"]')).not.toBeNull();
  expect(host.textContent).toBe('auth-required:');
  expect(mounts.count).toBe(1);

  authorized = true;
  await act(async () => modal.onSuccess!());
  expect(host.querySelector('[data-testid="access-code-modal"]')).toBeNull();
  expect(host.textContent).toBe(`live:${run.id}`);
  expect(mounts).toEqual({ count: 2, cleanups: 1 });
  expect(
    fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/generation-runs/')),
  ).toHaveLength(2);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await act(async () => root.unmount());
  expect(mounts.cleanups).toBe(2);
});
