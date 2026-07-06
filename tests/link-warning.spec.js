const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const TOPIC = '0x12a6d6e360de92ee96444e397580fa39ca65f27c25bd78a4bad6278011334fac';
const SRC  = fs.readFileSync(path.join(__dirname, '..', 'site', 'guestbook', 'chain.js'), 'utf8');
const RPC  = 'https://' + new URL(SRC.match(/rpc:\s*"([^"]+)"/)[1]).host + '/**';
const BASE = parseInt(SRC.match(/DEPLOY_BLOCK:\s*(\d+)/)[1], 10);
const LCD  = 'https://' + new URL(SRC.match(/LCD:\s*\[[^\]]*?"([^"]+)"/)[1]).host + '/**';
const A = '0x1111111111111111111111111111111111111111';

function makeLog(from, index, message, block) {
  const author = '0x' + '0'.repeat(24) + from.slice(2).toLowerCase();
  const idx = '0x' + BigInt(index).toString(16).padStart(64, '0');
  const bytes = Buffer.from(message, 'utf8');
  const offset = (32).toString(16).padStart(64, '0');
  const len = bytes.length.toString(16).padStart(64, '0');
  let data = bytes.toString('hex'); while (data.length % 64 !== 0) data += '0';
  return { topics: [TOPIC, author, idx], data: '0x' + offset + len + data, blockNumber: '0x' + block.toString(16) };
}
async function route(page, logs) {
  await page.route(RPC, async (r) => {
    const req = JSON.parse(r.request().postData() || '{}'); let result = null;
    if (req.method === 'eth_blockNumber') result = '0x' + (BASE + 2000).toString(16);
    else if (req.method === 'eth_getLogs') result = logs;
    else if (req.method === 'eth_getBlockByNumber') result = { timestamp: '0x' + Math.floor(Date.now()/1000).toString(16) };
    else if (req.method === 'eth_call') result = '0x' + '0'.padStart(64, '0');
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
  });
  await page.route(LCD, async (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ denom_owners: [], pagination: { next_key: null } }) }));
}

test('a URL in a post becomes a link that opens the external-warning modal', async ({ page }) => {
  await route(page, [ makeLog(A, 0, 'check this https://example.com/path cool', BASE + 10) ]);
  await page.goto('/guestbook/');
  const link = page.locator('#posts .post-body a.ext');
  await expect(link).toHaveText('https://example.com/path');
  await expect(link).not.toHaveAttribute('href', /.+/);            // no direct nav — modal is the only path
  await expect(page.locator('#link-overlay')).toBeHidden();
  await link.click();
  await expect(page.locator('#link-overlay')).toBeVisible();
  await expect(page.locator('#link-url')).toHaveText('https://example.com/path');
  await expect(page.locator('#link-go')).toHaveAttribute('href', 'https://example.com/path');
  await expect(page.locator('#link-go')).toHaveAttribute('target', '_blank');
  await expect(page.locator('#link-go')).toHaveAttribute('rel', /noopener/);
  await page.click('#link-cancel');
  await expect(page.locator('#link-overlay')).toBeHidden();
});

test('www. links get https:// and trailing punctuation is not swallowed', async ({ page }) => {
  await route(page, [ makeLog(A, 0, 'go to www.foo.com. thanks', BASE + 10) ]);
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post-body a.ext')).toHaveText('www.foo.com');   // trailing '.' excluded
  await expect(page.locator('#posts .post-body')).toContainText('. thanks');
  await page.click('#posts .post-body a.ext');
  await expect(page.locator('#link-url')).toHaveText('https://www.foo.com');          // normalized
});

test('javascript:/markup payloads are never linkified or executed', async ({ page }) => {
  const payload = 'javascript:alert(1) mailto:a@b.c <img src=x onerror="window.__xss=1"> http://safe.com';
  await route(page, [ makeLog(A, 0, payload, BASE + 10) ]);
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post')).toHaveCount(1);
  await expect(page.locator('#posts img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  const links = page.locator('#posts .post-body a.ext');
  await expect(links).toHaveCount(1);                                  // only the http(s) one
  await expect(links).toHaveText('http://safe.com');
  await expect(page.locator('#posts .post-body')).toContainText('javascript:alert(1)');   // rendered as inert text
});

test('warning modal closes on Escape and on backdrop click', async ({ page }) => {
  await route(page, [ makeLog(A, 0, 'link https://example.com here', BASE + 10) ]);
  await page.goto('/guestbook/');
  await page.click('#posts .post-body a.ext');
  await expect(page.locator('#link-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#link-overlay')).toBeHidden();
  await page.click('#posts .post-body a.ext');
  await expect(page.locator('#link-overlay')).toBeVisible();
  await page.locator('#link-overlay').click({ position: { x: 5, y: 5 } });   // backdrop
  await expect(page.locator('#link-overlay')).toBeHidden();
});
