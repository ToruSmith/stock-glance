# Stock Glance 台股觀測

用 Google Apps Script 部署的手機版看盤網頁。打開一個網址就能看到：

- **總覽**：七個指標組成的「反彈訊號儀表」，判斷規則全部公開；另有加權指數、台積電、費半、那指、標普 500、台積電 ADR、VIX、美元兌台幣的指標卡（附 60 日走勢線）
- **持股**：從 Google Sheet 讀取持股，計算即時市值、未實現損益、今日損益、扣除手續費與交易稅後的賣出淨損益，以及損益兩平價。點進個股可以看 1 個月到 5 年的走勢、MA5／MA20／MA60、你的成本線、近 12 個月配息與估算殖利率
- **籌碼**：三大法人買賣超與融資餘額，每個交易日晚上自動更新，附官方資料連結
- **觀察**：市場觀察與持股診斷筆記，內容直接在 Sheet 的「觀察筆記」分頁維護

盤中每 60 秒自動更新報價。漲跌顏色依台股慣例：紅漲綠跌。

## 架構

```
手機瀏覽器 ──► Apps Script 網頁 (doGet)
                 ├─ 證交所 MIS 即時報價  （盤中台股與加權指數）
                 ├─ Yahoo Finance 日線   （美股、VIX、匯率、歷史走勢、配息）
                 ├─ 證交所盤後資料       （三大法人 BFI82U、融資 MI_MARGN、個股日成交備援）
                 └─ Google Sheet         （持股、籌碼紀錄、觀察筆記、設定）
```

| 檔案 | 用途 |
| --- | --- |
| `src/Config.gs` | Sheet ID、指標清單、資料連結 |
| `src/Fetchers.gs` | 所有對外抓資料的程式與快取 |
| `src/Signals.gs` | 反彈訊號的判斷規則 |
| `src/Code.gs` | 網頁進入點、前端呼叫的 API、損益計算 |
| `src/Setup.gs` | 初始化、每日排程、籌碼回補 |
| `src/index.html` `Styles.html` `App.html` | 前端（不依賴任何外部 JS 套件，圖表為自繪 SVG） |
| `tests/harness.js` | 用假服務與合成資料在本機測試後端並產生預覽頁 |

## 資料 Sheet

預設使用 [Stock Glance 持股與資料](https://docs.google.com/spreadsheets/d/12_HJ7xI7NCCBNMayjWJnVbUVbucCvt5r9apdOOCgT1w/edit)。分頁：

- **持股**：`代號｜名稱｜股數｜成交均價｜投入成本｜類型｜市場｜備註`。代號欄必須是「純文字」格式，否則 `0050` 會變成 `50`。一張請填 1000 股。類型填 `ETF` 或 `股票`，用來決定交易稅率（0.1% 或 0.3%）；市場填 `上市` 或 `上櫃`。
- **籌碼**：由程式自動寫入，不用手動編輯。
- **觀察筆記**：`日期｜分類｜標題｜內容`，新增一列就會出現在網頁上。
- **設定**：手續費折扣、最低手續費、自動刷新秒數，以及兩個訊號門檻。

要改用別的 Sheet，可以修改 `Config.gs` 的 `SHEET_ID`，或在 Apps Script「專案設定 › 指令碼屬性」新增 `SHEET_ID`。

## 部署（第一次約 10 分鐘）

### 方法 A：直接貼上（最簡單）

1. 到 <https://script.google.com> 建立新專案，命名為 `Stock Glance`。
2. 「專案設定」勾選「在編輯器中顯示 appsscript.json 資訊清單檔案」，再把 `src/appsscript.json` 的內容貼進去。
3. 依照 `src/` 的檔名建立檔案並貼上內容：指令碼檔案有 `Config`、`Fetchers`、`Signals`、`Code`、`Setup`；HTML 檔案有 `index`、`Styles`、`App`。
4. 在上方函式選單選 `setup`，按「執行」，然後依提示授權。這一步會建立每日 22:00 的籌碼排程，並回補最近 25 個交易日的籌碼，大約需要 2～4 分鐘。
5. 按「部署 › 新增部署作業」，類型選「網頁應用程式」，執行身分選「我」，存取權選「只有我自己」，然後按部署。
6. 用手機打開部署網址。iPhone 可以按 Safari 的「分享 › 加入主畫面」，Android 用 Chrome 選單裡的「加到主畫面」。

### 方法 B：用 clasp 從這個 repo 同步

```bash
npm i -g @google/clasp@2.4.2
clasp login
cp .clasp.json.example .clasp.json   # 填入 Apps Script 專案 ID（專案設定頁可以找到）
clasp push -f
```

### 方法 C：GitHub Actions 自動部署

在 repo 的 **Settings › Secrets and variables › Actions** 新增下面幾個 secret，之後只要推送到 `main`，就會自動部署：

- `CLASPRC_JSON`：本機執行 `clasp login` 後，`~/.clasprc.json` 的完整內容
- `SCRIPT_ID`：Apps Script 專案 ID
- `DEPLOYMENT_ID`（選填）：網頁部署的 ID。設定後網址不會變，內容會自動更新

## 反彈訊號規則

| 指標 | 偏多 | 偏空 |
| --- | --- | --- |
| 費半止跌 | 站上 5 日線且當日收紅 | 創 20 日新低，或跌破 5 日線且跌逾 2% |
| 恐慌退燒（VIX） | 低於 20，或從 30 以上的高點回落 20% | 30 以上且接近 10 日高點 |
| 美股趨勢（標普 500） | 站上 20 日線 | 在 20 日線下且 20 日線下彎 |
| 台幣動向 | 5 日升值逾 0.3% | 5 日貶值逾 0.3% |
| 加權止跌 | 站上 5 日線且 5 日線翻揚 | 同時跌破 5 日線與季線 |
| 外資回補 | 近 3 日合計買超 | 近 3 日合計賣超超過門檻（預設 300 億） |
| 融資清洗 | 5 日減少逾 3% | 5 日增加逾門檻（預設 3%） |

規則刻意保持簡單，可以在 `Signals.gs` 自行調整。這些訊號只是整理公開資料的輔助工具，不構成投資建議。

## 本機測試

```bash
node tests/harness.js        # 產生 tests/out/preview.html（價格是合成資料）
```

## 已知限制

- 證交所 MIS 報價延遲約數秒，Yahoo 資料延遲約 15～20 分鐘。Yahoo 用的是非官方介面，改版時可能需要調整 `Fetchers.gs`。
- 證交所會限制查詢頻率，回補籌碼時每次請求之間會間隔 2 秒。
- Apps Script 網頁第一次開啟需要 1～3 秒。之後資料會快取，再開會比較快。
- 台指期夜盤、期貨未平倉沒有穩定的公開介面，目前只提供期交所連結。
