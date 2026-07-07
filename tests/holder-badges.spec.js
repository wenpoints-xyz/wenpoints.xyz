const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const TOPIC = '0x12a6d6e360de92ee96444e397580fa39ca65f27c25bd78a4bad6278011334fac';        // PostCreated
// Derive the mocked RPC host + deploy block from chain.js so this tracks config changes.
const CHAIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'site', 'guestbook', 'chain.js'), 'utf8');
const RPC  = 'https://' + new URL(CHAIN_SRC.match(/rpc:\s*"([^"]+)"/)[1]).host + '/**';
const BASE = parseInt(CHAIN_SRC.match(/DEPLOY_BLOCK:\s*(\d+)/)[1], 10);
const LATEST = BASE + 2000;
const DENOM = CHAIN_SRC.match(/DENOM:\s*"([^"]+)"/)[1];
// LCD origins (order matters — first is primary, rest are fallbacks).
const LCD_HOSTS = (CHAIN_SRC.match(/LCD:\s*\[([^\]]+)\]/)[1].match(/"([^"]+)"/g) || []).map(s => s.replace(/"/g, ''));
const [LCD1, LCD2] = LCD_HOSTS;

// Independent bech32 (BIP173) impl in the test — cross-checks the site's encoder by agreement.
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(v){let c=1;const G=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];
  for(const d of v){const b=c>>>25;c=((c&0x1ffffff)<<5)^d;for(let i=0;i<5;i++)if((b>>>i)&1)c^=G[i];}return c>>>0;}
function hrpExpand(h){const o=[];for(const c of h)o.push(c.charCodeAt(0)>>>5);o.push(0);for(const c of h)o.push(c.charCodeAt(0)&31);return o;}
function checksum(h,d){const m=polymod(hrpExpand(h).concat(d).concat([0,0,0,0,0,0]))^1,o=[];for(let i=0;i<6;i++)o.push((m>>>(5*(5-i)))&31);return o;}
function to5(bytes){let acc=0,bits=0;const o=[];for(const b of bytes){acc=(acc<<8)|b;bits+=8;while(bits>=5){bits-=5;o.push((acc>>>bits)&31);}}if(bits)o.push((acc<<(5-bits))&31);return o;}
function evmToInj(addr){const h=addr.replace(/^0x/,'').toLowerCase();const bytes=[];for(let i=0;i<20;i++)bytes.push(parseInt(h.substr(i*2,2),16));
  const d=to5(bytes),c=d.concat(checksum('inj',d));return 'inj1'+c.map(x=>B32[x]).join('');}

const hx = (v) => BigInt(v).toString(16).padStart(64, '0');
// posts now come from contract state (getPostsBlob), not events. Name kept so callers are unchanged.
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
const raw = (whole) => (BigInt(whole) * (10n ** 18n)).toString();   // whole tokens -> raw 18dp string

async function routeRpc(page, posts) {
  await page.route(RPC, async (r) => {
    const req = JSON.parse(r.request().postData() || '{}');
    let result = '0x' + hx(0);
    if (req.method === 'eth_call') {
      const sel = (req.params[0].data || '').slice(0, 10);
      if (sel === '0x06661abd') result = '0x' + hx(posts.length);       // count
      else if (sel === '0xef48eaa4') result = postsBlobRet(posts);      // getPostsBlob
      else if (sel === '0x34472457') result = '0x' + hx(32) + hx(0);    // getTips (none in badge tests)
    }
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
  });
}
// Fulfil the LCD denom_owners_by_query at `host` with a fixed owner list (one page).
async function routeLcd(page, host, owners, opts = {}) {
  await page.route(host + '/**', async (r) => {
    if (opts.fail) return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    const url = r.request().url();
    const second = url.includes('pagination.key=');
    const body = opts.paginate
      ? (second ? { denom_owners: owners.slice(1), pagination: { next_key: null } }
                : { denom_owners: owners.slice(0, 1), pagination: { next_key: 'PAGE2' } })
      : { denom_owners: owners, pagination: { next_key: null } };
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
}
const A = '0x1111111111111111111111111111111111111111';   // whale
const B = '0x2222222222222222222222222222222222222222';   // plankton
const C = '0x3333333333333333333333333333333333333333';   // not a holder
const owners = [
  { address: evmToInj(A), balance: { denom: DENOM, amount: raw(300000000) } },  // 300M -> whale
  { address: evmToInj(B), balance: { denom: DENOM, amount: raw(5000) } },       // 5k   -> plankton
];

test('bech32 evmToInj matches the deployer known vector and the site encoder', async ({ page }) => {
  await routeRpc(page, []); await routeLcd(page, LCD1, []);
  await page.goto('/guestbook/');
  const out = await page.evaluate(() => ({
    deployer: window.GB.evmToInj('0x68D85663DaE6Aed5F102b7ec1f5551b890Ce1db3'),
    bad: window.GB.evmToInj('nonsense'),
  }));
  expect(out.deployer).toBe('inj1drv9vc76u6hdtugzklkp7423hzgvu8dn5uvvqf');   // cross-checked vs Python + test impl
  expect(out.bad).toBeNull();
});

test('tierOf boundaries are exact (BigInt, no float drift)', async ({ page }) => {
  await routeRpc(page, []); await routeLcd(page, LCD1, []);
  await page.goto('/guestbook/');
  const t = await page.evaluate(() => {
    const d = 10n ** 18n, k = (n) => { const r = window.GB.tierOf(n); return r ? r.key : null; };
    return { zero: k(0n), dust: k(1n), p: k(99999n*d), s: k(100000n*d), f: k(1000000n*d), dol: k(10000000n*d), w: k(100000000n*d) };
  });
  expect(t).toEqual({ zero: null, dust: 'plankton', p: 'plankton', s: 'shrimp', f: 'fish', dol: 'dolphin', w: 'whale' });
});

test('balanceOf hits by inj mapping and misses to 0n', async ({ page }) => {
  await routeRpc(page, []); await routeLcd(page, LCD1, []);
  await page.goto('/guestbook/');
  const r = await page.evaluate(() => {
    const inj = window.GB.evmToInj('0x1111111111111111111111111111111111111111');
    const m = new Map([[inj.toLowerCase(), 42n]]);
    return { hit: window.GB.balanceOf(m, '0x1111111111111111111111111111111111111111').toString(),
             miss: window.GB.balanceOf(m, '0x2222222222222222222222222222222222222222').toString() };
  });
  expect(r).toEqual({ hit: '42', miss: '0' });
});

test('fetchHolders follows pagination.next_key across pages', async ({ page }) => {
  await routeRpc(page, []); await routeLcd(page, LCD1, owners, { paginate: true });
  await page.goto('/guestbook/');
  const size = await page.evaluate(() => window.GB.fetchHolders().then(m => m.size));
  expect(size).toBe(2);   // both pages ingested
});

test('posts show whale / plankton / no badge by holder balance', async ({ page }) => {
  await routeRpc(page, [ makeLog(A, 0, 'gm', BASE+10), makeLog(B, 1, 'hi', BASE+11), makeLog(C, 2, 'yo', BASE+12) ]);
  await routeLcd(page, LCD1, owners);
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post')).toHaveCount(3);
  const badge = (addr) => page.locator(`#posts .post[data-addr="${addr}"] .post-tier`);
  await expect(badge(A)).toHaveText('🐋');
  await expect(badge(B)).toHaveText('🦠');
  await expect(badge(C)).toHaveText('');                       // non-holder: no badge
  await expect(badge(A)).toHaveAttribute('title', /300,000,000 \$HELIXPOINT/);
});

test('LCD fallback: primary down, secondary serves the badges', async ({ page }) => {
  await routeRpc(page, [ makeLog(A, 0, 'gm', BASE+10) ]);
  await routeLcd(page, LCD1, [], { fail: true });             // primary 500s
  await routeLcd(page, LCD2, owners);                          // fallback serves
  await page.goto('/guestbook/');
  await expect(page.locator(`#posts .post[data-addr="${A}"] .post-tier`)).toHaveText('🐋');
});

test('all LCD endpoints down: no badges, posts still render (fail-silent)', async ({ page }) => {
  await routeRpc(page, [ makeLog(A, 0, 'gm', BASE+10) ]);
  for (const h of LCD_HOSTS) await routeLcd(page, h, [], { fail: true });
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post')).toHaveCount(1);   // post renders
  await expect(page.locator(`#posts .post[data-addr="${A}"] .post-tier`)).toHaveText('');
});

test('badge survives a list re-render (annotate idempotency via load more)', async ({ page }) => {
  const logs = [];
  for (let i = 0; i < 12; i++) logs.push(makeLog(A, i, 'post #' + i, BASE + 10 + i));
  await routeRpc(page, logs);
  await routeLcd(page, LCD1, owners);
  await page.goto('/guestbook/');
  await expect(page.locator('#posts .post')).toHaveCount(10);
  await expect(page.locator(`#posts .post[data-addr="${A}"] .post-tier`).first()).toHaveText('🐋');
  await page.click('#loadmore');                               // triggers renderList() -> re-annotate
  await expect(page.locator('#posts .post')).toHaveCount(12);
  await expect(page.locator(`#posts .post[data-addr="${A}"] .post-tier`).last()).toHaveText('🐋');
});
