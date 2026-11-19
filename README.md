# 台灣大眾運輸通

打開就是地圖，會顯示：

- **你的位置**，以及附近 YouBike 站的**可借車數 / 空位**（地圖上直接標示，每 30 秒更新）
- **最近的公車站牌**：走過去要幾分鐘，各路線還有幾分鐘到站
- 輸入目的地後，列出**接下來 3 班**：
  - 公車（要搭哪一路、走幾分鐘到哪個站牌、幾點開、幾點到）
  - 捷運（台北、桃園機捷、台中、高雄，含轉乘）
  - 台鐵（最近的車站 → 目的地最近的車站）
  - 高鐵（同上）
- 點一下公車或捷運的班次，地圖會畫出路線

## 資料來源

| 功能 | 來源 |
|---|---|
| YouBike 車數、公車到站時間、台鐵／高鐵時刻表 | 交通部 TDX 運輸資料流通服務 |
| 地圖、地址查詢、公車／捷運路線規劃 | Google Maps Platform |

---

## 第 1 步：申請 TDX 金鑰（免費）

1. 到 <https://tdx.transportdata.tw> 註冊會員（一般會員即可）。
2. 登入後進入「會員中心」→「資料服務」→「API 金鑰」。
3. 複製 **Client Id** 和 **Client Secret**。

> 一般會員有呼叫次數上限。伺服器已經做了快取（YouBike 30 秒、公車 20 秒、時刻表 10 分鐘、車站資料 1 天），自己或少數人用通常夠。

## 第 2 步：申請 Google 金鑰

1. 到 <https://console.cloud.google.com> 建立專案，並**綁定帳單**（Google 每月有免費額度，個人使用通常不會超過；建議到「預算與快訊」設一個上限提醒）。
2. 在「API 和服務 → 程式庫」啟用這三個：
   - **Maps JavaScript API**（顯示地圖）
   - **Routes API**（公車、捷運路線與班次）
   - **Geocoding API**（把目的地文字轉成座標）
3. 在「憑證」建立**兩把** API 金鑰：
   - **瀏覽器金鑰** → 應用程式限制選「網站」，填你的網址（例如 `https://你的網域/*`，本機測試加 `http://localhost:3000/*`）；API 限制只勾 Maps JavaScript API。
   - **伺服器金鑰** → 不設網站限制；API 限制只勾 Routes API、Geocoding API。這把只放在伺服器，不會傳到手機。

## 第 3 步：在自己電腦上跑起來

需要 Node.js 18 以上（<https://nodejs.org>），不用安裝任何套件。

```bash
cd tw-transit
cp .env.example .env      # Windows 用：copy .env.example .env
# 用記事本打開 .env，填入四個金鑰
node server.js
```

用瀏覽器打開 <http://localhost:3000>，允許定位就可以用了。

## 第 4 步：放上網路（讓手機也能用）

手機定位**一定要 https**，所以要放到有 https 的地方。最簡單的是 **Render**（有免費方案）：

1. 把整個 `tw-transit` 資料夾上傳到你的 GitHub（`.env` 不會被上傳，已在 `.gitignore`）。
2. 到 <https://render.com> → New → **Web Service** → 選這個 repo。
3. 設定：
   - Build Command：留空（或 `npm install`）
   - Start Command：`node server.js`
4. 在 **Environment** 加入 `TDX_CLIENT_ID`、`TDX_CLIENT_SECRET`、`GOOGLE_SERVER_KEY`、`GOOGLE_BROWSER_KEY` 四個變數。
5. 部署完會拿到 `https://xxxx.onrender.com`，**記得回 Google 把這個網址加進瀏覽器金鑰的網站限制**。

> Render 免費方案閒置一陣子會休眠，第一次打開要等 30 秒左右。Railway、Fly.io 或自己的主機也都可以，只要能跑 Node 並設定環境變數。

手機打開網址後，可以用瀏覽器的「加入主畫面」，用起來就像 App。

---

## 已知限制

- **捷運班次**來自 Google 的時刻表，不是即時到站；台北捷運以外的系統，Google 資料完整度可能較低。
- **台鐵、高鐵**是用「離你最近的車站」到「離目的地最近的車站」計算，若最近的車站不是你想搭的站（例如想到板橋搭高鐵），結果會不同。過了午夜的班次不會列出。
- **公車路線規劃**（要搭哪一路）來自 Google；**附近站牌的到站時間**來自 TDX 即時資料。
- 這個程式寫好時沒有真的金鑰可以測試，邏輯已用模擬資料測過。若某一區塊顯示錯誤，畫面會直接顯示錯誤原因，最常見是金鑰沒啟用對應的 API。

## 檔案

```
tw-transit/
├─ server.js          伺服器：保管金鑰、呼叫 TDX 與 Google、快取
├─ public/index.html  手機網頁：地圖與所有畫面
├─ .env.example       金鑰範本
└─ package.json
```
