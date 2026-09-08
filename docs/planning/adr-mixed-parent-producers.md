# Preserve mixed parent candidates at producer boundaries

2026-09-09. Follow-up to `adr-complete-parent-lineage.md`.

`bindNotificationProjection` and the parent-only branch of
`bindStructuredProjection` previously discarded every candidate without lineage
before inheritance. This bypassed the supplied-parent completeness guard: one
known context could hide a second unresolved context.

Keep the existing trigger (at least one parent has recorded lineage), but pass
the complete parent candidate list into `inherit`. Mixed known/unresolved inputs
then quarantine rather than publishing partial dependencies. Fully resolved
parents still contribute their union. This also preserves quarantined candidates,
so quarantine propagation remains active.

The all-untracked legacy path remains untracked; it does not acquire lineage and
is not evidence of verified non-memory input. Native evening still requires
recorded provenance and suppression checks. Operators must resolve the source
contract before treating untracked output as verified ancestry. When a legitimate
non-memory parent is mixed with a memory-derived parent, the absence of a typed
non-memory declaration conservatively quarantines the child; do not bypass it
by dropping that parent. This is an availability limitation pending admission.

Remaining HOLD: explicit memory-reference and parent-reference combinations in
the structured collector, bounded/deep input traversal, confirmed non-memory
declarations, source identities bound to approval/provider inputs, and historical
repair. This change does not establish complete end-to-end source admission.

Regression matrix: notification and structured producers, each with mixed,
fully resolved, and all-untracked parents. The two mixed cases failed before the
fix (child was visible); the other four establish resolved-union and untracked
compatibility. No schema or production state change is required.

Validation: 27 tests in six files passed (18.07s), covering the producer matrix,
authority, eleven persisted read contexts, initialization, notification intents,
and reviewability. Backend build, lint and three TypeScript configurations exited
0. Compiled Node PID 811909 invoked both production binding helpers against an
isolated DB; PID 811965 reopened it and observed two `lineage_unresolved` rows
(notification intent and control payload), visible count 0, exit 0. Source
identities were synthetic; no external provider or operating notification was used.
Additional compiled process 823118 called `NotificationIntentStore.persist` with
a fixture decision queue whose context had lineage and recommendation did not;
the resulting intent was suppressed with visible count 0 (exit 0). An initial
external experiment used nonexistent method `apply` and failed before persistence;
correcting the harness to the actual `persist` API produced this result.
