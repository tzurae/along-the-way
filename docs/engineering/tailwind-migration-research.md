# Tailwind CSS migration research

Research date: 2026-08-18

## Recommendation

**Recommendation:** adopt **Tailwind CSS 4.3.3** for `apps/web` only, using the first-party `@tailwindcss/vite` plugin and Tailwind v4's CSS-first configuration. Leave the root GitHub Pages site (`index.html`, `app.js`, and `styles.css`) byte-for-byte unchanged in this migration.

Pin `tailwindcss` and `@tailwindcss/vite` to `4.3.3`, matching the repository's existing exact-version policy. The official release feed identifies 4.3.3 as the current release, and the package's official source declares Vite 8 support ([Tailwind releases](https://github.com/tailwindlabs/tailwindcss/releases/tag/v4.3.3), [`@tailwindcss/vite` 4.3.3 package source](https://github.com/tailwindlabs/tailwindcss/blob/v4.3.3/packages/%40tailwindcss-vite/package.json)).

Do **not** create `tailwind.config.js`, `tailwind.config.ts`, or another `tailwind.config.*` file. In v4, `@theme`, `@utility`, `@custom-variant`, and `@source` are the canonical CSS-first configuration surface. JavaScript configuration remains a backward-compatibility path, is not auto-detected, must be loaded with `@config`, and does not support the old `corePlugins`, `safelist`, or `separator` options ([Tailwind upgrade guide](https://tailwindcss.com/docs/upgrade-guide#using-a-javascript-config-file), [functions and directives](https://tailwindcss.com/docs/functions-and-directives#compatibility)). This repository has no Tailwind v3 configuration or plugin ecosystem to preserve, so adding a compatibility file would create a second configuration language for no benefit.

This scope is intentionally conservative. Issue #1 says the existing GitHub Pages site must remain as a public, read-only fallback during MVP testing, and Issue #3 makes continued public readability an acceptance criterion. Migrating only `apps/web` establishes the new app's single token/component layer without putting the fallback at risk.

## Evidence labels

- **Verified fact** means a statement supported by official Tailwind, Vite, or first-party source documentation linked inline.
- **Repository observation** means a statement derived from the files and GitHub issues in this repository.
- **Recommendation** is the proposed choice for this repository.
- **Risk** is a failure mode the implementation issue should control.
- **Open decision** requires product or release ownership rather than a framework answer.

## Repository inventory

### Surface A: root GitHub Pages site

**Repository observations**

- `index.html` loads `styles.css?v=7` and `app.js?v=7` directly. There is no module bundler or CSS build step in that page.
- `.nojekyll` is present at the repository root. The root page is therefore a self-contained static publication surface rather than part of the Vite app.
- `app.js` owns the complete five-day itinerary data and renders agenda summaries, stop cards, transfer rows, details, ratings, weather modes, and active day/mode state into `innerHTML`.
- The root `styles.css` is 19,079 bytes and has been minified and append-patched over several revisions. It contains 8 custom properties, approximately 56 literal colors, five `max-width` media blocks, six `!important` declarations, and behavior involving `:has()`, pseudo-elements, sticky positioning, `backdrop-filter`, responsive overflow, and state classes.
- The dynamic expression ``agenda-${activeMode}`` creates `agenda-normal`, `agenda-heat`, `agenda-rain`, and `agenda-severe` only at runtime. Tailwind scans source as plain text and cannot infer class names assembled by interpolation; a root migration would need a static class map or a stable data attribute instead ([Tailwind source detection](https://tailwindcss.com/docs/detecting-classes-in-source-files#dynamic-class-names)).
- Issue #1 explicitly retains this surface at its existing public URL as a read-only fallback until the new app passes real-user acceptance. Issue #3 repeats that the existing GitHub Pages site must remain publicly readable.

**Constraint:** installing Tailwind in `apps/web` must not alter the root HTML, JavaScript, CSS, URL, or publication behavior.

### Surface B: Vite/React app under `apps/web`

**Repository observations**

- Root `package.json` runs Vite with `vite --config apps/web/vite.config.ts` and `vite build --config apps/web/vite.config.ts`.
- `apps/web/vite.config.ts` sets the project root to `apps/web`, uses `@vitejs/plugin-react`, and emits to `apps/web/dist`.
- Vite defines `root` as the directory containing `index.html`, and `build.outDir` is relative to that project root ([Vite shared options](https://vite.dev/config/shared-options#root), [Vite build options](https://vite.dev/config/build-options#build-outdir)). The existing configuration therefore already keeps the React build output separate from the repository-root Pages files.
- `apps/web/src/main.tsx` imports `apps/web/src/styles.css`. No extra CSS entry is needed.
- `TripSummaryPage.tsx` currently renders loading, error, and loaded states with semantic React markup and named CSS classes.
- `apps/web/src/styles.css` is 4,395 bytes and 255 lines, with 16 literal colors, one `max-width: 600px` media query, and one `prefers-reduced-motion` query. It also contains gradients, `clamp()`, a decorative `::after`, focus-visible styling, and a keyframed entrance animation.
- The Docker web image copies the repository package metadata, installs with the frozen Bun lockfile, runs `build:web`, and copies only `apps/web/dist` into the runtime image. Compose exposes this app through Caddy while the root Pages files are not part of that container.
- CI's `bun run build` already includes `build:web`; staging builds the same Dockerfile. Adding the Vite plugin therefore uses the existing build boundary rather than adding a separate production compiler.

### Existing design direction

**Repository observation:** Issue #1 requires a warm, quiet, content-first visual language with one design-token and component layer across the new application. It also requires consistent mobile/desktop concepts, visible focus, sufficient contrast, useful text-first loading, and status communication that does not rely on color alone.

**Implication:** Tailwind is an implementation tool, not permission to redesign the current page or introduce a second visual system. The first migration should preserve observable appearance and behavior while moving values into one deliberate token vocabulary.

## Verified Tailwind v4 choices

### Vite integration

**Verified facts**

- Tailwind's official Vite guide calls the dedicated Vite plugin the most seamless integration and specifies installing `tailwindcss` plus `@tailwindcss/vite`, adding `tailwindcss()` to Vite's `plugins`, and importing Tailwind with `@import "tailwindcss"` ([Tailwind Vite installation](https://tailwindcss.com/docs/installation/using-vite)).
- The v4 upgrade guide recommends the Vite plugin over the PostCSS plugin for Vite projects ([Tailwind upgrade guide](https://tailwindcss.com/docs/upgrade-guide#using-vite)).
- `@tailwindcss/vite` 4.3.3 declares a peer dependency of `vite: ^5.2.0 || ^6 || ^7 || ^8`, covering this repository's Vite 8.2.1 ([official package source](https://github.com/tailwindlabs/tailwindcss/blob/v4.3.3/packages/%40tailwindcss-vite/package.json)).

**Recommendation:** add the Tailwind plugin beside `react()` in `apps/web/vite.config.ts`. Do not add PostCSS or Autoprefixer packages/configuration.

### Source detection and this monorepo

**Verified facts**

- Tailwind v4 detects utility tokens by scanning source as plain text. It ignores CSS, lockfiles, `node_modules`, binary files, and gitignored files by default ([source detection](https://tailwindcss.com/docs/detecting-classes-in-source-files#which-files-are-scanned)).
- Dynamic fragments such as ``bg-${color}-500`` are not detectable; complete class strings must exist in source, commonly through a static mapping ([dynamic class names](https://tailwindcss.com/docs/detecting-classes-in-source-files#dynamic-class-names)).
- `source(none)` disables automatic detection and `@source` registers explicit source roots. Tailwind documents this for projects with multiple stylesheets that must produce isolated outputs ([disabling automatic detection](https://tailwindcss.com/docs/detecting-classes-in-source-files#disabling-automatic-detection)).
- The import `source(...)` option can set a base path when commands run from a monorepo root rather than the app root ([setting the base path](https://tailwindcss.com/docs/detecting-classes-in-source-files#setting-your-base-path)).

**Recommendation:** make the new app's boundary explicit in `apps/web/src/styles.css`:

```css
@import "tailwindcss" source(none);
@source "../index.html";
@source "./";
```

This keeps the React stylesheet dependent only on `apps/web/index.html` and `apps/web/src`, regardless of the process working directory. It also prevents class-like prose or legacy root markup from silently changing the app bundle. Do not use a broad repository-root source.

For React variants, map props/state to complete strings:

```ts
const toneClass = {
  success: "border-success text-success",
  warning: "border-warning text-warning",
  conflict: "border-conflict text-conflict",
} as const;
```

Do not build token names with string interpolation. Use `@source inline()` only for genuinely generated external content, not to hide an avoidable dynamic-class design ([safelisting utilities](https://tailwindcss.com/docs/detecting-classes-in-source-files#safelisting-specific-utilities)).

### Theme and design tokens

**Verified facts**

- `@theme` variables are design tokens that also create matching utility APIs; ordinary `:root` variables do not create utilities. Tailwind recommends `@theme` when a token should map to utilities and `:root` for variables that should not ([theme variables](https://tailwindcss.com/docs/theme#why-theme-instead-of-root)).
- Theme namespaces create utilities/variants for colors, fonts, type sizes, weights, tracking, leading, breakpoints, spacing, radii, shadows, easing, animation, and more ([theme namespaces](https://tailwindcss.com/docs/theme#theme-variable-namespaces)).
- CSS theme variables can be shared by importing a CSS theme file across projects, including monorepos ([sharing across projects](https://tailwindcss.com/docs/theme#sharing-across-projects)).

**Recommendation:** start with semantic tokens that reflect the product language, not Tailwind's default palette names and not every one-off measurement. Define them at the top of `apps/web/src/styles.css`:

```css
@theme {
  --font-sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    "Segoe UI", "Noto Sans TC", sans-serif;
  --font-display: Georgia, "Noto Serif TC", serif;

  --color-paper: #f5f0e7;
  --color-surface: #fffcf7;
  --color-ink: #24372f;
  --color-ink-strong: #1f3029;
  --color-muted: #5d6c65;
  --color-accent: #d37551;
  --color-accent-strong: #b55737;
  --color-on-dark: #fffaf2;
  --color-focus: #e09271;

  --radius-card: 2rem;
  --radius-panel: 1.125rem;
  --shadow-card: 0 28px 80px rgb(73 59 43 / 12%);
}
```

The actual migration should reconcile colors by role before committing exact names/values; the example is a shape, not a requirement to preserve redundant near-duplicates. Keep one-off illustration geometry, multi-stop background gradients, and private intermediate values as arbitrary values or plain CSS rather than inflating the theme. Use `:root` only when a value is needed by custom CSS but should not create a public utility.

Do not move tokens into a new package during this issue. There is only one migrated consumer. If a later approved scope migrates the Pages surface, extract the already-proven `@theme` block into a shared CSS file then; official v4 theme sharing is ordinary CSS import, so no JavaScript preset is needed ([sharing themes](https://tailwindcss.com/docs/theme#sharing-across-projects)).

### Custom utilities and non-trivial CSS

**Verified facts**

- `@utility` registers a custom utility that participates in variants such as `hover`, `focus`, and responsive variants ([functions and directives](https://tailwindcss.com/docs/functions-and-directives#utility-directive)).
- Tailwind supports arbitrary values, arbitrary properties, and arbitrary variants for exceptional values/selectors ([adding custom styles](https://tailwindcss.com/docs/adding-custom-styles#using-arbitrary-values)).
- Plain CSS remains supported, and complex reusable classes can live in `@layer components` so utilities may override them ([custom CSS and component classes](https://tailwindcss.com/docs/adding-custom-styles#using-custom-css)).
- `@apply` exists primarily for custom CSS or third-party overrides that should use Tailwind tokens ([functions and directives](https://tailwindcss.com/docs/functions-and-directives#apply-directive)).

**Recommendation:** use this order of preference:

1. Standard utilities for layout, spacing, type, colors, borders, shadows, and common state/responsive changes.
2. An arbitrary value for a true one-off, such as the decorative ring's exact offset.
3. Plain CSS in an appropriate layer for selectors or coupled behavior that is clearer as CSS.
4. `@utility` only when the same property-level behavior recurs and must compose with variants.
5. `@layer components` only for a reusable single-element styling primitive when a React component would be disproportionate.

Keep these existing behaviors as plain CSS where that is clearer than a dense arbitrary variant:

- the page's layered radial/linear background;
- the summary card's decorative `::after` ring;
- the named `arrive` keyframes and its reduced-motion condition;
- any future third-party DOM that React does not own;
- selectors whose meaning comes from document structure rather than a reusable component API.

Tailwind supports pseudo-element, media/feature-query, attribute, child, state, and stacked variants, including `motion-safe`/`motion-reduce`-style media conditions ([state variants](https://tailwindcss.com/docs/hover-focus-and-other-states)). Support does not mean every selector should be encoded into JSX.

### Reusable styling and React boundaries

**Verified fact:** Tailwind recommends a framework component when styles are reused across files in React, while noting that custom CSS is acceptable for a small single-element abstraction and that complex structure belongs in a component ([managing duplication](https://tailwindcss.com/docs/styling-with-utility-classes#managing-duplication)).

**Recommendation:**

- Keep utility classes next to the element they style.
- Extract a React component when markup, semantics, behavior, accessibility, and styling repeat together—for example `Button`, `StatusBadge`, `SurfaceCard`, `TimelineItem`, or `TransportLeg` once a second real use appears.
- Keep domain components named for the itinerary model, not for Tailwind primitives. A `TransportLeg` may use utilities internally; callers should not need to know its class list.
- Keep small local class strings local. Do not create a component solely to shorten a single `className`.
- Map closed visual variants to complete static class strings inside the owning component. Do not accept unconstrained color/spacing strings as component props.
- Avoid turning the old selectors (`trip-shell`, `summary-card`, and so on) into a permanent compatibility layer. Migrate each caller and delete an old selector once no caller uses it.
- Avoid broad use of `@apply`; it recreates stylesheet indirection and makes the utility-to-element relationship harder to inspect.

### Responsive, dark, and state variants

**Verified facts**

- Tailwind utilities accept state variants such as `hover`, `focus-visible`, `active`, `disabled`, attributes, `has-*`, and parent/peer variants; variants can be stacked ([hover, focus, and other states](https://tailwindcss.com/docs/hover-focus-and-other-states)).
- Responsive variants are mobile-first: an unprefixed utility is the base and breakpoint-prefixed utilities apply at and above the breakpoint ([responsive example](https://tailwindcss.com/docs/styling-with-utility-classes#media-queries-and-breakpoints)).
- `dark:` uses `prefers-color-scheme` by default and can be changed to a class or data-attribute strategy with `@custom-variant` ([dark mode](https://tailwindcss.com/docs/dark-mode)).

**Recommendation:** rewrite the current `max-width: 600px` rules mobile-first: make the current narrow layout the unprefixed base, then restore desktop layout with a single `min-[37.5rem]:...` boundary or a named product breakpoint if the same boundary recurs. Do not change layout merely to match Tailwind's default `sm` value.

Use `hover:`, `focus-visible:`, `active:`, and `disabled:` in JSX for interactive elements. Preserve the existing visible 3px focus treatment or an equally visible tokenized equivalent. Use text/icon/shape with color for statuses as Issue #1 requires.

Dark mode is **not part of the migration**. Tailwind's support does not make a new dark design free: the current gradients, transparent surfaces, shadows, contrast, images, and focus colors all need intentional design. Do not scatter speculative `dark:` classes. Add dark mode only in a separately accepted product issue and choose system-versus-manual behavior there.

### Preflight

**Verified facts**

- `@import "tailwindcss"` injects Preflight in the base layer. Preflight removes default margins, resets borders, unstyles headings/lists, makes replaced media block-level, and constrains images/videos to their parent ([Preflight](https://tailwindcss.com/docs/preflight)).
- Preflight can be omitted by importing Tailwind's theme and utilities separately, and base styles can be added in `@layer base` ([disabling/extending Preflight](https://tailwindcss.com/docs/preflight#disabling-preflight)).

**Recommendation:** keep Preflight enabled in `apps/web`. The React stylesheet already resets universal box sizing and body margin and explicitly styles its headings and interactive elements, so the surface is small enough to absorb the reset deliberately. During migration, verify headings, button font/border/background, images, lists, details/summary, and focus behavior before deleting equivalent old resets.

Do not enable Preflight on the root Pages site as a side effect. If the root is migrated later, decide separately whether to disable Preflight for the parity phase; injecting it into a large, append-patched legacy stylesheet is a broad visual change.

## Scope options

| Scope | Build/deploy shape | Benefits | Costs and risks | Issue #3 / fallback effect | Verdict |
| --- | --- | --- | --- | --- | --- |
| **1. `apps/web` only** | Existing Vite build emits `apps/web/dist`; root static files remain untouched. | Smallest diff; official Vite integration; establishes v4 tokens/components where future work will happen; no new Pages pipeline. | Two styling systems temporarily remain; legacy visual values are not automatically shared. | Fully preserves the current public Pages fallback. | **Recommended now.** |
| **2. Both surfaces, separate outputs** | Vite plugin for `apps/web`; Tailwind CLI or a second Vite/static build compiles a separate root stylesheet. The CLI is the official non-Vite compiler and writes static CSS ([Tailwind CLI](https://tailwindcss.com/docs/installation/tailwind-cli)). | Both surfaces use one framework and could import shared CSS tokens. | Two source graphs and two output lifecycles; Pages needs a reliable build/publish workflow; Preflight and legacy selector parity are large; dynamic `agenda-${activeMode}` must be refactored; generated CSS ownership must be decided. Play CDN is not acceptable because Tailwind marks it development-only ([Play CDN](https://tailwindcss.com/docs/installation/play-cdn)). | Can preserve Pages only if compiled assets are published atomically and the old readable artifact remains available through rollout. | Viable later, but too much risk before Issue #3. |
| **3. Migrate/remove the root site** | Move its data/UI into the React app, or replace the Pages entry with a built artifact/redirect after cutover. | One long-term UI/runtime and no duplicate styling. | Conflates styling migration with data migration, routing, hosting, privacy, and fallback retirement; removal destroys the independent failure mode. | **Conflicts now.** Issue #1 says Pages stays through MVP beta and Issue #3 requires it to remain readable. | Not viable until post-beta cutover is explicitly approved and a public/read-only replacement is proven. |

## Boring migration sequence

1. **Freeze scope.** Record `apps/web` as the only Tailwind source/output. Capture the current app at loading, error, loaded-with-decision, loaded-without-decision, narrow, wide, keyboard-focus, and reduced-motion states for comparison. Do not touch root Pages files.
2. **Install one integration.** Add exact `tailwindcss` and `@tailwindcss/vite` 4.3.3 dev dependencies and update `bun.lock`. Add `tailwindcss()` beside `react()` in the existing Vite config.
3. **Establish the CSS boundary.** Put `@import "tailwindcss" source(none)` plus explicit `@source` rules at the top of `apps/web/src/styles.css`. Keep default Preflight.
4. **Define the first token vocabulary.** Consolidate repeated font, color, radius, shadow, and focus values into `@theme`. Keep one-off geometry/gradients out of the public token namespace.
5. **Migrate outside in.** Convert page/root/base styles, shell, header, card, facts, decision panel, loading state, and error state in small vertical slices. Preserve the mobile-first equivalent of the 600px rules.
6. **Keep complex behavior honest.** Retain the background, decorative pseudo-element, and animation as small plain-CSS rules using theme variables. Do not force them into hard-to-read class strings.
7. **Extract only proven components.** When Issue #3 adds repeated itinerary elements, put repeated structure/semantics into React components and closed variant maps. Do not build a speculative component library during this migration.
8. **Delete migrated CSS.** Remove each obsolete selector/reset after its last caller is converted. The finished app stylesheet should contain Tailwind directives/tokens and only the custom CSS justified above, not a full duplicate of the legacy class sheet.
9. **Verify both surfaces before merge.** Build and exercise `apps/web` in its production serving path, visually/keyboard-check the named states, and open the public GitHub Pages URL to confirm the five-day itinerary remains readable and interactive. Compare generated output only as a diagnostic, not as a checked-in API.
10. **Keep rollout reversible.** Deploy the Vite app through the existing container/staging path. Do not alter Pages publication, DNS, or entry links in the same issue.

## Proposed package, config, and file changes

This is a plan for the future implementation issue, not work performed by this research note.

| Path | Proposed change | Why |
| --- | --- | --- |
| `package.json` | Add exact dev dependencies `tailwindcss: "4.3.3"` and `@tailwindcss/vite: "4.3.3"`. No PostCSS, Autoprefixer, CLI, browser/CDN, class-merging, or variant-library dependency. | Matches official Vite setup and existing exact pins. |
| `bun.lock` | Regenerate through the normal Bun install flow. | Required by frozen installs in CI and Docker. |
| `apps/web/vite.config.ts` | Import `tailwindcss` from `@tailwindcss/vite`; add `tailwindcss()` to `plugins` beside `react()`. | Official v4 Vite integration. |
| `apps/web/src/styles.css` | Add Tailwind import, explicit sources, `@theme`, limited base/custom CSS; delete selectors as TSX callers migrate. | One CSS-first configuration and token source. |
| `apps/web/src/TripSummaryPage.tsx` | Replace old semantic style class names with utilities and, where repetition is real, small owned components/static variant maps. Preserve DOM semantics and behavior. | Moves styling without redesigning data/state logic. |
| `apps/web/src/main.tsx` | Normally no change; it already imports the correct stylesheet. | Avoid weightless churn. |
| `tailwind.config.*` | **Do not create.** | v4 CSS-first project has no compatibility need. |
| root `index.html`, `app.js`, `styles.css`, `.nojekyll` | **No change.** | Preserve the public fallback and Issue #3 acceptance. |
| Docker/Compose/Caddy/workflows | No expected change beyond the lockfile/package installation already consumed by the existing web build. | Existing `build:web` and `apps/web/dist` boundary already carries compiled CSS. |

If a later issue chooses scope 2, it would additionally need `@tailwindcss/cli` 4.3.3 or a deliberate second Vite entry, a non-generated source stylesheet distinct from the published CSS output, explicit root `index.html`/`app.js` sources, a Pages build/publish workflow, static state class mapping, and a decision on checked-in versus CI-produced assets. None belongs in the recommended issue.

## Risks and controls

| Risk | Evidence / trigger | Control |
| --- | --- | --- |
| Root Pages outage or visual regression | Shared stylesheet/build output or Preflight leaks into root publication. | Keep root files and publication unchanged; explicitly scope Tailwind sources to `apps/web`; verify the public URL. |
| Missing generated state styles | Runtime interpolation hides complete utility tokens. | Use static maps of complete class strings. Root `agenda-${activeMode}` must be refactored if that surface is ever migrated. |
| Monorepo over-scanning | Build runs from repository root and auto detection sees unrelated files. | `source(none)` plus explicit `@source` entries. |
| Preflight regression | Heading/list/button/image defaults change. | Keep it isolated to the app; inventory those elements and add deliberate base/utility styles. |
| “Migration” becomes redesign | Token cleanup changes colors, spacing, hierarchy, or responsive behavior. | Preserve visual/behavioral contract first; make redesigns separate accepted work. |
| JSX class strings become unreadable | Complex pseudo/selectors and repeated closed variants are inlined indiscriminately. | Keep coupled selectors/animations in plain CSS; extract repeated semantics into React components. |
| Token sprawl | Every literal becomes a public `@theme` value. | Tokenize repeated semantic decisions only; use arbitrary values/plain CSS for one-offs. |
| Accidental framework compatibility layer | Old names survive through `@apply` wrappers. | Migrate callers and delete obsolete selectors; reserve `@apply` for a demonstrated CSS/third-party need. |
| Browser support mismatch | Tailwind v4 uses modern CSS and targets Safari 16.4+, Chrome 111+, and Firefox 128+ ([upgrade guide](https://tailwindcss.com/docs/upgrade-guide#browser-requirements)). | Confirm the product browser support floor. If older browsers are required, this recommendation must be revisited before implementation. |
| Unplanned dark mode scope | Adding `dark:` piecemeal produces incomplete contrast/gradient states. | Declare dark mode out of scope and open a design-backed issue later. |
| Two temporary token vocabularies drift | Root and app remain separate during beta. | Treat root as frozen fallback; make the app token vocabulary canonical for new work; share only after an approved root migration. |

## Open decisions

1. **Browser floor:** can the private MVP require Safari 16.4+, Chrome 111+, and Firefox 128+, Tailwind v4's documented baseline? If not, stop before installation and reassess.
2. **Visual parity tolerance:** should migration acceptance use screenshot thresholds, design review, or named manual comparisons? The recommendation is named state/viewport comparisons with only intentional diffs approved.
3. **Token names:** approve the final semantic roles after grouping the current near-duplicate colors. The example names above are a starting vocabulary, not final design approval.
4. **Dark mode:** defer. If later approved, decide system-only, manual, or three-way system/light/dark before adding variants.
5. **Root retirement:** only after the new application passes two-user beta, a public/read-only replacement exists, and the owner explicitly approves retiring the independent fallback. This cannot be bundled with the Tailwind issue.
6. **Future sharing:** if the root surface is later migrated, decide whether a shared theme warrants one CSS file under an existing package or a new package. Do not create that abstraction with one consumer.

## Acceptance criteria for the future migration issue

- [ ] `tailwindcss` and `@tailwindcss/vite` are pinned to 4.3.3 and the Bun lockfile is updated.
- [ ] The existing React and Tailwind Vite plugins both run from `apps/web/vite.config.ts`; no PostCSS pipeline is introduced.
- [ ] `apps/web/src/styles.css` uses CSS-first `@theme`/`@source` configuration and no `tailwind.config.*` exists.
- [ ] Tailwind's source graph is explicitly limited to `apps/web/index.html` and `apps/web/src`.
- [ ] The React app preserves loading, error/retry, loaded, next-decision present/absent, mobile, desktop, keyboard focus, and reduced-motion behavior.
- [ ] Preflight effects on headings, lists, buttons, images/media, details/summary, borders, margins, and focus are reviewed and deliberately styled.
- [ ] Repeated product decisions use semantic theme tokens; one-off decorative values do not inflate the theme.
- [ ] Reusable multi-element UI is encapsulated in React components, while local utility lists remain local and justified complex selectors/animations remain plain CSS.
- [ ] All conditional utility classes exist as complete static strings; no utility name is assembled through interpolation.
- [ ] Old `apps/web` selectors are removed after their callers migrate; there is no duplicate full legacy stylesheet or broad `@apply` compatibility layer.
- [ ] The Vite production build succeeds through the existing `build:web` path and the built app is exercised through its production static server/container path.
- [ ] Mobile and desktop visual comparison finds no unapproved changes, and keyboard focus remains visible with sufficient contrast.
- [ ] The root `index.html`, `app.js`, `styles.css`, and `.nojekyll` are unchanged.
- [ ] The existing public GitHub Pages URL still renders the complete five-day itinerary and its day/weather-mode interactions.
- [ ] No CDN/browser Tailwind runtime is shipped.

## Issue-ready draft

### Proposed title

`[01a] 建立 Tailwind CSS v4 設計 token 與 Web 樣式基礎`

`[01a]` 表示這是插入既有 `[01]` platform foundation 與 `[02]` itinerary issue 之間的前端基礎工作；不需要替已存在的 issue 重新編號。

### Proposed body

```markdown
## Parent

- #1

## What to build

在 #3 擴充完整行程畫面之前，只將 `apps/web` 的現有 selector-based 樣式遷移至 Tailwind CSS 4.3.3。使用第一方 Vite plugin 與 Tailwind v4 CSS-first configuration，建立新應用唯一的設計 token 與元件樣式基礎。

Repository 根目錄的 GitHub Pages 網站是獨立的公開唯讀 fallback。本 issue 不遷移、不重新建置、不 redirect，也不修改根目錄的 `index.html`、`app.js`、`styles.css` 或 `.nojekyll`。

## Technical decisions

- 固定使用 `tailwindcss` 與 `@tailwindcss/vite` 4.3.3。
- 在 `apps/web/vite.config.ts` 將 `tailwindcss()` 加到 React plugin 旁。
- 在 `apps/web/src/styles.css` 使用 `@theme`、明確的 `@source` 與少量必要的 plain CSS。
- 不建立 `tailwind.config.*`、PostCSS config 或 CDN/browser runtime。
- Tailwind source detection 只涵蓋 `apps/web/index.html` 與 `apps/web/src`。
- React app 保留預設 Preflight，並明確處理 element reset。
- 保留現有視覺、responsive 與互動行為；本 issue 不做 redesign 或 dark mode。
- Conditional style 使用完整、可靜態偵測的 class string。
- 只有當結構、語意、行為與樣式確實重複時才抽 React component。
- 複雜 gradient、pseudo-element 與 reduced-motion animation 在比 arbitrary variant 清楚時，保留為少量、使用 token 的 CSS。

## Acceptance criteria

- [ ] 固定版本的 Tailwind 4.3.3 dependencies 與更新後的 Bun lockfile 已提交。
- [ ] `bun run build:web` 經既有 Vite build 編譯 Tailwind，production serving path 能載入產生的 CSS。
- [ ] 沒有新增 `tailwind.config.*`、PostCSS pipeline、Play CDN、styling helper 或 variant library。
- [ ] Tailwind 只掃描 `apps/web/index.html` 與 `apps/web/src`。
- [ ] Semantic theme tokens 涵蓋重複的 typography、color、radius、shadow 與 focus 決策，不把一次性裝飾數值全部公開成 token。
- [ ] Loading、error/retry、loaded、next-decision present/absent、mobile、desktop、keyboard focus 與 reduced-motion 保持現有可觀察行為，除非差異已明確核准。
- [ ] Preflight 對 semantic element 的影響均有意識地處理，且結果可存取。
- [ ] Conditional style 只使用完整、可靜態偵測的 class name，不插值組合 utility 名稱。
- [ ] Caller 完成遷移後刪除舊 `apps/web` selector；保留的 custom CSS 只服務必要結構，不作 compatibility alias。
- [ ] 根目錄 `index.html`、`app.js`、`styles.css` 與 `.nojekyll` 沒有 diff。
- [ ] 現有 GitHub Pages 仍可公開閱讀，五個日期 tab 與四種天氣模式都能操作。

## Out of scope

- 遷移或移除根目錄 GitHub Pages 網站
- 變更 Pages hosting、DNS、URL 或 deployment
- Redesign 或 dark mode
- 新增 component library、class-merging library、variant library 或 Tailwind plugin ecosystem
- 變更旅程資料、API、React state behavior 或 #3 itinerary feature scope
- 在第二個 migrated consumer 出現前建立 shared token package

## Verification

- 透過現有 web server/container path 實際執行 Vite production artifact。
- 比較 loading、error、loaded-with-decision、loaded-without-decision、mobile、desktop、focus-visible 與 reduced-motion 狀態。
- 開啟公開 GitHub Pages URL，操作五個日期 tab 與四種天氣模式。

## Blocked by

- #2 的 Web/Vite foundation 已合併；#2 尚未完成的外部 AWS credential 步驟不阻擋本 issue。

## Blocks

- #3
```

## Bottom line

Tailwind v4.3.3 is a clean fit for the existing Vite 8 React build. Its canonical configuration is CSS-first, so this repository should use `@theme`, `@source`, and narrowly justified `@utility`/plain CSS rather than introduce `tailwind.config.*`. Migrating only `apps/web` is the smallest change that advances Issue #1's single token/component layer while honoring Issue #3's non-negotiable public GitHub Pages fallback.
