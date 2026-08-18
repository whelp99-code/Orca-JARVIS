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
| Body | `--type-body` | Forms and body copy |
| Small | `--type-sm` | Supporting copy and controls |
| Extra small | `--type-xs` | Labels and machine metadata |

Primary text uses `--font-sans`; identifiers, digests, timestamps, and command values use `--font-mono`. Weights, line heights, and label tracking use the existing root tokens. Body copy is never smaller than `--type-sm`.

## 4. Spacing & Layout

All spacing derives from the 4px base tokens `--space-1` through `--space-10`. `--size-page` bounds the page frame, `--size-reading` bounds forms and readable supporting content, and `--size-textarea` gives multiline interview controls a stable minimum editing area.

The document owns vertical scrolling. The sticky primary navigation remains visible. Proposal creation uses StyleGallery's supporting-pane pattern for a primary interview beside supplemental preview output, with no nested scroll container: https://github.com/changeroa/StyleGallery/blob/main/patterns/split-sidebar/supporting-pane.md. The panes use an overflow-safe intrinsic grid and reflow to one readable column when narrow. DOM order remains interview first, preview second.

## 5. Components

### Primary Navigation
- **Structure**: `nav` containing route links.
- **States**: default, hover, focus-visible, current page.
- **Spacing**: `--space-1` through `--space-3`; `--size-nav` and `--size-control`.
- **Accessibility**: named navigation landmark, real links, visible focus, current route exposed by `aria-current`.
- **Motion**: none.
- **Layout**: wrapping cluster inside the page frame; document scroll owner.

### Panel
- **Structure**: semantic section with optional header and body.
- **States**: default, empty, loading, error, success.
- **Spacing**: `--space-3`, `--space-4`, and `--space-6`.
- **Accessibility**: named by heading or `aria-label`; live/error state uses the appropriate role.
- **Motion**: none.
- **Layout**: stack; no internal scroll owner.

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

## 6. Motion & Interaction

Motion intensity is low. State changes are immediate and no automatic animation is used. Hover, active, and focus feedback communicate affordance without moving layout. Any future non-essential motion must animate only transform or opacity and honor `prefers-reduced-motion`.

## 7. Depth & Surface

Strategy: borders-only. Surface hierarchy uses `--color-canvas`, `--color-surface`, and `--color-surface-raised`; `--border-width`, `--color-border`, and `--color-border-strong` provide separation. No box shadows or decorative glows.

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
