# Panel Identity & Context (custom title + note + activity)

Per-panel identity layer so you can tell terminals, SSH sessions and web panels apart at a glance
without reading their contents. V1 ships a manual **custom title** and **note**; the model and a
pipeline are prepared for a future AI-generated **activity summary**.

## Data model (block meta)

Everything lives in existing **block metadata** (`waveobj.Block.Meta`), so there is no parallel state
and it persists exactly like every other block setting (SQLite JSON blob, written via the
`SetMetaCommand` RPC → `wstore.UpdateObjectMeta`). Keys are declared in
`pkg/waveobj/wtypemeta.go` (`MetaTSType`) and regenerated into `pkg/waveobj/metaconsts.go` and
`frontend/types/gotypes.d.ts` with `task generate`.

| Key                        | Type    | Meaning                                                        | Field name (V1) |
| -------------------------- | ------- | ------------------------------------------------------------- | --------------- |
| `frame:title`              | string  | **customTitle** — manual title, overrides the auto title      | ✅ live          |
| `frame:note`               | string  | **note** — free-text purpose, shown on hover                  | ✅ live          |
| `frame:activity`           | string  | **activitySummary** — short "what am I doing" (AI, future)     | model only      |
| `frame:activity:updatedat` | number  | **activitySummaryUpdatedAt** — unix ms                        | model only      |
| `frame:activity:source`    | string  | **activitySummarySource** — `manual` / `ai:<model>`           | model only      |
| `frame:activity:enabled`   | bool    | per-panel opt-in for smart/AI context capture (default off)   | model only      |

`frame:title` is **reused** (not reinvented): it already overrode the header title and is never
written automatically by any view, so it is the natural home for customTitle.

`autoTitle` is **not** a new stored field — it is the view's own live identity: the connection
(`ndf@host:port`, shown by the connection button) for terminals, and the URL box for web panels.

## customTitle vs autoTitle

- The block header renders `resolvePanelTitle(customTitle, hideViewName, viewName)` (see
  `frontend/app/block/panelidentity-util.ts`): if a custom title is set it wins and is shown
  prominently; otherwise the previous behaviour is unchanged.
- The auto title keeps updating internally and stays reachable (connection button / URL box, and the
  hover tooltip). A shell/OSC title change or a web navigation only touches `connection`/`cmd:cwd`/
  `url` — it can never clobber `frame:title`.
- **Reset** writes `frame:title: null`; `MergeMeta` treats null as delete, so the panel falls back to
  the auto title.

## Using it

- **Rename**: double-click the panel title, or right-click the header → **Rename Panel**. A small
  popover (not a modal) edits title + note. Enter saves the title; ⌘/Ctrl+Enter saves from the note.
- **Note**: right-click → **Edit Note** (same popover). A note shows a small 🗒 marker on the title and
  the full text (plus connection / path) in the hover tooltip.
- **Reset**: right-click → **Reset Custom Title**.
- **F2 is intentionally not used** — it is already bound to *tab* rename (`keymodel.ts`), and the spec
  said not to introduce a conflicting binding.

Terminal (local + SSH) and web panels are both supported; any other view that shows a header title
(preview, sysinfo, …) also gets rename/note for free through the shared header component.

## Persistence checklist (verified)

Create panel → set title → add note → quit → reopen → title + note remain. Also survives reload,
workspace restore, and multi-window, because it is plain block meta (same path as connection, cwd,
theme, etc.). Nothing is stored only in React/memory. See `pkg/waveobj/panelidentity_test.go`.

## Smart Activity / AI context — prepared, not wired

`frontend/app/block/panelactivity.ts` (+ `panelactivity-util.ts`) define the pipeline:

```
Panel → collectPanelContext → sanitizePanelContext → ActivitySummarizer → writeActivitySummary
        (existing meta only)   (scrubSecrets)         (registered later)   (frame:activity:*)
```

- `registerActivitySummarizer(impl)` — a provider (OpenClaw / Nexus Provider Fabric / a local model)
  plugs in here. Until one is registered, `isActivitySummaryAvailable()` is false and **no UI button
  appears** (the header only adds "Generate Activity Summary" when a summarizer exists).
- `sanitizePanelContext` / `scrubSecrets` strip passwords, tokens, API keys, `Authorization`/`Bearer`,
  cookies, private-key blocks and long base64 blobs. Today only existing metadata is collected (no
  scrollback, no DOM scraping) — the scrubber is the mandatory gate for when richer signals are added.
- `clampSummary` enforces ≤ 8 words and strips quotes/trailing punctuation.
- `ActivitySummaryPrompt` is the suggested prompt (describe the *goal*, not the tool).

### Why AI is not shipped yet

There is no trivial + safe one-shot inference path in the app today: every real path needs either
telemetry-enabled Wave cloud or a user-configured API key (see `nexus/docs/AI.md` /
`pkg/aiusechat/usechat.go`). Per scope, no new dependency / API key / parallel provider was added.

### What's needed to enable AI

1. Implement an `ActivitySummarizer` (e.g. OpenClaw, or a thin non-streaming RPC around
   `pkg/aiusechat` / `google.SummarizeFile`, or an OpenAI-compatible local endpoint via `ai:baseurl`).
2. Call `registerActivitySummarizer()` at startup.
3. (Optional) Add event-driven / debounced triggers (panel created, significant web nav, cwd change,
   N commands, idle) that call `generatePanelActivitySummary(blockId)` when `isActivityEnabled(blockId)`.
4. (Optional) Show `frame:activity` under the title (the tooltip already displays it when present).
