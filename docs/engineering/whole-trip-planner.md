# 全旅程容量規劃器

契約：GitHub `tzurae/along-the-way#158`。這是容量檢查與分日，不是時間表。所有移動數字都是直線距離估算；不查付費路線，也不使用營業時間。每天的順序在最後一步先排吃飯時間（第 8 步），而草稿的每一天帶一份直線估算的時間軸（`timeline`），只給畫面看、不進 validator。政策版本由 contracts 的 `PLANNING_POLICY_VERSION = "whole-trip-planner-v3"` 單一定義（v2 → v3：每天的順序改成先排吃飯時間，三餐 P3＋P2）。

**2026-10-19 owner 決定：拿掉「每日直線距離上限」與「單段直線距離上限」**（沒有人知道自己一天能走幾公里）。設定、每日調整、總覽、原因與放寬建議都不再有公里上限；排程只剩 count、effort、budget 三個 hard check。距離仍換算成移動分鐘進 budget，所以跑太遠會因估計總時數超標而排不進去。DB 的 `max_daily_straight_km`／`max_hop_straight_km` 欄位依 owner 決定暫時保留不讀，日後再用 migration 移除。

## 系統邊界與不變條件

- DB snapshot builder 是資料轉接處。它決定 selected/scheduled 分類、固定項目的每日歸屬、住宿、時區、餐飲去重、有效上限及 frozen estimates；solver 不讀 DB。
- `planner-model.ts` 是 normalized input/output。固定項目的 `startMinute`、`endMinute`、arrival/departure clip 全部是 **UTC epoch minutes**，不是當地幾點幾分。`localStartMinute` 只決定固定錨點放在中午前或中午後。
- `day-load.ts` 共用所有容量計算。一般讀值與獨立 validator 直接算；搜尋使用同一計算器，但預先保留不可變的時窗、固定路線端點與距離矩陣。
- `solveWholeTrip` 只接受輸入、回傳結果，沒有 clock、random、DB、網路或寫入。每個搜尋順序與 tie-break 都固定。
- `validateWholeTripPlan` 不接受 construction cache 或距離矩陣。它從原始 snapshot 與輸出的 `orderedPlaceIds` 重新算 Haversine、時窗、聯集占用、餐飲、五項 hard checks，並檢查覆蓋、重複、keep、pinned 與 cached load 是否一致。
- 狀態只有 `complete`、`baseline_conflict`、`proven_infeasible`、`search_incomplete`。只有 `complete` 可以套用。沒有 partial apply。
- 基線衝突是診斷，不是候選行程：`baseline_conflict` 的 `days=[]`。其他狀態的每個輸出日都必須有效。validator 不一致會丟 internal error，不能改成略過檢查。
- fixed-selected 每日按 place id 去重，數量與體力計一次；停留已在固定占用，不再進 flexible visit。pinned 住宿／機場只在原日中段排序，沒有數量、體力或停留負荷，未分日者不會被新分日，也不叫 unplaced。

## 時區與時窗

2026-10-19 owner/coordinator 已把以下決策加入 issue 契約：planning timezone 不依 flexible 地點的分日或順序，否則套用改了第一站，重新讀取的時窗就可能不同。

`resolvePlanningDayTimeZone` 由 snapshot builder 單一負責，讀值、preview、solver、apply 都用同一結果：

1. 當晚住宿的非空 timezone。
2. 前晚住宿的非空 timezone。住宿缺座標也不能丟掉它的 timezone。
3. 當地日期屬於這天的固定項目，使用這天顯示的 endpoint：start.localDate 等於當天就取 start，否則 end.localDate 等於當天就取 end。依 instant、itemId 排序取最早。
4. trip planning default timezone：住宿與固定項目各一票，取非空 timezone 的眾數，同票按 IANA 字串排序。雙端點項目一票，優先 start 的非空 timezone，否則第一個非空 endpoint。
5. 若上一步沒有 timezone，從 selected places 依 placeId 排序，取第一個有非空 timezone 的地點。
6. 仍沒有就 `baseline_unverifiable`。builder 可用內部 UTC 算診斷，但 revision 的 timezone 為 null；這不是允許排程的 UTC fallback。

`inputRevision` 同時包含 resolved place timezone、planning default timezone 與每個 resolved day timezone。移動 flexible assignments 不參與上述 precedence。

day-load 使用既有 `@js-temporal/polyfill`，以輸入日期和 IANA timezone 解析 dayStart/dayEnd，沒有新依賴。`24:00` 是下一天的午夜。容量時窗遇 DST gap/overlap 使用 Temporal `compatible`；既有固定 endpoint 已由原本的 endpoint parser 決定實際 instant，不能重新猜。時間差以真實經過分鐘計算，不能把 DST 日硬算成 1440 分鐘。

- `ARRIVAL_BUFFER_MINUTES = 60`，start 取所有 arrival end 加 60 後的最大值。
- `DEPARTURE_BUFFER_MINUTES = 120`，end 取所有 departure start 減 120 後的最小值。
- 固定占用與時窗取交集後做聯集。住宿只做錨點，不做占用。
- meal contribution 的 id 代表同一餐／餐廳地點。重複 key 取最大分鐘，並與 fixed-selected restaurant/cafe 的同一 place id 去重；flexible 餐飲也用 place id。剩餘用餐預留為 `max(0, reserve − covered)`。
- budget 保留原公式，不把負值偷偷 clamp 成 0。**只有固定基線的一天（沒有 flexible）不做 budget 比較，utilisation 的 budget 項在 budget ≤ 0 時為 0**：依 spec §2，短或空的時窗（晚到、早走、整天的固定行程）只承載固定基線，否則 reserve 造成的負 budget 會讓整趟行程變成 baseline conflict。只要放進任何 flexible，budget 就照公式檢查，非正 budget 一定超標。count、effort 的固定基線超標仍回 `fixed_baseline_over_cap`（2026-10-19 審查修正）。
- `noLodging` 表示兩端至少一端完全沒有輸入住宿。不存在的端點可以省略；已輸入但缺座標的住宿不能省略。

## 直線距離與路線

每對不同座標的 Haversine 距離只算一次，四捨五入成 integer metres，放在共享矩陣。使用座標當矩陣 key，不把不同座標但同 id 的 endpoint 混為一談。每日路線是：前晚住宿 → 中午前固定錨點 → flexible+pinned 中段 → 中午後固定錨點 → 當晚住宿。

進入固定錨點用 start endpoint，離開用 end endpoint。固定服務內部的 start→end 不是 leg；時間已在 occupancy，服務距離不能再算進移動時間。即使兩個節點座標相同，它們仍是兩個路線節點，該段依設定收 `perLegMinutes`。

每段 `ceil(metres × detourFactor ÷ (speedKmh × 1000 / 60)) + perLegMinutes`。距離只透過這個移動分鐘影響 budget，沒有公里上限。距離未知時仍回傳可解釋的已知部分，但 status 必須是 `unverifiable_distance`，不能把缺的路段當成通過。

utilisation 是 count、effort、load/budget 三個 hard ratio 的最大值。`UTILISATION_BAND = 0.05`。0/0 視為 0；非正 budget 但有負荷或赤字時，用有限的超標值，不輸出 JSON Infinity。比 band 前只加 `1e-9` 抵消二進位浮點邊界，不改 hard check。

## 搜尋順序與固定額度

所有字串 id 使用 code-unit ascending 比較，不依執行機器 locale。days 先按日期、再按 dayId 排序（輸出順序就是畫面上的第 N 天）。

1. Preflight 先看固定基線，再看 keep 的既有安排。缺 flexible 座標是 `missing_coordinates`；固定錨點／住宿缺座標或固定時間無法解析是 `baseline_unverifiable`。keep 依各 hard check 回 `existing_*`，不偷搬既有地點。count/effort 照原樣檢查；若既有順序超出 budget，先用最後那一次相同的日內 reorder 重排（keep 模式本來就允許改順序），再用重排後的負荷判斷 `existing_budget_over_cap`，並以重排結果作為搜尋起點（2026-10-19 coordinator 裁定）。
2. 只有總剩餘數量容量、單一地點超過每一天的保守下界能產生 `proven_infeasible`。單地點時間證明使用 **零 travel、完整 meal cover** 的樂觀下界；這比較弱，但絕不把 greedy 插不進去當成無解證明。kept visit/effort 仍是不可移動負荷。
3. 主 construction order：可行日最少 → normalized size 最大 → votes 最多 → placeId。size 取各日 `max(effort/maxEffort, visit/max(1,budget))` 的最大值。
4. 最便宜的有效插入以新增 integer metres 排序，再比插入後 day utilisation band、dayId、position。新增距離只查前→新、新→後、前→後三個矩陣值；搜尋內不跑日內 exact reorder。
5. Repair 先重新插入 unplaced，再用深度最多 2 的 ejection chains。可以移出一個或同時兩個 movable 地點，插入未排地點，再把移出的地點放到別天。只有整個 queue 放回且所有日有效才比較最終 objective；不要求中間狀態改善平衡。keep 與 pinned 不得被 eject。
6. 接著做跨日 relocate/swap。swap 移除後的中間狀態不拿來當最後可行性，兩邊放回後才比較。
7. 主 order 之外再跑 3 個固定 alternative，保留找到的最佳結果。
8. 最後每個 day 依序呼叫一次 `planDayOrder`（`apps/api/src/planning/day-order.ts`，三餐 P2）：先用同一 integer matrix 換算的直線分鐘跑 `simulateDay` 的規則，再在「負荷仍為 valid」的順序裡挑三餐分數最好的（趕不上固定安排 → 三餐偏離時段 → 移動分鐘，移動在最少的 10 分內算平手，再比跟原有位置對調的組數）；可排的地點 ≤ 9 且每天 20,000 步內是精確搜尋（`exact`），否則先定早／午／晚餐的位置、各段再照順路排（`many_places`）。solver 交來的那天順序一定是候選之一，所以結果不會比它差。排不出時間軸的日子（有未解析的固定項目、缺座標、每一種順序都有 >120 分的直線頭／中段）照舊只跑一次 `orderByStraightLine`（中段 ≤8 exhaustive，>8 nearest-neighbour + capped 2-opt），重排後再驗，超出 budget 就保留之前已有效的順序，並標 `distance`／`no_frame` 或 `long_leg`。每做完一天讓出一次 event loop（`solveWholeTrip` 因此是 async）。最後獨立 validator 再重算整個結果；validator 不看順序的挑法，只重算負荷。

| Named constant | 值與意義 |
|---|---|
| `PLANNER_MAX_DAYS` | 30，API 超過回 422 `planner_input_too_large`，不限制設定與讀值 |
| `PLANNER_MAX_FLEXIBLE_PLACES` | 150，同上 |
| `FEASIBILITY_CANDIDATE_LIMIT` | 60,000，每次 solve 計算主排序用的插入候選上限 |
| `CONSTRUCTION_CANDIDATE_LIMIT` | 60,000，每個 start 的有效性評估上限 |
| `IMPROVEMENT_CANDIDATE_LIMIT` | 20,000，每個 start 的 repair/relocate/swap 候選共用額度 |
| `EJECTION_CHAIN_MAX_DEPTH` | 2，最多移出兩個已排地點，不是兩個不受限巢狀 loop |
| `IMPROVEMENT_MAX_PASSES` | 4，每個 start 的改善輪數 |
| `CONSTRUCTION_ORDERS` | `constrained_first`；alternatives 是 `largest_first`、`smallest_first`、`votes_first` |
| `TWO_OPT_MAX_PASSES` | 12，既有手動排順路也使用固定上限 |
| `SAME_TYPE_OBJECTIVE` | `minimise`，中段相鄰且兩者都是 flexible 的同類型配對數；pinned 會隔開配對 |
| `CANONICAL_TUPLE_LAYOUT` | days 依日曆順序（date，再 dayId），每天接該日 middle placeId ascending，再放空字串分隔；不把 position 算進 assignment tuple |
| `MAX_PLANNER_SUGGESTIONS` | 3，每個 unplaced 找最佳單日建議，最後依建議排序只顯示前三個 |
| `SUGGESTION_CLOCK_STEP_MINUTES` | 1，與 HH:mm 精度相同 |
| `SUGGESTION_CLOCK_LIMIT_MINUTES` | 1440，也就是 `24:00` |
| `SUGGESTION_CANDIDATE_LIMIT` | 200,000，放寬建議檢查的插入位置＋時窗起點總數；用完就停止找建議（建議是盡力而為，不影響 status） |

三個 alternative 的完整比較：largest 是 size ↓、feasible-days ↑、votes ↓、id ↑；smallest 是 size ↑、feasible-days ↑、votes ↓、id ↑；votes 是 votes ↓、feasible-days ↑、size ↓、id ↑。額度用完只代表搜尋停止，不能產生新的無解證明。搜尋延遲是 **UNVERIFIED**，需由 owner 實際試用。

objective 是 lexicographic：placed count 最大 → 最大 utilisation band 最小 → 全部 metres 最小 → `Σ |count − target|` 最小 → same-type adjacency 最少 → canonical tuple 最小。日內最後重排可能降低距離但提高同類相鄰數；這是規格要求的最後 route pass，不會拿它換掉有效性。

## 放寬建議

2026-10-19 Main 明確確認：只放寬 hard caps，也就是 count、effort、dayStart 更早、dayEnd 更晚（公里上限已移除）。**不減少 meal/rest/slack，不改 soft target 或 travel profile。**

每個 unplaced、每個日子、每個中段插入位置都看候選。count/effort 設成剛好可行且不低於原值的最小合法 cap；若要明確覆寫 flight-reduced maxPlaces，還要符合 raw `target ≤ max`。超過 count 12、effort 25 的候選直接丟掉。

時窗以 1 分鐘枚舉可能的更早開始，為每個開始找最早的可行結束。end capacity 用 prefix maximum，所以擴大時窗撞上固定占用、反而暫時減少可用容量時，不會假裝容量單調增加。候選仍逐一跑 day-load，從不只信代數推導。

`SUGGESTION_TIE_BREAK`：最大 relative increase → fields changed → dayId → placeId → canonical override fields。數量、體力、距離各用 `(new-old)/old`；時窗用增加的總 wall-clock window 除以原 wall-clock window。只看被放寬的 hard caps。前兩項相同時，dayId 是 spec 指定的穩定 tie-break。

建議只包含改動欄位，不存到正式 override。UI 把它合進 draft overrides 再 preview。沒有合法單日建議時顯示「需要增加天數、取消選取，或放寬多天」。若搜尋額度停止時某個 unplaced 實際已有有效插入，該候選日沒有假的 blocking check；status 仍是 `search_incomplete`。

## 手算追蹤：5 個地點、2 天

這是 SpecGriller 的反例，不是已執行測試。兩日都 09:00–12:00，budget=180，meal/rest/slack=0，perLeg=0；全部座標相同，沒有住宿／固定項目，maxPlaces=3、effort cap=25，每站 effort=1。A/B 的 visit=90，C/D/E 的 visit=60。

主 construction 按 A、B、C、D、E：

1. A 放 D1，負荷 90/0。
2. B 放 D2，負荷 90/90。
3. C 放 D1，負荷 150/90。
4. D 放 D2，負荷 150/150。
5. E 放任一天都是 210，先留下 unplaced。

repair 的原子 move：從 D1 移出 A，插入 E，D1 暫時是 C+E=120；A 需要去 D2。從 D2 移出 D，插入 A，D2 成為 B+A=180；再把 D 放回 D1，D1 成為 C+E+D=180。最多移出 A/D 兩個，兩個都放到別天。最後是 **90+90／60+60+60**，placed count 4→5，所以即使最大 utilisation 從 150/180 升到 1，objective 仍必須接受。最後 reorder 不改負荷，獨立 validator 應得到兩日 valid、status complete。

## 手算追蹤：航班時窗

同一 day timezone，設定 09:00–19:00。flight 的 normalized start=10:00、arrival end=14:00，arrival buffer=60，所以有效窗變成 15:00–19:00，共 240 分鐘。flight 占用 `[10:00,14:00)` 與新窗沒有交集，不能再扣四小時。

若固定 meal 是 `[16:00,17:00)`，meal contribution 同一餐 60 分鐘，用餐預留 60 已抵完。rest=30、slack=15%，所以 fixed occupancy=60、slack=36、budget=`240−60−0−30−36=114`。120 分鐘的 museum 即使 travel=0 也放不下，不能拿原先 600 分鐘的日窗宣稱可行。

若航班改為 17:30 或 18:00 才到，window 只剩 30 或 0 分鐘。這天不能增加 flexible（budget 為負），但只有固定基線時仍是 valid，不會變成 baseline conflict。flight-day light caps 另外按欄位減半，明確 override 的欄位不再減半。

## 手算追蹤：雙端點 transport anchor

全部 latitude=0。前晚住宿 A longitude=0，09:00–10:00 火車的 start B longitude=0.01、end C longitude=1；flexible D longitude=1.01，當晚住宿 E longitude=1.02。火車在中午前，路線為 `A → [B ⇢ C 固定服務] → D → E`。

只算 A→B、C→D、D→E。每段 Haversine 約 1111.949 m，round=1112 m，daily=3336 m、maxHop=1112 m。**B→C 的約 110 km 不加入任何 leg。** transit 15 km/h、detour 1.35、perLeg 10：每段 `ceil(1112×1.35÷250)+10=17` 分鐘，總 travel=51。火車服務的 60 分鐘只進 fixed occupancy 一次。

若 dayStart/end=09:00/19:00、meal/rest/slack=60/30/15，budget=`600−60−60−30−90=360`。D visit=60，所以 load=111，符合 budget。例子假定火車 endpoints 沒有另被 selected；若 selected，fixed-selected 每日仍各計一次 count/effort，但不能重複加 flexible visit。

## 手算追蹤：缺座標不是零距離

某日已輸入夜宿 H，但 `coordinates=null`；可變地點 P 有座標。即使只有 P→H 一段、已知 metres 的加總是 0，route node H 存在，所以 `missingCoordinateIds=[H]`、day status=`unverifiable_distance`。solver 的固定基線 preflight 回 `baseline_unverifiable`，`days=[]`，apply 不可用。

對照：兩晚都完全沒有輸入住宿時，端點真的不存在。只有 P 的一天沒有 leg，可以是 valid，但 `noLodging=true`，顯示「這天沒有住宿，距離只算地點之間」。若缺座標的是 P 本身，preflight 是 per-place `missing_coordinates`。這三種情況不能混在一起。

## DB、proposal 與設定的補充決策

以下是各 ownership 實作的共同介面決策；執行效果仍需 owner 驗證。

- preview 使用 repeatable-read snapshot，只新增 proposal，不改 itinerary/settings，也不 enqueue AI。proposal 存 30 分鐘；existing account limiter 是每帳號每分鐘 10 次 preview。
- apply 先鎖 trip，再檢查 scheduler，接著鎖 idempotency/proposal。canonical provider identities 以穩定順序 `FOR SHARE`，避免跨 trip facts refresh 插進 revision/寫入之間。
- apply 先以 saved-only、`useAi:false`、不帶 frozen 的 snapshot 比 revision。這樣新 selected place 沒有舊 frozen 值時，會先正確得到 `plan_stale`，而不是誤判 estimate validation error。revision 相符後保存 drafts，再一律用同一份 frozen estimates 重建實際 caps 的 snapshot 做 independent validation。
- revision 排除背景 AI publication，包含 member estimates、`meal_role`（哪一餐，migration 050）、votes、分類、resolved facts/coordinates/timezones、items、lodging、day/date、assignments/order、settings/override versions 與 policy。preview 直接保存 snapshot estimates，含固定項目可能引用但不在 trip 日期內的地點。
- bulk writer 以 desired-days 為 assignment source，維護 positions、selection history、versions、actor/time；fixed-selected 不寫，pinned 只改原日順序；保留 scheduled guard。
- 舊／新／order-only days 使用既有 migration 020 assignment trigger bump version。只有一個 `whole_trip_plan.applied` aggregate event，related ids 含 affected days + changed places；draft saves 不另外發事件。
- **bulk write 後、commit 前**，在同一 transaction 用同一 builder 與 frozen estimates 再建 snapshot、再跑 validator；若不一致就是 internal error，全部 rollback。這是 revision/constructor 以外的最後安全網。
- writes 與 idempotency response 同一 transaction。所有 proposal lookup 都檢查 trip/id/expiry；expired 回 404 `whole_trip_plan_not_found`。有效期限內同 key replay 不再發 event。
- override DELETE 保留全 null row/version tombstone，讀取呈現 raw:null，避免 version 歸零造成 ABA。一般 settings/override cross-field 在 flight reduction 前檢查；lightTravelDays 可以合法讓 soft target 高於實際 hard max。
- `POST /api/trips/:tripId/planning-load` 接 PlanningDrafts、requireScheduler，只讀草稿對既有安排的 impact，沒有 solver 30/150 限制；GET 仍是 active-member 的 saved-load 讀取。設定頁不能拿 `baseline_conflict` 的空 candidate days 當 impact。

## AI profile 補充決策

AI 只給估值，不選日期、不寫行程。language=`zh-TW`、prompt=`place-planning-profile-v1`、estimate policy=`place-estimates-v1`。來源沿用 place-guides fetcher，來源文字是資料，不是指令。

worker concurrency=2，stale claim=5 分鐘，failed backoff=1h/6h/24h；每 trip 的 UTC 日實際 model-generation cap=50，queue refresh=60s。evidence/input 使用 SHA-256，input tuple 包含 canonicalName、placeType、evidenceHash；cache validity 還包含 identity、model、prompt/policy、language。preview 不產生 AI，只讀有效 cache，缺值用有來源標籤的 defaults。member 值優先；低信心 AI 不會把值壓到 type default 以下。

來源刷新：`ready`／`no_evidence` 超過 24 小時（`PLACE_PLANNING_PROFILE_EVIDENCE_MAX_AGE_MILLISECONDS`）就重新排入佇列；worker 重新抓 Wikipedia/Wikivoyage 摘錄。摘錄 hash、input hash、model、prompt、policy、language 都沒變時，直接還原原本的 ready／no_evidence 並更新 `evidence_checked_at`，**不呼叫模型**；有變才重新生成。所以來源出現或改變最晚一天內會反映。讀取有效性不看 evidence 年齡，worker 停掉時已有的 AI 估值不會消失。

模型輸出規則：任一估值非 null 時至少要引用一段摘錄（否則視為失敗）；兩個估值都是 null 存成 `no_evidence`。strict JSON schema 不支援 `maxLength`／`uniqueItems`，所以 parser 把超過 120 字的理由截斷、重複的 evidence index 去重。

## Owner 檢查步驟與未驗證範圍

本次依 Rule 9 只編輯與靜態閱讀，沒有跑 tests、typecheck、build、scripts、server、browser、container 或外部 API；沒有新增或修改 tests。下列行為全部 **UNVERIFIED**，不是已通過的執行結果。

1. 透過 public preview API 建上面的 5-place/2-day 情境，檢查 complete、兩日 180 分鐘、五個 flexible 各出現一次。用相同 snapshot 重複 preview，比較 result（不比較 proposal id/time）應完全相同。
2. 用航班例子讀 `planning-load`，確認窗是 240 分鐘、occupancy=60、budget=114；120-minute museum 不應排入。把 arrival 改成 18:00，確認不會輸出無效候選日。
3. 用 transport 的兩個遠端 endpoint，檢查只出現三個接駁 legs，daily=3336 m、travel=51；不能加入服務內 B→C。
4. 保留夜宿但清掉座標，確認 load 是 unverifiable、preview 不可套用；刪掉整個 lodging entry 後，確認變成缺住宿提示而不是未知座標。
5. keep 模式把既有日 maxPlaces 調到更小，確認 `existing_count_over_cap`，切 replan 才能搬日。fixed-selected 與 pinned 的日子不變。
6. 準備總剩餘 count 不足的輸入，確認 `proven_infeasible`；準備沒有容量證明但搜尋沒放完的輸入，確認只能 `search_incomplete`。兩者都不可 apply，每個候選日仍 valid。
7. 對 unplaced 使用建議，檢查所有值在合法範圍、沒有 meal/rest/slack 的削減；只改 draft overrides。重建 preview 後，用 `planning-load` 核對建議日的五項 hard checks。
8. 產生 complete proposal 後改 member estimate、地點 timezone 或 assignment，apply 應 409 plan_stale；只發布新 AI profile 不應 stale。apply 後重新 GET load，每日仍 valid，fixed/pinned 規則、版本與單一 aggregate event 都保持一致。
9. 最後由 coordinator/owner 依既有流程跑 typecheck 與既有 suites，並用 30-day/150-flexible 邊界量實際 latency；這份文件沒有宣稱它已達到任何延遲目標。
