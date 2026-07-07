const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// The homepage teaser now reads the newest posts from contract state (count + getPostsBlob), like the guestbook.
const HTML = fs.readFileSync(path.join(__dirname, '..', 'site', 'index.html'), 'utf8');
const RPC = '**' + new URL(HTML.match(/RPC\s*=\s*"([^"]+)"/)[1]).host + '**';

const hx = (v) => BigInt(v).toString(16).padStart(64, '0');
function makePost(addr, index, msg, deleted) { return { index, addr, ts: 1751800000 + index, deleted: !!deleted, msg }; }
function postsBlobRet(posts) {
  let blob = '';
  for (const p of posts) {
    const mb = Buffer.from(p.msg, 'utf8');
    blob += hx(p.index) + '0'.repeat(24) + p.addr.slice(2).toLowerCase() + hx(p.ts || 0) + hx(p.deleted ? 1 : 0) + hx(mb.length) + mb.toString('hex');
  }
  const len = blob.length / 2; let data = blob; while ((data.length / 2) % 32) data += '00';
  return '0x' + hx(32) + hx(len) + data;
}
async function route(page, posts, opts = {}) {
  await page.route(RPC, async (r) => {
    const req = JSON.parse(r.request().postData() || '{}');
    let result = '0x' + hx(0);
    if (req.method === 'eth_call') {
      const sel = (req.params[0].data || '').slice(0, 10);
      if (sel === '0x06661abd') result = '0x' + hx(posts.length);                       // count
      else if (sel === '0xef48eaa4') { if (opts.delay) await new Promise((res) => setTimeout(res, opts.delay)); result = postsBlobRet(posts); } // getPostsBlob
    }
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
  });
}

test('homepage teaser shows the 3 most-recent posts, newest first', async ({ page }) => {
  await route(page, [
    makePost('0x1111111111111111111111111111111111111111', 0, 'gm'),
    makePost('0x2222222222222222222222222222222222222222', 1, 'points'),
    makePost('0x3333333333333333333333333333333333333333', 2, 'wen airdrop'),
    makePost('0x4444444444444444444444444444444444444444', 3, 'latest one'),
  ]);
  await page.goto('/');
  await expect(page.locator('#gb-peek')).toBeVisible();
  await expect(page.locator('#gb-peek-list li')).toHaveCount(3);              // only 3, not all 4
  await expect(page.locator('#gb-peek-list li').first()).toContainText('latest one');
  await expect(page.locator('#gb-peek-list li').first()).toContainText('0x4444…4444');
});

test('homepage teaser hides deleted posts and renders markup inert', async ({ page }) => {
  await route(page, [
    makePost('0x1111111111111111111111111111111111111111', 0, '<img src=x onerror="window.__xss=1">'),
    makePost('0x2222222222222222222222222222222222222222', 1, 'delete me', true),
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
  await route(page, [ makePost('0x1111111111111111111111111111111111111111', 0, 'gm see https://example.com/x cool') ]);
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
  await route(page, [ makePost('0x2222222222222222222222222222222222222222', 0, 'loaded') ], { delay: 700 }); // hold getPostsBlob
  await page.goto('/');
  await expect(page.locator('#gb-peek .gb-peek-skel').first()).toBeVisible();          // placeholder while loading
  await expect(page.locator('#gb-peek-list li.gb-peek-skel')).toHaveCount(0, { timeout: 4000 }); // replaced
  await expect(page.locator('#gb-peek .gb-peek-msg').first()).toHaveText('loaded');
});
