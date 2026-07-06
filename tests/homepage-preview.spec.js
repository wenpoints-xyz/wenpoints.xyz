const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const T_POST = '0x12a6d6e360de92ee96444e397580fa39ca65f27c25bd78a4bad6278011334fac';   // PostCreated
const T_DEL  = '0x1da4a15b15417b54b8b3bea2ca87cfc4c94f0fee7d86702d0dab9e2906e7a7d3';   // PostDeleted
// Derive the mocked RPC host + deploy block straight from the homepage script so this
// tracks the mainnet cutover (same trick as guestbook.spec.js).
const HTML   = fs.readFileSync(path.join(__dirname, '..', 'site', 'index.html'), 'utf8');
const RPC    = '**' + new URL(HTML.match(/RPC\s*=\s*"([^"]+)"/)[1]).host + '**';
const DEPLOY = parseInt(HTML.match(/DEPLOY\s*=\s*(\d+)/)[1], 10);
const LATEST = DEPLOY + 100;   // small range -> one getLogs window

// Build a PostCreated log exactly as the contract emits it, so the page decodes it for real.
function makeLog(from, index, message, block) {
  const author = '0x' + '0'.repeat(24) + from.slice(2).toLowerCase();
  const idx = '0x' + BigInt(index).toString(16).padStart(64, '0');
  const bytes = Buffer.from(message, 'utf8');
  const offset = (32).toString(16).padStart(64, '0');
  const len = bytes.length.toString(16).padStart(64, '0');
  let data = bytes.toString('hex');
  while (data.length % 64 !== 0) data += '0';
  return { topics: [T_POST, author, idx], data: '0x' + offset + len + data,
    blockNumber: '0x' + block.toString(16), logIndex: '0x' + index.toString(16) };
}
function makeDeleteLog(index, block) {
  const idx = '0x' + BigInt(index).toString(16).padStart(64, '0');
  return { topics: [T_DEL, idx, '0x' + '0'.repeat(64)], data: '0x',
    blockNumber: '0x' + block.toString(16), logIndex: '0x' + (index + 500).toString(16) };
}

async function route(page, logs) {
  await page.route(RPC, async (r) => {
    const req = JSON.parse(r.request().postData() || '{}');
    let result = null;
    if (req.method === 'eth_blockNumber') result = '0x' + LATEST.toString(16);
    else if (req.method === 'eth_getLogs') result = logs;
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
  });
}

test('homepage teaser shows the 3 most-recent posts, newest first', async ({ page }) => {
  await route(page, [
    makeLog('0x1111111111111111111111111111111111111111', 0, 'gm', DEPLOY + 10),
    makeLog('0x2222222222222222222222222222222222222222', 1, 'points', DEPLOY + 11),
    makeLog('0x3333333333333333333333333333333333333333', 2, 'wen airdrop', DEPLOY + 12),
    makeLog('0x4444444444444444444444444444444444444444', 3, 'latest one', DEPLOY + 13),
  ]);
  await page.goto('/');
  await expect(page.locator('#gb-peek')).toBeVisible();
  await expect(page.locator('#gb-peek-list li')).toHaveCount(3);              // only 3, not all 4
  await expect(page.locator('#gb-peek-list li').first()).toContainText('latest one');
  await expect(page.locator('#gb-peek-list li').first()).toContainText('0x4444…4444');
});

test('homepage teaser hides deleted posts and renders markup inert', async ({ page }) => {
  await route(page, [
    makeLog('0x1111111111111111111111111111111111111111', 0, '<img src=x onerror="window.__xss=1">', DEPLOY + 10),
    makeLog('0x2222222222222222222222222222222222222222', 1, 'delete me', DEPLOY + 11),
    makeDeleteLog(1, DEPLOY + 20),
  ]);
  await page.goto('/');
  await expect(page.locator('#gb-peek')).toBeVisible();
  expect(await page.locator('#gb-peek img').count()).toBe(0);                 // markup is inert text
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(page.locator('#gb-peek-list')).not.toContainText('delete me'); // deleted post hidden
  await expect(page.locator('#gb-peek-list li')).toHaveCount(1);
});

test('homepage teaser stays hidden when the guestbook is empty', async ({ page }) => {
  await route(page, []);
  await page.goto('/');
  await page.waitForTimeout(800);   // let the deferred idle callback run
  await expect(page.locator('#gb-peek')).toBeHidden();
});

test('a URL in a preview post opens the external-warning modal', async ({ page }) => {
  await route(page, [ makeLog('0x1111111111111111111111111111111111111111', 0, 'gm see https://example.com/x cool', DEPLOY + 10) ]);
  await page.goto('/');
  const link = page.locator('#gb-peek .gb-peek-msg a.ext');
  await expect(link).toHaveText('https://example.com/x');
  await link.click();
  await expect(page.locator('#link-overlay')).toBeVisible();
  await expect(page.locator('#link-url')).toHaveText('https://example.com/x');
  await expect(page.locator('#link-go')).toHaveAttribute('href', 'https://example.com/x');
  await expect(page.locator('#link-go')).toHaveAttribute('rel', /noopener/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#link-overlay')).toBeHidden();
});

test('preview shows a loading skeleton, then swaps in the posts', async ({ page }) => {
  await page.route(RPC, async (r) => {                        // hold eth_getLogs so the skeleton is observable
    const req = JSON.parse(r.request().postData() || '{}');
    let result = null;
    if (req.method === 'eth_blockNumber') result = '0x' + LATEST.toString(16);
    else if (req.method === 'eth_getLogs') { await new Promise(res => setTimeout(res, 700)); result = [ makeLog('0x2222222222222222222222222222222222222222', 0, 'loaded', DEPLOY + 10) ]; }
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
  });
  await page.goto('/');
  await expect(page.locator('#gb-peek .gb-peek-skel').first()).toBeVisible();          // placeholder while loading
  await expect(page.locator('#gb-peek-list li.gb-peek-skel')).toHaveCount(0, { timeout: 4000 }); // replaced
  await expect(page.locator('#gb-peek .gb-peek-msg').first()).toHaveText('loaded');
});
