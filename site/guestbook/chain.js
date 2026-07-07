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
  // topics defaults to posts+deletes so the message scan stays lean; tips are loaded separately (deferred).
  function getEvents(fromBlock, toBlock, topics) {
    topics = topics || [CONFIG.TOPIC_POST, CONFIG.TOPIC_DELETE];
    var chunks = [], f = fromBlock;
    while (f <= toBlock) { var t = Math.min(f + CONFIG.LOG_CHUNK, toBlock); chunks.push([f, t]); f = t + 1; }
    var out = [];
    return chunks.reduce(function (p, rng) {
      return p.then(function () {
        return rpc("eth_getLogs", [{
          address: CONFIG.CONTRACT,
          topics: [topics],
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

  // ---- tipping (USDC / USDT / INJ-via-wINJ; all ERC20; recorded on-chain via Tipped events) ----
  var TIP = {
    WINJ: "0x0000000088827d2d103ee2d9A6b781773AE03FfB",
    SEL_APPROVE: "0x095ea7b3", SEL_ALLOWANCE: "0xdd62ed3e", SEL_BALANCEOF: "0x70a08231",
    SEL_TIP: "0xfb279ef3", SEL_DEPOSIT: "0xd0e30db0",       // deposit() wraps native INJ -> wINJ
    TOPIC_TIPPED: "0xce094bbbb6144b00cddac7b300e0482127a8f4d3a1c16ff030afa0512b3059c5",
    TOKENS: [
      { symbol: "USDC", address: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a", decimals: 6,  presets: ["0.1", "0.5", "1", "5"] },
      { symbol: "USDT", address: "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13", decimals: 6,  presets: ["0.1", "0.5", "1", "5"] },
      { symbol: "INJ",  address: "0x0000000088827d2d103ee2d9A6b781773AE03FfB", decimals: 18, presets: ["0.01", "0.1", "1"], wrap: true } // token = wINJ
    ]
  };
  function tipTokenBySymbol(sym) { for (var i = 0; i < TIP.TOKENS.length; i++) if (TIP.TOKENS[i].symbol === sym) return TIP.TOKENS[i]; return null; }
  function tipTokenByAddr(addr) { var a = strip0x(String(addr)).toLowerCase(); for (var i = 0; i < TIP.TOKENS.length; i++) if (strip0x(TIP.TOKENS[i].address).toLowerCase() === a) return TIP.TOKENS[i]; return null; }

  function padAddr(a) { return strip0x(a).toLowerCase().padStart(64, "0"); }
  function padUint(v) { return BigInt(v).toString(16).padStart(64, "0"); }
  function encodeApprove(spender, amount) { return TIP.SEL_APPROVE + padAddr(spender) + padUint(amount); }
  function encodeTipCalldata(index, token, amount) { return TIP.SEL_TIP + padUint(index) + padAddr(token) + padUint(amount); }

  // human decimal string <-> raw BigInt (per token decimals)
  function toRaw(amountStr, decimals) {
    var s = String(amountStr == null ? "" : amountStr).trim();
    if (!s || !/^\d*\.?\d*$/.test(s)) return 0n;
    var p = s.split("."), whole = p[0] || "0", frac = (p[1] || "");
    frac = (frac + "0".repeat(decimals)).slice(0, decimals);
    return BigInt(whole || "0") * (10n ** BigInt(decimals)) + BigInt(frac || "0");
  }
  function fromRaw(raw, decimals) {
    raw = BigInt(raw); var base = 10n ** BigInt(decimals), whole = raw / base, frac = raw % base;
    if (frac === 0n) return whole.toString();
    var f = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    return whole.toString() + "." + f;
  }

  function erc20Read(sel, token, args) {
    return rpc("eth_call", [{ to: token, data: sel + args }, "latest"]).then(function (r) { return toBigInt(r || "0x0"); }).catch(function () { return 0n; });
  }
  function allowance(token, owner, spender) { return erc20Read(TIP.SEL_ALLOWANCE, token, padAddr(owner) + padAddr(spender)); }
  function erc20BalanceOf(token, owner) { return erc20Read(TIP.SEL_BALANCEOF, token, padAddr(owner)); }
  function nativeBalance(owner) { return rpc("eth_getBalance", [owner, "latest"]).then(function (r) { return toBigInt(r || "0x0"); }).catch(function () { return 0n; }); }

  // Tipped: topics [t0, index, from, token]; data = amount
  function decodeTipped(log) {
    return {
      index: toBigInt(log.topics[1]),
      from: "0x" + strip0x(log.topics[2]).slice(-40),
      token: "0x" + strip0x(log.topics[3]).slice(-40),
      amount: toBigInt(log.data),
      blockNumber: parseInt(log.blockNumber, 16)
    };
  }

  // writes
  function sendApprove(provider, from, token, amount) {
    return provider.request({ method: "eth_sendTransaction", params: [{ from: from, to: token, data: encodeApprove(CONFIG.CONTRACT, amount) }] });
  }
  function sendTip(provider, from, index, token, amount) {
    return provider.request({ method: "eth_sendTransaction", params: [{ from: from, to: CONFIG.CONTRACT, data: encodeTipCalldata(index, token, amount) }] });
  }
  function sendWrap(provider, from, amount) { // deposit native INJ -> wINJ
    return provider.request({ method: "eth_sendTransaction", params: [{ from: from, to: TIP.WINJ, value: "0x" + BigInt(amount).toString(16), data: TIP.SEL_DEPOSIT }] });
  }

  // ---- state reads via eth_call (replaces scanning the whole event history) ----
  var SEL_COUNT = "0x06661abd", SEL_POSTSBLOB = "0xef48eaa4", SEL_GETTIPS = "0x34472457";
  function ethCall(data) { return rpc("eth_call", [{ to: CONFIG.CONTRACT, data: data }, "latest"]); }
  function count() { return ethCall(SEL_COUNT).then(function (r) { return parseInt(r, 16) || 0; }); }

  // getPostsBlob(offset,limit) -> packed bytes: per post index(32) author(32) ts(32) deleted(32) msgLen(32) msg(msgLen)
  function getPosts(offset, limit) { return ethCall(SEL_POSTSBLOB + padUint(offset) + padUint(limit)).then(decodePostsBlob); }
  function decodePostsBlob(hexret) {
    var h = strip0x(hexret || "");
    if (h.length < 128) return [];
    var len = parseInt(h.slice(64, 128), 16);            // returns (bytes): [dataOffset][len][data]
    var d = h.slice(128, 128 + len * 2), out = [], p = 0;
    while (p + 320 <= d.length) {                          // 160-byte fixed header = 320 hex
      var index = toBigInt("0x" + d.slice(p, p + 64)); p += 64;
      var author = "0x" + d.slice(p + 24, p + 64); p += 64; // low 20 bytes of the word
      var ts = parseInt(d.slice(p, p + 64), 16); p += 64;
      var del = parseInt(d.slice(p, p + 64), 16) === 1; p += 64;
      var mlen = parseInt(d.slice(p, p + 64), 16); p += 64;
      out.push({ index: index, author: author, timestamp: ts, deleted: del, message: hexToUtf8(d.slice(p, p + mlen * 2)) });
      p += mlen * 2;
    }
    return out;
  }

  // getTips(uint256[] indices, address[] tokens) -> flat uint256[] row-major (index-major, token-minor)
  function encodeGetTipsCall(indices, tokens) {
    var offTok = 0x40 + 32 + indices.length * 32;         // after [offIdx][offTok][idxLen][...idx]
    return SEL_GETTIPS + padUint(0x40) + padUint(offTok)
      + padUint(indices.length) + indices.map(function (i) { return padUint(i); }).join("")
      + padUint(tokens.length) + tokens.map(function (t) { return padAddr(t); }).join("");
  }
  function getTips(indices, tokens) { return ethCall(encodeGetTipsCall(indices, tokens)).then(decodeUintArray); }
  function decodeUintArray(hexret) {
    var h = strip0x(hexret || "");
    if (h.length < 128) return [];
    var len = parseInt(h.slice(64, 128), 16), out = [];   // [offset][len][elements]
    for (var i = 0; i < len; i++) out.push(toBigInt("0x" + h.slice(128 + i * 64, 192 + i * 64)));
    return out;
  }

  window.GB = {
    CONFIG: CONFIG,
    encodePostCalldata: encodePostCalldata, encodeDeleteCalldata: encodeDeleteCalldata,
    decodePostCreated: decodePostCreated, decodePostDeleted: decodePostDeleted,
    rpc: rpc, blockNumber: blockNumber, getEvents: getEvents, blockTime: blockTime, isAdmin: isAdmin,
    sendPost: sendPost, sendDelete: sendDelete,
    TOKEN: TOKEN, bech32Encode: bech32Encode, evmToInj: evmToInj,
    fetchHolders: fetchHolders, balanceOf: balanceOf, tierOf: tierOf,
    TIP: TIP, tipTokenBySymbol: tipTokenBySymbol, tipTokenByAddr: tipTokenByAddr,
    encodeApprove: encodeApprove, encodeTipCalldata: encodeTipCalldata,
    decodeTipped: decodeTipped, allowance: allowance, erc20BalanceOf: erc20BalanceOf, nativeBalance: nativeBalance,
    sendApprove: sendApprove, sendTip: sendTip, sendWrap: sendWrap, toRaw: toRaw, fromRaw: fromRaw,
    count: count, getPosts: getPosts, getTips: getTips,
    decodePostsBlob: decodePostsBlob, decodeUintArray: decodeUintArray, encodeGetTipsCall: encodeGetTipsCall
  };
})();
