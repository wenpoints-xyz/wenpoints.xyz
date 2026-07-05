/* chain.js — zero-dependency Injective EVM helpers for the $HELIXPOINT Guestbook.
   Reads posts from PostCreated event logs; writes via eth_sendTransaction.
   Exposed as window.GB. No libraries — hand-rolled ABI for one string arg + one event. */
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
    CONTRACT: "0x2b81Aa221c93FE2dd4f21EA992316B102b090674",
    DEPLOY_BLOCK: 132601081,
    POST_SELECTOR: "0x8ee93cf3", // keccak256("post(string)")[:4]
    TOPIC_POSTCREATED: "0x12a6d6e360de92ee96444e397580fa39ca65f27c25bd78a4bad6278011334fac", // keccak256("PostCreated(address,uint256,string)")
    LOG_CHUNK: 9000 // stay under public-RPC eth_getLogs range caps
  };

  // ---- hex / utf8 helpers ----
  function strip0x(h) { return h.indexOf("0x") === 0 ? h.slice(2) : h; }
  function pad32(hexNo0x) { while (hexNo0x.length % 64 !== 0) hexNo0x += "0"; return hexNo0x; }
  function utf8Bytes(s) { return new TextEncoder().encode(s); }
  function bytesToHex(b) { var o = ""; for (var i = 0; i < b.length; i++) o += b[i].toString(16).padStart(2, "0"); return o; }
  function hexToBytes(h) { h = strip0x(h); var b = new Uint8Array(h.length / 2); for (var i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }
  function hexToUtf8(h) { return new TextDecoder().decode(hexToBytes(h)); }
  function toBigInt(hex) { return BigInt(hex.indexOf("0x") === 0 ? hex : "0x" + hex); }

  // ---- encode post(string) calldata: selector + [offset 0x20][len][utf8 bytes padded] ----
  function encodePostCalldata(message) {
    var bytes = utf8Bytes(message);
    var offset = (32).toString(16).padStart(64, "0");
    var len = bytes.length.toString(16).padStart(64, "0");
    var data = pad32(bytesToHex(bytes));
    return CONFIG.POST_SELECTOR + offset + len + data;
  }

  // ---- decode a PostCreated log -> { author, index, message, blockNumber } ----
  // topics: [topic0, author(32B), index(32B)]; data = abi.encode(string) = [offset][len][bytes]
  function decodePostCreated(log) {
    var author = "0x" + strip0x(log.topics[1]).slice(-40);
    var index = toBigInt(log.topics[2]);
    var d = strip0x(log.data);
    var len = parseInt(d.slice(64, 128), 16);               // second word = string length
    var msgHex = d.slice(128, 128 + len * 2);               // then the utf8 bytes
    return { author: author, index: index, message: hexToUtf8(msgHex), blockNumber: parseInt(log.blockNumber, 16) };
  }

  // ---- raw JSON-RPC over HTTP (reads; no wallet needed) ----
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

  // eth_getLogs for PostCreated across [from,to], chunked to respect range caps
  function getPostLogs(fromBlock, toBlock) {
    var chunks = [], f = fromBlock;
    while (f <= toBlock) { var t = Math.min(f + CONFIG.LOG_CHUNK, toBlock); chunks.push([f, t]); f = t + 1; }
    var out = [];
    return chunks.reduce(function (p, rng) {
      return p.then(function () {
        return rpc("eth_getLogs", [{
          address: CONFIG.CONTRACT,
          topics: [CONFIG.TOPIC_POSTCREATED],
          fromBlock: "0x" + rng[0].toString(16),
          toBlock: "0x" + rng[1].toString(16)
        }]).then(function (logs) { out = out.concat(logs); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  // block timestamp cache (event has no timestamp; read it from the block)
  var _blockTs = {};
  function blockTime(bn) {
    if (_blockTs[bn]) return Promise.resolve(_blockTs[bn]);
    return rpc("eth_getBlockByNumber", ["0x" + bn.toString(16), false]).then(function (b) {
      var ts = b && b.timestamp ? parseInt(b.timestamp, 16) * 1000 : Date.now();
      _blockTs[bn] = ts; return ts;
    });
  }

  // send a post via the connected wallet; returns tx hash
  function sendPost(provider, from, message) {
    return provider.request({ method: "eth_sendTransaction", params: [{ from: from, to: CONFIG.CONTRACT, data: encodePostCalldata(message) }] });
  }
  // poll a tx receipt until mined (or timeout ms)
  function waitReceipt(hash, timeoutMs) {
    var start = Date.now();
    return new Promise(function (resolve, reject) {
      (function tick() {
        rpc("eth_getTransactionReceipt", [hash]).then(function (r) {
          if (r) return resolve(r);
          if (Date.now() - start > (timeoutMs || 90000)) return reject(new Error("timeout"));
          setTimeout(tick, 2500);
        }).catch(function () { setTimeout(tick, 2500); });
      })();
    });
  }

  window.GB = {
    CONFIG: CONFIG, encodePostCalldata: encodePostCalldata, decodePostCreated: decodePostCreated,
    rpc: rpc, blockNumber: blockNumber, getPostLogs: getPostLogs, blockTime: blockTime,
    sendPost: sendPost, waitReceipt: waitReceipt
  };
})();
