const { test, expect } = require('@playwright/test');

// Injected before every page load: a fake EIP-6963 wallet on Injective EVM (chainId 0x6f0).
const MOCK = `
(() => {
  const mock = {
    _acct: '0xAbC0000000000000000000000000000000001234',
    request: async ({ method }) => {
      if (method === 'eth_requestAccounts') return [mock._acct];
      if (method === 'eth_chainId') return '0x6f0';
      return null;
    },
    on(ev, cb) { cbs[ev] = cb; }
  };
  const cbs = {};
  window.__emitAccounts = (a) => cbs.accountsChanged && cbs.accountsChanged(a);
  window.__announceMock = () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { name: 'MockMetaMask', rdns: 'io.metamask', icon: '' }, provider: mock }
    }));
})();
`;

async function connect(page) {
  await page.addInitScript(MOCK);
  await page.goto('/guestbook/?e2e=1');
  await page.evaluate(() => window.__announceMock());
  await page.click('#connect-btn');
  await page.click('#wlist .wopt'); // MockMetaMask is listed first
  await expect(page.locator('#account')).toBeVisible();
}

test('compose is gated until a wallet connects', async ({ page }) => {
  await page.addInitScript(MOCK);
  await page.goto('/guestbook/?e2e=1');
  await expect(page.locator('#msg')).toBeDisabled();
  await expect(page.locator('#sign-btn')).toBeDisabled();
  await expect(page.locator('#sign-btn')).toHaveText('Connect wallet to sign');
});

test('a malicious post renders as inert text, not executed markup', async ({ page }) => {
  await connect(page);
  await page.fill('#msg', '<img src=x onerror="window.__xss=1"><script>window.__xss=2<\/script>');
  await page.click('#sign-btn');
  await expect(page.locator('#posts .post')).toHaveCount(4); // 3 seed + 1 new
  expect(await page.locator('#posts img').count()).toBe(0);
  expect(await page.locator('#posts script').count()).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(page.locator('#posts .post-body').first()).toContainText('<img src=x onerror');
});

test('signing prepends the post with the truncated signer address', async ({ page }) => {
  await connect(page);
  await page.fill('#msg', 'gm from the test');
  await page.click('#sign-btn');
  await expect(page.locator('#posts .post-body').first()).toHaveText('gm from the test');
  await expect(page.locator('#posts .post-addr').first()).toHaveText('0xAbC0…1234');
});

test('load more pages 10 at a time, then shows the end marker', async ({ page }) => {
  await page.addInitScript(MOCK);
  await page.goto('/guestbook/?e2e=1');
  await page.evaluate(() => window.__gb.seedMany(25));
  await expect(page.locator('#posts .post')).toHaveCount(10);
  await page.click('#loadmore');
  await expect(page.locator('#posts .post')).toHaveCount(20);
  await page.click('#loadmore');
  await expect(page.locator('#posts .post')).toHaveCount(25);
  await expect(page.locator('#loadmore')).toBeHidden();
  await expect(page.locator('#end')).toBeVisible();
});

test('empty guestbook shows the empty state', async ({ page }) => {
  await page.addInitScript(MOCK);
  await page.goto('/guestbook/?e2e=1');
  await page.evaluate(() => window.__gb.clear());
  await expect(page.locator('#empty')).toBeVisible();
});

// A Brave-style wallet: injected via window.ethereum, does NOT announce via EIP-6963, defaults to Ethereum.
const INJECTED = `
(() => {
  window.__calls = [];
  window.ethereum = {
    isBraveWallet: true,
    request: async ({ method }) => {
      window.__calls.push(method);
      if (method === 'eth_requestAccounts') return ['0xAbC0000000000000000000000000000000001234'];
      if (method === 'eth_chainId') return '0x1';           // wallet defaults to Ethereum
      if (method === 'wallet_switchEthereumChain') return null;
      return null;
    },
    on() {}
  };
})();
`;

test('switching the wallet account updates the UI; locking disconnects', async ({ page }) => {
  await connect(page);
  await expect(page.locator('#account')).toHaveText('0xAbC0…1234');
  await page.evaluate(() => window.__emitAccounts(['0xBBB0000000000000000000000000000000000002']));
  await expect(page.locator('#account')).toHaveText('0xBBB0…0002');
  await page.evaluate(() => window.__emitAccounts([])); // wallet locked / access revoked
  await expect(page.locator('#connect-btn')).toBeVisible();
  await expect(page.locator('#msg')).toBeDisabled();
});

test('a Brave-style injected wallet (no EIP-6963) appears and connects', async ({ page }) => {
  await page.addInitScript(INJECTED);
  await page.goto('/guestbook/?e2e=1');
  await page.click('#connect-btn');
  await expect(page.locator('#wlist .wopt').first()).toContainText('Brave Wallet');
  await page.locator('#wlist .wopt').first().click();
  await expect(page.locator('#account')).toBeVisible();
});

test('connecting on the wrong chain proactively switches to Injective', async ({ page }) => {
  await page.addInitScript(INJECTED);
  await page.goto('/guestbook/?e2e=1');
  await page.click('#connect-btn');
  await page.locator('#wlist .wopt').first().click();
  await expect(page.locator('#account')).toBeVisible();
  const calls = await page.evaluate(() => window.__calls);
  expect(calls).toContain('wallet_switchEthereumChain');
});
