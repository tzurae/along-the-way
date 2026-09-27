# 香港旅程共同規劃 MVP 規格

- 狀態：已完成產品設計，等待使用者審閱書面規格
- 日期：2026-08-17
- 範圍：第一階段「共同規劃 MVP」

## Problem Statement

目前的香港旅程網站是一個離線優先的靜態頁面。它已能顯示五日行程、天氣替代模式、景點說明、交通段與外部連結，但所有旅程、景點、評分、評論與規則都直接寫在前端資料中。只有修改程式的人能調整內容，旅伴無法加入想去的地方、表達自己的偏好，系統也無法根據固定訂位、營業時間與交通順暢程度提出可信的插入方案。

這使共同規劃退化成在聊天軟體、Google Maps 與現有網站之間反覆切換。當兩人的偏好不同、景點休息、需要預約或路線明顯繞路時，使用者必須自行比較，而且無法看見修改前後的代價。若系統只提供看似聰明但不可解釋的自動重排，使用者反而更難信任它。

使用者真正需要的不是另一份景點功課，而是一個有溫度、以人為本的共同規劃空間：兩個人都能留下自己的意願，系統尊重固定事項與現實限制，提出少量可理解的選項，並讓人保有最後決定權。

本規格只處理第一階段「共同規劃 MVP」。旅途中即時重新規劃、完整資料型離線模式、公開註冊與付費訂閱屬於後續階段。

## Solution

建立一個僅限邀請的共同旅程 Web App，將現有香港行程匯入後端資料庫。旅程建立者可邀請旅伴以 Email 一次性連結登入；兩人能分別加入地點、設定「必去／想去／可有可無／不想去」、補充預算、停留時間、日期偏好與預約狀態。

使用者要求安排某個地點時，系統會先套用不可違反的硬限制，再依兩人偏好、額外交通、折返、行程節奏、用餐時間與預算產生最多三個可解釋方案。每個方案都顯示放在哪一天、插在何處、增加多少交通、是否需要移動或取代既有項目、資料來源與仍需人工確認的風險。系統只提供預覽，不會在使用者確認前改動正式行程。

核心規劃採可重現的規則與分數模型，不讓生成式 AI 決定行程。外部地點、路線與評論資料透過可替換的供應商介面取得；取得不到時顯示「未知」，不把未知包裝成安全。Google 評論只呈現 API 提供的代表性評論及其中的風險訊號，不宣稱取得全站最佳或最差評論。

現有 GitHub Pages 網站在新系統測試期間繼續存在，作為可公開閱讀與故障回退版本。新系統先在獨立測試網址只開放給兩位使用者，完成真實共同規劃驗收後才決定切換入口。

## User Stories

1. 身為旅程建立者，我想用 Email 一次性連結登入，以便不必建立及記住另一組密碼。
2. 身為旅程建立者，我想在第一次登入後保持登入狀態，以便規劃期間不必反覆驗證。
3. 身為旅程建立者，我想邀請指定 Email 的旅伴加入旅程，以便只有預期的人能看到私人行程。
4. 身為旅伴，我想透過有期限的邀請連結加入，以便快速開始共同規劃。
5. 身為旅程建立者，我想撤銷尚未使用的邀請，以便錯寄時能立即阻止存取。
6. 身為旅程建立者，我想移除旅程成員，以便我能控制旅程資料的存取權。
7. 身為旅程成員，我想知道誰加入或修改了內容，以便共同規劃具有責任脈絡。
8. 身為旅程成員，我想只能存取自己加入的旅程，以便其他旅程的私人資料不會外洩。
9. 身為旅程成員，我想看到既有香港五日行程被完整匯入，以便不必重新輸入已完成的規劃。
10. 身為旅程成員，我想依日期查看每日時間線，以便快速理解每一天要做什麼。
11. 身為旅程成員，我想在兩站之間看到交通方式、預估時間與順路程度，以便理解路線而不是只看景點清單。
12. 身為旅程成員，我想把住宿、航班、固定訂位與一般景點視為不同類型，以便畫面顯示真正相關的資訊。
13. 身為剛抵達的旅客，我想在機場與飯店項目先看到入住、行李與交通資訊，以便不被不重要的歷史介紹干擾。
14. 身為餐廳訪客，我想先看到價位、用餐時段、休息日與預約狀態，以便判斷是否能實際前往。
15. 身為景點訪客，我想看到歷史背景、推薦理由、票價、導航與風險評論，以便理解為什麼值得安排。
16. 身為旅程成員，我想從主選單進入住宿與交通資訊，以便它們隨時可取用又不搶佔每日行程主畫面。
17. 身為旅程成員，我想在手機與桌面上使用一致的視覺語言，以便不必重新學習操作方式。
18. 身為旅程成員，我想貼上 Google Maps 或 maps.app.goo.gl 連結新增地點，以便直接使用朋友傳來的推薦。
19. 身為旅程成員，我想用文字搜尋地點，以便沒有連結時仍能快速加入。
20. 身為旅程成員，我想手動建立查不到的地點，以便私人住所、臨時活動或新店仍能保留在想去清單。
21. 身為旅程成員，我想在位置資訊不足時看見「需要補充位置」，以便系統不會假裝能計算路線。
22. 身為旅程成員，我想讓相同 Google Place ID 的地點自動合併，以便同一間店不會因兩人重複加入而分裂。
23. 身為旅程成員，我想在疑似重複但證據不足時自行確認，以便同名分店不會被誤合併。
24. 身為旅程成員，我想知道地點是誰加入的並保留原始備註，以便理解推薦脈絡。
25. 身為旅程成員，我想把地點留在未排程的想去清單，以便不必加入後立刻決定日期。
26. 身為旅程成員，我想標示自己對地點的必去、想去、可有可無或不想去，以便系統保留每個人的真實意願。
27. 身為旅程成員，我想修改自己的偏好而不覆蓋旅伴的偏好，以便兩人的意見不會混成一筆資料。
28. 身為旅程成員，我想看見一方必去、另一方不想去的明確衝突，以便系統不會用平均分數掩蓋分歧。
29. 身為旅程成員，我想補充預計停留時間，以便系統能判斷一天是否塞得下。
30. 身為旅程成員，我想設定希望或禁止安排的日期，以便配合展覽日、同行者時間與個人偏好。
31. 身為旅程成員，我想提供每人或整體預算，以便超出預算的方案被明確標示。
32. 身為旅程成員，我想把航班、住宿、已付款活動與餐廳訂位設成固定事項，以便規劃器不能偷偷移動它們。
33. 身為旅程成員，我想記錄是否不需預約、可能需要、建議預約、已預約、已額滿或尚未確認，以便預約風險不是一個模糊標籤。
34. 身為旅程成員，我想保存訂位時間、訂位人、備註與官方連結，以便現場需要時能快速找到資訊。
35. 身為旅程成員，我想鎖定特定行程項目，以便重新規劃時保留我明確決定的內容。
36. 身為旅程成員，我想要求系統替一個想去地點找安排方式，以便不用逐日手動試排。
37. 身為旅程成員，我想看到最多三個真正可行且有差異的方案，以便能比較而不被大量選項淹沒。
38. 身為旅程成員，我想在只有一個可行方案時看到一個方案而非湊數，以便結果保持誠實。
39. 身為旅程成員，我想在沒有可行方案時知道是哪個限制造成，以便決定是否調整限制。
40. 身為旅程成員，我想知道每個方案增加多少交通時間，以便判斷景點是否值得繞路。
41. 身為旅程成員，我想知道方案是否造成折返與行程過緊，以便避免紙上可行、現場痛苦的安排。
42. 身為旅程成員，我想知道方案尊重或衝突了哪些人的偏好，以便討論取捨。
43. 身為旅程成員，我想知道方案是否影響用餐時間、預算或既有低優先項目，以便看見完整代價。
44. 身為旅程成員，我想在方案需要取代既有項目時看見被取代內容，以便沒有任何行程被悄悄刪除。
45. 身為旅程成員，我想看到修改前後的同日時間線與路線，以便在確認前理解結果。
46. 身為旅程成員，我想選擇插入、取代或保持未排程，以便系統建議不會剝奪手動控制。
47. 身為旅程成員，我想在正式套用前再次驗證固定限制與資料新鮮度，以便過期方案不會破壞行程。
48. 身為旅程成員，我想在接受方案後讓兩台裝置看見相同結果，以便共同規劃保持同步。
49. 身為旅程成員，我想在兩人同時修改不同內容時自動保留兩邊變更，以便不發生無謂衝突。
50. 身為旅程成員，我想在兩人同時修改同一內容時看到差異，以便選擇而不是讓後存檔者覆蓋前者。
51. 身為旅程成員，我想查看修改紀錄，以便知道行程何時、由誰、為何被調整。
52. 身為旅程成員，我想讓重試中的新增與套用操作保持唯一，以便網路不穩時不會出現重複資料。
53. 身為旅程成員，我想看到 Google 分數、評論數、來源與查詢時間，以便知道資訊不是永久有效的事實。
54. 身為旅程成員，我想優先看 API 回傳評論中的低分風險訊號，以便提早知道排隊、服務、價格或品質問題。
55. 身為旅程成員，我想被告知評論是依關聯性提供、並非真正的全站最差評論，以便不被誤導。
56. 身為旅程成員，我想能開啟每則評論與地點的原始 Google Maps 頁面，以便查看完整最新內容。
57. 身為旅程成員，我想在外部服務失敗時仍看見已確認行程，以便地圖 API 故障不會讓整個旅程消失。
58. 身為旅程成員，我想看到「未知」「資料過期」與「確認衝突」等文字狀態，以便資訊不只依賴顏色傳達。
59. 身為旅程成員，我想讓行程文字與主要操作先出現、圖片稍後載入，以便慢速網路下仍能立刻開始使用。
60. 身為旅程成員，我想使用清楚的焦點狀態、足夠對比與鍵盤操作，以便不同裝置與能力的使用者都能完成規劃。
61. 身為系統管理者，我想限制登入信件、地點查詢與規劃請求頻率，以便個人開發者的成本不會失控。
62. 身為系統管理者，我想看見外部服務錯誤、規劃失敗與背景任務狀態，以便能診斷問題而不讀取私人行程內容。
63. 身為系統管理者，我想每天把資料庫加密備份到主機之外，以便單一主機故障時仍能恢復。
64. 身為系統管理者，我想定期執行還原演練，以便備份不是只有檔案存在而從未被驗證。
65. 身為系統管理者，我想在新系統出問題時保留既有 GitHub Pages 網站，以便使用者仍有可靠的唯讀行程。

## Implementation Decisions

### 1. Scope and migration boundary

- 本次只實作共同規劃 MVP：邀請式登入、單一已匯入旅程、想去清單、成員偏好、限制與預約、可解釋插入方案、預覽與確認、同步與修改紀錄、可信的地點詳情。
- 現有靜態網站保持可部署與可公開閱讀。新應用使用獨立測試網址；通過兩人真實驗收前不取代 GitHub Pages。
- 建立可重複執行的匯入程序，把現有五日旅程、景點、日程、交通段、固定事項、歷史說明、推薦理由、價格參考與資料來源轉成正式資料。
- 現有硬編碼的 Google 評論文字與評分不作為永久資料匯入；新系統依供應商條款即時取得並正確標示來源。
- 資料模型從第一天支援多旅程與多成員，但 MVP 介面只開放既有香港旅程與兩位受邀使用者，不製作公開建立旅程流程。

### 2. Human-centered experience

- 視覺延續目前溫暖、安靜、內容優先的方向，建立單一設計 token 與元件層，統一字級、間距、色彩、圖示、按鈕、焦點及錯誤狀態。
- 主要導覽為「每日行程」「想去清單」「旅程資訊」「成員」。住宿與交通進入旅程資訊，不在每日行程上方長期佔位。
- 每日行程以日期、當日目的、時間線和站點間交通為主。交通段放在兩個站點之間，顯示方式、時間、順路／繞路與「開啟路線」。
- 地點詳情依類型顯示：機場與飯店優先呈現抵達、入住、行李及交通；餐廳優先呈現價位、營業、預約及評論風險；景點才呈現歷史、推薦理由、門票及參觀時間。
- 每張卡只顯示有用的資訊圖示。歷史、推薦、價格、地圖與評論使用一致但可辨識的圖示，不渲染不適用的空區塊。
- 行程所屬狀態不重複顯示。例如使用者已位於某個模式或清單中，不再在每張卡重複「正常保留」「雨天保留」等標籤。
- 新增地點流程固定為：貼連結／搜尋／手動新增 → 確認地點 → 填偏好與限制 → 儲存至想去清單 → 要求安排。
- 推薦流程固定為：產生方案 → 比較理由與代價 → 查看修改前後 → 確認插入、取代或不排程。確認前正式行程保持不變。

### 3. Application architecture and runtime

- 採 TypeScript 模組化單體，不採微服務。前端使用 React 與 Vite；後端使用 Bun 執行 Hono；資料存取使用 Kysely；主要資料庫為 PostgreSQL 並啟用 PostGIS。
- 前端與 API 使用同一來源網域，避免不必要的跨來源 Cookie 與 CORS 複雜度。Caddy 負責 TLS、壓縮、靜態資產與反向代理。
- API 與背景工作程序由同一份應用映像啟動為不同程序。背景工作處理 Email、資料重新驗證、過期邀請與備份狀態，不引入 Redis。
- 簡單工作佇列使用 PostgreSQL 工作表與 advisory lock，確保單一工作只被一個 worker 處理。MVP 為單一應用節點，但介面不依賴單一程序記憶體。
- Docker Compose 包含 Caddy、應用、worker、PostgreSQL/PostGIS 與備份工作。正式環境部署於 AWS Lightsail 香港區 2 GB RAM／2 vCPU 起始方案。
- 執行環境與框架只透過內部介面被領域模組使用，保留未來把 Hono 應用移到其他 Bun／Node 相容平台的能力。

### 4. Module boundaries and primary testing seam

- Identity & Access 負責 magic link、session、invite 與 membership authorization。
- Trip Workspace 負責旅程、成員、日期、旅程資訊與版本。
- Place Intake 負責 Google Maps 連結解析、搜尋、手動地點與去重。
- Preferences & Constraints 負責成員偏好、停留時間、日期偏好、預算、固定事項與預約狀態。
- Itinerary 負責每日時間線、行程項目、鎖定狀態、交通段及確認版本。
- Planning Service 是最高且主要的測試接縫。它接收一份完整規劃快照與供應商觀測值，無副作用地回傳零到三個方案及 reason codes。
- Provider Adapters 將地點、路線、Email 與未來天氣供應商隔離在領域之外。領域規則不直接依賴 Google 回應格式。
- Suggestion Acceptance 負責重新驗證、樂觀鎖、冪等、交易式套用與修改事件。
- Place Detail 負責把第一方內容、官方來源與當次供應商資料組合成可展示模型，並執行 attribution 規則。
- Audit & Notifications 負責不可變修改事件、即時更新通知與可供使用者閱讀的變更摘要。
- 對外 application operations 固定涵蓋：請求／消耗 magic link、讀取／登出 session、讀取旅程工作區、邀請／移除成員、解析／搜尋／建立地點、設定偏好／限制／預約、產生方案、接受方案、讀取修改歷史及訂閱旅程事件。
- 所有 mutation contract 都包含 trip identity；會改動既有 aggregate 的操作另包含 expected version，可能重試的操作另包含 idempotency key。回應只回傳授權後的 read model，不直接暴露資料庫資料列。
- 錯誤使用穩定 machine code 與安全的人類說明，至少區分 validation、unauthenticated、forbidden、not-found、conflict、stale-suggestion、provider-unavailable、rate-limited 與 internal；前端不靠比對錯誤文字決定流程。

### 5. Data model

- `User` 保存穩定身分、Email、顯示名稱與狀態。
- `Trip` 保存名稱、日期範圍、時區、預設幣別、目前 itinerary version 與狀態。香港旅程使用 `Asia/Hong_Kong` 與 HKD。
- `TripMember` 連結使用者與旅程，角色為 owner、editor 或 viewer。MVP 使用 owner 與 editor；viewer 先保留在授權模型中。
- `Place` 保存內部識別、可合法長期保存的第一方／使用者資料及供應商 reference。Google Place ID 可保存；其他 Google Places 內容只有在條款允許時才持久化。
- `TripPlace` 保存旅程中的候選地點、加入者、原始備註、來源連結、希望日期、停留時間、預算、可替代性與排程狀態。
- `MemberPlacePreference` 每位成員每個候選地點一筆，值為 must、want、optional、neutral 或 dislike，避免平均覆蓋個別意見。
- `ItineraryDay` 保存日期、標題、目的、可用時間窗與每日版本資訊。
- `ItineraryItem` 保存項目類型、開始時間或時間窗、停留時間、排序、鎖定狀態、TripPlace reference 及使用者備註。類型至少區分 transport、lodging、reservation、meal、attraction、free-time。
- `ItineraryLeg` 保存兩個確認項目間的交通模式、使用者確認備註與可合法保存的資料；即時供應商時間按供應商保存政策處理。
- `Constraint` 保存固定時間、不可移動、最小緩衝、禁止日期、預算上限及來源。值可為 confirmed、unknown 或 conflicted。
- `Reservation` 保存狀態、日期時間、訂位人、官方連結、備註及確認時間。狀態為 not-needed、unknown、possibly-needed、recommended、booked、unavailable。
- `SuggestionRun` 保存請求者、候選地點、輸入 itinerary version、規劃規則版本、建立與過期時間。
- `SuggestionOption` 保存插入／取代意圖、reason codes、分數構成、風險、人工確認項目與基準版本；不得永久保存條款不允許保存的供應商原始內容。
- `ChangeEvent` 是不可變事件，保存 actor、旅程、事件類型、目標、前後摘要、理由與時間，用於歷史及同步。
- `MagicLinkToken`、`InviteToken` 與 `Session` 保存雜湊 token、期限、使用／撤銷時間及必要的裝置資訊。
- 所有旅程所有資料列都具有 trip scope；任何查詢與修改都必須先通過 TripMember 授權。
- 真實時間點以 UTC instant 保存；每日日期與沒有時區的行程鐘點連同 Trip timezone 保存，避免部署地區或夏令時間改變行程。金額以最小貨幣單位整數與 ISO currency 保存，不使用浮點數。

### 6. Authentication, invitations, and authorization

- 登入使用 Email magic link。登入 token 單次使用、只保存雜湊、15 分鐘失效；成功後建立 30 天滑動式 session。
- Session 使用 Secure、HttpOnly、SameSite=Lax Cookie。登出、移除成員或安全事件可撤銷所有相關 session。
- 邀請綁定指定 Email、單次接受、7 天失效，owner 可隨時撤銷。已接受邀請後，兩位成員仍各自擁有獨立身分與偏好。
- MVP 不開放公開註冊。初始 owner 由部署時的 bootstrap Email 建立；其後只有有效邀請能加入旅程。
- owner 可邀請、撤銷邀請及移除成員；editor 可編輯旅程但不能管理 owner；viewer 只能閱讀。
- 授權集中在後端 Membership Policy，不依賴前端隱藏按鈕。所有 trip-scoped application service 都先執行同一授權檢查。

### 7. Place intake and duplicate handling

- 支援 Google Maps 完整網址、`maps.app.goo.gl` 短網址、文字搜尋及手動新增。
- 解析短網址時只允許已核准的 Google Maps host，限制重新導向次數、回應大小與逾時，禁止伺服器請求任意 URL，避免 SSRF。
- 成功解析後以 provider place ID 作為最強去重鍵。同一 trip 已存在相同 ID 時，合併成同一 TripPlace，保留兩位加入者與各自備註／偏好。
- 沒有 provider ID 時，使用正規化名稱、地址與距離產生「疑似重複」提示；不得在信心不足時自動合併不同分店。
- 手動地點若沒有足以路由的位置，可保存到想去清單但狀態為 needs-location，不能進入規劃器。
- 所有外部查詢結果都攜帶 provider、observed-at、attribution 與可用期限，畫面不得只顯示無來源事實。

### 8. Constraints, reservations, and fact certainty

- 硬限制包括航班、飯店轉移、已確認訂位、鎖定項目、固定時間窗、場館確認休息日、最後入場時間、停留時間與最小交通緩衝。
- 確認不可能的 placement 必須被排除。資料未知時不得視為可行；可保留為低信心方案，但必須列入 manual checks，且不能標為「無風險」。
- Google 的 `reservable` 只代表支援預約，不能轉換成「仍有位置」或「已預約」。只有使用者確認或可驗證的訂位資料才能將狀態設為 booked。
- 固定項目不能被規劃器移動或取代。若使用者想違反固定限制，必須先明確解鎖或修改該限制，再重新產生方案。
- 背景工作在旅程前 7 天及前 1 天重新確認已排行程的營業與預約風險。發現變更只通知並標示衝突，不自動改寫行程。

### 9. Explainable planning engine

- Planning Service 先列舉所有日期及可插入位置，再執行 hard feasibility gate。通過者才進入軟性排序。
- 軟性因素包含：每位成員偏好、額外交通時間、折返、當日可用時間比例、用餐時間、預算、室內／戶外屬性、候選優先度與既有項目的可替代性。
- 初始排序採可讀級距而非不可追蹤的黑盒權重：額外交通 15 分鐘內為佳、16–30 分鐘為可接受、31–60 分鐘為明顯代價、超過 60 分鐘除非存在 must 偏好否則不列為推薦；使用超過每日可用時間 95% 視為不可行，81–95% 標為緊湊；超過預算是軟性風險而非自動禁止。
- must 與 dislike 的成員衝突不可互相抵消。方案可因一人的 must 而出現，但必須以 preference conflict 顯示另一人的 dislike，不能被描述為雙方都適合。
- 規劃器只可取代未鎖定且標為 optional／可替代的項目；所有取代方案都必須明示犧牲內容。
- 回傳最多三個具有實質差異的方案：最佳插入、其他日期／時段，以及必要時的明確取代方案。少於兩個可行方案時不湊數。
- 每個方案包含日期、插入位置、前後時間線差異、交通增量、折返判斷、偏好符合與衝突、預算影響、被取代項目、資料來源、confidence、manual checks 與 reason codes。
- confidence 依硬資料完整性與新鮮度產生：必要欄位皆可驗證為 high；非關鍵資訊未知為 medium；營業、位置、停留或交通等關鍵資訊未知為 low。
- 人類可讀說明由 reason codes 與模板產生。MVP 不允許生成式 AI 改變 placement、硬限制或分數；未來即使加入文字潤飾，也只能解釋既有結構化結果。
- 同一輸入快照、供應商觀測值與規則版本必須產生相同排序，並以穩定 tie-breaker 保證可重現。

### 10. Suggestion lifecycle and acceptance

- 產生方案時先取得最新可用的 place facts 與 route observations，再建立無副作用的 suggestion run。
- 方案綁定 itinerary version、偏好／限制版本與資料觀測時間。規劃 MVP 的方案最長有效 24 小時；任何相關版本改變立即失效。
- 接受方案時重新檢查 membership、idempotency key、基準版本與所有硬限制。外部關鍵資料超過 24 小時時先重新取得並重跑規劃。
- 若重跑後選定 placement 已不再等價，回傳 stale suggestion，保留原方案供比較但不套用，要求使用者選擇新方案。
- 成功接受時，在單一資料庫交易中更新行程、遞增 itinerary version、標記 suggestion 已接受並寫入 ChangeEvent。
- 每個 mutation 接受 client-generated idempotency key；相同使用者、旅程與 key 的重試回傳原結果，不執行第二次。

### 11. External data, reviews, photos, and freshness

- 地點搜尋、詳情與路線使用供應商 adapter。第一個 adapter 使用 Google Places／Routes，但領域模型不暴露 Google-specific response shape。
- 只請求當次畫面或規劃真正需要的 fields，避免不必要成本。評分、評論、營業時間及照片在使用者開啟詳情或要求規劃時取得，不作全旅程預抓。
- 長期保存 Google Place ID；Google 建議超過 12 個月重新確認 ID。其他 Google Places 內容依官方保存與 attribution 規範處理，不建立無期限本地複本。
- 評論區清楚標示 API 最多提供五則依關聯性排序的代表性評論。若回傳中包含三顆星以下內容，顯示為「風險評論」；若沒有，明確說明本次代表性評論中沒有低分內容。
- 不使用 scraping 取得完整評論，不宣稱代表性評論是全站最佳／最差。每則評論按供應商提供內容顯示作者頭像、名稱、作者頁連結、相對時間、翻譯狀態（若有）與個別 Google Maps 來源連結；空間受限時仍遵守官方最低 attribution 要求。
- 供應商不可用時，保留第一方行程、使用者備註與上次確認狀態；rating、hours、reviews 與 live route 顯示 unavailable／unknown，不用舊值假裝即時。
- 精選圖片分兩類：具有可驗證授權與 attribution 的第一方／策展圖片可存放 CDN；Google Place Photos 即時取得並按官方規範顯示，不永久快取 photo name 或圖片內容。
- 圖片使用尺寸資訊、占位骨架、lazy loading 與非阻塞解碼。主要行程文字和操作不得等待圖片或評論才渲染。

### 12. Concurrency and collaboration updates

- 所有可變 trip aggregate 使用樂觀版本控制。不同 aggregate 的不衝突修改可各自成功；同一版本上的衝突修改回傳 current version 與使用者可讀差異。
- 客戶端不自動覆寫衝突。使用者可重新套用自己的變更、接受目前版本，或回到比較畫面。
- 同步通知使用 Server-Sent Events，事件只包含 trip version、entity type、entity ID 與 change summary；客戶端收到後重新讀取授權資料。
- SSE 斷線時使用漸進退避重連，並以視窗重新聚焦及低頻輪詢作為 fallback。同步失敗不阻止目前畫面閱讀。
- ChangeEvent 提供歷史及衝突脈絡，但不保存敏感 token、完整供應商回應或秘密資料。

### 13. Error handling and degraded behavior

- 已確認行程來自 PostgreSQL，外部供應商故障不能讓頁面整體失敗。頁面分區顯示地點、路線、評論各自狀態。
- 可重試的 provider timeout、rate limit 與暫時錯誤使用有上限的 exponential backoff；驗證錯誤、權限錯誤與確認不存在的地點不重試。
- 規劃請求可在 route provider 部分失敗時回傳「無法可靠比較」及 manual checks，但不得偽造分鐘數或順路結論。
- Magic link 請求永遠使用不洩漏帳號是否存在的通用回應。過期、已使用與撤銷 token 顯示可採取的下一步。
- 使用者輸入錯誤保留表單內容；系統錯誤提供可分享的 correlation ID，不向畫面暴露堆疊、SQL 或供應商秘密。
- 前端以文字、圖示及顏色共同表示 success、unknown、warning、conflict 與 unavailable，避免單靠顏色。

### 14. Security and privacy

- 所有輸入使用 schema 驗證；所有顯示的使用者文字安全轉義；外部連結使用安全 opener 行為。
- Cookie-based mutation 執行 same-origin／Origin 驗證及 CSRF 防護。登入、邀請、搜尋與規劃端點各自有 per-IP 與 per-account rate limit。
- Provider API key、Email credential、資料庫密碼與備份金鑰只存在部署 secrets，不進入前端 bundle、日誌或 Git。
- 應用資料庫帳號採最小權限。MVP 以集中式 Membership Policy 執行租戶隔離；PostgreSQL Row-Level Security 留作公開 SaaS 前的防禦加深，不在本規格內。
- 日誌不記錄 magic link、invite token、session cookie、完整評論、完整行程內容或私人備註；必要操作紀錄使用 stable IDs 與事件類型。
- 使用者移除成員時立即撤銷其 membership 與 session 存取；既有 ChangeEvent 保留 actor ID 與非敏感摘要以維持稽核完整性。

### 15. Performance, accessibility, and responsive behavior

- 行程資料與主要操作為首要內容；圖片、評論與次要 enrichment 延遲載入。外部 provider call 不阻塞已確認行程的初始顯示。
- 初次載入在一般 4G 條件下以 2.5 秒內顯示可操作的核心行程為目標；快取後的應用 shell 應更快。規劃請求立即顯示進度，目標在 10 秒內產生結果或明確部分失敗。
- 所有互動元件支援鍵盤、可見焦點、語意標籤與合理觸控目標。active 與 focus 使用與背景具互補對比的樣式，不以低對比同色系表示。
- 手機以底部主導覽與單欄時間線為主；桌面可使用側欄／雙欄比較。資訊順序一致，避免桌面與手機出現不同概念模型。
- 說明、來源與風險內容可展開，但主要決策資訊不藏在只能 hover 的狀態。

### 16. Deployment, backups, and rollout

- 正式起始部署使用 AWS Lightsail 香港區與 Docker Compose；Caddy 自動管理 HTTPS。成本目標為每月約 US$12–18，不含網域、Email 與依量計費的 Google Maps API。
- 每日資料庫備份加密後傳送到主機之外的 object storage，保留 7 份每日、4 份每週與 3 份每月備份。
- 每月至少執行一次自動還原驗證，並記錄備份時間、檔案校驗、還原完成與 schema health check。
- 提供應用 health、readiness 與 worker heartbeat；部署前執行 migration，migration 失敗不得切換流量。
- 上線順序為：建立 staging → 匯入香港旅程 → 建立 owner → 邀請旅伴 → 執行兩人真實流程 → 驗證備份還原與權限隔離 → 決定公開入口。
- GitHub Pages 在 MVP beta 期間保留。新系統發生嚴重問題時，使用者仍可透過舊網址讀取既有行程。

## Testing Decisions

### Testing principles and seam

- 好測試只驗證可觀察行為：輸入旅程快照、偏好、限制與 provider observations 後，檢查回傳方案、reason codes、資料變更與權限結果，不斷言私有函式、內部查詢順序或 React 元件實作細節。
- 最高且主要接縫為 Planning Service application interface。規劃規則的大部分組合測試都透過這一個接縫執行，使用手工建立的 provider observations，避免測試依賴網路。
- 次要接縫只有 Identity／Membership application service、Place Intake application service 與 Suggestion Acceptance transaction。UI 測試只覆蓋使用者關鍵流程。
- 現有靜態專案沒有自動測試或既有測試先例；本規格建立第一套測試慣例。TypeScript 單元／整合測試使用 Vitest，瀏覽器流程使用 Playwright，資料庫整合測試使用獨立 PostgreSQL/PostGIS 測試實例。

### Planning behavior tests

- 固定航班、飯店轉移、已確認訂位與鎖定項目永不被移動或取代。
- 確認休息、營業時間不足、最後入場來不及或交通緩衝不足的 placement 被排除。
- 關鍵資訊未知時，結果標為 low confidence 並列出 manual check，不被描述為安全。
- must 與 dislike 同時存在時保留 preference conflict，不平均成 neutral。
- 同一輸入、觀測值與規則版本產生相同排序與 reason codes。
- 額外交通級距、每日 80%／95% 節奏界線、預算警告與用餐時間影響符合規格。
- 只取代未鎖定且可替代項目，且回傳 sacrificed item。
- 最多回傳三個差異化方案；只有一個可行方案時不產生假替代方案；沒有方案時回傳阻擋原因。

### Identity, permissions, and data isolation tests

- Magic link 單次使用、15 分鐘失效、token 僅以雜湊保存，成功後建立正確 session。
- Invite 綁定 Email、7 天失效、可撤銷且不能重複接受。
- owner、editor、viewer 權限符合規格；非成員無法讀寫或猜測其他 trip ID 的資料。
- 移除成員後既有 session 立即失去該 trip 存取權。
- 帳號不存在與存在時的登入請求回應不洩漏差異。

### Place intake and provider tests

- 完整 Google Maps URL、允許的短網址、文字搜尋及手動新增都能產生明確結果。
- 短網址解析只跟隨 allowlist host 與有限 redirects；私人 IP、非 Google host、超大回應與逾時都安全失敗。
- 相同 provider ID 自動合併並保留兩位使用者資料；疑似同名分店只提示不自動合併。
- 無位置的手動地點可保存但不能要求規劃。
- Provider adapters 使用人工最小 fixture 做 contract tests，不把真實 Google 評論或受限制內容提交進測試資料。
- Google attribution、來源連結、代表性評論說明與翻譯標示在供應商有提供時正確呈現。

### Acceptance, concurrency, and failure tests

- 預覽不改變正式行程；成功接受在單一交易中更新行程、版本、suggestion 與 ChangeEvent。
- itinerary version 或相關偏好／限制版本變更後，舊 suggestion 被判定 stale。
- 相同 idempotency key 重試回傳相同結果且只產生一筆行程變更。
- 兩位使用者修改不同 aggregate 時都成功；修改同一舊版本時第二筆收到可比較 conflict，不發生 last-write-wins。
- SSE 斷線與重連不影響資料正確性；重新聚焦後能讀取最新版本。
- Place、route 或 reviews provider 個別失敗時，已確認行程仍正常顯示且失敗區塊標為 unknown／unavailable。

### End-to-end and release tests

- 使用兩個獨立瀏覽器 context 模擬旅程建立者與旅伴：登入、接受邀請、加入同一地點、各自表態、看到衝突、產生方案、比較、接受並在另一裝置看到更新。
- 驗證從朋友提供的 `maps.app.goo.gl` 連結加入地點到成功安排的完整 happy path。
- 驗證沒有可行方案、外部 API timeout、過期方案與同時編輯的 recovery paths。
- 在主要手機寬度與桌面寬度測試時間線、交通段、方案比較、詳情、焦點順序與觸控目標。
- 使用自動 accessibility 檢查加人工鍵盤流程；使用受控 4G 網路檢查核心內容 2.5 秒顯示目標與圖片不阻塞。
- 匯入測試確認五個日期、固定事項、順序、交通段、來源與使用者內容可重複匯入且不重複建立。
- 部署 smoke test 包含登入、資料庫 migration、health、background worker、Email adapter、provider adapter 與 HTTPS。
- 備份測試從最新加密備份還原到空白資料庫，驗證 schema、旅程數、成員數、itinerary version 與關鍵關聯完整。

## Out of Scope

- 公開註冊、自助建立多趟旅程、旅程範本與公開分享市場。
- Stripe 或其他付款、訂閱方案、用量計費、優惠碼、發票與付費管理後台。
- 三人以上的大型團體協調、投票規則、聊天室與留言討論串。
- 旅途中依目前位置、延誤、完成狀態與即時天氣自動重新規劃。
- 正常／太熱／下雨／惡劣天氣的資料型動態替代方案；現有靜態網站可繼續保有既有模式。
- 新 Web App 的完整離線資料同步與離線結構性編輯。資料型唯讀快照、完成勾選與離線筆記留到第二階段。
- 自動替使用者完成餐廳、門票、飯店或交通訂位與付款。
- 抓取 Google Maps 網頁、取得完整評論集、保證全站最佳／最差評論或永久保存受限制內容。
- 生成式 AI 自動決定行程、修改硬限制、靜默刪除內容或產生無來源事實。
- 任意地點的完整歷史研究與自動文章生成；匯入景點沿用策展內容，新增地點顯示可驗證的供應商／官方資料與使用者備註。
- 原生 iOS／Android App、推播通知、Apple／Google Wallet 與裝置即時定位。
- 微服務、Kubernetes、多區主動備援、Redis、事件串流平台與獨立資料倉儲。
- 公開 SaaS 上線所需的 PostgreSQL RLS、完整稽核後台、客服工具與分析平台。

## Further Notes

- 產品後續分成兩階段：第二階段是手機版「今天」陪伴、第一／最後一天情境、天氣替代、離線唯讀與現場重新規劃；第三階段才加入公開多旅程、收費、額度與營運管理。
- Hono／Bun／Kysely 與 provider interfaces 保留 Railway、Cloud Run 或其他容器平台遷移能力；AWS Lightsail 香港是目前成本與延遲平衡下的起始部署，不是不可替換依賴。
- 正式 Email magic link 需要可驗證寄件網域與 SMTP／Email provider credential。部署前將網域 DNS、寄件者與退信處理列為基礎設施必要條件。
- Google Maps Platform 需要啟用 billing、限制 API key、設定配額與用量告警。應用必須遵循 [Place Details](https://developers.google.com/maps/documentation/places/web-service/place-details)、[Places policies and attributions](https://developers.google.com/maps/documentation/places/web-service/policies)、[Place IDs](https://developers.google.com/maps/documentation/places/web-service/place-id) 與 [Place Photos](https://developers.google.com/maps/documentation/places/web-service/place-photos) 的現行規範。
- 所有外部價格、營業、評分、評論數與路線資訊都必須顯示來源與 observed-at。使用者確認的訂位與固定事項優先於第三方資料；來源互相矛盾時顯示衝突，不自行選一個當真相。
- 規格假設 MVP 僅供旅程建立者與其旅伴使用，不承諾匿名訪客、搜尋引擎索引或公開分享。這讓第一階段可優先驗證真正的核心價值：貼入一個想去的地方後，兩人在數分鐘內理解最合適的安排及代價並共同確認。
