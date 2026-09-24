# JARVIS Control Center Design System

## 1. Atmosphere & Identity

A restrained operational command surface: compact, legible, and evidence-first. Charcoal layers, precise borders, and monospaced machine values keep system state readable without decorative chrome. The signature is status communicated through language and a single semantic color ramp rather than ornamental graphics.

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
- **States**: live, reconnecting, offline, current route, keyboard focus.
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

### Today Decision Surface
- **Structure**: six semantic panels in fixed source order: NOW, BLOCKED, DECISIONS, NEXT 3, WORKERS, RISKS.
- **States**: loading, live, stale, offline, blocked, staging, accepted, and validation error.
- **Spacing**: `--space-1` through `--space-6`; action rows use existing Record List and Form Control geometry.
- **Accessibility**: native headings, lists, `details`/`summary`, `time`, buttons, status, and alert semantics; cached data never enables mutation.
- **Motion**: none; async controls swap labels and disabled state immediately.
- **Layout**: StyleGallery `ram-grid` inside the existing sticky-header shell; document owns scrolling and source/focus order is unchanged at every width.

### Memory Control Surface
- **Structure**: heading/status, bounded Search, Results/Detail, Conflicts, Candidates, then Effects and privacy receipts in fixed DOM order.
- **States**: loading, ready, no data, stale, offline, incompatible, sensitive-redacted, pending approval, applying, verified complete, and forgotten removal.
- **Spacing**: `--space-1` through `--space-6`; forms, records, panels, and status reuse existing primitives.
- **Accessibility**: persistent labels, native buttons/checkbox/fieldset, one atomic live status, initiator-safe focus, and no subject-revealing accessible names for redacted records.
- **Motion**: none; privacy removal and authority state changes are immediate.
- **Layout**: document scroll owner; Results/Detail and Candidates/Effects use overflow-safe two-column grids above 40rem and preserve source/focus order when stacked.
- **Privacy**: no query in URL/storage, no memory-derived links or HTML, and no path/download/clipboard surface.

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
