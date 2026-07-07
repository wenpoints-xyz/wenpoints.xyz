const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// The guestbook reads posts+tips from contract STATE via eth_call (count / getPostsBlob / getTips),
// not a log scan. These mocks serve those calls; helpers below encode returns exactly as the contract would.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'site', 'guestbook', 'chain.js'), 'utf8');
const RPC = '**' + new URL(SRC.match(/rpc:\s*"([^"]+)"/)[1]).host + '**';
const TIP_ADDRS = (SRC.match(/address:\s*"(0x[0-9a-fA-F]{40})"/g) || []).map((s) => s.match(/0x[0-9a-fA-F]{40}/)[0]).slice(0, 3);
const ACCT = '0xAbC0000000000000000000000000000000001234';

const hx = (v) => BigInt(v).toString(16).padStart(64, '0');
function postsBlobRet(posts) {                       // getPostsBlob(bytes) return
  let blob = '';
  for (const p of posts) {
    const mb = Buffer.from(p.msg, 'utf8');
    blob += hx(p.index) + '0'.repeat(24) + p.addr.slice(2).toLowerCase() + hx(p.ts || 0) + hx(p.deleted ? 1 : 0) + hx(mb.length) + mb.toString('hex');
  }
  const len = blob.length / 2; let data = blob; while ((data.length / 2) % 32) data += '00';
  return '0x' + hx(32) + hx(len) + data;
}
const uintArrRet = (vals) => '0x' + hx(32) + hx(vals.length) + vals.map(hx).join('');
function tipsFlat(state) {                            // getTips(uint256[]) flat, index-major token-minor
  const out = [];
  for (let i = 0; i < state.posts.length; i++) for (const t of TIP_ADDRS) out.push((state.tips[i] && state.tips[i][t.toLowerCase()]) || 0n);
  return out;
}
async function routeState(page, state) {
  state = Object.assign({ posts: [], tips: {}, admin: false }, state);
  page._state = state;
  await page.route(RPC, async (route) => {
    const req = JSON.parse(route.request().postData() || '{}');
    let result = '0x' + hx(0);
    if (req.method === 'eth_call') {
      const sel = (req.params[0].data || '').slice(0, 10);
      if (sel === '0x06661abd') result = '0x' + hx(state.posts.length);   // count()
      else if (sel === '0xef48eaa4') result = postsBlobRet(state.posts);  // getPostsBlob
      else if (sel === '0x34472457') result = uintArrRet(tipsFlat(state));// getTips
      else if (sel === '0x24d7806c') result = '0x' + hx(state.admin ? 1 : 0); // isAdmin
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
  });
  return state;
}
const post = (index, addr, msg, deleted) => ({ index, addr, ts: 1751800000 + index, deleted: !!deleted, msg });

// authorized=true → eth_accounts returns the account (wallet still authorizes this dApp), enabling a silent reconnect on reload.
const walletScript = (authorized) => `(() => {
  const cbs = {}; window.__calls = [];
  const p = { isMetaMask: true,
    request: async ({ method }) => {
      window.__calls.push(method);
      if (method === 'eth_requestAccounts') return ['${ACCT}'];
      if (method === 'eth_accounts') return ${authorized ? `['${ACCT}']` : '[]'};
      if (method === 'eth_chainId') return '0x6f0';
      if (method === 'eth_sendTransaction') return '0x' + 'de'.repeat(32);
      return null;
    }, on(ev, cb) { cbs[ev] = cb; } };
  window.__emitAccounts = (a) => cbs.accountsChanged && cbs.accountsChanged(a);
  window.ethereum = p;
})();`;
const WALLET = walletScript(true);
async function connect(page) {
  await page.addInitScript(WALLET);
  await page.goto('/guestbook/');
  await page.click('#connect-btn');
  await page.locator('#wlist .wopt').first().click();
  await expect(page.locator('#account')).toBeVisible();
}

test('loads posts from contract state', async ({ page }) => {
  await routeState(page, { posts: [post(0, '0x1111111111111111111111111111111111111111', 'gm on chain')] });
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post')).toHaveCount(1);
  await expect(page.locator('#posts .post-body').first()).toHaveText('gm on chain');
  await expect(page.locator('#posts .post-addr').first()).toHaveText('0x1111…1111');
});

test('sender address links to its injscan account in a new tab', async ({ page }) => {
  await routeState(page, { posts: [post(0, '0x68D85663DaE6Aed5F102b7ec1f5551b890Ce1db3', 'gm')] });
  await page.goto('/guestbook/');
  const a = page.locator('#posts .post-addr').first();
  await expect(a).toHaveAttribute('href', 'https://injscan.com/account/inj1drv9vc76u6hdtugzklkp7423hzgvu8dn5uvvqf'); // 0x -> inj1
  await expect(a).toHaveAttribute('target', '_blank');
  await expect(a).toHaveAttribute('rel', /noopener/);
});

test('a stored message with markup renders as inert text', async ({ page }) => {
  const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2<\/script>';
  await routeState(page, { posts: [post(0, '0x2222222222222222222222222222222222222222', payload)] });
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post')).toHaveCount(1);
  expect(await page.locator('#posts img').count()).toBe(0);
  expect(await page.locator('#posts script').count()).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(page.locator('#posts .post-body').first()).toContainText('<img src=x onerror');
});

test('empty guestbook shows the empty state', async ({ page }) => {
  await routeState(page, { posts: [] });
  await page.goto('/guestbook/');
  await expect(page.locator('#empty')).toBeVisible();
});

test('load more pages 10 at a time, then shows the end marker', async ({ page }) => {
  const posts = [];
  for (let i = 0; i < 25; i++) posts.push(post(i, '0x3333333333333333333333333333333333333333', 'post #' + i));
  await routeState(page, { posts });
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post')).toHaveCount(10);
  await page.click('#loadmore');
  await expect(page.locator('#posts .post')).toHaveCount(20);
  await page.click('#loadmore');
  await expect(page.locator('#posts .post')).toHaveCount(25);
  await expect(page.locator('#loadmore')).toBeHidden();
  await expect(page.locator('#end')).toBeVisible();
});

test('compose is gated until a wallet connects', async ({ page }) => {
  await routeState(page, { posts: [] });
  await page.goto('/guestbook/');
  await expect(page.locator('#msg')).toBeDisabled();
  await expect(page.locator('#sign-btn')).toBeDisabled();
});

test('signing sends a tx and the post is confirmed once state shows it', async ({ page }) => {
  const state = await routeState(page, { posts: [] });
  await connect(page);
  await page.fill('#msg', 'hello chain');
  await page.click('#sign-btn');                       // sends the tx; page polls state to confirm
  state.posts.push(post(0, ACCT, 'hello chain'));      // reveal the post on-chain
  await expect(page.locator('#posts .post-body').first()).toHaveText('hello chain');
  expect(await page.evaluate(() => window.__calls)).toContain('eth_sendTransaction');
  await expect(page.locator('#msg')).toHaveValue('');
  await expect(page.locator('#sign-btn')).toHaveText('Sign');
});

test('switching the wallet account updates the UI; locking disconnects', async ({ page }) => {
  await routeState(page, { posts: [] });
  await connect(page);
  await expect(page.locator('#account')).toHaveText('0xAbC0…1234');
  await page.evaluate(() => window.__emitAccounts(['0xBBB0000000000000000000000000000000000002']));
  await expect(page.locator('#account')).toHaveText('0xBBB0…0002');
  await page.evaluate(() => window.__emitAccounts([]));
  await expect(page.locator('#connect-btn')).toBeVisible();
  await expect(page.locator('#msg')).toBeDisabled();
});

test('wallet connection persists across a reload (silent reconnect, no popup)', async ({ page }) => {
  await routeState(page, { posts: [] });
  await connect(page);
  await expect(page.locator('#account')).toHaveText('0xAbC0…1234');
  await page.reload();
  await expect(page.locator('#account')).toBeVisible();                 // reconnected without clicking
  await expect(page.locator('#account')).toHaveText('0xAbC0…1234');
  await expect(page.locator('#connect-btn')).toBeHidden();
  await expect(page.locator('#wallet-overlay')).toBeHidden();           // no wallet picker shown
  await expect(page.locator('#msg')).toBeEnabled();                     // compose is unlocked again
  const calls = await page.evaluate(() => window.__calls);
  expect(calls).toContain('eth_accounts');                             // used the silent path...
  expect(calls).not.toContain('eth_requestAccounts');                  // ...not the popup path
});

test('an explicit disconnect is remembered across a reload (no auto-reconnect)', async ({ page }) => {
  await routeState(page, { posts: [] });
  await connect(page);
  await page.click('#disconnect-btn');
  await expect(page.locator('#connect-btn')).toBeVisible();
  await page.reload();
  await expect(page.locator('#connect-btn')).toBeVisible();
  await expect(page.locator('#account')).toBeHidden();
  expect(await page.evaluate(() => window.__calls)).not.toContain('eth_accounts'); // flag cleared → no reconnect attempt
});

test('a revoked wallet does not silently reconnect (stale flag cleared)', async ({ page }) => {
  await routeState(page, { posts: [] });
  await page.addInitScript(walletScript(false));            // wallet no longer authorizes this dApp → eth_accounts returns []
  await page.goto('/guestbook/');
  await page.evaluate(() => localStorage.setItem('hp-wallet', 'io.metamask')); // pretend a prior session saved it
  await page.reload();
  await expect(page.locator('#connect-btn')).toBeVisible();
  await expect(page.locator('#account')).toBeHidden();
  expect(await page.evaluate(() => window.__calls)).toContain('eth_accounts');      // tried silently...
  expect(await page.evaluate(() => localStorage.getItem('hp-wallet'))).toBeNull();  // ...then cleared the stale flag
});

test('a post flagged deleted is hidden', async ({ page }) => {
  await routeState(page, { posts: [
    post(0, '0x1111111111111111111111111111111111111111', 'keep me'),
    post(1, '0x2222222222222222222222222222222222222222', 'delete me', true),
  ] });
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post')).toHaveCount(1);
  await expect(page.locator('#posts .post-body').first()).toHaveText('keep me');
});

test('a non-admin sees no delete controls', async ({ page }) => {
  await routeState(page, { admin: false, posts: [post(0, '0x1111111111111111111111111111111111111111', 'hi')] });
  await connect(page);
  await expect(page.locator('#posts .post')).toHaveCount(1);
  await expect(page.locator('.post-del')).toHaveCount(0);
});

test('an admin sees delete controls and can delete a post', async ({ page }) => {
  const state = await routeState(page, { admin: true, posts: [post(0, '0x1111111111111111111111111111111111111111', 'bye')] });
  await connect(page);
  await expect(page.locator('.post-del')).toHaveCount(1);
  await page.click('.post-del');                        // sends deletePost tx
  state.posts[0].deleted = true;                        // reveal the delete on-chain
  await expect(page.locator('#posts .post')).toHaveCount(0);
  expect(await page.evaluate(() => window.__calls)).toContain('eth_sendTransaction');
});
