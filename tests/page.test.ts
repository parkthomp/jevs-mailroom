import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { withSiteUrls } from '../server/page.js';

test('share tags point at the site’s own absolute URLs, leaving the rest of the page alone', async () => {
  const html = await readFile('index.html', 'utf8');
  const page = withSiteUrls(html, 'https://mailroom.example');
  const content = (key: string) => page.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`))?.[1];
  assert.equal(content('og:url'), 'https://mailroom.example/');
  assert.equal(content('og:image'), 'https://mailroom.example/og-image.png');
  assert.equal(content('twitter:image'), 'https://mailroom.example/og-image.png');
  assert.equal(content('twitter:card'), 'summary_large_image');
  for (const key of ['og:title', 'og:description', 'twitter:title', 'twitter:description', 'description']) assert.ok(content(key), key);
  assert.match(page, /href="\/favicon.svg"/);
  assert.match(page, /src="\/client\/main.tsx"/);
});
