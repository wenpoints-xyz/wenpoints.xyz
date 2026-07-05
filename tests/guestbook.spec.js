const { test, expect } = require('@playwright/test');

const RPC = '**k8s.testnet.json-rpc.injective.network**';
const TOPIC = '0x12a6d6e360de92ee96444e397580fa39ca65f27c25bd78a4bad6278011334fac';
const BASE = 132601081;          // must be >= chain.js CONFIG.DEPLOY_BLOCK
const LATEST = BASE + 2000;

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

// Mock the JSON-RPC endpoint chain.js reads from. `state` lets a test mutate logs/block mid-flow.
async function routeChain(page, state) {
  state = Object.assign({ logs: [], latest: LATEST }, state);
  page._chain = state;
  await page.route(RPC, async (route) => {
    const req = JSON.parse(route.request().postData() || '{}');
    let result;
    if (req.method === 'eth_blockNumber') result = '0x' + state.latest.toString(16);
    else if (req.method === 'eth_getLogs') result = state.logs;
    else if (req.method === 'eth_getBlockByNumber') result = { timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
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

test('signing sends a tx, waits for the receipt, and the post arrives via events', async ({ page }) => {
  const state = await routeChain(page, { logs: [], latest: LATEST });
  state.onReceipt = () => { // once the tx confirms, the next getLogs returns the new post
    state.latest = LATEST + 1;
    state.logs = [makeLog('0xAbC0000000000000000000000000000000001234', 0, 'hello chain', LATEST + 1)];
  };
  await connect(page);
  await page.fill('#msg', 'hello chain');
  await page.click('#sign-btn');
  await expect(page.locator('#posts .post-body').first()).toHaveText('hello chain');
  expect(await page.evaluate(() => window.__calls)).toContain('eth_sendTransaction');
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
