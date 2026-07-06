const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const T_POST = '0x12a6d6e360de92ee96444e397580fa39ca65f27c25bd78a4bad6278011334fac';
const SRC = fs.readFileSync(path.join(__dirname, '..', 'site', 'guestbook', 'chain.js'), 'utf8');
const RPC = '**' + new URL(SRC.match(/rpc:\s*"([^"]+)"/)[1]).host + '**';
const LCD = 'https://' + new URL(SRC.match(/LCD:\s*\[[^\]]*?"([^"]+)"/)[1]).host + '/**';
const BASE = parseInt(SRC.match(/DEPLOY_BLOCK:\s*(\d+)/)[1], 10);
const LATEST = BASE + 2000;
const T_TIP = SRC.match(/TOPIC_TIPPED:\s*"([^"]+)"/)[1];
const USDC = SRC.match(/symbol:\s*"USDC",\s*address:\s*"([^"]+)"/)[1];
const SEL_TIP = SRC.match(/SEL_TIP:\s*"([^"]+)"/)[1];
const SEL_APPROVE = '0x095ea7b3';
const ACCT = '0xAbC0000000000000000000000000000000001234';
const BIG = 10n ** 30n;

const hex32 = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
function makeLog(from, index, message, block) {
  const author = '0x' + '0'.repeat(24) + from.slice(2).toLowerCase();
  const idx = hex32(index);
  const bytes = Buffer.from(message, 'utf8');
  let data = bytes.toString('hex'); while (data.length % 64 !== 0) data += '0';
  return { topics: [T_POST, author, idx], data: '0x' + (32).toString(16).padStart(64, '0') + bytes.length.toString(16).padStart(64, '0') + data,
    blockNumber: '0x' + block.toString(16), logIndex: '0x0' };
}
function tippedLog(index, from, token, amount, block) {
  return { topics: [T_TIP, hex32(index), '0x' + '0'.repeat(24) + from.slice(2).toLowerCase(), '0x' + '0'.repeat(24) + token.slice(2).toLowerCase()],
    data: hex32(amount), blockNumber: '0x' + block.toString(16), logIndex: '0x1' };
}

async function routeChain(page, state) {
  state = Object.assign({ logs: [], latest: LATEST, allowance: 0n, erc20: 0n, native: 0n }, state);
  page._chain = state;
  await page.route(RPC, async (route) => {
    const req = JSON.parse(route.request().postData() || '{}');
    let result = null;
    if (req.method === 'eth_blockNumber') result = '0x' + state.latest.toString(16);
    else if (req.method === 'eth_getLogs') result = state.logs;
    else if (req.method === 'eth_getBlockByNumber') result = { timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
    else if (req.method === 'eth_getBalance') result = hex32(state.native);
    else if (req.method === 'eth_call') {
      const sel = (req.params[0].data || '').slice(0, 10);
      if (sel === '0xdd62ed3e') result = hex32(state.allowance);      // allowance
      else if (sel === '0x70a08231') result = hex32(state.erc20);     // balanceOf
      else result = hex32(0);                                         // isAdmin -> 0
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
  });
  await page.route(LCD, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ denom_owners: [], pagination: { next_key: null } }) }));
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

test('per-post tip totals render from Tipped events', async ({ page }) => {
  await routeChain(page, { logs: [
    makeLog('0x1111111111111111111111111111111111111111', 0, 'tip me', BASE + 10),
    tippedLog(0, '0x2222222222222222222222222222222222222222', USDC, 5000000n, BASE + 11), // 5 USDC
  ] });
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post .tip-totals')).toContainText('5 USDC');
});

test('untipped post shows only the Tip button, no totals', async ({ page }) => {
  await routeChain(page, { logs: [ makeLog('0x1111111111111111111111111111111111111111', 0, 'hi', BASE + 10) ] });
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post .tip-btn')).toHaveText('💰 Tip');
  await expect(page.locator('#posts .post .tip-totals')).toHaveText('');
});

test('tip with sufficient allowance = single tip tx, totals update', async ({ page }) => {
  const state = await routeChain(page, { logs: [ makeLog('0x1111111111111111111111111111111111111111', 0, 'gm', BASE + 10) ], allowance: BIG, erc20: BIG });
  await connect(page);
  await page.click('#posts .post .tip-btn');
  await expect(page.locator('#tip-overlay')).toBeVisible();
  await page.fill('#tip-amount', '1');                         // USDC is the default token
  await page.click('#tip-go');
  await page.waitForFunction((s) => window.__sent.some((x) => (x.data || '').startsWith(s)), SEL_TIP);
  expect(await sentSelectors(page)).not.toContain(SEL_APPROVE); // allowance already sufficient -> no approve
  // reveal the Tipped event so the confirm poll resolves
  state.logs.push(tippedLog(0, ACCT, USDC, 1000000n, LATEST + 1)); state.latest = LATEST + 1;
  await expect(page.locator('#toast')).toContainText('Tipped');
  await expect(page.locator('#posts .post .tip-totals')).toContainText('1 USDC');
});

test('tip needing approval fires approve then tip', async ({ page }) => {
  const state = await routeChain(page, { logs: [ makeLog('0x1111111111111111111111111111111111111111', 0, 'gm', BASE + 10) ], allowance: 0n, erc20: BIG });
  await connect(page);
  await page.click('#posts .post .tip-btn');
  await page.fill('#tip-amount', '1');
  await page.click('#tip-go');
  await page.waitForFunction((s) => window.__sent.some((x) => (x.data || '').startsWith(s)), SEL_APPROVE);
  state.allowance = BIG;                                        // approve "landed"
  await page.waitForFunction((s) => window.__sent.some((x) => (x.data || '').startsWith(s)), SEL_TIP);
  const sels = await sentSelectors(page);
  expect(sels.indexOf(SEL_APPROVE)).toBeLessThan(sels.indexOf(SEL_TIP)); // approve before tip
  state.logs.push(tippedLog(0, ACCT, USDC, 1000000n, LATEST + 1)); state.latest = LATEST + 1;
  await expect(page.locator('#toast')).toContainText('Tipped');
});

test('insufficient balance blocks the tip (no tx sent)', async ({ page }) => {
  await routeChain(page, { logs: [ makeLog('0x1111111111111111111111111111111111111111', 0, 'gm', BASE + 10) ], allowance: BIG, erc20: 0n });
  await connect(page);
  await page.click('#posts .post .tip-btn');
  await page.fill('#tip-amount', '1');
  await page.click('#tip-go');
  await expect(page.locator('#tip-status')).toContainText('not enough');
  expect(await sentSelectors(page)).not.toContain(SEL_TIP);
});

test('tip while disconnected opens the wallet picker', async ({ page }) => {
  await routeChain(page, { logs: [ makeLog('0x1111111111111111111111111111111111111111', 0, 'gm', BASE + 10) ] });
  await page.goto('/guestbook/');
  await expect(page.locator('#tip-overlay')).toBeHidden();
  await page.click('#posts .post .tip-btn');
  await expect(page.locator('#wallet-overlay')).toBeVisible();  // gated: connect first
});
