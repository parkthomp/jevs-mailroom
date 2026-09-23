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

test('Jev sprints a note to the trash, then strolls off to mill about', async ({ page, request }) => {
  // The canvas draws Jev from the planned legs on its own clock, so he keeps moving between snapshots.
  await page.goto('/');
  await expect(page.getByText('THE MAILROOM IS OPEN', { exact: true })).toBeVisible();
  for (let i = 0; i < 80; i++) {
    const room = await (await request.get('/api/room')).json();
    if (!room.active && !room.queue.length) break;
    await page.waitForTimeout(250);
  }
  type Leg = { kind: string; from: number; to: number; path: [number, number][]; carrying?: string };
  const sentAt = Date.now();
  await page.getByRole('textbox', { name: 'Your message to Jev' }).fill(`[trash] sprint fixture ${Date.now()}`);
  await page.getByRole('button', { name: 'Send to Jev', exact: true }).click();
  let legs: Leg[] = [];
  for (let i = 0; i < 100; i++) {
    const room = await (await request.get('/api/room')).json();
    if (room.active?.destination === 'trash') { legs = room.jev; break; }
    await page.waitForTimeout(50);
  }
  const carry = legs.find(leg => leg.kind === 'run' && leg.carrying)!, drop = legs.find(leg => leg.kind === 'drop')!;
  // Even from the far side of the room, the note is in the can within a few seconds.
  expect(drop.to - sentAt).toBeLessThan(5000);
  // The canvas reports where it drew Jev, in room pixels (the trash can is at x 262).
  const jevX = async () => Number(await page.locator('canvas').getAttribute('data-jev-x'));
  const at = (time: number) => page.waitForTimeout(Math.max(0, time - Date.now()));
  await at(carry.from + (carry.to - carry.from) * .6);
  const midSprint = await jevX();
  expect(midSprint).toBeGreaterThan(80);
  expect(midSprint).toBeLessThan(262);
  await at(drop.from + 100);
  expect(await jevX()).toBe(262);
  // No pause: he heads off for a stroll as soon as the note lands.
  let stroll: Leg | undefined;
  for (let i = 0; i < 100 && !stroll; i++) {
    stroll = ((await (await request.get('/api/room')).json()).jev as Leg[]).find(leg => leg.kind === 'walk' && leg.from >= drop.to);
    if (!stroll) await page.waitForTimeout(100);
  }
  expect(stroll!.from - drop.to).toBeLessThan(500);
  expect(stroll!.path[0]).toEqual([262, 122]);
  await at(stroll!.to + 200);
  expect(await jevX()).toBe(stroll!.path.at(-1)![0]);
});
