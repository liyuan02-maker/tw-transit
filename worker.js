// 台灣大眾運輸通 — Cloudflare Worker（保管金鑰、代查 TDX）
// 需要設定三個 Secret：TDX_ID、TDX_SECRET、GOOGLE_KEY
// 以及一個 KV 綁定：TOKEN_KV（存 TDX 登入憑證）

const ALLOW = ["https://liyuan02-maker.github.io", "http://localhost:8765"];
const TDX = "https://tdx.transportdata.tw/api/";

// 不同資料暫存多久（秒）
function ttlFor(path) {
  if (/Availability|EstimatedTimeOfArrival/.test(path)) return 30;
  if (/DailyTimetable|DailyTrainTimetable/.test(path)) return 600;
  return 86400; // 車站、站牌等
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOW.includes(origin) ? origin : ALLOW[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (obj, status, origin, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...cors(origin), ...extra } });

// TDX 登入憑證：存在記憶體 + KV（TOKEN_KV），一天只需要登入一次
let token = null, tokenExp = 0, inflight = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getToken(env, force) {
  if (token && Date.now() < tokenExp) return token;
  if (inflight) return inflight;            // 同時多個請求只登入一次
  inflight = (async () => {
    if (env.TOKEN_KV && !force) {
      const j = await env.TOKEN_KV.get("tdx", "json");
      if (j && j.exp > Date.now() + 60000) { token = j.t; tokenExp = j.exp; return token; }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch("https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.TDX_ID, client_secret: env.TDX_SECRET }),
      });
      if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`TDX 登入失敗 (${r.status})，請檢查 TDX 金鑰`);
      const j = await r.json();
      token = j.access_token;
      tokenExp = Date.now() + (j.expires_in - 600) * 1000;
      if (env.TOKEN_KV) await env.TOKEN_KV.put("tdx", JSON.stringify({ t: token, exp: tokenExp }), { expirationTtl: Math.max(60, j.expires_in - 600) });
      return token;
    }
    throw new Error("伺服器正在向 TDX 取得登入憑證，通常幾分鐘內會好，請稍後再試");
  })().finally(() => { inflight = null; });
  return inflight;
}

// 排程：每 5 分鐘檢查一次，憑證剩不到 6 小時就重新登入
async function refreshToken(env) {
  if (!env.TOKEN_KV) return "no KV";
  const j = await env.TOKEN_KV.get("tdx", "json");
  if (j && j.exp - Date.now() > 6 * 3600 * 1000) return "still valid";
  token = null; tokenExp = 0;
  try { await getToken(env, true); return "refreshed"; } catch (e) { return e.message; }
}

async function clearToken(env) {
  token = null; tokenExp = 0;
  if (env.TOKEN_KV) await env.TOKEN_KV.delete("tdx");
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshToken(env).then(r => console.log("token:", r)));
  },

  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(origin) });

    if (url.pathname === "/" || url.pathname === "/ping") return json({ ok: true, tdx: !!env.TDX_ID, google: !!env.GOOGLE_KEY, kv: !!env.TOKEN_KV,
      token: env.TOKEN_KV ? (await env.TOKEN_KV.get("tdx", "json")) ? "ready" : "waiting" : "no KV" }, 200, origin);

    // 只給自己的網站用
    if (origin && !ALLOW.includes(origin)) return json({ error: "not allowed" }, 403, origin);

    if (url.pathname === "/config") return json({ google: env.GOOGLE_KEY || "" }, 200, origin);

    if (url.pathname.startsWith("/tdx/")) {
      const path = url.pathname.slice(5);
      if (!/^(basic|advanced)\/v[23]\//.test(path)) return json({ error: "bad path" }, 400, origin);

      const cacheKey = new Request(url.toString(), { method: "GET" });
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        const r = new Response(cached.body, cached);
        for (const [k, v] of Object.entries(cors(origin))) r.headers.set(k, v);
        return r;
      }

      const q = url.search ? url.search + "&$format=JSON" : "?$format=JSON";
      let res;
      for (let attempt = 0; attempt < 2; attempt++) {
        let t;
        try { t = await getToken(env); } catch (e) { return json({ error: e.message }, 503, origin); }
        res = await fetch(TDX + path + q, { headers: { authorization: `Bearer ${t}` } });
        if (res.status === 401 && attempt === 0) { await clearToken(env); continue; }
        break;
      }
      if (res.status === 429) return json({ error: "TDX 呼叫太頻繁" }, 429, origin);
      if (!res.ok) return json({ error: `TDX 錯誤 ${res.status}` }, res.status, origin);

      const body = await res.text();
      const ttl = ttlFor(path);
      const out = new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${ttl}` } });
      ctx.waitUntil(caches.default.put(cacheKey, out.clone()));
      const r = new Response(body, out);
      for (const [k, v] of Object.entries(cors(origin))) r.headers.set(k, v);
      return r;
    }

    return json({ error: "not found" }, 404, origin);
  },
};
