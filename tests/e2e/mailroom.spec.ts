import { expect, test, type Page } from '@playwright/test';

// New visitors say who they are before walking in.
async function enter(page: Page, name = 'TESTER') {
  await page.getByRole('textbox', { name: 'Your name' }).fill(name);
  await page.getByRole('button', { name: 'Walk in' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
// The menu offers everything the room does without walking; these flows use it.
async function write(page: Page, note: string) {
  await page.getByRole('button', { name: 'MENU', exact: true }).click();
  await page.getByRole('button', { name: 'Write a note' }).click();
  await page.getByRole('textbox', { name: 'Your message to Jev' }).fill(note);
  await page.getByRole('button', { name: 'Send to Jev', exact: true }).click();
}
async function browse(page: Page, category: string) {
  await page.getByRole('button', { name: 'MENU', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^Browse ${category}`) }).click();
}
// Holds an arrow key until the canvas reports your character where the check wants it.
async function walk(page: Page, key: string, check: string) {
  await page.keyboard.down(key);
  await page.waitForFunction(`(({ playerX: x, playerY: y }) => (${check}))(Object.fromEntries(Object.entries(document.querySelector('canvas').dataset).map(([k, v]) => [k, Number(v)])))`, undefined, { timeout: 10000 });
  await page.keyboard.up(key);
}

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
    // Names come out in capitals, cut to twelve characters.
    await enter(page, 'ada lovelace!');
    await enter(observer, 'Watcher');
    await expect(page.locator('.visitors')).toHaveText(/\d+ here/);
    await write(page, note);
    await expect(page.getByText('Filed in Big Ideas', { exact: true })).toBeVisible({ timeout: 20000 });
    // Each visitor sees the other's character walking around.
    await expect(observer.locator('canvas')).toHaveAttribute('data-visitors', /^[1-9]/);
    await expect(observer.locator('canvas')).toHaveAttribute('data-names', /(^|,)ADA LOVELACE(,|$)/);
    await page.getByRole('button', { name: 'See your message' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByText(note, { exact: true })).toBeVisible();
    await browse(observer, 'Big Ideas');
    await expect(observer.getByRole('dialog').getByText(note, { exact: true })).toBeVisible();
    // Everyone else sees who sent it.
    await expect(observer.getByRole('dialog').locator('article', { hasText: note }).getByText('FROM ADA LOVELACE', { exact: true })).toBeVisible();
    await observer.reload();
    await expect(observer.getByRole('dialog').getByText(note, { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await author.close(); await visitor.close(); }
});

test('Jev turns away a name he won’t write on a tag, and the visitor can pick another', async ({ page }) => {
  await page.goto('/');
  // The local demo turns away names containing TRASH, standing in for obscene or attacking ones.
  await page.getByRole('textbox', { name: 'Your name' }).fill('trash mouth');
  await page.getByRole('button', { name: 'Walk in' }).click();
  await expect(page.getByRole('alert')).toContainText('TRASH');
  await expect(page.getByRole('dialog')).toBeVisible();
  await enter(page, 'Grace');
  await expect(page.locator('canvas')).toBeVisible();
});

test('screened-out envelope gets tossed without exposing its contents to visitors', async ({ page }) => {
  await page.goto('/');
  const publicFrames: string[] = [];
  page.on('websocket', socket => socket.on('framereceived', frame => publicFrames.push(String(frame.payload))));
  // Reload to attach the observer before the room socket opens.
  await page.reload();
  await enter(page);
  const note = `[trash] PRIVATE_BROWSER_FIXTURE_${Date.now()}`;
  await write(page, note);
  await expect(page.getByText('Jev discarded your message', { exact: true })).toBeVisible({ timeout: 20000 });
  expect(publicFrames.join('')).not.toContain(note);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await browse(page, 'Spam');
  await expect(page.getByRole('dialog').getByText(note, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /correct|recategorize/i })).toHaveCount(0);
});

test('mobile and reduced-motion visitors get a touch pad and can open every bin without horizontal overflow', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await enter(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Use', exact: true })).toBeVisible();
    for (const category of ['Compliments', 'Feedback', 'Important', 'Big Ideas', 'Dad Jokes', 'Art', 'Spam']) {
      await browse(page, category);
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
  await enter(page);
  await expect(page.locator('.visitors')).toHaveText(/\d+ here/);
  for (let i = 0; i < 80; i++) {
    const room = await (await request.get('/api/room')).json();
    if (!room.active && !room.queue.length) break;
    await page.waitForTimeout(250);
  }
  type Leg = { kind: string; from: number; to: number; path: [number, number][]; carrying?: string };
  const sentAt = Date.now();
  await write(page, `[trash] sprint fixture ${Date.now()}`);
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

test('visitors walk up to a bin to read it and to the incoming desk to write a note', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('dialog', { name: 'What’s your name?' })).toBeVisible();
  // Nobody walks in until they've said who they are.
  await page.keyboard.press('Escape');
  await expect(page.locator('canvas')).toHaveAttribute('data-player-y', '159');
  await enter(page, 'walker');
  await page.getByRole('button', { name: 'MENU', exact: true }).click();
  await expect(page.getByRole('button', { name: /Change name WALKER/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.visitors')).toHaveText(/\d+ here/);
  // In through the door, round the left of Jev's desk, and up to the Big Ideas bin.
  await walk(page, 'ArrowRight', 'x >= 165');
  await walk(page, 'ArrowUp', 'y <= 58');
  await expect(page.getByRole('button', { name: 'Read Big Ideas' })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Big Ideas', exact: true })).toBeVisible();
  // Your character stays put while a window is open.
  const x = await page.locator('canvas').getAttribute('data-player-x');
  await page.keyboard.down('ArrowRight'); await page.waitForTimeout(300); await page.keyboard.up('ArrowRight');
  await expect(page.locator('canvas')).toHaveAttribute('data-player-x', x!);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Back down past the rug and over to the incoming desk.
  await walk(page, 'ArrowDown', 'y >= 132');
  await walk(page, 'ArrowLeft', 'x <= 80');
  await expect(page.getByRole('button', { name: 'Write a note' })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByRole('textbox', { name: 'Your message to Jev' })).toBeFocused();
  // Typing never walks your character around.
  await page.keyboard.type('asdw');
  await expect(page.getByRole('textbox', { name: 'Your message to Jev' })).toHaveValue('asdw');
});


test('returning visitors refresh receipts that still refer to an old bin', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('jevs-mailroom-receipts-v1', JSON.stringify([{
    id: 'old-note', token: 'saved-token', status: 'delivered',
    progress: { id: 'old-note', status: 'delivered', category: 'ideas' },
  }])));
  let refreshed = false;
  await page.route('**/api/submissions/old-note', async route => {
    expect(route.request().headers()['x-receipt-token']).toBe('saved-token');
    refreshed = true;
    await route.fulfill({ json: { id: 'old-note', status: 'delivered', category: 'important' } });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await enter(page);
  await expect.poll(() => refreshed).toBe(true);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('jevs-mailroom-receipts-v1')!)[0].progress.category)).toBe('important');
  expect(errors).toEqual([]);
});

test('walking up to Jev and saying hi stops him for a chat everyone can see', async ({ browser }) => {
  const talker = await (await browser.newContext()).newPage(), observer = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  talker.on('pageerror', error => errors.push(error.message));
  await Promise.all([talker.goto('/'), observer.goto('/')]);
  await enter(talker, 'Chatty');
  await enter(observer, 'Watcher');
  const canvas = talker.locator('canvas'), prompt = talker.getByRole('button', { name: /Talk to Jev/ });
  // Chase Jev around the room until he's close enough to talk to.
  for (let i = 0; i < 100 && !await prompt.isVisible(); i++) {
    const at = await canvas.evaluate(el => Object.fromEntries(Object.entries((el as HTMLCanvasElement).dataset).map(([k, v]) => [k, Number(v)])));
    const dx = at.jevX - at.playerX, dy = at.jevY - at.playerY;
    const key = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'ArrowRight' : 'ArrowLeft' : dy > 0 ? 'ArrowDown' : 'ArrowUp';
    await talker.keyboard.down(key); await talker.waitForTimeout(120); await talker.keyboard.up(key);
  }
  await expect(prompt).toBeVisible();
  await talker.keyboard.press('Space');
  const lines = ['ONLY A SITH DEALS IN ABSOLUTES', 'I HEAR PARKER IS A GREAT TEAM MEMBER', "THIS IS NOT THE DROID YOU'RE LOOKING FOR", 'BEEP BOOP', 'HELLO THERE', 'RENDER IS MY HOME', 'I LOVE JSON', 'THIS COULD HAVE BEEN AN EMAIL'];
  await expect.poll(() => canvas.getAttribute('data-jev-line')).toMatch(new RegExp(`^(${lines.join('|')})$`));
  const line = await canvas.getAttribute('data-jev-line');
  await expect.poll(() => observer.locator('canvas').getAttribute('data-jev-line')).toBe(line);
  await expect(prompt).toBeHidden();
  await talker.screenshot({ path: '.context/jev-chat.png' });
  // He holds still while he talks, then wanders on after five seconds.
  const x = await canvas.getAttribute('data-jev-x');
  await talker.waitForTimeout(3000);
  expect(await canvas.getAttribute('data-jev-x')).toBe(x);
  await expect.poll(() => canvas.getAttribute('data-jev-line'), { timeout: 4000 }).toBe('');
  expect(errors).toEqual([]);
});
