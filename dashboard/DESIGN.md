# JARVIS Control Center Design System

## 1. Atmosphere & Identity

A restrained operational command surface: compact, legible, and evidence-first. Charcoal layers, precise borders, and monospaced machine values keep system state readable without decorative chrome. The signature is status communicated through language and a single semantic color ramp rather than ornamental graphics.

### Operating Price read state
The finance-read route uses the existing panel, form-field, identity-list and
local-work-card primitives. Unconfigured remains explicit. Loading, refused and
read-complete are distinct; HTTP200 never implies financial confirmation.
The card shows the exact raw response body and its SHA without numeric rewriting.
Missing producer fields stay missing; official_tax_ready=false is displayed from
the response. CRM workspace absence stays RT UNBOUND. Identifiers and raw JSON
wrap at 390px, document scrolling remains the sole scroll owner, and no new tokens
or motion are introduced. Credentials remain backend-only.
The company-registration card uses the same primitives and preserves its separate
native body, revision and SHA. CONFIRMED is identity-only; workspace registration
never confirms a project link, money, approval or financial execution receipt.
Missing, refused and unconfirmed registration states never imply a usable join.
The mail-candidate panel shows separate CRM and SB counts. Native CRM recent
records expose only id/status/confirmed/freshness/createdAt (at most five);
title access is explicitly unavailable. Only the isolated fixture has synthetic
titles. Unconnected is not zero, each reader may independently refuse, and the
panel has no confirmation or editing actions. Fixture counts stay LOCAL_ONLY;
native reads never imply business approval. Credentials remain backend-only.

## 2. Color

The shipped dark theme is the only page theme. Every implementation color references a token from `styles.css`.

| Role | Token | Usage |
|---|---|---|
| Canvas | `--color-canvas` | Document background |
| Surface | `--color-surface` | Navigation, panels, controls |
| Raised surface | `--color-surface-raised` | Inputs, selected and nested regions |
| Border | `--color-border` | Panel and row separation |
| Strong border | `--color-border-strong` | Controls |
| Primary text | `--color-text` | Headings and key values |
| Muted text | `--color-text-muted` | Body and supporting copy |
| Dim text | `--color-text-dim` | Metadata and empty states |
| Information | `--color-info` | Informational accents |
| Success | `--color-success` | Ready and live states |
| Warning | `--color-warning` | Cautions and pending states |
| Danger | `--color-danger` | Errors and risks |
| Focus | `--color-focus` | Keyboard focus outline |
| Selection | `--color-selection` | Active navigation and selected text |

Rules:
- Accent colors communicate state; they are not decoration.
- Body and control contrast must meet WCAG 2.2 AA.
- Raw color values belong only in the root token declarations.

## 3. Typography

| Level | Token | Usage |
|---|---|---|
| Title | `--type-title` | Route heading |
| Count | `--type-count` | Primary numeric status |
| Panel | `--type-panel` | Panel and subsection headings |
| Lead | `--type-lead` | The one line a card must be read by (workboard "why") |
| Body | `--type-body` | Forms and body copy |
| Small | `--type-sm` | Supporting copy and controls |
| Extra small | `--type-xs` | Labels and machine metadata |

Primary text uses `--font-sans`; identifiers, digests, timestamps, and command values use `--font-mono`. Weights, line heights, and label tracking use the existing root tokens. Body copy is never smaller than `--type-sm`.

## 4. Spacing & Layout

All spacing derives from the 4px base tokens `--space-1` through `--space-10`. `--size-page` bounds the page frame, `--size-reading` bounds forms and readable supporting content, `--size-textarea` gives multiline interview controls a stable minimum editing area, and `--size-fact-min` is the narrowest column a labelled fact (where/who/how) may occupy before the fact grid stacks.

The document owns vertical scrolling. The operational shell uses StyleGallery's sticky-header pattern with no nested scroll container: https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/sticky-header.md. Primary navigation remains visible while main content and the attribution footer stay in semantic source order. Proposal creation uses StyleGallery's supporting-pane pattern for a primary interview beside supplemental preview output, with no nested scroll container: https://github.com/changeroa/StyleGallery/blob/main/patterns/split-sidebar/supporting-pane.md. The panes use an overflow-safe intrinsic grid and reflow to one readable column when narrow. DOM order remains interview first, preview second.

## 5. Components

### Primary Navigation
- **Structure**: `nav` containing route links.
- **States**: default, hover, focus-visible, current page.
- **Spacing**: `--space-1` through `--space-3`; `--size-nav` and `--size-control`.
- **Accessibility**: named navigation landmark, real links, visible focus, current route exposed by `aria-current`.
- **Motion**: none.
- **Layout**: wrapping cluster inside the page frame; document scroll owner.

### Operational Shell
- **Structure**: skip link, sticky header with primary navigation and canonical connection state, one main landmark, and attribution footer.
- **States**: live, reconnecting, offline, read-only (phone), current route, keyboard focus.
- **Surfaces**: the same build serves the loopback control center (`local`) and the tailnet phone gateway (`phone`, marked by the gateway's `jarvis-phone-mode` meta). On the phone the navigation offers only Today, Products, Memory, Approvals and Security, the state pill reads `읽기 전용` with the `--color-info` dot (`data-state="readonly"`), no authority stream opens, and every mutation control is absent: the phone is read-only by design, never "disconnected".
- **Spacing**: `--space-1` through `--space-4`; navigation and controls use `--size-nav` and `--size-control`.
- **Accessibility**: skip link targets the programmatically focusable main landmark; navigation follows route order; state is politely announced; footer links to the shipped notice.
- **Motion**: none.
- **Layout**: resilient header/main/footer grid; document scroll owner; navigation stays on one line at 1024px and above.

### Panel
- **Structure**: semantic section with optional header and body.
- **States**: default, empty, loading, error, success.
- **Spacing**: `--space-3`, `--space-4`, and `--space-6`.
- **Accessibility**: named by heading or `aria-label`; live/error state uses the appropriate role.
- **Motion**: none.
- **Layout**: stack; no internal scroll owner.

### Task Graph
- **Structure**: named panel, Graph/List pressed-state controls, source graph image, and equivalent ordered list.
- **States**: graph, list, empty, keyboard focus.
- **Spacing**: `--space-1` through `--space-4`.
- **Accessibility**: canonical source order is unchanged; graph has a concise accessible name and list view exposes the same start/edge sequence semantically.
- **Motion**: none.
- **Layout**: overflow-safe intrinsic grid that collapses to block flow without clipping identifiers.

### Timeline
- **Structure**: named panel with an ordered event list and evidence metadata.
- **States**: loading, retrying, empty, error, success.
- **Spacing**: `--space-2` through `--space-4`.
- **Accessibility**: busy and state announcements use status/alert roles; time uses native `time`; source text and evidence remain verbatim.
- **Motion**: none.
- **Layout**: ordered stack; document scroll owner; long and CJK values wrap.

### Form Control
- **Structure**: explicit label followed by input, select, or textarea; helper/error copy follows the control.
- **States**: default, hover, focus-visible, disabled, invalid.
- **Spacing**: `--space-2` and `--space-3`; control height uses `--size-control`.
- **Accessibility**: every control has a persistent label, native semantics, and visible focus. Related checkboxes use `fieldset` and `legend`.
- **Motion**: none.
- **Layout**: stack; controls remain full-width and wrap long values.

### Proposal Preview
- **Structure**: named result region containing status, digest, selected member list, warnings, budget, and stage action when ready.
- **States**: idle, loading, needs input, blocked, ready, staging, staged, error.
- **Spacing**: `--space-2` through `--space-6`.
- **Accessibility**: status changes use `role=status`; failures and blocks use `role=alert`; the stage action exists only for ready proposals.
- **Motion**: none.
- **Layout**: supplemental pane beside the interview at wide widths, following it in DOM and focus order; document scroll owner.

### Record List
- **Structure**: semantic list of records with title, summary, and metadata.
- **States**: populated and empty.
- **Spacing**: `--space-1` through `--space-4`.
- **Accessibility**: list order equals API order; identifiers wrap rather than overflow.
- **Motion**: none.
- **Layout**: feed stack; no internal scroll owner.

### Company Candidate Approval
- **Structure**: existing approval Record List; explicit accept-and-verified-complete
  scope, native disclosure for provider/workspace/candidate/content/access fence,
  and existing representative passkey approve/reject controls.
- **States**: pending, expired, approved awaiting separate processor, accepted
  awaiting downstream verification, rejected awaiting SB forwarding (read-only),
  uncertain requiring review, superseded removed.
- **Privacy**: metadata only; no company content, personal memory or raw source.
- **Layout, typography and motion**: existing Record List, Panel, Digest and
  identity-list primitives and tokens; no new geometry, colors or animation.
- **Authority**: processor does not sign representative decisions; acceptance is
  not processing completion. Approved/accepted items retain their exact identity.
  Unforwarded rejections remain visible without decision controls. Their exact
  request ID is available in the existing identity disclosure for manual execution.

### Company Daily Report
- **Structure**: read-only Record List card in the existing approval inbox, date and
 18:00 KST cutoff, separate completed/protected/uncertain counts, then a native
 disclosure for the immutable metadata rows and original receipt references.
- **States**: published, empty (0 records), notification pending/unsupported/failed/
 delivered, and selected report detail. A report never contains representative
 approve/reject controls. Existing human candidates keep their passkey controls.
- **Privacy**: candidate/source/policy/operation/receipt identifiers only. No body,
 contact values, amount, personal memory or invented representative approval.
- **Layout and tokens**: existing Panel, Record List, Digest, identity-list and
 button primitives; document scrolling and wrapping identifiers at390px. No new
 colors, spacing values, fonts, motion or developer runtime dependencies.
- **Accessibility**: named disclosure with native keyboard behavior; report links
 address the exact report rather than the latest card. Dates use native time and
 KST display. Technical identifiers remain selectable in the evidence disclosure.
 Receipt fragment targets reserve the existing shell navigation scroll margin:
 three navigation-height tokens below64rem and one above, as on Finance Read.

### Today Decision Surface
- **Structure**: six semantic panels in fixed source order: NOW, BLOCKED, DECISIONS, NEXT 3, WORKERS, RISKS.
- **States**: loading, live, stale, offline, blocked, staging, accepted, validation error, and read-only (phone: a status banner replaces the stale alert, the approvals link and worker/risk authority data are not rendered, and no action is enabled).
- **Spacing**: `--space-1` through `--space-6`; action rows use existing Record List and Form Control geometry.
- **Accessibility**: native headings, lists, `details`/`summary`, `time`, buttons, status, and alert semantics; cached data never enables mutation.
- **Motion**: none; async controls swap labels and disabled state immediately.
- **Layout**: StyleGallery `ram-grid` inside the existing sticky-header shell; document owns scrolling and source/focus order is unchanged at every width.

### Read-only Product Hub
- **Structure**: a named product section before Today, also available at `/products`; six Panel articles in fixed order: CRM, Mail, AI tax, Second Brain, messenger and approvals. Each exposes its source-specific summary, read state and observation time. Available screens have navigation links; Price has no screen and shows `화면 준비 중` without a link or button.
- **States**: loading, ready, explicit no data, unconfigured, unavailable, denied, stale and configured-only. Failed reads remove old counts instead of turning them into zero. Price configured-only is not a live ledger read or an available UI. Candidate, message and pending-control counts are never added together.
- **Authority and privacy**: bounded summary GET with existing session/CSRF; no source bodies, record identities, arbitrary provider links, money calculation or mutation controls. The approval card navigates only; it does not authorize or perform a decision.
- **Links**: public dashboard build-time env values configure destinations. CRM web defaults to HTTPS `jm-omachy.alpines-goldeye.ts.net:8448`; its separate candidate approval screen defaults to HTTPS port `8450` (review-ui, not Price). Mail defaults to HTTPS port `8451`. Memory, messenger and approvals default to `/memory`, `/products#product-messenger` and `/approvals`. Source-provided URLs never set these links. Price deliberately has no destination.
- **Layout and tokens**: existing Panel and Record List geometry, intrinsic grid with `--size-agent-min`, spacing `--space-2` through `--space-6`, existing type/color tokens, document scrolling and wrapping long content. No new visual tokens, motion, shadow or colored state borders.
- **Accessibility**: semantic section/article/headings, native links/buttons/time, one atomic read status, visible keyboard focus, control-height links and scroll margin beneath the sticky header. The existing dark theme is retained under both OS color preferences.

Product destination configuration (`dashboard/.env.example`) uses `VITE_JARVIS_CRM_URL`,
`VITE_JARVIS_CRM_REVIEW_URL`, `VITE_JARVIS_MAIL_URL`, `VITE_JARVIS_MEMORY_URL`,
`VITE_JARVIS_MESSENGER_URL` and `VITE_JARVIS_APPROVALS_URL`. Set them in the environment
when running `npm run build:dashboard`, or in `dashboard/.env.production.local`.
They are public navigation URLs embedded in the static dashboard build; changing
only the running service environment does not update an already-built dashboard.

### Memory Control Surface
- **Structure**: heading with provider badge and a `Refresh memory` button, one atomic live status, bounded Search, Results/Detail, Conflicts, Candidates, then Effects and privacy receipts in fixed DOM order.
- **States**: loading, ready, no data, expired (status token lapsed), stale (provider reported stale evidence), offline, unavailable, incompatible, not loaded, sensitive-redacted, superseded, staging (busy), pending approval, applying, verified complete, and forgotten removal. The badge and status copy derive from the latest provider read, never from the status route alone; offline, unavailable, or stale is never presented as an empty result or as `ready`, and a panel whose data was cleared or could not be read renders an explicit "Not loaded" state (or "Loading" while a reload is in flight), never its empty-state copy.
- **Detail**: title, excerpt (or redaction/supersession copy), an `identity-list` of Citation, Provenance (safe label / owner class), Sensitivity, Retention with native `time`, Freshness, and History (`current` or `superseded` plus the superseding request); then a bounded `Record history` ordered list (operation, state, request id, receipt id, `time`), and finally the correction form and Privacy actions.
- **Actions**: correct/forget/export render only when the status route enables mutations and the record lists the action; a staging action swaps its label, disables its siblings, and dispatches exactly one command per activation. Superseded records expose no actions. On the phone surface no action renders and the Candidates and Effects panels are omitted: the gateway proxies status, conflicts and search only, and every memory change is staged from the Linux control center.
- **Announcements**: staged, stale-selection, prohibited-content, and transport outcomes are announced through the single atomic status region using safe copy keyed by machine code; raw API messages never render. An outcome speaks only for the search generation that produced it, so expiry, a privacy-epoch change, or a new search retires it and the region reverts to provider copy rather than reporting an outcome the surface has outlived.
- **Freshness**: the status read token expires after 60 s; expiry clears every panel and marks them not loaded. Searching on an expired status re-reads the whole surface (status and every panel) before querying, and `Refresh memory` does the same on demand. A same-epoch reload refreshes results and history in place; a privacy-epoch change clears private results, drafts, and selection immediately. A reload that fails after the surface is up keeps the surface, marks the panels not loaded, and announces the failure.
- **Color**: badge text uses `--color-success` (ready), `--color-warning` (expired, stale, incompatible), `--color-danger` (offline, unavailable); result and conflict notices follow the same ramp. State is text plus color, never color alone.
- **Spacing**: `--space-1` through `--space-6`; forms, records, panels, and status reuse existing primitives; the Detail body and search form inset by `--space-4`.
- **Typography**: the Detail title uses `--type-panel`; metadata and history identifiers use `--font-mono` at `--type-sm`; CJK text keeps whole words (`word-break: keep-all`) and only unbroken tokens longer than a line may wrap anywhere.
- **Accessibility**: persistent labels, native buttons/checkbox/fieldset, one atomic live status, initiator-safe focus, `aria-busy` on staging regions, and no subject-revealing accessible names for redacted records.
- **Motion**: none; privacy removal and authority state changes are immediate.
- **Layout**: document scroll owner; Results/Detail and Candidates/Effects use overflow-safe two-column grids above 40rem and preserve source/focus order when stacked.
- **Privacy**: no query in URL/storage, no memory-derived links or HTML, no path/download/clipboard surface, and provider origin labels that look like paths or URIs are replaced with a safe label.

### Finance Read Preparation
- **Structure**: route heading, explicit isolated-fixture/unconfigured notice, bounded request form, then a preparation result panel. The result exposes company, target, case/report, source revision, view and operation identities, not invented financial results.
- **States**: unconfigured (no action), isolated fixture idle, refused, and prepared locally. Editing the request retires the previous result immediately. Preparation is not a live read, consumed approval, signed receipt or integrated acceptance.
- **Actions**: only local contract validation; no approval, send, tax, payment, provider connection or authority registration control.
- **Accessibility**: persistent native labels, bounded inputs, grouped case/report reference, one atomic status region and safe code-based refusal copy. The phone gateway exposes neither the route nor its navigation link.
- **Layout**: existing Panel, Form Control, Proposal Preview and `proposal-layout` supporting panes; document owns scrolling. Identifier values wrap anywhere and the request precedes its result in DOM order. Form/disclosure scroll targets reserve three navigation-height tokens below 64rem for the wrapping sticky header, and one above that breakpoint.
- **Color and motion**: existing tokens only; fixture/preparation uses informational or warning text, never live-success tone; no motion.
- **Composition**: the normal route is unconfigured. Explicit Vite development mode `fp5-local` supplies fixture authority only; production builds contain no active fixture runtime.
- **Company-memory evidence**: a separate panel in the same explicit local composition displays selected fields from the Root-admitted MS receipt. It preserves candidate state, workspace, immutable message locator, parser, content/request digests, ack version and the recorded receipt identity. Native disclosure keeps technical evidence behind the summary. This historical isolated projection is not a new signed receipt, current connection, business approval or personal memory, and is not joined to the finance fixture's different company. It exposes no action or memory-derived link.
- **Mail-to-work evidence**: a separate recorded MR panel preserves Mail producer source/request/audit identities, receive/mapping versions and explicit-human-fixture mapping authority. Producer IDs are not labeled as Root's fresh fixture IDs. This is not a new command, live identity, archive approval, financial truth or a merge with the MS source. It uses the same token spacing and native disclosure, with no action or provider client.
- **Work-reference memory evidence**: a separate recorded RS panel uses Root's independently observed request, receive receipt and raw-source byte digest. It preserves candidate/EMITTED/version 2, RS_LOCAL_ONLY and ARCHIVE_PROJECTION_ONLY. Native approval stays boolean false; the locator's approval string stays `"false"` and is not coerced into a grant. Technical IDs remain behind native disclosure. The panel has no action or live outbox/personal-memory implication.

### Purpose Workboard
- **Structure**: heading, then two sections in fixed source order: items needing the user (ordered list, queue order) and work grouped by project purpose. Every card reads top-down as why, what, where/who/how facts, the user's action, and a closed evidence disclosure.
- **States**: loading, load error, not collected, empty queue, empty groups, urgency tones (now/soon/watch/none), purpose confirmed/proposed/unknown, evidence open/closed, reconfirmation required.
- **Spacing**: `--space-1` through `--space-6`; card accent uses `--border-accent`; fact columns use `--size-fact-min`.
- **Typography**: the why line uses `--type-lead` and is the largest text on a card; what uses `--type-body`; facts and actions use `--type-sm`; labels and evidence use `--type-xs` in `--font-mono`.
- **Accessibility**: native headings, `ol`/`ul`, `dl`, `time`, and a real button with `aria-expanded`/`aria-controls` for evidence. Unknown purpose is announced verbatim as 목적 확인 필요; unsupported actions say 원천에서 처리 instead of rendering an inert button.
- **Privacy of identifiers**: digests, session/attempt keys, source generations, and raw refs render only inside the opened evidence disclosure, never in the default DOM.
- **Motion**: none.
- **Layout**: document scroll owner; lead cards use an asymmetric two-column area grid at 64rem and above and stack below; purpose groups use the existing auto-fit card grid; everything wraps with `overflow-wrap: anywhere`.

## 6. Motion & Interaction

### Local Five-product Work Card
- **Structure**: one native finance job article, purpose and blocked-state summary, then source, native project, amounts, approval and receipt in that order. Recorded MS/RS/MR/MT proofs remain separate; RT displays native Price state, source identity and its explicit company/workspace registration.
- **Identity**: every job section carries the same internal case and response-body revision. Native project/source IDs and producer snapshot remain distinct from the internal J1 report reference and body hash.
- **States**: recorded LOCAL_ONLY native UNBOUND, UNAPPROVED, CONFIRMED and SOURCE_CHANGED. Only a native confirmed link with its matching human-confirmed company/workspace registration establishes identity confirmation; never caller-supplied registration. SOURCE_CHANGED preserves registration history but removes current connection confirmation and shows unavailable current project/amounts as null. Identity confirmation never implies finance approval. Body integrity does not prove producer freshness; both financial readiness flags remain false.
- **Layout**: existing Panel and Record List primitives; document scrolling, source-order stack, token spacing, wrapping identifiers including disclosure titles, and native disclosures. No financial aggregation across independent fixture scopes.
- **Actions**: disclosure only. No read principal, grant, approval, provider call, payment or journal effect. Development `fp5-local` only; default production remains unconfigured.

Motion intensity is low. State changes are immediate and no automatic animation is used. Hover, active, and focus feedback communicate affordance without moving layout. Any future non-essential motion must animate only transform or opacity and honor `prefers-reduced-motion`.

## 7. Depth & Surface

Strategy: borders-only. Surface hierarchy uses `--color-canvas`, `--color-surface`, and `--color-surface-raised`; `--border-width`, `--color-border`, and `--color-border-strong` provide separation. A single inline-start accent of `--border-accent` in a semantic color marks urgency on workboard cards. No box shadows or decorative glows.

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- WCAG 2.2 AA target, including 4.5:1 body text and 3:1 large text/control boundary contrast.
- Full keyboard reachability with a visible focus outline on every interactive element.
- Native form labels and grouping; no placeholder-as-label controls.
- Status, blocked, pending, staged, and transport-error outcomes are announced semantically.
- The route reflows at 375px without horizontal scrolling of primary content.
- Long objectives, identifiers, and digests wrap safely.

### Accepted Debt

None.
