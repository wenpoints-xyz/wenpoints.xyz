const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'site', 'guestbook', 'chain.js'), 'utf8');
const RPC = '**' + new URL(SRC.match(/rpc:\s*"([^"]+)"/)[1]).host + '**';
const TIP_ADDRS = (SRC.match(/address:\s*"(0x[0-9a-fA-F]{40})"/g) || []).map((s) => s.match(/0x[0-9a-fA-F]{40}/)[0]).slice(0, 3);
const USDC = TIP_ADDRS[0];
const SEL_TIP = SRC.match(/SEL_TIP:\s*"([^"]+)"/)[1];
const SEL_APPROVE = '0x095ea7b3';
const ACCT = '0xAbC0000000000000000000000000000000001234';
const BIG = 10n ** 30n;

const hx = (v) => BigInt(v).toString(16).padStart(64, '0');
function postsBlobRet(posts) {
  let blob = '';
  for (const p of posts) {
    const mb = Buffer.from(p.msg, 'utf8');
    blob += hx(p.index) + '0'.repeat(24) + p.addr.slice(2).toLowerCase() + hx(p.ts || 0) + hx(p.deleted ? 1 : 0) + hx(mb.length) + mb.toString('hex');
  }
  const len = blob.length / 2; let data = blob; while ((data.length / 2) % 32) data += '00';
  return '0x' + hx(32) + hx(len) + data;
}
const uintArrRet = (vals) => '0x' + hx(32) + hx(vals.length) + vals.map(hx).join('');
function tipsFlat(state) {
  const out = [];
  for (let i = 0; i < state.posts.length; i++) for (const t of TIP_ADDRS) out.push((state.tips[i] && state.tips[i][t.toLowerCase()]) || 0n);
  return out;
}
const post = (index, addr, msg) => ({ index, addr, ts: 1751800000 + index, deleted: false, msg });

async function routeState(page, state) {
  state = Object.assign({ posts: [], tips: {}, admin: false, allowance: 0n, erc20: 0n, native: 0n }, state);
  page._state = state;
  await page.route(RPC, async (route) => {
    const req = JSON.parse(route.request().postData() || '{}');
    let result = '0x' + hx(0);
    if (req.method === 'eth_call') {
      const sel = (req.params[0].data || '').slice(0, 10);
      if (sel === '0x06661abd') result = '0x' + hx(state.posts.length);
      else if (sel === '0xef48eaa4') result = postsBlobRet(state.posts);
      else if (sel === '0x34472457') result = uintArrRet(tipsFlat(state));
      else if (sel === '0x24d7806c') result = '0x' + hx(state.admin ? 1 : 0);
      else if (sel === '0xdd62ed3e') result = '0x' + hx(state.allowance);      // allowance
      else if (sel === '0x70a08231') result = '0x' + hx(state.erc20);          // balanceOf
    } else if (req.method === 'eth_getBalance') result = '0x' + hx(state.native);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
  });
  return state;
}
const WALLET = `(() => {
  window.__sent = [];
  const p = { isMetaMask: true,
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts') return ['${ACCT}'];
      if (method === 'eth_chainId') return '0x6f0';
      if (method === 'eth_sendTransaction') { window.__sent.push(params[0]); return '0x' + 'de'.repeat(32); }
      return null;
    }, on() {} };
  window.ethereum = p;
})();`;
async function connect(page) {
  await page.addInitScript(WALLET);
  await page.goto('/guestbook/');
  await page.click('#connect-btn');
  await page.locator('#wlist .wopt').first().click();
  await expect(page.locator('#account')).toBeVisible();
}
const sentSelectors = (page) => page.evaluate(() => window.__sent.map((s) => (s.data || '').slice(0, 10)));

test('per-post tip totals render from state', async ({ page }) => {
  await routeState(page, { posts: [post(0, '0x1111111111111111111111111111111111111111', 'tip me')], tips: { 0: { [USDC.toLowerCase()]: 5000000n } } });
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post .tip-totals')).toContainText('5 USDC');
});

test('untipped post shows only the Tip button, no totals', async ({ page }) => {
  await routeState(page, { posts: [post(0, '0x1111111111111111111111111111111111111111', 'hi')] });
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post .tip-btn')).toHaveText('💰 Tip');
  await expect(page.locator('#posts .post .tip-totals')).toHaveText('');
});

test('tip with sufficient allowance = single tip tx, totals update', async ({ page }) => {
  const state = await routeState(page, { posts: [post(0, '0x1111111111111111111111111111111111111111', 'gm')], allowance: BIG, erc20: BIG });
  await connect(page);
  await page.click('#posts .post .tip-btn');
  await expect(page.locator('#tip-overlay')).toBeVisible();
  await page.fill('#tip-amount', '1');                 // USDC default
  await page.click('#tip-go');
  await page.waitForFunction((s) => window.__sent.some((x) => (x.data || '').startsWith(s)), SEL_TIP);
  expect(await sentSelectors(page)).not.toContain(SEL_APPROVE);
  state.tips[0] = { [USDC.toLowerCase()]: 1000000n };  // reveal the tip on-chain
  await expect(page.locator('#toast')).toContainText('Tipped');
  await expect(page.locator('#posts .post .tip-totals')).toContainText('1 USDC');
});

test('tip needing approval fires approve then tip', async ({ page }) => {
  const state = await routeState(page, { posts: [post(0, '0x1111111111111111111111111111111111111111', 'gm')], allowance: 0n, erc20: BIG });
  await connect(page);
  await page.click('#posts .post .tip-btn');
  await page.fill('#tip-amount', '1');
  await page.click('#tip-go');
  await page.waitForFunction((s) => window.__sent.some((x) => (x.data || '').startsWith(s)), SEL_APPROVE);
  state.allowance = BIG;                                // approve "landed"
  await page.waitForFunction((s) => window.__sent.some((x) => (x.data || '').startsWith(s)), SEL_TIP);
  const sels = await sentSelectors(page);
  expect(sels.indexOf(SEL_APPROVE)).toBeLessThan(sels.indexOf(SEL_TIP));
  state.tips[0] = { [USDC.toLowerCase()]: 1000000n };
  await expect(page.locator('#toast')).toContainText('Tipped');
});

test('insufficient balance blocks the tip (no tx sent)', async ({ page }) => {
  await routeState(page, { posts: [post(0, '0x1111111111111111111111111111111111111111', 'gm')], allowance: BIG, erc20: 0n });
  await connect(page);
  await page.click('#posts .post .tip-btn');
  await page.fill('#tip-amount', '1');
  await page.click('#tip-go');
  await expect(page.locator('#tip-status')).toContainText('not enough');
  expect(await sentSelectors(page)).not.toContain(SEL_TIP);
});

test('tip while disconnected opens the wallet picker', async ({ page }) => {
  await routeState(page, { posts: [post(0, '0x1111111111111111111111111111111111111111', 'gm')] });
  await page.goto('/guestbook/');
  await expect(page.locator('#tip-overlay')).toBeHidden();
  await page.click('#posts .post .tip-btn');
  await expect(page.locator('#wallet-overlay')).toBeVisible();
});
