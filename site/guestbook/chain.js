/* chain.js — zero-dependency Injective EVM helpers for the $HELIXPOINT Guestbook (upgradeable, UUPS).
   Reads posts from PostCreated/PostDeleted events; writes post/deletePost via eth_sendTransaction.
   Exposed as window.GB. No libraries — hand-rolled ABI for the few shapes used here. */
(function () {
  "use strict";

  // ---- config: flip CHAIN + CONTRACT + DEPLOY_BLOCK for testnet <-> mainnet ----
  var CONFIG = {
    CHAIN: {
      idHex: "0x6f0", id: 1776, name: "Injective",
      rpc: "https://sentry.evm-rpc.injective.network/",
      explorer: "https://blockscout.injective.network",
      nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 }
    },
    CONTRACT: "0xc71D862cD4E6b35F6aA29Fd908c27d1c4b2406EA", // UUPS proxy (mainnet)
    DEPLOY_BLOCK: 172959998,
    SEL_POST: "0x8ee93cf3",         // post(string)
    SEL_DELETE: "0x094cd5ee",       // deletePost(uint256)
    SEL_ISADMIN: "0x24d7806c",      // isAdmin(address)
    TOPIC_POST: "0x12a6d6e360de92ee96444e397580fa39ca65f27c25bd78a4bad6278011334fac",   // PostCreated(address,uint256,string)
    TOPIC_DELETE: "0x1da4a15b15417b54b8b3bea2ca87cfc4c94f0fee7d86702d0dab9e2906e7a7d3",  // PostDeleted(uint256,address)
    LOG_CHUNK: 9000
  };

  // ---- $HELIXPOINT holder-badge config (Cosmos bank side, via LCD) ----
  // Guestbook posters are EVM 0x addresses; the token balance lives on the Cosmos bank
  // module keyed by the inj1 address = bech32("inj", same 20 account bytes).
  var TOKEN = {
    DENOM: "factory/inj13j2rpnlwl30c02d4pzukykwfeyyhelvry9cqte/shroom_8_be9bddf36b94db69",
    DECIMALS: 18,                       // denoms_metadata is Not Implemented on Injective LCD;
                                        // supply is exactly 1e9 with 18dp -> hard-coded with evidence.
    LCD: [                              // tried in order; first success wins, all-fail -> no badges
      "https://sentry.lcd.injective.network",
      "https://lcd.injective.network",
      "https://injective-api.polkachu.com"
    ],
    // descending; tierOf returns the first tier whose min (in whole tokens) is met. any dust >0 -> plankton.
    TIERS: [
      { key: "whale",    min: 100000000n, icon: "🐋", label: "whale" },
      { key: "dolphin",  min: 10000000n,  icon: "🐬", label: "dolphin" },
      { key: "fish",     min: 1000000n,   icon: "🐟", label: "fish" },
      { key: "shrimp",   min: 100000n,    icon: "🦐", label: "shrimp" },
      { key: "plankton", min: 1n,         icon: "🦠", label: "plankton" }
    ]
  };

  // ---- hex / utf8 helpers ----
  function strip0x(h) { return h.indexOf("0x") === 0 ? h.slice(2) : h; }
  function pad32(hexNo0x) { while (hexNo0x.length % 64 !== 0) hexNo0x += "0"; return hexNo0x; }
  function utf8Bytes(s) { return new TextEncoder().encode(s); }
  function bytesToHex(b) { var o = ""; for (var i = 0; i < b.length; i++) o += b[i].toString(16).padStart(2, "0"); return o; }
  function hexToBytes(h) { h = strip0x(h); var b = new Uint8Array(h.length / 2); for (var i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }
  function hexToUtf8(h) { return new TextDecoder().decode(hexToBytes(h)); }
  function toBigInt(hex) { return BigInt(hex.indexOf("0x") === 0 ? hex : "0x" + hex); }

  // ---- calldata encoders ----
  function encodePostCalldata(message) {
    var bytes = utf8Bytes(message);
    var offset = (32).toString(16).padStart(64, "0");
    var len = bytes.length.toString(16).padStart(64, "0");
    return CONFIG.SEL_POST + offset + len + pad32(bytesToHex(bytes));
  }
  function encodeDeleteCalldata(index) {
    return CONFIG.SEL_DELETE + BigInt(index).toString(16).padStart(64, "0");
  }

  // ---- event decoders ----
  // PostCreated: topics [t0, author, index]; data = abi.encode(string)
  function decodePostCreated(log) {
    var d = strip0x(log.data);
    var len = parseInt(d.slice(64, 128), 16);
    return {
      author: "0x" + strip0x(log.topics[1]).slice(-40),
      index: toBigInt(log.topics[2]),
      message: hexToUtf8(d.slice(128, 128 + len * 2)),
      blockNumber: parseInt(log.blockNumber, 16)
    };
  }
  // PostDeleted: topics [t0, index, by]
  function decodePostDeleted(log) { return { index: toBigInt(log.topics[1]) }; }

  // ---- JSON-RPC over HTTP (reads) ----
  var _id = 0;
  function rpc(method, params) {
    return fetch(CONFIG.CHAIN.rpc, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++_id, method: method, params: params || [] })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    });
  }
  function blockNumber() { return rpc("eth_blockNumber", []).then(function (h) { return parseInt(h, 16); }); }

  // fetch both PostCreated + PostDeleted logs across [from,to], chunked
  function getEvents(fromBlock, toBlock) {
    var chunks = [], f = fromBlock;
    while (f <= toBlock) { var t = Math.min(f + CONFIG.LOG_CHUNK, toBlock); chunks.push([f, t]); f = t + 1; }
    var out = [];
    return chunks.reduce(function (p, rng) {
      return p.then(function () {
        return rpc("eth_getLogs", [{
          address: CONFIG.CONTRACT,
          topics: [[CONFIG.TOPIC_POST, CONFIG.TOPIC_DELETE]],
          fromBlock: "0x" + rng[0].toString(16), toBlock: "0x" + rng[1].toString(16)
        }]).then(function (logs) { out = out.concat(logs); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  var _blockTs = {};
  function blockTime(bn) {
    if (_blockTs[bn]) return Promise.resolve(_blockTs[bn]);
    return rpc("eth_getBlockByNumber", ["0x" + bn.toString(16), false]).then(function (b) {
      var ts = b && b.timestamp ? parseInt(b.timestamp, 16) * 1000 : Date.now();
      _blockTs[bn] = ts; return ts;
    });
  }

  // is `addr` an admin? (eth_call isAdmin(address))
  function isAdmin(addr) {
    var data = CONFIG.SEL_ISADMIN + strip0x(addr).toLowerCase().padStart(64, "0");
    return rpc("eth_call", [{ to: CONFIG.CONTRACT, data: data }, "latest"]).then(function (res) {
      return toBigInt(res || "0x0") === 1n;
    }).catch(function () { return false; });
  }

  // writes via the connected wallet
  function sendPost(provider, from, message) {
    return provider.request({ method: "eth_sendTransaction", params: [{ from: from, to: CONFIG.CONTRACT, data: encodePostCalldata(message) }] });
  }
  function sendDelete(provider, from, index) {
    return provider.request({ method: "eth_sendTransaction", params: [{ from: from, to: CONFIG.CONTRACT, data: encodeDeleteCalldata(index) }] });
  }

  // ---- bech32 (BIP173) encode: 0x EVM address -> inj1 Cosmos address ----
  var B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  function b32Polymod(vals) {
    var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3], chk = 1;
    for (var p = 0; p < vals.length; p++) {
      var top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ vals[p];
      for (var i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
    }
    return chk >>> 0;
  }
  function b32HrpExpand(hrp) {
    var o = [], i;
    for (i = 0; i < hrp.length; i++) o.push(hrp.charCodeAt(i) >>> 5);
    o.push(0);
    for (i = 0; i < hrp.length; i++) o.push(hrp.charCodeAt(i) & 31);
    return o;
  }
  function b32Checksum(hrp, data) {
    var mod = b32Polymod(b32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0])) ^ 1, o = [];
    for (var i = 0; i < 6; i++) o.push((mod >>> (5 * (5 - i))) & 31);
    return o;
  }
  function bits8to5(bytes) {
    var acc = 0, bits = 0, o = [];
    for (var i = 0; i < bytes.length; i++) {
      acc = (acc << 8) | bytes[i]; bits += 8;   // 20-byte input -> acc stays well within 32-bit
      while (bits >= 5) { bits -= 5; o.push((acc >>> bits) & 31); }
    }
    if (bits > 0) o.push((acc << (5 - bits)) & 31);
    return o;
  }
  function bech32Encode(hrp, bytes) {
    var data = bits8to5(bytes), comb = data.concat(b32Checksum(hrp, data)), s = hrp + "1";
    for (var i = 0; i < comb.length; i++) s += B32.charAt(comb[i]);
    return s;
  }
  function evmToInj(addr) {
    var h = strip0x(String(addr || "")).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(h)) return null;
    return bech32Encode("inj", hexToBytes(h));
  }

  // ---- LCD (Cosmos REST gateway) with endpoint fallback ----
  function lcd(path) {
    var hosts = TOKEN.LCD, i = 0;
    function tryNext() {
      if (i >= hosts.length) return Promise.reject(new Error("all LCD endpoints failed"));
      return fetch(hosts[i++] + path, { headers: { "Accept": "application/json" } })
        .then(function (r) { if (!r.ok) throw new Error("lcd " + r.status); return r.json(); })
        .catch(function () { return tryNext(); });
    }
    return tryNext();
  }

  // ---- holder map: one paginated denom_owners_by_query, cached per page load ----
  // Query-param form (…_by_query?denom=) handles the slash-bearing factory denom; the path form rejects it.
  var _holders = null;                 // Map(inj1(lowercase) -> BigInt raw)
  function fetchHolders() {
    if (_holders) return Promise.resolve(_holders);
    var denom = encodeURIComponent(TOKEN.DENOM), map = new Map(), pages = 0, MAX = 25;
    function page(key) {
      var path = "/cosmos/bank/v1beta1/denom_owners_by_query?denom=" + denom + "&pagination.limit=1000";
      if (key) path += "&pagination.key=" + encodeURIComponent(key);
      return lcd(path).then(function (j) {
        var owners = (j && j.denom_owners) || [];
        for (var k = 0; k < owners.length; k++) {
          var o = owners[k];
          if (o && o.address && o.balance && o.balance.amount) map.set(o.address.toLowerCase(), toBig(o.balance.amount));
        }
        var next = j && j.pagination && j.pagination.next_key;
        return (next && ++pages < MAX) ? page(next) : map;
      });
    }
    return page(null).then(function (m) { _holders = m; return m; })
      .catch(function () { _holders = new Map(); return _holders; });   // fail-silent: no badges, posts unaffected
  }
  function toBig(s) { try { return BigInt(s); } catch (e) { return 0n; } }

  function balanceOf(map, addr) {
    if (!map) return 0n;
    var inj = evmToInj(addr);
    if (!inj) return 0n;
    return map.get(inj.toLowerCase()) || 0n;
  }
  function tierOf(raw) {
    if (!raw || raw <= 0n) return null;
    var whole = raw / (10n ** BigInt(TOKEN.DECIMALS)), T = TOKEN.TIERS;
    for (var i = 0; i < T.length; i++) {
      if (whole >= T[i].min) return { key: T[i].key, icon: T[i].icon, label: T[i].label, whole: whole };
    }
    var p = T[T.length - 1];                          // dust (>0 but <1 whole token) still shows plankton
    return { key: p.key, icon: p.icon, label: p.label, whole: whole };
  }

  window.GB = {
    CONFIG: CONFIG,
    encodePostCalldata: encodePostCalldata, encodeDeleteCalldata: encodeDeleteCalldata,
    decodePostCreated: decodePostCreated, decodePostDeleted: decodePostDeleted,
    rpc: rpc, blockNumber: blockNumber, getEvents: getEvents, blockTime: blockTime, isAdmin: isAdmin,
    sendPost: sendPost, sendDelete: sendDelete,
    TOKEN: TOKEN, bech32Encode: bech32Encode, evmToInj: evmToInj,
    fetchHolders: fetchHolders, balanceOf: balanceOf, tierOf: tierOf
  };
})();
