const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const TOPIC = '0x12a6d6e360de92ee96444e397580fa39ca65f27c25bd78a4bad6278011334fac';
const SRC  = fs.readFileSync(path.join(__dirname, '..', 'site', 'guestbook', 'chain.js'), 'utf8');
const RPC  = 'https://' + new URL(SRC.match(/rpc:\s*"([^"]+)"/)[1]).host + '/**';
const BASE = parseInt(SRC.match(/DEPLOY_BLOCK:\s*(\d+)/)[1], 10);
const LCD  = 'https://' + new URL(SRC.match(/LCD:\s*\[[^\]]*?"([^"]+)"/)[1]).host + '/**';
const A = '0x1111111111111111111111111111111111111111';

const hx = (v) => BigInt(v).toString(16).padStart(64, '0');
// posts come from contract state now (getPostsBlob). Name kept so the test bodies read the same.
function makeLog(from, index, message) { return { index, addr: from, ts: 1751800000 + index, deleted: false, msg: message }; }
function postsBlobRet(posts) {
  let blob = '';
  for (const p of posts) {
    const mb = Buffer.from(p.msg, 'utf8');
    blob += hx(p.index) + '0'.repeat(24) + p.addr.slice(2).toLowerCase() + hx(p.ts || 0) + hx(p.deleted ? 1 : 0) + hx(mb.length) + mb.toString('hex');
  }
  const len = blob.length / 2; let data = blob; while ((data.length / 2) % 32) data += '00';
  return '0x' + hx(32) + hx(len) + data;
}
async function route(page, posts) {
  await page.route(RPC, async (r) => {
    const req = JSON.parse(r.request().postData() || '{}'); let result = '0x' + hx(0);
    if (req.method === 'eth_call') {
      const sel = (req.params[0].data || '').slice(0, 10);
      if (sel === '0x06661abd') result = '0x' + hx(posts.length);
      else if (sel === '0xef48eaa4') result = postsBlobRet(posts);
      else if (sel === '0x34472457') result = '0x' + hx(32) + hx(0);
    }
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
