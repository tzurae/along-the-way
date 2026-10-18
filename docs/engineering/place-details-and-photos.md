# 景點詳情與可重用授權照片

## 範圍與目前狀態

本分支實作 [正式規格](../superpowers/specs/2026-10-09-place-details-and-photos-design.md) 的 B 體驗：清單小縮圖、詳情相簿、逐張資訊及完整照片檢視器。景點文字、來源、照片及權限由正式 API／PostgreSQL 供應，不使用 POC 的本機假資料。

現行讀取規則已依 #149 與 2026-10-18 owner 核准的 Commons 候選流程更新。這不是部署完成宣告；本次依 RULES.md rule 9 不跑本機測試或 browser，檢查交給 PR 的 Verify CI。實際圖片、付費 API 與正式資料行為仍是 `UNVERIFIED`。下方「歷史驗收與追蹤」保留早期證據，不代表 #149 已通過那些情境。帳號、登入 cookie、資料庫密碼不能加入 repository。

不包含：照片上傳、旅程相簿、任意景點自動研究、抓取 Google Maps 網頁圖片、公開圖片網址，或改動投票／排程／導航／成員權限演算法。既有 Google Maps 網頁外連不作為圖片抓取來源；下述 Google Places (New) Photos fallback 是經驗證、私有代理的獨立路徑。

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
GET /api/trips/:tripId/google-place-photos/<providerPlaceId>?index=0|1|2&photo=<photoFingerprint>&resource=<photoToken>&maxWidth=192|1024&exp=<unixSeconds>&sig=<base64urlHmac>
```

`kind` 亦接受 `proposal`、`itinerary-place`。詳情回傳 `{ detail }`，其中 curated／Commons `photos` 與 Google `googlePhotos` 各為 0–3 張且不得同時非空；`photosUnavailable` 區分 Google fallback 失敗與真的沒有照片，`commonsPhotoReportable` 標示目前代表照片能否檢舉。縮圖預覽回傳 `{ previews }`，每項只有 curated／Commons 首張 `photo`（沒有則 null）及 capped `photoCount` 0–3，絕不回 Google DTO。契約與嚴格 parser 位於 `packages/contracts/src/place-details.ts`。日期必須是實際存在的完整日曆日期；省略日期不表示來源已證實當日有效。

每條 route 先驗證登入與有效旅程成員資格，再解析同一旅程的 reference。策展照片雜湊不是公開憑證：仍需登入、旅程成員資格，以及 reference 與照片的關聯；其回應使用 private／no-store。Google 代理一律要求綁定旅程、使用者、provider place id、index、fingerprint、完整 photo resource 與到期時間的 HMAC capability，不能只憑地點已屬於旅程略過驗章。代理按帳號每小時 600 次、IP 每小時 1,200 次限流，回應使用 `Cache-Control: private, max-age=86400` 及 `X-Content-Type-Options: nosniff`。未知檔案、缺失或毀損不冒充正常圖片。

已接受提案優先使用 `accepted_trip_place_id` 的 canonical identity；未接受提案的 Google provider id 直接來自該提案，無須為顯示照片建立 `place_identities`。legacy 行程地點只能經同旅程既有 `trip_places.legacy_place_id` 關聯解析。地點名稱不作為身分匹配鍵；不建立或合併身分來湊內容。手動地點、未知店、同名分店及未關聯的 travel-only 地點不借用其他地點的內容或照片；原有可確認的行程資料仍保留。

完整策展內容與依 position 排序的前三張照片由同一 SQL statement 讀取 publication snapshot，且在 JSON aggregation 前即限制為 3。預覽批次只取首張策展 metadata 及 capped count，沒有策展照片時查儲存的 Commons 代表照片，再沒有就回 null。三種 reference 都不呼叫 Google、不消耗 `place_photo_metadata` 額度。詳細照片才走下述 Google fallback。

## 經人工查核的 catalog

- `apps/api/data/place-details/initial-places.json`：清水寺、東福寺、永觀堂；每處七類敘述、各三張不同作品。
- `apps/api/data/place-details/verification-places.json`：香港公園單張照片，僅供非京都控制驗收；不是自動替真實旅程發布。
- `apps/api/assets/place-photos/`：十個實際作品的二十個 JPEG 衍生檔（展示版及縮圖），以內容 SHA-256 命名。

catalog 不會在啟動時依名稱自動套用。營運者必須逐一確認現有 canonical identity 與實際地點，再明確匯入；新加的任意景點沒有照片是正常狀態，不可借用其他地點的照片。

每個作品保留獨立的作者、credit、作品頁、原始檔來源、授權名称／版本／連結、拍攝日期（未知為 null）、查核時間、永久版本查核網址、地点判別證據、原始尺寸、修改說明及限制。Commons 查核網址必須指向 numeric `oldid` 或 `Special:PermanentLink`，不能只有會變動的目前頁面。不同作品的 CC BY-SA 4.0、CC BY 2.5、CC0 不合併為固定相簿署名。衍生檔縮放與詳情預覽 CSS 裁切的說明保留；完整檢視器以 contain 呈現完整構圖。歷史照片不表示當日景況或夜間開放。

## Google Places 照片 fallback

策展照片優先，其次是已儲存的 Commons 代表照片，不以 Google 補滿。只有詳情兩者都沒有且具有 provider identity 時，才用一次 Google Places (New) metadata 查詢取得前三張 `googlePhotos[0..2]`；前三張任一 metadata 無效時整組失敗，不能壓縮陣列改變 index。加入前的主動搜尋仍可顯示 index 0 照片，候選比較由使用者開啟後讀詳情。所有 client URL 都是同源 `/api/trips/.../google-place-photos/...`，不包含 Google API key。

每張 Google DTO 的 `index` 為 `0 | 1 | 2`，ID 為 `google:<providerPlaceId>:<index>:<fingerprint>`。縮圖與大圖 URL 必須帶相同的 index、fingerprint、resource、exp、sig。`sig` 是 `TOKEN_SECRET` 對 `tripId|userId|providerPlaceId|index|fingerprint|photoName|exp` 的 HMAC-SHA256 base64url，其中 `photoName` 是 `places/<providerPlaceId>/photos/<resource>`。`exp` 固定為簽發當日之下一個 UTC 日結束。竄改 index、fingerprint、resource、過期、跨旅程或換使用者，均不能以原簽章取得 media。

DTO 仍以尺寸、依序的作者 display name／URI，以及 Google 提供時的 `googleMapsUri` 計算 SHA-256 前 16 個小寫十六進位字元作 fingerprint；index 區分相同 metadata 的位置。圖片代理驗章後直接以簽發時的完整 photoName 取 media，不再 GetPlace，也不重新解讀上游排序。resource 過期由 Google media 回應映射為 404，不偷換成另一張照片。取得 `photoUri` 使用 `skipHttpRedirect=true`；短效 URL 必須是 HTTPS `googleusercontent.com` 或其子網域，最多手動跟隨兩次並逐次驗證 host，只接受 JPEG、PNG、WebP，metadata 上限 256 KiB，圖片上限 5 MiB，圖片抓取逾時 8 秒。照片名稱、短效 URL 與 bytes 不寫入 PostgreSQL、檔案或 server cache；只有瀏覽器依 private header 暫存。依 [Google Places 政策](https://developers.google.com/maps/documentation/places/web-service/policies#photos)，使用 Google 圖片時顯示 `Google Maps`、作者署名及該張照片自己的 Maps 連結。

`photos` field mask 屬於 **Essentials IDs Only** SKU；依 [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing)（2026-10-12 查閱）不計費，但仍受配額與延遲影響。當時 Google Place Photo media 每月前 1,000 次免費，其後每 1,000 次 US$7（每次 US$0.007）：未命中 browser cache 時，詳情只看首張是一次 media，看完三張為三次、免費額度後合計 US$0.021。每月 1,000 次打開若都只看首張，剛好用完免費池；若都看三張，3,000 次扣免費後為 US$14。這是有日期的價格紀錄，不是重新查價。口袋／AI／今天清單不載入 Google media；主動搜尋結果的 192px Google 縮圖仍是另一個 media request，照片數 badge 不發 request。

#149 記錄 2026-10-18 的 `GetPlaceRequest` quota 為 2,000/day。新版清單 preview 用零次 Google；詳情 fallback 一次 metadata；media 不再追加 GetPlace。`/place-previews` 使用 `Cache-Control: private, max-age=3600`；`/place-details` 另加 `Vary: Cookie`，正常時 private/max-age=3600，`photosUnavailable` 時 private/no-store，避免快取暫時失敗。UI 顯示「照片暫時無法載入」，不誤稱沒有照片。media 仍是 private/max-age=86400。

## Commons 候選與檢舉

依序部署 `032_commons_photo_candidates`、`033_commons_candidate_names`；後者加入 `names`、`instance_of` 與 `auto_applied`。strict CID backfill 只讀既存 source URL，列出 no_cid、no_item、multiple_items、no_p18、licence_rejected、error 或 matched，完全不查 Google。候選搜尋另用多語 label／alias 與 1 km 座標範圍；只保留有名稱關聯、P18 及合格 Commons 授權／rendition 的候選。

自動套用限 worship／nature／museum，必須 exact normalized label／alias、類型相容、已知距離 ≤300 m，且只有一個合格候選。其他候選使用左右對照由成員確認／拒絕。`--refresh` 更新候選 facts，移除無關 pending，保留 confirmed／rejected 決定。回填命令與部署前提見 [README](../../README.md#commons-candidate-backfill-migrations-032033)。

`GET /api/trips/:tripId/commons-candidates` 讀候選；`POST .../commons-candidates/:candidateId/decision` 接受 confirm／reject；`GET .../commons-candidates/:candidateId/assets/:filename` 讀受保護圖片。`POST /api/trips/:tripId/trip-places/:tripPlaceId/commons-photo/report` 在同一交易刪除 Commons 代表照片並標為 rejected；strict store／候選決定／檢舉共用 identity-first lock，避免被拒絕照片又寫回。web 搭配 `commonsPhotoReportable`、trip-place reference 與編輯權限顯示「這不是正確的圖片？」。已無照片回 409，其他候選可繼續比對。

新增地點後的 16 秒 refresh 同時更新候選、no-cache preview 與已開啟的詳情。背景 auto_applied 不會留下 pending 候選，所以不能只靠候選 banner 更新圖片。


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

每份 CLI JSON 輸入上限 8 MiB。圖片須放在 packaged asset root，以 64 位小寫 SHA-256 加 `.jpg`／`.png`／`.webp` 命名；manifest 提供相同 SHA-256、實際尺寸及 media type。逐檔拒絕 symlink、非法路徑、非一般檔案、超過 20 MiB、雜湊／容器／尺寸不符。所有檔案先驗證，再以 advisory-locked transaction 取代本次各 identity 的內容與照片。任一較晚 entry 失敗也不部分發布；重複同份合法輸入不增加副本。清空策展照片陣列會發布零張策展照片；若地點有 Google provider identity，讀取時才依上述政策嘗試 fallback，且不把結果寫回 catalog。策展照片 GET 仍檢查 packaged 檔案完整性。

新增目的地沿用相同 manifest／bindings／資產流程，不新增名稱特例。未查核的作品不能靠合法格式的 JSON 就被稱為授權查核完成；營運者仍須保留實際逐張來源證據。

## 日期、未知與衝突

來源保留 `checkedAt`、`publishedAt`、`validFrom`、`validUntil`、`expiresAt`，不把 read time 重寫成查核日期。有效期間含首尾日期。來源到期，或不涵蓋請求的旅程日期，相關 block 的 `needsRecheck` 為 true；UI 保留原文字、來源與日期並顯示「需要重新確認」。`certainty` 的 `unknown`／`conflicted` 亦明示，不自行挑值或修改行程。

一張全年時段表不代表每項季節活動全年適用。清水寺 daytime 2026-09-01–11-20 與 autumn night 2026-11-21–11-30 分別使用自己的適用範圍，即使兩者來自同一官方網址。

## UI、失敗與 Today snapshot

相簿支持零／一／兩／多張；署名與完整資訊對應選中的作品。照片網路失敗只影響該作品，詳情文字及其他照片不等待它。56px 小資訊列必須是主詳情捲動的一部分，沒有內層垂直捲動；截斷的摘要不能取代完整資訊入口。放大／關閉不得改動加入原因、投票、行程或其版本。

Today snapshot schema version 6 保留 endpoint 的 legacy Place reference、歷史參與者移除狀態、wishlist routing facts 與地點 type。wishlist 沿用 TripPlace `id`，不存未使用的 canonical `placeId`。合格 version 2／3／4／5 在同帳號、exact-key 檢查後遷移到 6：version 2 缺少的 endpoint reference、version 2／3 缺少的 participant removal、version 2–4 缺少的 wishlist routing facts、version 2–5 缺少的 place type 保持 null，不從別份快照猜測。遷移通過完整驗證後，即使 `setItem` 因 quota 失敗，也返回可讀記憶體結果並保留原值。照片或 optional 詳情失敗不使核心 snapshot 作廢；Google metadata 不進 snapshot，離線不發起 authenticated 詳情讀取。

資訊列使用固定 CSS pixels，而非隨 root 字級成長的 rem 高度；兩列摘要之外，完整資訊控制占滿獨立的 56px 欄位。檢視器明確覆寫共用 Dialog 的 responsive max-width，且 metadata 欄寬同時受可用寬度比例與最大寬度限制，不能把圖片欄擠到零。metadata 標籤／內容依自身 container 寬度排版，不以整個 viewport 推定狹窄側欄能放兩欄。

桌面檢視器固定照片區，完整資訊欄獨立捲動；手機保留整個檢視器捲動。開啟聚焦標題，不能因長作者取得焦點而把照片捲出畫面。圖片 grid item 明確允許縮小，直式作品不以 intrinsic 最小高度撐出 viewport。關閉控制至少 44px；reduced-motion override 必須勝過共用 Dialog 的 data-state 動畫。

口袋名單／建議頁／Today 按實際 section container 寬度切換雙欄，不能僅按整個 viewport 假定有空間容納 rem 側欄。入口保存原視窗位置，關閉時先無捲動地恢復焦點，再還原該位置；閱讀不改寫任何投票或排程資料。

## 歷史驗收與追蹤（#149 之前）

本節保留早期實作的驗收、暫存證據與當時工作狀態；不代表這次 #149／候選流程已跑過相同檢查。這次實際 CI 結果記在 release PR，owner browser 驗證仍是 `UNVERIFIED`。

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
