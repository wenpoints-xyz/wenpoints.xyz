/* chain.js — zero-dependency Injective EVM helpers for the $HELIXPOINT Guestbook (upgradeable, UUPS).
   Reads posts from PostCreated/PostDeleted events; writes post/deletePost via eth_sendTransaction.
   Exposed as window.GB. No libraries — hand-rolled ABI for the few shapes used here. */
(function () {
  "use strict";

  // ---- config: flip CHAIN + CONTRACT + DEPLOY_BLOCK for testnet <-> mainnet ----
  var CONFIG = {
    CHAIN: {
      idHex: "0x59f", id: 1439, name: "Injective EVM Testnet",
      rpc: "https://k8s.testnet.json-rpc.injective.network/",
      explorer: "https://testnet.blockscout.injective.network",
      nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 }
    },
    CONTRACT: "0xEA9A00Fc317781E272165D323C65a9B654c4284c", // UUPS proxy
    DEPLOY_BLOCK: 132603458,
    SEL_POST: "0x8ee93cf3",         // post(string)
    SEL_DELETE: "0x094cd5ee",       // deletePost(uint256)
    SEL_ISADMIN: "0x24d7806c",      // isAdmin(address)
    TOPIC_POST: "0x12a6d6e360de92ee96444e397580fa39ca65f27c25bd78a4bad6278011334fac",   // PostCreated(address,uint256,string)
    TOPIC_DELETE: "0x1da4a15b15417b54b8b3bea2ca87cfc4c94f0fee7d86702d0dab9e2906e7a7d3",  // PostDeleted(uint256,address)
    LOG_CHUNK: 9000
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

  window.GB = {
    CONFIG: CONFIG,
    encodePostCalldata: encodePostCalldata, encodeDeleteCalldata: encodeDeleteCalldata,
    decodePostCreated: decodePostCreated, decodePostDeleted: decodePostDeleted,
    rpc: rpc, blockNumber: blockNumber, getEvents: getEvents, blockTime: blockTime, isAdmin: isAdmin,
    sendPost: sendPost, sendDelete: sendDelete
  };
})();
