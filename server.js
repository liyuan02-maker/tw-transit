// 台灣大眾運輸通 — 伺服器
// Node.js 18 以上，不需安裝任何套件：  node server.js
// 金鑰放在 .env（參考 .env.example），絕不會傳到瀏覽器（Google 瀏覽器金鑰除外）。

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------- 讀取 .env ----------
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (_) {}

const {
  TDX_CLIENT_ID, TDX_CLIENT_SECRET,
  GOOGLE_SERVER_KEY, GOOGLE_BROWSER_KEY,
  PORT = 3000,
} = process.env;

const TDX = "https://tdx.transportdata.tw/api";

// ---------- 小工具 ----------
const cache = new Map();
async function cached(key, ttlSec, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + ttlSec * 1000 });
  return val;
}

function distM(aLat, aLon, bLat, bLon) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const walkMin = m => Math.max(1, Math.round(m / 75)); // 每分鐘約 75 公尺

// 台北時間的日期與「幾點幾分」
function taipeiNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const hh = p.hour === "24" ? 0 : +p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: hh * 60 + +p.minute };
}
const hmToMin = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

// ---------- TDX ----------
let tdxToken = null, tdxTokenExp = 0;
async function getTdxToken() {
  if (tdxToken && Date.now() < tdxTokenExp) return tdxToken;
  if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) throw new Error("尚未設定 TDX_CLIENT_ID / TDX_CLIENT_SECRET");
  const res = await fetch("https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials", client_id: TDX_CLIENT_ID, client_secret: TDX_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`TDX 登入失敗 (${res.status})`);
  const j = await res.json();
  tdxToken = j.access_token;
  tdxTokenExp = Date.now() + (j.expires_in - 300) * 1000;
  return tdxToken;
}

async function tdx(pathAndQuery) {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const url = `${TDX}${pathAndQuery}${sep}$format=JSON`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${await getTdxToken()}`, "accept-encoding": "gzip" },
    });
    if (res.status === 401 && attempt === 0) { tdxToken = null; continue; }
    if (res.status === 429) throw new Error("TDX 呼叫太頻繁，請稍後再試");
    if (!res.ok) throw new Error(`TDX 錯誤 ${res.status}：${pathAndQuery.split("?")[0]}`);
    return res.json();
  }
}
const near = (lat, lon, r) => `$spatialFilter=nearby(${lat},${lon},${r})`;

// ---------- YouBike ----------
async function bikeNearby(lat, lon) {
  const key = `bike:${lat.toFixed(3)},${lon.toFixed(3)}`;
  return cached(key, 30, async () => {
    const [stations, avail] = await Promise.all([
      cached(`bikeSt:${lat.toFixed(3)},${lon.toFixed(3)}`, 3600,
        () => tdx(`/advanced/v2/Bike/Station/NearBy?${near(lat, lon, 600)}`)),
      tdx(`/advanced/v2/Bike/Availability/NearBy?${near(lat, lon, 600)}`),
    ]);
    const byId = new Map(avail.map(a => [a.StationUID, a]));
    return stations.map(s => {
      const a = byId.get(s.StationUID) || {};
      const sLat = s.StationPosition.PositionLat, sLon = s.StationPosition.PositionLon;
      const d = distM(lat, lon, sLat, sLon);
      return {
        id: s.StationUID,
        name: (s.StationName?.Zh_tw || "").replace(/^YouBike2\.0_|^YouBike1\.0_/, ""),
        lat: sLat, lon: sLon,
        bikes: a.AvailableRentBikes ?? null,
        docks: a.AvailableReturnBikes ?? null,
        service: a.ServiceStatus ?? 1,
        dist: Math.round(d), walk: walkMin(d),
      };
    }).sort((x, y) => x.dist - y.dist).slice(0, 20);
  });
}

// ---------- 公車：附近站牌 + 到站時間 ----------
const CITY = {
  TPE: "Taipei", NWT: "NewTaipei", TAO: "Taoyuan", TXG: "Taichung", TNN: "Tainan", KHH: "Kaohsiung",
  KEE: "Keelung", HSZ: "Hsinchu", HSQ: "HsinchuCounty", MIA: "MiaoliCounty", CHA: "ChanghuaCounty",
  NAN: "NantouCounty", YUN: "YunlinCounty", CYQ: "ChiayiCounty", CYI: "Chiayi", PIF: "PingtungCounty",
  ILA: "YilanCounty", HUA: "HualienCounty", TTT: "TaitungCounty", KIN: "KinmenCounty",
  PEN: "PenghuCounty", LIE: "LienchiangCounty",
};

async function busNearby(lat, lon) {
  const key = `bus:${lat.toFixed(3)},${lon.toFixed(3)}`;
  return cached(key, 20, async () => {
    const stops = await cached(`busSt:${lat.toFixed(3)},${lon.toFixed(3)}`, 3600,
      () => tdx(`/advanced/v2/Bus/Stop/NearBy?${near(lat, lon, 400)}&$top=40`));

    // 以站名分組，取最近的 3 個站牌
    const groups = new Map();
    for (const s of stops) {
      const name = s.StopName?.Zh_tw || "";
      const d = distM(lat, lon, s.StopPosition.PositionLat, s.StopPosition.PositionLon);
      const g = groups.get(name) || { name, dist: Infinity, uids: [], lat: 0, lon: 0 };
      g.uids.push(s.StopUID);
      if (d < g.dist) Object.assign(g, { dist: d, lat: s.StopPosition.PositionLat, lon: s.StopPosition.PositionLon });
      groups.set(name, g);
    }
    const nearest = [...groups.values()].sort((a, b) => a.dist - b.dist).slice(0, 3);

    // 依縣市（或公路客運 THB）查到站時間
    const byCity = new Map();
    for (const g of nearest) for (const uid of g.uids) {
      const pre = uid.slice(0, 3);
      const k = pre === "THB" ? "InterCity" : CITY[pre];
      if (!k) continue;
      if (!byCity.has(k)) byCity.set(k, []);
      byCity.get(k).push(uid);
    }
    const etas = [];
    await Promise.all([...byCity].map(async ([city, uids]) => {
      const filter = encodeURIComponent(uids.map(u => `StopUID eq '${u}'`).join(" or "));
      const p = city === "InterCity"
        ? `/basic/v2/Bus/EstimatedTimeOfArrival/InterCity?$filter=${filter}`
        : `/basic/v2/Bus/EstimatedTimeOfArrival/City/${city}?$filter=${filter}`;
      try { etas.push(...await tdx(p)); } catch (e) { console.warn(e.message); }
    }));

    const STATUS = { 1: "尚未發車", 2: "交管不停靠", 3: "末班車已過", 4: "今日未營運" };
    return nearest.map(g => {
      const rows = etas.filter(e => g.uids.includes(e.StopUID)).map(e => ({
        route: e.RouteName?.Zh_tw || "",
        dir: e.Direction,
        min: e.EstimateTime != null ? Math.round(e.EstimateTime / 60) : null,
        status: e.EstimateTime != null ? null : (STATUS[e.StopStatus] || "無資料"),
      }));
      // 同一路線同方向只留一筆
      const uniq = new Map();
      for (const r of rows) {
        const k = r.route + "|" + r.dir;
        const old = uniq.get(k);
        if (!old || (r.min != null && (old.min == null || r.min < old.min))) uniq.set(k, r);
      }
      return {
        name: g.name, lat: g.lat, lon: g.lon,
        dist: Math.round(g.dist), walk: walkMin(g.dist),
        arrivals: [...uniq.values()].sort((a, b) => (a.min ?? 999) - (b.min ?? 999)),
      };
    });
  });
}

// ---------- 台鐵 / 高鐵：最近車站 + 接下來三班 ----------
async function traStations() {
  return cached("traSt", 86400, async () => {
    const j = await tdx("/basic/v3/Rail/TRA/Station");
    return (j.Stations || j).map(s => ({
      id: s.StationID, name: s.StationName.Zh_tw,
      lat: s.StationPosition.PositionLat, lon: s.StationPosition.PositionLon,
    }));
  });
}
async function thsrStations() {
  return cached("thsrSt", 86400, async () => {
    const j = await tdx("/basic/v2/Rail/THSR/Station");
    return j.map(s => ({
      id: s.StationID, name: s.StationName.Zh_tw,
      lat: s.StationPosition.PositionLat, lon: s.StationPosition.PositionLon,
    }));
  });
}
function nearestStation(list, lat, lon) {
  let best = null;
  for (const s of list) {
    const d = distM(lat, lon, s.lat, s.lon);
    if (!best || d < best.dist) best = { ...s, dist: Math.round(d) };
  }
  return best;
}

async function railNext3(kind, o, d) {
  const { date, minutes } = taipeiNow();
  const after = minutes + Math.min(walkMin(o.dist), 30); // 預留走到車站的時間（最多 30 分）
  if (kind === "tra") {
    const j = await cached(`traOD:${o.id}:${d.id}:${date}`, 600,
      () => tdx(`/basic/v3/Rail/TRA/DailyTrainTimetable/OD/${o.id}/to/${d.id}/${date}`));
    return (j.TrainTimetables || []).map(t => {
      const st = t.StopTimes || [];
      const a = st.find(x => x.StationID === o.id), b = st.find(x => x.StationID === d.id);
      return a && b ? {
        no: t.TrainInfo.TrainNo,
        type: (t.TrainInfo.TrainTypeName?.Zh_tw || "").replace(/\(.*\)/, ""),
        dep: a.DepartureTime.slice(0, 5), arr: b.ArrivalTime.slice(0, 5),
      } : null;
    }).filter(x => x && hmToMin(x.dep) >= after)
      .sort((x, y) => hmToMin(x.dep) - hmToMin(y.dep)).slice(0, 3);
  } else {
    const j = await cached(`thsrOD:${o.id}:${d.id}:${date}`, 600,
      () => tdx(`/basic/v2/Rail/THSR/DailyTimetable/OD/${o.id}/to/${d.id}/${date}`));
    return j.map(t => ({
      no: t.DailyTrainInfo.TrainNo, type: "高鐵",
      dep: t.OriginStopTime.DepartureTime.slice(0, 5),
      arr: t.DestinationStopTime.ArrivalTime.slice(0, 5),
    })).filter(x => hmToMin(x.dep) >= after)
      .sort((x, y) => hmToMin(x.dep) - hmToMin(y.dep)).slice(0, 3);
  }
}

async function railPlan(kind, from, to) {
  const list = kind === "tra" ? await traStations() : await thsrStations();
  const o = nearestStation(list, from.lat, from.lon);
  const d = nearestStation(list, to.lat, to.lon);
  const limit = kind === "tra" ? 8000 : 25000; // 離車站太遠就不建議
  if (!o || !d) return { note: "找不到車站資料" };
  if (o.id === d.id) return { note: "起訖最近的是同一站，不需要搭乘" };
  if (o.dist > limit || d.dist > limit) return { note: `起點或目的地離${kind === "tra" ? "台鐵" : "高鐵"}站太遠`, from: o, to: d };
  return { from: o, to: d, trains: await railNext3(kind, o, d) };
}

// ---------- Google：地址轉座標、Routes API 大眾運輸 ----------
async function geocode(address) {
  return cached(`geo:${address}`, 86400, async () => {
    const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    u.search = new URLSearchParams({ address, key: GOOGLE_SERVER_KEY, language: "zh-TW", region: "tw" });
    const j = await (await fetch(u)).json();
    if (j.status !== "OK") throw new Error(`找不到「${address}」(${j.status})`);
    const r = j.results[0];
    return { lat: r.geometry.location.lat, lon: r.geometry.location.lng, name: r.formatted_address };
  });
}

const FIELD_MASK = [
  "routes.duration", "routes.polyline.encodedPolyline",
  "routes.legs.steps.travelMode", "routes.legs.steps.staticDuration",
  "routes.legs.steps.distanceMeters", "routes.legs.steps.transitDetails",
].join(",");

async function computeTransit(from, to, modes, departureTime) {
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": GOOGLE_SERVER_KEY,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: from.lat, longitude: from.lon } } },
      destination: { location: { latLng: { latitude: to.lat, longitude: to.lon } } },
      travelMode: "TRANSIT",
      computeAlternativeRoutes: true,
      departureTime: departureTime.toISOString(),
      languageCode: "zh-TW", regionCode: "TW",
      transitPreferences: { allowedTravelModes: modes },
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message || `Routes API 錯誤 ${res.status}`);
  return j.routes || [];
}

const secs = s => parseInt(String(s || "0").replace("s", ""), 10) || 0;

// 把 Google 的一條路線整理成前端好顯示的格式
function summarize(route) {
  const steps = (route.legs || []).flatMap(l => l.steps || []);
  const parts = [];
  let walkBefore = 0, seenTransit = false, walkAfter = 0;
  for (const s of steps) {
    if (s.travelMode === "WALK") {
      const m = secs(s.staticDuration);
      if (!seenTransit) walkBefore += m; else walkAfter += m;
      if (parts.length && parts[parts.length - 1].kind === "walk") parts[parts.length - 1].sec += m;
      else parts.push({ kind: "walk", sec: m });
    } else if (s.transitDetails) {
      seenTransit = true; walkAfter = 0;
      const t = s.transitDetails, line = t.transitLine || {};
      parts.push({
        kind: "transit",
        vehicle: line.vehicle?.type || "",
        vehicleName: line.vehicle?.name?.text || "",
        line: line.nameShort || line.name || "",
        lineFull: line.name || "",
        color: line.color || null, textColor: line.textColor || null,
        headsign: t.headsign || "",
        from: t.stopDetails?.departureStop?.name || "",
        to: t.stopDetails?.arrivalStop?.name || "",
        dep: t.stopDetails?.departureTime || null,
        arr: t.stopDetails?.arrivalTime || null,
        stops: t.stopCount || 0,
      });
    }
  }
  const transits = parts.filter(p => p.kind === "transit");
  if (!transits.length) return null;
  const first = transits[0], last = transits[transits.length - 1];
  const arrive = last.arr ? new Date(new Date(last.arr).getTime() + walkAfter * 1000).toISOString() : null;
  return {
    firstDep: first.dep,
    firstLine: first.line, firstVehicle: first.vehicle,
    walkToStop: Math.round(walkBefore / 60),
    arrive, durationMin: Math.round(secs(route.duration) / 60),
    parts, polyline: route.polyline?.encodedPolyline || null,
  };
}

// 取得某種交通方式「接下來三班」：必要時把出發時間往後推再查一次
async function next3(from, to, modes, keep) {
  const out = [], seen = new Set();
  let t = new Date();
  for (let i = 0; i < 3 && out.length < 3; i++) {
    const routes = await computeTransit(from, to, modes, t);
    let latest = null;
    for (const r of routes) {
      const s = summarize(r);
      if (!s || !keep(s)) continue;
      const k = s.firstLine + "|" + s.firstDep;
      if (seen.has(k)) continue;
      seen.add(k); out.push(s);
      if (!latest || s.firstDep > latest) latest = s.firstDep;
    }
    if (!latest) break;
    t = new Date(new Date(latest).getTime() + 60000);
  }
  return out.sort((a, b) => (a.firstDep || "").localeCompare(b.firstDep || "")).slice(0, 3);
}

const METRO_TYPES = new Set(["SUBWAY", "METRO_RAIL", "LIGHT_RAIL", "TRAM", "MONORAIL"]);

async function plan(from, destText) {
  const to = await geocode(destText);
  const settle = p => p.then(v => ({ ok: true, v }), e => ({ ok: false, e: e.message }));
  const [bus, metro, tra, thsr] = await Promise.all([
    settle(next3(from, to, ["BUS"], s => s.firstVehicle === "BUS")),
    settle(next3(from, to, ["SUBWAY", "LIGHT_RAIL"], s => s.parts.some(p => METRO_TYPES.has(p.vehicle)))),
    settle(railPlan("tra", from, to)),
    settle(railPlan("thsr", from, to)),
  ]);
  return { to, bus, metro, tra, thsr };
}

// ---------- HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function latlon(q) {
  const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon"));
  if (!(lat >= 21 && lat <= 27 && lon >= 118 && lon <= 123)) throw Object.assign(new Error("座標不在台灣範圍"), { code: 400 });
  return { lat, lon };
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/config.js") {
      return send(res, 200, `window.GOOGLE_BROWSER_KEY=${JSON.stringify(GOOGLE_BROWSER_KEY || "")};`, MIME[".js"]);
    }
    if (u.pathname === "/api/bike") { const p = latlon(u.searchParams); return send(res, 200, await bikeNearby(p.lat, p.lon)); }
    if (u.pathname === "/api/bus") { const p = latlon(u.searchParams); return send(res, 200, await busNearby(p.lat, p.lon)); }
    if (u.pathname === "/api/plan") {
      const p = latlon(u.searchParams);
      const dest = (u.searchParams.get("to") || "").trim().slice(0, 120);
      if (!dest) return send(res, 400, { error: "請輸入目的地" });
      if (!GOOGLE_SERVER_KEY) return send(res, 500, { error: "尚未設定 GOOGLE_SERVER_KEY" });
      return send(res, 200, await plan(p, dest));
    }
    // 靜態檔案
    // index.html 放在 public/ 或和 server.js 同一層都可以（方便用手機上傳）
    if (u.pathname === "/" || u.pathname === "/index.html") {
      const a = path.join(__dirname, "public", "index.html"), b = path.join(__dirname, "index.html");
      return fs.readFile(fs.existsSync(a) ? a : b, (err, buf) => {
        if (err) return send(res, 404, { error: "找不到 index.html" });
        res.writeHead(200, { "content-type": MIME[".html"] }); res.end(buf);
      });
    }
    const file = path.join(__dirname, "public", path.normalize(u.pathname));
    if (!file.startsWith(path.join(__dirname, "public"))) return send(res, 403, { error: "forbidden" });
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  } catch (e) {
    console.error(e);
    send(res, e.code || 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`台灣大眾運輸通 http://localhost:${PORT}`));
