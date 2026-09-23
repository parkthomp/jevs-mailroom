import { expect, test } from '@playwright/test';

test('two visitors watch a note get filed and can browse its durable bin history', async ({ browser }) => {
  const author = await browser.newContext();
  const visitor = await browser.newContext();
  const page = await author.newPage();
  const observer = await visitor.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const note = `Please add a tiny garden for Jev. ${Date.now()}`;
  try {
    await Promise.all([page.goto('/'), observer.goto('/')]);
    await expect(page.getByText('THE MAILROOM IS OPEN', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Your message to Jev' }).fill(note);
    await page.getByRole('button', { name: 'Send to Jev', exact: true }).click();
    await expect(page.getByText('Filed in Ideas', { exact: true })).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'See your message' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByText(note, { exact: true })).toBeVisible();
    await observer.getByRole('button', { name: /^Browse Ideas/ }).click();
    await expect(observer.getByRole('dialog').getByText(note, { exact: true })).toBeVisible();
    await observer.reload();
    await expect(observer.getByRole('dialog').getByText(note, { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await author.close(); await visitor.close(); }
});

test('screened-out envelope gets tossed without exposing its contents to visitors', async ({ page }) => {
  await page.goto('/');
  const publicFrames: string[] = [];
  page.on('websocket', socket => socket.on('framereceived', frame => publicFrames.push(String(frame.payload))));
  // Reload to attach the observer before the room socket opens.
  await page.reload();
  const note = `[trash] PRIVATE_BROWSER_FIXTURE_${Date.now()}`;
  await page.getByRole('textbox', { name: 'Your message to Jev' }).fill(note);
  await page.getByRole('button', { name: 'Send to Jev', exact: true }).click();
  await expect(page.getByText('Jev discarded your message', { exact: true })).toBeVisible({ timeout: 20000 });
  expect(publicFrames.join('')).not.toContain(note);
  await expect(page.getByRole('textbox')).toHaveValue('');
  await page.getByRole('button', { name: /^Browse Misc/ }).click();
  await expect(page.getByRole('dialog').getByText(note, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /correct|recategorize/i })).toHaveCount(0);
});

test('mobile and reduced-motion visitors can open every bin without horizontal overflow', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const category of ['Compliments', 'Ideas', 'Complaints', 'Misc']) {
      await page.getByRole('button', { name: new RegExp(`^Browse ${category}`) }).click();
      await expect(page.getByRole('dialog').getByRole('heading', { name: category, exact: true })).toBeVisible();
      const box = await page.getByRole('dialog').boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(391);
      await page.getByRole('button', { name: 'Close message archive' }).click();
    }
  } finally { await context.close(); }
});

test('Jev keeps walking to his destination while the room snapshot stays unchanged', async ({ page, request }) => {
  // Regression guard: the canvas re-anchored its server-clock offset on every parent render,
  // which pinned "now" to the last snapshot and left Jev stalling mid-walk.
  await page.goto('/');
  await expect(page.getByText('THE MAILROOM IS OPEN', { exact: true })).toBeVisible();
  for (let i = 0; i < 60; i++) {
    const room = await (await request.get('/api/room')).json();
    if (!room.active && !room.queue.length) break;
    await page.waitForTimeout(500);
  }
  await page.getByRole('textbox', { name: 'Your message to Jev' }).fill(`[trash] walk fixture ${Date.now()}`);
  await page.getByRole('button', { name: 'Send to Jev', exact: true }).click();
  let active: { destination: string; endsAt: number } | null = null;
  for (let i = 0; i < 100 && !active; i++) {
    active = (await (await request.get('/api/room')).json()).active;
    if (!active) await page.waitForTimeout(100);
  }
  expect(active?.destination).toBe('trash');
  // Find Jev by his workwear colour once the walk should have finished but the room is still busy.
  const jevX = async () => page.evaluate(() => {
    const el = document.querySelector('canvas') as HTMLCanvasElement;
    const pixels = el.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, el.width, el.height).data;
    let sum = 0, count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] === 111 && pixels[i + 1] === 146 && pixels[i + 2] === 163) { sum += (i / 4) % el.width; count++; }
    }
    return count ? sum / count : -1;
  });
  const atStart = await jevX();
  await page.waitForTimeout(Math.max(0, active!.endsAt - Date.now() - 250));
  const atEnd = await jevX();
  expect(atStart).toBeGreaterThan(0);
  // The trash can sits on the far right; a frozen clock would leave Jev by the desk or the tray.
  expect(atEnd).toBeGreaterThan(700);
  expect(atEnd).toBeGreaterThan(atStart);
});
