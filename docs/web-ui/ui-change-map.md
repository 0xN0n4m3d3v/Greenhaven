# UI Change Map — web-ui responsive overhaul

- **Snapshot date:** 2026-04-28 (original authoring)
- **Relocated:** 2026-05-16 — moved from `packages/web-ui/UI_CHANGE_MAP.md`
  to `docs/web-ui/ui-change-map.md` under Phase-7 hygiene item `U-6`.
  Content is preserved verbatim below; this is still a PLAN doc, not an
  implementation record. The responsive overhaul itself is out of
  scope for U-6 and tracked separately under the web-ui change backlog.

Status: PLAN. No code changes yet. Reviewed against current `App.tsx`, `App.css`, `style.css`.

## TL;DR what's broken now

1. **`100vh` everywhere** — breaks on mobile browsers (address-bar pop-in/out makes the layout overshoot the screen).
2. **Hardcoded 3-column grid `292 / 1fr / 280`** — only two breakpoints (1040px, 760px). Below 760px both sidebars + chat stack vertically without a drawer; the world-panel just *disappears* — content is lost.
3. **No CSS variables** — every colour is inlined in `App.css`. Theming = find/replace.
4. **Tailwind imported but unused** — `style.css:1` pulls Tailwind, no `className="md:..."` anywhere.
5. **Fixed font sizes** — no `clamp()` / fluid type. `26px`/`28px` headings stay 28px on a 320px phone.
6. **No container queries** — chat-bubble width is `min(640px, 78%)` of viewport, not of the chat column. With a wide left rail open, bubbles waste space.
7. **Touch targets** — quick-action buttons & inline mentions are pill-sized (~30px tall). Apple/Google minimum is 44×44.
8. **`min-w-0` missing on flex children** — long single-word URLs / Cyrillic without spaces overflow horizontally instead of wrapping.

## Target layout, three breakpoints

Mobile-first. All `min-width` queries (progressive enhancement).

| Width band | Layout |
|---|---|
| **0 – 767px** (phone) | Single column = chat. Left rail is a *drawer* opened by hamburger. World panel = drawer opened by info icon. |
| **768 – 1199px** (tablet) | Two columns: left rail (240px) + chat. World panel becomes a drawer. |
| **1200px+** (desktop) | Three columns: left rail (260px) + chat + world panel (300px). |

Drawers slide from the side with backdrop. Use `<dialog>` element + native ESC-to-close + `popover` API for trap-focus, or the daisyUI-style label-checkbox pattern if we want zero JS.

## Per-element change map

Format: **Element** → *current* / *symptom on phone* / *change*

### Layout root

- **`html, body, #app`** (`style.css:24+`) → `height: 100vh` → invisible toolbar overflow on mobile → switch to `100dvh` with `100vh` fallback (`min-height: 100vh; min-height: 100dvh;` two-line rule).
- **`.game-shell`** (`App.css:1–10`) → `grid-template-columns: 292px 1fr 280px; height: 100vh` → mobile-first becomes `display: grid; grid-template-columns: 1fr;` then `@media (min-width: 768px)` adds left rail, `@media (min-width: 1200px)` adds world panel. Replace `100vh` → `100dvh`.

### Tokens & theming

- **Add `:root` variables** in `style.css`: `--bg-base`, `--bg-rail`, `--text`, `--text-dim`, `--accent-gold`, `--accent-orange`, `--accent-teal`, `--border`, `--bubble-self`, `--bubble-other`, `--bubble-system`, `--radius-md` (16), `--radius-lg` (22), `--space-1..8`, `--font-sm` (clamp 11–13), `--font-base` (clamp 14–16), `--font-lg` (clamp 17–20), `--font-xl` (clamp 22–28).
- Replace hard-coded `rgba(...)` in `App.css` with `var(--*)`.

### `.contact-rail` (left rail)

- Currently `width: 292px; padding: 24px;` — too wide for mobile (it occupies whole screen as a drawer).
- Change: outside drawer, `padding: 16px` (mobile) → `20px` (tablet) → `24px` (desktop).
- When inside mobile drawer: `width: min(86vw, 320px); height: 100dvh; transform: translateX(-100%)` until `[data-open]`, then `0`. Drawer overlay: position fixed, z-index high, animated.
- **brand-block** (`App.tsx:893`): keep, but smaller `.brand-mark` on mobile (40px instead of 48px).
- **section-title** (`App.tsx:901`): `letter-spacing: 0.18em; font-size: clamp(10px, 2vw, 11px)`.
- **.location-card** (`App.tsx:902`): expand tap area to `min-height: 44px`, allow text to wrap with `min-width: 0` on the middle column.
- **.stat-grid** (`App.tsx:923`): on phone `grid-template-columns: 1fr` (single column instead of 1fr 1fr).

### `.chat-stage` (centre)

- Currently `grid-template-rows: auto 1fr auto` — works, but `.message-flow` with `padding: 32px` is too much on mobile.
- Change: padding `12px 12px` (mobile) → `20px 24px` (tablet) → `28px 32px` (desktop). Use `clamp()` so it's smooth.
- **`.chat-header`** (`App.tsx:936`): on phone, *prepend* a hamburger button (left) + "world panel" button (right). Both 44×44. Title centre-aligned, scene-line truncated with `text-overflow: ellipsis`.
- **`.nearby-strip`** (`App.tsx:944`): on phone collapses into a horizontal scroll list (`overflow-x: auto; -webkit-overflow-scrolling: touch`) so wraps don't push header height up.
- **`.message-flow`** (`App.tsx:956`): `min-height: 0` (critical for flex overflow), `flex: 1 1 0`, scroll-padding-top so anchored scroll doesn't hide header.
- **`.bubble`** (`App.css:209`): switch from viewport-relative to **container-query-relative**:
  - Wrap chat-stage with `container-type: inline-size; container-name: chat;`.
  - `.bubble { max-width: min(640px, 86%); }` becomes `@container chat (min-width: 640px) { .bubble { max-width: 78% } }`. On a narrow column the bubble takes 86%, on wide column 78% — width tracks column, not viewport.
  - Add `min-width: 0` and `overflow-wrap: anywhere` so long URLs / unbreakable Cyrillic wrap.
- **`.bubble-author`**: the long author name + dice chip should `flex-wrap: wrap` on mobile.
- **`.message-rich`**: `word-break: break-word` is too aggressive — use `overflow-wrap: anywhere` (only breaks when there's no other way).
- **Optimistic / pending bubbles**: add `aria-live="polite"` so screen readers announce streaming progress. Cosmetic but cheap.
- **`.action-dock`** (`App.tsx:1061`): on phone, `padding: 12px 12px env(safe-area-inset-bottom)` — respect home-indicator notch on iOS.
- **`.quick-actions`**: on phone make horizontally scrollable (single row) instead of wrap. Tap targets `min-height: 44px`.
- **`.composer`** (`App.tsx:1086`): on phone the input grows to fill, send button stays `auto`. Add `font-size: 16px` on the input on phones (prevents iOS auto-zoom on focus).

### `.world-panel` (right rail)

- Currently `display: none` below 1040px → content is unreachable.
- Change: it stays available as a *drawer* on tablet & phone, opens via the new header button.
- **`.panel-card`** (`App.tsx:1101`): on phone reduce `padding: 14px` (was 18). Keep border radius.
- **`.slot-list`** (`App.tsx:1110`): existing `overflow-wrap: anywhere` is fine. Just respect the new spacing.

### Inline mentions

- **`.inline-mention`** (`App.css:365`): tap area ≥44px? Currently inline-block pill, ~24px tall — too small. Change to `padding: 6px 10px` on mobile so it grows. On desktop keep current.

### Loading screen

- **`.loading-card`** already uses `min(520px, calc(100vw - 32px))` — keep. Just swap `100vh` → `100dvh`.

### Dice bubble

- Hardcoded `--side: 28px` for the d20. Should scale: `--side: clamp(24px, 6vw, 32px)` so it doesn't dominate small screens.

## CSS-only drawer pattern (no extra JS state)

Use `<input type="checkbox" id="rail-toggle" hidden>` outside the drawer + `<label for="rail-toggle">` as the hamburger button. CSS rule: `#rail-toggle:checked ~ .contact-rail { transform: translateX(0); }`. Closes by clicking backdrop label or ESC (small JS). This keeps App.tsx state lean and avoids prop-drilling drawer state through 50 LOC of components.

Alternative: use the new HTML `popover` attribute and `command` invokers. Browser support is solid in late 2025 (Chrome/Edge/Safari TP); older Safari needs polyfill.

I'd vote for the `popover` route — it's the modern answer.

## Mobile-only details

1. **Safe areas** — wrap shell padding with `env(safe-area-inset-{top,right,bottom,left}, 0px)` so iOS notch and home indicator don't clip content.
2. **Input zoom prevention** — `font-size: 16px` on `<input>` and `<textarea>` (already covered above).
3. **Scroll containment** — `.message-flow { overscroll-behavior: contain; }` so pulling the messages doesn't bounce the whole page.
4. **`tap-highlight-color: transparent`** on buttons; replace with custom `:active` background.
5. **`-webkit-text-size-adjust: 100%`** on `<html>` so iOS doesn't auto-resize text on rotation.
6. **`scroll-snap`** — out of scope for this pass but worth noting for `.nearby-strip` horizontal scroll.

## What I'd skip for this pass

- Migrating to Tailwind utility classes wholesale. Touching every JSX element doubles risk for no responsive benefit. Keep `App.css`, just rewrite the rules with variables + `min-width` queries + container queries.
- Adding any new components (e.g. real Drawer component). Use the popover/dialog primitive.
- Theme switcher. Tokens go to `:root`; second theme can land later by overriding at `[data-theme=light]`.

## Order of operations when we start

1. **`style.css`** — define `:root` tokens + replace `100vh` with `100dvh` (5 lines).
2. **`App.css` layout block** (lines 1–23) — mobile-first 1-col → tablet 2-col → desktop 3-col. Drop the desktop-down media queries.
3. **`.message-flow` + `.bubble`** — container queries. ~20 lines touched.
4. **`.action-dock`, `.composer`, `.quick-actions`** — touch targets + safe-area. ~10 lines.
5. **Drawers** for rail + world-panel with `popover` attr + 3 lines of JSX in `App.tsx`. Single-digit-LOC change to App.tsx.
6. **Token sweep** — replace inlined colors with `var(--*)`. Mechanical find-replace.
7. Visual smoke at 360 / 414 / 768 / 1024 / 1280 / 1920 widths; ~10-20 visual fixes.

Estimated total touch: ~250 lines of CSS, ~30 lines of JSX (drawer triggers + popover targets). One PR, two if drawers want to be separate.

## Sources from research

- [Tailwind CSS – `overflow-wrap` reference](https://tailwindcss.com/docs/overflow-wrap)
- [Tailwind CSS – `text-wrap`](https://tailwindcss.com/docs/text-wrap)
- [daisyUI Drawer pattern](https://daisyui.com/components/drawer/)
- [Tailkits – Responsive sidebar/drawer techniques](https://tailkits.com/components/)
- [Djamware – React responsive design with CSS Grid + media queries](https://www.djamware.com/post/react-responsive-design-with-css-grid-and-media-queries-build-mobile-first-layouts)
- [Steve Kinney – Truncation and Wrapping in Tailwind](https://stevekinney.com/courses/tailwind/truncation-and-wrapping)
- [Pagedone – Tailwind CSS Chat Bubble templates](https://pagedone.io/docs/chat-bubble)

---

*If you read this and disagree with any decision (e.g. "I want world-panel to actually disappear on phone, not be a drawer" or "I want a Tailwind rewrite"), call it out before I touch code.*
