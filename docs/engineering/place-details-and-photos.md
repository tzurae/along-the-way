# 景點詳情與可重用授權照片

## 範圍與目前狀態

本分支實作 [正式規格](../superpowers/specs/2026-10-09-place-details-and-photos-design.md) 的 B 體驗：清單小縮圖、詳情相簿、逐張資訊及完整照片檢視器。景點文字、來源、照片及權限由正式 API／PostgreSQL 供應，不使用 POC 的本機假資料。

目前正在隔離環境完成行為驗收與修復；這不是部署完成宣告。未直接觀察的驗收項目仍是 `UNVERIFIED`。此次不修改真實旅程，不 commit／push／建立 PR／部署。驗收帳號、登入 cookie、資料庫密碼只保存在隔離環境，不能加入 repository。

不包含：照片上傳、旅程相簿、任意景點自動研究、Google Places Photo API、抓取 Google 圖片、公開圖片網址，或改動投票／排程／導航／成員權限演算法。既有 Google Maps 外連不成為本相簿的照片來源。

## 身分與讀取介面

三個入口使用相同 `PlaceDetailContent`：

| 入口 | `kind` | `id` |
| --- | --- | --- |
| 口袋名單 | `trip-place` | 該旅程的 `TripPlace.id` |
| AI 建議 | `proposal` | 該旅程的提案 id |
| 今天的行程地點 | `itinerary-place` | legacy `Place.id` |
| 今天的待排地點 | `trip-place` | `TripPlace.id` |

```text
GET /api/trips/:tripId/place-details?kind=trip-place&id=<UUID>&date=YYYY-MM-DD
GET /api/trips/:tripId/place-previews?kind=trip-place&ids=<UUID>,<UUID>
GET /api/trips/:tripId/place-photo-assets/<sha256>.jpg?kind=trip-place&id=<UUID>
```

`kind` 亦接受 `proposal`、`itinerary-place`。詳情回傳 `{ detail }`，縮圖預覽回傳 `{ previews }`；契約與嚴格 parser 位於 `packages/contracts/src/place-details.ts`。日期必須是實際存在的完整日曆日期；省略日期不表示來源已證實當日有效。

每條 route 先驗證登入與有效旅程成員資格，再解析同一旅程的 reference。照片路徑中的雜湊不是公開存取憑證：仍需登入、旅程成員資格，以及該 reference 對應照片的關聯。照片回應使用 private／no-store，未知檔案、缺失或毀損不冒充正常圖片。

已接受提案優先使用 `accepted_trip_place_id` 的 canonical identity；未接受提案才使用已有 provider identity。legacy 行程地點只能經同旅程既有 `trip_places.legacy_place_id` 關聯解析。地點名稱不作為匹配鍵；不建立或合併身分來湊內容。未知店、同名分店及未關聯的 travel-only 地點保留空白 curated 內容；原有可確認的行程資料仍保留。

完整內容與已排序照片由同一 SQL statement 讀取 publication snapshot，避免一個詳情混用兩次匯入的資料。預覽批次只讀首張照片，不逐卡呼叫完整詳情或供應商。

## 經人工查核的 catalog

- `apps/api/data/place-details/initial-places.json`：清水寺、東福寺、永觀堂；每處七類敘述、各三張不同作品。
- `apps/api/data/place-details/verification-places.json`：香港公園單張照片，僅供非京都控制驗收；不是自動替真實旅程發布。
- `apps/api/assets/place-photos/`：十個實際作品的二十個 JPEG 衍生檔（展示版及縮圖），以內容 SHA-256 命名。

catalog 不會在啟動時依名稱自動套用。營運者必須逐一確認現有 canonical identity 與實際地點，再明確匯入；新加的任意景點沒有照片是正常狀態，不可借用其他地點的照片。

每個作品保留獨立的作者、credit、作品頁、原始檔來源、授權名称／版本／連結、拍攝日期（未知為 null）、查核時間、永久版本查核網址、地点判別證據、原始尺寸、修改說明及限制。Commons 查核網址必須指向 numeric `oldid` 或 `Special:PermanentLink`，不能只有會變動的目前頁面。不同作品的 CC BY-SA 4.0、CC BY 2.5、CC0 不合併為固定相簿署名。衍生檔縮放與詳情預覽 CSS 裁切的說明保留；完整檢視器以 contain 呈現完整構圖。歷史照片不表示當日景況或夜間開放。

## 營運者匯入

先執行 migration；新增的 `curated_place_details`、`curated_place_photos` 是 additive tables。匯入不是 HTTP 會員功能，而是持有資料庫發布權限的營運者 CLI。

在 repository 根目錄使用 Bun 1.3.14：

```sh
DATABASE_URL='<explicit target database URL>' \
  bun apps/api/src/place-details/import-curated-place-details.ts \
  --manifest apps/api/data/place-details/initial-places.json \
  --bindings '<reviewed existing-identities.json>'
```

不得沿用不明的 shell／`.env` 指向正式資料庫。先確認連線目標與寫入批准；本次驗收只使用 `along_place_details_verify`。

Bindings 格式：

```json
{
  "version": 1,
  "bindings": [
    {
      "key": "kiyomizu",
      "canonicalPlaceId": "<existing canonical UUID>",
      "itineraryPlaceIds": ["<existing legacy Place UUID>"]
    }
  ]
}
```

上述是單一 entry 的結構示例，不能直接用於含三個地點的初始 manifest。bindings 必須精確覆蓋該 manifest 全部 keys；`canonicalPlaceId` 不得填 `TripPlace.id`。每個 legacy id 必須已經與指定 canonical identity 有既存關聯；無需要額外列出的 legacy 關聯可使用空陣列。匯入不建立該關聯，也不更新 provider／canonical／行程地點。

`manifest key ↔ canonical identity` 一經發布不得改指另一身分。錯誤的重指、重複 key／身分／legacy id、缺少綁定及不匹配的既有關聯都會拒絕。驗收副本也須使用自己的 manifest keys，不能把已發布的 key 改綁到測試副本。

每份 CLI JSON 輸入上限 8 MiB。圖片須放在 packaged asset root，以 64 位小寫 SHA-256 加 `.jpg`／`.png`／`.webp` 命名；manifest 提供相同 SHA-256、實際尺寸及 media type。逐檔拒絕 symlink、非法路徑、非一般檔案、超過 20 MiB、雜湊／容器／尺寸不符。所有檔案先驗證，再以 advisory-locked transaction 取代本次各 identity 的內容與照片。任一較晚 entry 失敗也不部分發布；重複同份合法輸入不增加副本。清空照片陣列會發布零張，不以舊照片補齊。照片 GET 亦檢查 packaged 檔案完整性，沒有遠端抓圖 fallback。

新增目的地沿用相同 manifest／bindings／資產流程，不新增名稱特例。未查核的作品不能靠合法格式的 JSON 就被稱為授權查核完成；營運者仍須保留實際逐張來源證據。

## 日期、未知與衝突

來源保留 `checkedAt`、`publishedAt`、`validFrom`、`validUntil`、`expiresAt`，不把 read time 重寫成查核日期。有效期間含首尾日期。來源到期，或不涵蓋請求的旅程日期，相關 block 的 `needsRecheck` 為 true；UI 保留原文字、來源與日期並顯示「需要重新確認」。`certainty` 的 `unknown`／`conflicted` 亦明示，不自行挑值或修改行程。

一張全年時段表不代表每項季節活動全年適用。清水寺 daytime 2026-09-01–11-20 與 autumn night 2026-11-21–11-30 分別使用自己的適用範圍，即使兩者來自同一官方網址。

## UI、失敗與 Today snapshot

相簿支持零／一／兩／多張；署名與完整資訊對應選中的作品。照片網路失敗只影響該作品，詳情文字及其他照片不等待它。56px 小資訊列必須是主詳情捲動的一部分，沒有內層垂直捲動；截斷的摘要不能取代完整資訊入口。放大／關閉不得改動加入原因、投票、行程或其版本。

Today snapshot schema version 3 僅新增行程 endpoint 的 legacy Place reference；wishlist 沿用已足夠的 TripPlace `id`，不額外保存未使用的 canonical `placeId`。合格 version 2 在同帳號及 exact-key 檢查下遷移，缺少的 endpoint reference 為 null，不靠名稱／座標猜 identity。遷移結果通過驗證後，即使 `setItem` 因 quota 失敗，也返回可讀的記憶體結果並保留原始快照；不能將寫入失敗當成資料損壞而刪除。照片或 optional 詳情失敗不使核心 projection／snapshot 作廢。離線不發起 authenticated 詳情讀取。

資訊列使用固定 CSS pixels，而非隨 root 字級成長的 rem 高度；兩列摘要之外，完整資訊控制占滿獨立的 56px 欄位。檢視器明確覆寫共用 Dialog 的 responsive max-width，且 metadata 欄寬同時受可用寬度比例與最大寬度限制，不能把圖片欄擠到零。metadata 標籤／內容依自身 container 寬度排版，不以整個 viewport 推定狹窄側欄能放兩欄。

桌面檢視器固定照片區，完整資訊欄獨立捲動；手機保留整個檢視器捲動。開啟聚焦標題，不能因長作者取得焦點而把照片捲出畫面。圖片 grid item 明確允許縮小，直式作品不以 intrinsic 最小高度撐出 viewport。關閉控制至少 44px；reduced-motion override 必須勝過共用 Dialog 的 data-state 動畫。

口袋名單／建議頁／Today 按實際 section container 寬度切換雙欄，不能僅按整個 viewport 假定有空間容納 rem 側欄。入口保存原視窗位置，關閉時先無捲動地恢復焦點，再還原該位置；閱讀不改寫任何投票或排程資料。

## 驗收與追蹤

已直接觀察：真實 magic-link／Mailpit 登入、正式建旅程 API、營運者 CLI 匯入與禁止重指、三 reference 內容一致、匿名401、非法日曆400、同名／未知空內容、季節時段修前修後 HTTP、零／一／兩張、過期／衝突頁面、三入口相同七節正文、原生手機 1→2→3→2→1 及 56px／正文位置穩定。獨立 backend verifier 比對 56 次 authenticated 展示／縮圖回應（另 56 次匿名拒絕），並核對下列十份 Commons 永久版本；二十個 packaged JPEG 逐檔與官方 Commons 衍生檔 SHA-256 相等。

| 作品 | 作者 | 選用授權 | 實際核對的永久版本 |
| --- | --- | --- | --- |
| `commons-53618736` | Martin Falbisoner | CC BY-SA 4.0 | [824728699](https://commons.wikimedia.org/w/index.php?title=File:Kiyomizu-dera,_Kyoto,_November_2016_-07.jpg&oldid=824728699) |
| `commons-53593907` | Martin Falbisoner | CC BY-SA 4.0 | [1017025418](https://commons.wikimedia.org/w/index.php?title=File:Kiyomizu-dera,_Kyoto,_November_2016_-01.jpg&oldid=1017025418) |
| `commons-93859358` | Basile Morin | CC BY-SA 4.0 | [1283326472](https://commons.wikimedia.org/w/index.php?title=File:Interior_view_of_the_Buddhist_temple_Amidado_with_a_golden_statue_of_the_Buddha_seated_Kiyomizu-dera_Kyoto_Japan.jpg&oldid=1283326472) |
| `commons-61103282` | Immanuel Giel | CC BY-SA 4.0 | [1207456241](https://commons.wikimedia.org/w/index.php?title=File:Honbo_Garden,_Tofukuji_17.jpg&oldid=1207456241) |
| `commons-61103283` | Immanuel Giel | CC BY-SA 4.0 | [1129590252](https://commons.wikimedia.org/w/index.php?title=File:Honbo_Garden,_Tofukuji_18.jpg&oldid=1129590252) |
| `commons-61103303` | Immanuel Giel | CC BY-SA 4.0 | [1086177786](https://commons.wikimedia.org/w/index.php?title=File:Honbo_Garden,_Tofukuji_35.jpg&oldid=1086177786) |
| `commons-53849698` | Martin Falbisoner | CC BY-SA 4.0 | [1225427615](https://commons.wikimedia.org/w/index.php?title=File:Eikan-do_Zenrin-ji,_November_2016_-03.jpg&oldid=1225427615) |
| `commons-1415461` | Tomomarusan | CC BY 2.5 | [1101467967](https://commons.wikimedia.org/w/index.php?title=File:Eikando_Zenrinji-temple_Tahoto.JPG&oldid=1101467967) |
| `commons-195976308` | lumoplank | CC0 1.0 | [1281834641](https://commons.wikimedia.org/w/index.php?title=File:Eikando,_Kyoto_-_Eikando7376.jpg&oldid=1281834641) |
| `commons-49044047` | Citobun | CC BY-SA 4.0 | [1267201094](https://commons.wikimedia.org/w/index.php?title=File:Hong_Kong_Park_lake_and_restaurant.jpg&oldid=1267201094) |

拍攝日期、地點判別、原始來源後續裁切／色彩修整、Flickr CC0 查核及各授權修改要求也逐張對照；CC0 作品只有「早於 2026-03-11」資訊，維持 `capturedAt: null`，不捏造精確拍攝日。此表與 manifest 的來源證據可以在後續 session 重讀；暫存報告不是唯一依據。

本次隔離 project 為 `along-place-details-verify`：web 25100、Mailpit 25101、私有資料庫 loopback 25102；資料與證據在 `/tmp/along-place-details-verification/`，不是正式部署。臨時資料含明示的控制假資料，不代表真實 AI 研究。

Browser 工具曾把不同 named tabs 指向同一 Chromium target，造成並行操作串擾；受影響的獨立 UI FAIL／PASS 已撤回為 `UNVERIFIED`。後續瀏覽器驗收必須串行、持有排他的 browser 操作窗口；不同名字不能作為隔離證據。

新整合回歸測試 `apps/api/test/place-detail-flow.integration.test.ts` 使用獨立 `TEST_DATABASE_URL`，涵蓋 reference／成員／資產隔離、未知、日期、衝突、原子匯入及實際初始 catalog 的季節範圍。使用者另行批准後，根 `test:integration` 已納入它；本地執行此實際 CI 入口，125 項／5 files 通過。不代表已觸發 GitHub CI。

最新 typecheck 通過，單元 278 項／29 files 通過。瀏覽器回歸位於既有 `trip-place.spec.ts`，防止圖片零寬／越出可視範圍、56px 高度膨脹、完整資訊不可讀與 reduced-motion 退步；使用明示的測試像素只隔離版面，真實照片與權利證據另行驗證。

第一輪獨立 spec／standards review 都指出：合法舊快照的升級寫入失敗被誤當損壞而刪除。公開 `TodaySnapshotStore.read()` 回歸已觀察修前失敗、修後保留讀取與原值；實際離線 production app 也重現「旅程不可讀、原值刪除」。相同離線＋quota 場景修後確認旅程可讀、原 version 2 儲存值保留，且 API 真正不可達。A05／A15 已補量測：三入口的照片檢視器關閉保持正文位置、選中作品及內層捲動；再關閉詳情，恢復原入口焦點及視窗位置，口袋 0→0、建議 0→0、Today 487→487。Today 初次量測的 549→487 是既有 SSE 重新連線提示移除，使 document height 同減 62px；詳情 section 的 viewport 位置未動，不能把此差異當成詳情關閉缺陷。最終位置比較先等待真實 SSE 連線，不修改同步機制。

整頁 axe 4.10.3 曾在 390／1440 找到既有「新增想去地點」按鈕對比 4.25:1。依補充批准改用既有深色底／淺色字後，相同 390／1440 × 詳情／檢視器四組整頁及新增區域 WCAG 2 A／AA、2.1 AA 掃描均零違規。鍵盤、焦點、44px 控制與 reduced-motion 另以真實瀏覽器觀察；自動掃描不代表涵蓋所有人工無障礙需求。

證據位於 `/tmp/along-place-details-verification/`：`cross-entry-final.json`、`mobile-sequence-final.json`、`native-scroll-final.json`、`image-failure-final.json`、`final-public-smoke.json`、`return-position-final.json`、`offline-migration-before.json`／`offline-migration-after.json`、`accessibility-final.json`、`seasonal-before.json`／`seasonal-after.json`、`commons-rights-evidence.json`。最終獨立 runtime 與綜合 review 均為 PASS，原始報告保存為 `independent-runtime-final.json`／`independent-final-review.json`。未直接觀察的項目維持 `UNVERIFIED`。

### A01–A17 公開介面結果

| 驗收 | 結果 | 直接證據 |
| --- | --- | --- |
| A01 | PASS | 三入口七節內容及首張逐作品署名一致；入口原有原因／時間保留。`cross-entry-final.json` |
| A02 | PASS | 真實三地清單縮圖解碼，與 API 第一作品相符。`final-public-smoke.json` |
| A03 | PASS | 原生 touch 1→2→3→2→1，三作者／三授權逐張對應；56px 及正文位置固定。`mobile-sequence-final.json` |
| A04 | PASS | 桌面箭頭、兩端 disabled、不越界。`final-public-smoke.json` |
| A05 | PASS | 三入口第二作品檢視、關閉後作品／正文／捲動不變；直式照片完整構圖可見。`return-position-final.json`、`portrait-after.json` |
| A06 | PASS | 真實 API 零／一／兩／多張 fixture，控制對應數量。`final-public-smoke.json` |
| A07 | PASS | 320／390／1440 長正文能到最後來源，無橫向溢出。`final-public-smoke.json` |
| A08 | PASS | 手機資訊列垂直 touch、桌面資訊列／正文 wheel 均帶動正文，到底及回頭成立。`native-scroll-final.json` |
| A09 | PASS | 1440／1024／390、root 16／32px 長署名／metadata；固定 56px、完整資訊可讀。`final-public-smoke.json`、既有 Playwright 回歸 |
| A10 | PASS | 僅阻斷一份真實展示 JPEG，文字可讀、錯誤作品不破圖，下一真實作品仍解碼。`image-failure-final.json` |
| A11 | PASS | 未知及同名不同 identity 無借用照片／地址／導航。`final-public-smoke.json` |
| A12 | PASS | 十份 Commons 永久版本、二十份官方展示／縮圖 SHA-256；作者／授權／修改逐作品核對。上表、`commons-rights-evidence.json` |
| A13 | PASS | 到期／日期不適用明示，原來源與查核日期保留；季節時段修前修後 HTTP。`final-public-smoke.json`、`seasonal-before.json`／`seasonal-after.json` |
| A14 | PASS | 衝突兩來源與各日期可讀，不自行選值。`final-public-smoke.json` |
| A15 | PASS | 三入口原位置／焦點恢復；旅程、skeleton、清單及建議 GET 回應在閱讀前後 byte-identical。`return-position-final.json`、`final-public-smoke.json` |
| A16 | PASS | 香港、不同日期及單張照片同流程；沒有京都特殊路徑。`final-public-smoke.json` |
| A17 | PASS | 四組整頁 axe 零違規；鍵盤／焦點／觸控尺寸／reduced-motion 真實觀察。`accessibility-final.json`、`final-public-smoke.json` |

上述 PASS 限隔離 Chromium 實際情境；實體 iOS／Android 裝置、一般 4G 核心 2.5 秒目標及遠端 GitHub CI 未直接驗證，維持 `UNVERIFIED`。本功能不新增完整離線相簿。

### 最終候選與獨立結論

第二次暨最終 fresh-context review 閱讀完整 61-file 變更、tracked diff、新 source／contracts／tests／catalog、二十張圖片及被 gitignore 忽略的 `PRODUCT.md`／原規格；沒有阻擋程式缺陷。其唯一剩餘 DOC-01 是 README 仍稱快照 schema 2，已在原段落更正為 schema 3，說明合格 version 2 遷移及 upgrade write 失敗保留原值，經同 reviewer 有界重查確認。

該 read-only reviewer 沒有執行工具，初次結論保留 `UNVERIFIED`，未把靜態閱讀冒稱獨立瀏覽器驗證。另行提供原生 Node／Playwright 執行能力後，獨立 runtime verifier 直接量測 Today 1024px／root 32px 無橫向溢出、完整 metadata 與圖片可讀、Escape／原入口焦點與位置恢復、真實 960×1280 直式構圖、schema 3 真實快照、合法 version 2 quota 離線讀取、exact-key／同帳號非法快照拒絕、匿名 401、未知／同名隔離及核心四份 GET 回應 SHA-256 不變，均 PASS。

身份證據不是僅信任正在運行的網址。完整 249-file 候選已凍結為 `frozen-candidate.tar.gz`，包含 tracked 基底、新功能 source／素材及 ignored 規範文件，排除 `.env`、dependencies、dist、`.git` 與無關 untracked 檔案。僅從它的 `frozen-build-candidate/` 重建現有隔離 project 的 api／worker／web；獨立 verifier 再以 `materialize-frozen-candidate.mjs` 建立自己的副本，逐檔／aggregate 校驗並確認現行 image 身份，重建後的 Today 放大字級／檢視器再次 PASS。

- archive SHA-256：`5be0d0566a5ccbf29bca25e1a3f53398775f5be6d472c1aa060e50eb64603abb`。
- frozen source bundle SHA-256：`e6fed12b9547a101da9fa1f928a0d5350567d0e8a001631c198e71fbc2823ff2`。
- api／worker image：`sha256:cadd215fab0baa3d73f0fd6549f77be67510c184058635f1938550367a84e76a`。
- web image：`sha256:35a902755cacf5738fc1cebf898201b3621806f43ec997362386320c339b6e04`。
- public JS：`index-Cx3bkB-i.js`，SHA-256 `cd2b08aee22eecb2a0c9f613884f5fa341322431f82891664b82ac30832825f1`。
- public CSS：`index-Bj1b7TdZ.css`，SHA-256 `e26c9b7fa5e43a4e1f5776e990ab17764270d848f54d3c27d08d5a04a88075ad`。

最終 reviewer 綜合原 static review、有界 DOC-01 重查與獨立 runtime 證據，Spec／Standards 均 PASS，沒有 surviving finding；清楚歸屬 runtime 觀察於 verifier，而非自己未執行的介面。凍結後只更新本段、產品／規格的驗收狀態，不更改 runtime build inputs。

### 收尾、安全與接續

工具曾意外輸出一次自建隔離測試 session 的 cookie，非正式使用者憑證。使用者另選「批准隔離收尾」後，僅以公開 `POST /api/logout` 撤銷該 session；修前 `GET /api/session` 為 200，logout 為 204，原 cookie 再讀為 401，並從 `session.json` 移除 cookie。不在文件或證據重貼它；`session-revocation.json` 保存無 token 的結果。

依同一收尾批准移除八份自建一次性 `.mjs`、暫存 Playwright config、三份自建 Chrome profile，以及誤解到暫存根部的候選副本（按 frozen source 清單逐檔確認；248 files 加已刪 config）。證據 JSON／截圖／官方下載、immutable archive、凍結／verifier 副本及 materialize helper、private runtime env／override、運行環境與合成旅程保留。`cleanup-evidence.json` 記錄範圍。清理後公開 `/health`／`/ready` 均 200，DB／email worker available，兩份 public asset SHA 如上；`delivery-public-smoke.json` 是實際回應。

目前分支 `feature/place-details-photos`，worktree `/Users/xiezirui/projects/along the way/along-the-way-feature-place-details-photos`，基底 `c4a0afa31ca7ac3452ba809bc439055ed7f27487`；未 commit／push／PR／Issue mutation／正式部署。`PRODUCT.md` 與原規格本來即為 ignored 文件，本次完整 review／freeze 已明確納入，不能只靠 tracked diff 找它們。真實旅程、25080 sandbox、既有 POC、其他 worktree 與既有核心演算法不變。

可操作入口：`http://localhost:25100/`，Mailpit `http://localhost:25101/`；登入 `place-details-owner@example.test` 並取新的 magic link，勿重用已撤銷 session。合成旅程與標明的 fake AI／過期／衝突／長署名資料仍在隔離 DB，代表驗收控制資料而非真實 AI 研究。當前工作已完成；任何提交、Issue 更新或正式部署仍須另行明確批准。
