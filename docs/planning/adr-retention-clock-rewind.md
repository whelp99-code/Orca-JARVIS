# Retention execution clock rollback

2026-09-09. Two regression cases reproduced execution before the persisted claim
time and successful deletion settlement after the execution clock moved backward.

The current lease query must require updated_at and not_before no later than the
observed clock. Before adapter invocation a rejected claim leaves its row unchanged.
After synchronous adapter execution, a completedAt earlier than started is an
E_CLOCK_INVALID failure: roll back adapter writes and settle the owned job failed
using the already observed start timestamp. Equal timestamps remain valid.

This supplements expiry/fence/policy checks on the same transaction. It does not
authorize production deletion adapters or schedules; those remain separately HOLD.
