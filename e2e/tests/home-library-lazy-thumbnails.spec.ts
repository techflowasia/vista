import type { Locator, Page, Request, Route } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

const COURSE_COUNT = 24;
/** COURSE_THUMBNAIL_CONCURRENCY in lib/hooks/use-course-thumbnails.ts. */
const THUMBNAIL_CONCURRENCY = 4;

const thumbnailColor = (index: number) => `rgb(30, 58, ${100 + index})`;

async function expectThumbnail(card: Locator, index: number) {
  await expect(card.locator('[data-thumbnail-state="loading"]')).toHaveCount(0);
  const background = card.locator('.thumbnail-slide [style*="background-color"]');
  await expect(background).toBeVisible();
  await expect(background).toHaveCSS('background-color', thumbnailColor(index));
}

async function seedCourse(
  page: Page,
  stageId: string,
  name: string,
  updatedAt: number,
  colorIndex: number,
) {
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name,
      description: '',
      style: 'professional',
      createdAt: updatedAt,
      updatedAt,
    },
    scenes: [
      {
        id: 'scene-1',
        stageId,
        type: 'slide',
        title: name,
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: `slide-${stageId}`,
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: defaultTheme,
            background: { type: 'solid', color: thumbnailColor(colorIndex) },
            elements: [],
          },
        },
        createdAt: updatedAt,
        updatedAt,
      },
    ],
    outline: { outlines: [], createdAt: updatedAt, updatedAt },
  });
}

async function seedLibrary(page: Page, prefix: string): Promise<string[]> {
  await page.goto('/', { waitUntil: 'networkidle' });
  const names: string[] = [];
  const now = Date.now();
  for (let i = 0; i < COURSE_COUNT; i++) {
    const name = `${prefix} ${String(i).padStart(2, '0')}`;
    names.push(name);
    // Distinct times so the list order (newest first) is the seed order.
    await seedCourse(page, uniqueStageId('e2e-lazy-thumbnail'), name, now - i * 1000, i);
  }
  return names;
}

/** Thumbnails kept in the device cache (`maic-device-cache`). */
function cachedThumbnailCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('maic-device-cache');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains('courseThumbnails')) {
            database.close();
            resolve(0);
            return;
          }
          const count = database
            .transaction('courseThumbnails')
            .objectStore('courseThumbnails')
            .count();
          count.onsuccess = () => {
            database.close();
            resolve(count.result);
          };
          count.onerror = () => reject(count.error);
        };
      }),
  );
}

test.describe('Home library loading', () => {
  test('lists every course before any course content loads, then loads thumbnails lazily and bounded', async ({
    page,
  }) => {
    const prefix = `Lazy ${crypto.randomUUID().slice(0, 6)}`;
    const names = await seedLibrary(page, prefix);

    // Hold every course document read until the test releases it.
    const held: Route[] = [];
    const requested: string[] = [];
    let holdReads = true;
    const inFlight = new Set<Request>();
    const scrollRequests = new Set<Request>();
    const completed = new Set<Request>();
    const failed: string[] = [];
    let measuringScroll = false;
    let maxInFlight = 0;
    page.on('request', (request) => {
      if (
        request.method() !== 'GET' ||
        !new URL(request.url()).pathname.startsWith('/api/persistence/documents/')
      ) {
        return;
      }
      inFlight.add(request);
      if (measuringScroll) {
        scrollRequests.add(request);
        maxInFlight = Math.max(maxInFlight, inFlight.size);
      }
    });
    page.on('requestfinished', (request) => {
      inFlight.delete(request);
      if (scrollRequests.has(request)) completed.add(request);
    });
    page.on('requestfailed', (request) => {
      if (inFlight.delete(request)) failed.push(request.url());
    });
    page.on('response', (response) => {
      if (inFlight.has(response.request()) && !response.ok()) failed.push(response.url());
    });
    await page.route('**/api/persistence/documents/*', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      requested.push(new URL(route.request().url()).pathname);
      if (!holdReads) return route.continue();
      held.push(route);
    });
    const releaseAll = async () => {
      while (held.length) await held.shift()!.continue();
    };

    await page.goto('/');
    const cards = page.locator('.group.cursor-pointer').filter({ hasText: prefix });

    // The whole list renders while no course content has been served.
    await expect(cards).toHaveCount(COURSE_COUNT);
    for (const name of [names[0], names[COURSE_COUNT - 1]]) {
      await expect(cards.filter({ hasText: name })).toHaveCount(1);
    }
    await expect(cards.first().locator('[data-thumbnail-state="loading"]')).toBeVisible();

    // Loads are bounded: only `THUMBNAIL_CONCURRENCY` are in flight however
    // many cards are on screen.
    await expect.poll(() => held.length).toBe(THUMBNAIL_CONCURRENCY);
    await page.waitForTimeout(500);
    expect(held.length).toBe(THUMBNAIL_CONCURRENCY);

    // ...and lazy: releasing them loads the cards near the viewport, not the
    // whole library.
    await expect
      .poll(async () => {
        await releaseAll();
        return held.length;
      })
      .toBe(0);
    await page.waitForTimeout(500);
    await releaseAll();
    await expectThumbnail(cards.first(), 0);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.length).toBeLessThan(COURSE_COUNT);

    // Scrolling the last card into view loads its thumbnail.
    holdReads = false;
    await releaseAll();
    await expect.poll(() => inFlight.size).toBe(0);
    measuringScroll = true;
    for (const index of [Math.floor(COURSE_COUNT / 2), COURSE_COUNT - 1]) {
      const card = cards.filter({ hasText: names[index] });
      await card.scrollIntoViewIfNeeded();
      await expectThumbnail(card, index);
      await expect.poll(() => inFlight.size).toBe(0);
    }
    expect(scrollRequests.size).toBeGreaterThan(THUMBNAIL_CONCURRENCY);
    expect(completed.size).toBe(scrollRequests.size);
    expect(failed).toEqual([]);
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(THUMBNAIL_CONCURRENCY);
  });

  test('a failed document load releases its slot for a queued thumbnail', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1600 });
    await page.goto('/', { waitUntil: 'networkidle' });
    const prefix = `Failed ${crypto.randomUUID().slice(0, 6)}`;
    const now = Date.now();
    const courses = Array.from({ length: THUMBNAIL_CONCURRENCY + 1 }, (_, index) => ({
      id: uniqueStageId('e2e-failed-thumbnail'),
      name: `${prefix} ${index}`,
      index,
    }));
    for (const course of courses) {
      await seedCourse(page, course.id, course.name, now - course.index * 1000, course.index);
    }

    const held = new Map<string, Route>();
    const requested: string[] = [];
    const inFlight = new Set<Request>();
    const completed = new Set<Request>();
    const failed: Request[] = [];
    const errors: Array<{ id: string; status: number }> = [];
    let maxInFlight = 0;
    let holdReads = true;
    const courseId = (request: Request) => {
      if (request.method() !== 'GET') return undefined;
      const path = new URL(request.url()).pathname;
      if (!path.startsWith('/api/persistence/documents/')) return undefined;
      const id = decodeURIComponent(path.split('/').pop()!);
      return courses.some((course) => course.id === id) ? id : undefined;
    };
    page.on('request', (request) => {
      const id = courseId(request);
      if (!id) return;
      requested.push(id);
      inFlight.add(request);
      maxInFlight = Math.max(maxInFlight, inFlight.size);
    });
    page.on('requestfinished', (request) => {
      if (inFlight.delete(request)) completed.add(request);
    });
    page.on('requestfailed', (request) => {
      if (inFlight.delete(request)) failed.push(request);
    });
    page.on('response', (response) => {
      const id = courseId(response.request());
      if (id && !response.ok()) errors.push({ id, status: response.status() });
    });
    const handler = async (route: Route) => {
      const id = courseId(route.request());
      if (!id) return route.fallback();
      if (!holdReads) return route.continue();
      held.set(id, route);
    };
    const release = async (id: string) => {
      const route = held.get(id)!;
      held.delete(id);
      await route.continue();
    };
    await page.route('**/api/persistence/documents/*', handler);
    try {
      await page.goto('/');
      const cards = page.locator('.group.cursor-pointer').filter({ hasText: prefix });
      await expect(cards).toHaveCount(courses.length);
      for (const course of courses) {
        await expect(cards.filter({ hasText: course.name })).toBeInViewport();
      }
      await expect.poll(() => held.size).toBe(THUMBNAIL_CONCURRENCY);
      const activeIds = [...held.keys()];
      const failedId = activeIds[0];
      const blockedIds = activeIds.slice(1);
      const queued = courses.find((course) => !activeIds.includes(course.id))!;
      expect(requested).toHaveLength(THUMBNAIL_CONCURRENCY);
      expect(requested).not.toContain(queued.id);
      expect(inFlight.size).toBe(THUMBNAIL_CONCURRENCY);
      await expect(
        cards.filter({ hasText: queued.name }).locator('[data-thumbnail-state="loading"]'),
      ).toBeVisible();

      const failedRoute = held.get(failedId)!;
      held.delete(failedId);
      await failedRoute.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'THUMBNAIL_TEST_FAILURE', message: 'Unavailable' } }),
      });
      await expect.poll(() => held.has(queued.id)).toBe(true);
      expect([...held.keys()].sort()).toEqual([...blockedIds, queued.id].sort());
      expect(requested).toHaveLength(courses.length);
      expect(inFlight.size).toBe(THUMBNAIL_CONCURRENCY);
      const failedCourse = courses.find((course) => course.id === failedId)!;
      const failedCard = cards.filter({ hasText: failedCourse.name });
      await expect(failedCard.locator('[data-thumbnail-state="loading"]')).toHaveCount(0);
      await expect(failedCard.locator('.thumbnail-slide')).toHaveCount(0);
      await expect(failedCard.locator('.text-xl.opacity-50')).toBeVisible();

      await release(queued.id);
      await expectThumbnail(cards.filter({ hasText: queued.name }), queued.index);
      await expect.poll(() => inFlight.size).toBe(blockedIds.length);
      expect([...held.keys()].sort()).toEqual([...blockedIds].sort());
      expect(completed.has(failedRoute.request())).toBe(true);
      for (const id of blockedIds) expect(inFlight.has(held.get(id)!.request())).toBe(true);

      holdReads = false;
      for (const id of blockedIds) await release(id);
      for (const course of courses.filter((course) => course.id !== failedId)) {
        await expectThumbnail(cards.filter({ hasText: course.name }), course.index);
      }
      await expect.poll(() => inFlight.size).toBe(0);
      expect(held.size).toBe(0);
      expect(requested.sort()).toEqual(courses.map((course) => course.id).sort());
      expect(completed.size).toBe(courses.length);
      expect(failed).toEqual([]);
      expect(errors).toEqual([{ id: failedId, status: 503 }]);
      expect(maxInFlight).toBe(THUMBNAIL_CONCURRENCY);
    } finally {
      holdReads = false;
      for (const id of [...held.keys()]) await release(id);
      await page.unroute('**/api/persistence/documents/*', handler);
    }
  });

  test('a reload shows unchanged courses from the device cache and reads only a changed one', async ({
    page,
  }) => {
    const prefix = `Cached ${crypto.randomUUID().slice(0, 6)}`;
    await page.goto('/', { waitUntil: 'networkidle' });
    const now = Date.now();
    const ids = [0, 1, 2].map(() => uniqueStageId('e2e-cached-thumbnail'));
    for (const [i, id] of ids.entries()) {
      await seedCourse(page, id, `${prefix} ${i}`, now - i * 1000, i);
    }
    const cards = page.locator('.group.cursor-pointer').filter({ hasText: prefix });
    const documentReads: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'GET' && path.startsWith('/api/persistence/documents/')) {
        documentReads.push(decodeURIComponent(path.split('/').pop()!));
      }
    });
    const loaded = async (changed = false) => {
      await expect(cards).toHaveCount(ids.length);
      await expect(cards.locator('[data-thumbnail-state="loading"]')).toHaveCount(0);
      for (const i of ids.keys()) {
        await expectThumbnail(
          cards.filter({ hasText: `${prefix} ${i}` }),
          changed && i === 1 ? 3 : i,
        );
      }
    };

    await page.goto('/');
    await loaded();
    expect(documentReads.filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort());
    await expect.poll(() => cachedThumbnailCount(page)).toBeGreaterThanOrEqual(ids.length);

    // Nothing changed: every thumbnail comes from the device cache.
    documentReads.length = 0;
    await page.reload();
    await loaded();
    expect(documentReads.filter((id) => ids.includes(id))).toEqual([]);

    // One course changed: only that one is read again.
    await seedCourse(page, ids[1]!, `${prefix} 1`, now + 5000, 3);
    documentReads.length = 0;
    await page.reload();
    await loaded(true);
    expect(documentReads.filter((id) => ids.includes(id))).toEqual([ids[1]]);
  });
});
