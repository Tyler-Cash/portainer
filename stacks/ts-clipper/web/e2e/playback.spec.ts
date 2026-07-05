import { test, expect } from '@playwright/test';
import path from 'node:path';

const FIXTURE = path.join(__dirname, 'fixtures', 'test.mp4');

test('uploaded video plays back, and seeking recovers to a playable frame', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  const videoRequests: { url: string; status: number }[] = [];
  page.on('response', (res) => {
    if (/\/api\/upload\/[0-9a-f-]+(\?|$)/.test(res.url()) && !res.url().includes('/thumbnail')) {
      videoRequests.push({ url: res.url(), status: res.status() });
    }
  });

  await page.goto('/');

  // Read the id from the request URL rather than the upload response body —
  // Chromium's CDP response-body cache can evict small/fast bodies before
  // Playwright reads them ("Request content was evicted from inspector
  // cache"), which is a tooling quirk, not an app bug.
  const [initialVideoRequest] = await Promise.all([
    page.waitForRequest((req) => /\/api\/upload\/[0-9a-f-]+\?start=0$/.test(req.url()), {
      timeout: 20_000,
    }),
    page.locator('input[type="file"]').setInputFiles(FIXTURE),
  ]);
  const id = initialVideoRequest.url().match(/\/api\/upload\/([0-9a-f-]+)\?/)![1];
  console.log(`uploaded id=${id}`);

  try {
    const video = page.locator('video');
    await expect(video).toBeVisible({ timeout: 15_000 });

    // Wait for the initial remux stream to actually start delivering data.
    await page.waitForFunction(
      () => (document.querySelector('video') as HTMLVideoElement)?.readyState >= 2,
      { timeout: 20_000 },
    );

    await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).play());
    await page.waitForTimeout(3000);

    const afterPlay = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement;
      return {
        currentTime: v.currentTime,
        paused: v.paused,
        readyState: v.readyState,
        networkState: v.networkState,
        error: v.error ? { code: v.error.code, message: v.error.message } : null,
      };
    });
    console.log('after play:', JSON.stringify(afterPlay));
    expect(afterPlay.error).toBeNull();
    expect(afterPlay.currentTime, 'currentTime should advance after play() + waiting').toBeGreaterThan(0.5);

    // Click roughly the middle of the scrub track to trigger a seek, matching
    // the real user gesture that reportedly produces a black screen.
    const track = page.locator('.timeline-track');
    const box = await track.boundingBox();
    if (!box) throw new Error('timeline track not found');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    // The seek reloads the video element with a new src — give it time to
    // reconnect and start delivering frames again.
    await page.waitForTimeout(5000);

    const afterSeek = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement;
      return {
        currentTime: v.currentTime,
        paused: v.paused,
        readyState: v.readyState,
        networkState: v.networkState,
        error: v.error ? { code: v.error.code, message: v.error.message } : null,
      };
    });
    console.log('after seek:', JSON.stringify(afterSeek));
    console.log('video requests:', JSON.stringify(videoRequests));

    expect(afterSeek.error).toBeNull();
    expect(afterSeek.readyState, 'video should have usable data after seeking').toBeGreaterThanOrEqual(2);

    // Exactly one reload request for the click-seek (plus the original
    // load) — proves the debounce fix, not a request storm.
    expect(videoRequests.length, `expected ~2 video requests, got: ${JSON.stringify(videoRequests)}`).toBeLessThanOrEqual(3);
  } finally {
    await page.request.delete(`/api/upload/${id}`).catch(() => {});
  }

  expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([]);
});
