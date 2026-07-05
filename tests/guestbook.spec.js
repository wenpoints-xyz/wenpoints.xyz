const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const RPC = '**k8s.testnet.json-rpc.injective.network**';
const TOPIC = '0x12a6d6e360de92ee96444e397580fa39ca65f27c25bd78a4bad6278011334fac';        // PostCreated
const TOPIC_DEL = '0x1da4a15b15417b54b8b3bea2ca87cfc4c94f0fee7d86702d0dab9e2906e7a7d3';   // PostDeleted
// Read DEPLOY_BLOCK from chain.js so the mocked block range always covers it (survives redeploys).
const CHAIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'site', 'guestbook', 'chain.js'), 'utf8');
const BASE = parseInt(CHAIN_SRC.match(/DEPLOY_BLOCK:\s*(\d+)/)[1], 10);
const LATEST = BASE + 2000;      // small range -> one getLogs chunk

// Build a PostCreated log the way the contract emits it, so chain.js decodes it for real.
function makeLog(from, index, message, block) {
  const author = '0x' + '0'.repeat(24) + from.slice(2).toLowerCase();
  const idx = '0x' + BigInt(index).toString(16).padStart(64, '0');
  const bytes = Buffer.from(message, 'utf8');
  const offset = (32).toString(16).padStart(64, '0');
  const len = bytes.length.toString(16).padStart(64, '0');
  let data = bytes.toString('hex');
  while (data.length % 64 !== 0) data += '0';
  return { topics: [TOPIC, author, idx], data: '0x' + offset + len + data, blockNumber: '0x' + block.toString(16) };
}
function makeDeleteLog(index, block) {
  const idx = '0x' + BigInt(index).toString(16).padStart(64, '0');
  return { topics: [TOPIC_DEL, idx, '0x' + '0'.repeat(64)], data: '0x', blockNumber: '0x' + block.toString(16) };
}

// Mock the JSON-RPC endpoint chain.js reads from. `state` lets a test mutate logs/block mid-flow.
async function routeChain(page, state) {
  state = Object.assign({ logs: [], latest: LATEST, admin: false }, state);
  page._chain = state;
  await page.route(RPC, async (route) => {
    const req = JSON.parse(route.request().postData() || '{}');
    let result;
    if (req.method === 'eth_blockNumber') result = '0x' + state.latest.toString(16);
    else if (req.method === 'eth_getLogs') result = state.logs;
    else if (req.method === 'eth_getBlockByNumber') result = { timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
    else if (req.method === 'eth_call') result = '0x' + (state.admin ? '1' : '0').padStart(64, '0'); // isAdmin(address)
    else if (req.method === 'eth_getTransactionReceipt') { if (state.onReceipt) state.onReceipt(); result = { status: '0x1', blockNumber: '0x1' }; }
    else result = null;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
  });
  return state;
}

// An injected wallet already on Injective EVM testnet (0x59f), recording tx sends.
const WALLET = `
(() => {
  const cbs = {};
  window.__calls = [];
  const p = {
    isMetaMask: true,
    request: async ({ method }) => {
      window.__calls.push(method);
      if (method === 'eth_requestAccounts') return ['0xAbC0000000000000000000000000000000001234'];
      if (method === 'eth_chainId') return '0x59f';
      if (method === 'eth_sendTransaction') return '0xdeadbeef';
      return null;
    },
    on(ev, cb) { cbs[ev] = cb; }
  };
  window.__emitAccounts = (a) => cbs.accountsChanged && cbs.accountsChanged(a);
  window.ethereum = p;
})();
`;

async function connect(page) {
  await page.addInitScript(WALLET);
  await page.goto('/guestbook/');
  await page.click('#connect-btn');
  await page.locator('#wlist .wopt').first().click();
  await expect(page.locator('#account')).toBeVisible();
}

test('loads posts from PostCreated events', async ({ page }) => {
  await routeChain(page, { logs: [makeLog('0x1111111111111111111111111111111111111111', 0, 'gm on chain', BASE + 10)] });
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post')).toHaveCount(1);
  await expect(page.locator('#posts .post-body').first()).toHaveText('gm on chain');
  await expect(page.locator('#posts .post-addr').first()).toHaveText('0x1111…1111');
});

test('an on-chain message with markup renders as inert text', async ({ page }) => {
  const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2<\/script>';
  await routeChain(page, { logs: [makeLog('0x2222222222222222222222222222222222222222', 0, payload, BASE + 10)] });
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post')).toHaveCount(1);
  expect(await page.locator('#posts img').count()).toBe(0);
  expect(await page.locator('#posts script').count()).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(page.locator('#posts .post-body').first()).toContainText('<img src=x onerror');
});

test('empty guestbook shows the empty state', async ({ page }) => {
  await routeChain(page, { logs: [] });
  await page.goto('/guestbook/');
  await expect(page.locator('#empty')).toBeVisible();
});

test('load more pages 10 at a time, then shows the end marker', async ({ page }) => {
  const logs = [];
  for (let i = 0; i < 25; i++) logs.push(makeLog('0x3333333333333333333333333333333333333333', i, 'post #' + i, BASE + 10 + i));
  await routeChain(page, { logs });
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
  await routeChain(page, { logs: [] });
  await page.goto('/guestbook/');
  await expect(page.locator('#msg')).toBeDisabled();
  await expect(page.locator('#sign-btn')).toBeDisabled();
});

test('signing sends a tx and the post is confirmed once it appears via events', async ({ page }) => {
  const state = await routeChain(page, { logs: [], latest: LATEST });
  await connect(page);
  await page.fill('#msg', 'hello chain');
  await page.click('#sign-btn'); // sends the tx; the page now polls events to confirm
  // reveal the post on chain — the confirmation poll picks it up (no reliance on tx-by-hash receipt)
  state.latest = LATEST + 1;
  state.logs = [makeLog('0xAbC0000000000000000000000000000000001234', 0, 'hello chain', LATEST + 1)];
  await expect(page.locator('#posts .post-body').first()).toHaveText('hello chain');
  expect(await page.evaluate(() => window.__calls)).toContain('eth_sendTransaction');
  await expect(page.locator('#msg')).toHaveValue('');       // textarea cleared on success
  await expect(page.locator('#sign-btn')).toHaveText('Sign'); // button reset (no longer "Confirming…")
});

test('switching the wallet account updates the UI; locking disconnects', async ({ page }) => {
  await routeChain(page, { logs: [] });
  await connect(page);
  await expect(page.locator('#account')).toHaveText('0xAbC0…1234');
  await page.evaluate(() => window.__emitAccounts(['0xBBB0000000000000000000000000000000000002']));
  await expect(page.locator('#account')).toHaveText('0xBBB0…0002');
  await page.evaluate(() => window.__emitAccounts([]));
  await expect(page.locator('#connect-btn')).toBeVisible();
  await expect(page.locator('#msg')).toBeDisabled();
});

test('a post flagged by PostDeleted is hidden', async ({ page }) => {
  await routeChain(page, { logs: [
    makeLog('0x1111111111111111111111111111111111111111', 0, 'keep me', BASE + 10),
    makeLog('0x2222222222222222222222222222222222222222', 1, 'delete me', BASE + 11),
    makeDeleteLog(1, BASE + 12),
  ] });
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post')).toHaveCount(1);
  await expect(page.locator('#posts .post-body').first()).toHaveText('keep me');
});

test('a non-admin sees no delete controls', async ({ page }) => {
  await routeChain(page, { admin: false, logs: [makeLog('0x1111111111111111111111111111111111111111', 0, 'hi', BASE + 10)] });
  await connect(page);
  await expect(page.locator('#posts .post')).toHaveCount(1);
  await expect(page.locator('.post-del')).toHaveCount(0);
});

test('an admin sees delete controls and can delete a post', async ({ page }) => {
  const state = await routeChain(page, { admin: true, logs: [makeLog('0x1111111111111111111111111111111111111111', 0, 'bye', BASE + 10)] });
  await connect(page);
  await expect(page.locator('.post-del')).toHaveCount(1);   // admin sees the delete control
  await page.click('.post-del');                            // sends deletePost tx
  state.latest = LATEST + 1;                                 // reveal the PostDeleted event for the confirm poll
  state.logs = state.logs.concat([makeDeleteLog(0, LATEST + 1)]);
  await expect(page.locator('#posts .post')).toHaveCount(0); // hidden once the delete confirms
  expect(await page.evaluate(() => window.__calls)).toContain('eth_sendTransaction');
});
