# Workboard cutover and rollback plan (NOT EXECUTED)

Status: planning only. Operator approval is required before **any** production apply. The current production authority link was read before and after the regression checks and remained `releases/ef49ba0dda37eb3b93e1306eba1ea6e8bf7ade9c`. Do not flip production `authority/current` for this isolated workboard exercise.

## Proposed gated cutover

1. Obtain explicit operator approval and a separately reviewed production change window before touching production. Confirm the release and DB backup/restore procedure with the operator; do not treat passing isolated tests as authorization.
2. In an **isolated database first**, apply only additive migrations `migrations/099_workboard_projection.sql`, `migrations/100_workboard_purpose.sql`, and `migrations/101_workboard_attention.sql` in order. These create workboard-specific tables; they do not rewrite existing task or binding tables. Verify migration status and targeted workboard checks there before considering any production apply.
3. Keep any isolated preview on port 4180, separate from the existing 4173/4174/4176 listeners. Production migrations or release changes require separate operator approval; no production `current` flip is part of this plan.

## Rollback if the isolated evaluation fails

Leave production `authority/current` on `releases/ef49ba0dda37eb3b93e1306eba1ea6e8bf7ade9c` and stop **only** the isolated 4180 server, if one has been started. Retire or restore the isolated database using its own snapshot; do not remove migrations from or roll back the production database as part of this isolated rollback. At the time of these checks no 4180 server was listening, so no stop action was needed or performed. Do not stop or rebind 4173, 4174, or 4176.

No cutover, rollback operation, migration, deployment, activation, push, or restart was executed to produce this document. The plan checkbox remains untouched.
