# Local retention: what deployment has to decide

Rebuilding the authority database in place destroys the old one. The product refuses to do that
unless it can prove nobody else holds the file, and on this host it cannot prove that. This note
records why, what the options are, and which single question only the operator can answer.

## What the product does today

Before anything is removed, the swap asks who holds the source inode. A process this user owns whose
descriptors cannot be read is treated as a hole rather than a silence - nothing about such a process
says it is *not* holding the database - and the operation refuses with
`LOCAL_RETENTION_EXCLUSION_UNPROVABLE`, leaving the source, its write-ahead log and the built
candidate exactly where they were. The scheduled service reports that as its own outcome,
`unprovable`, carrying the unreadable process ids, so it is not confused with being blocked behind
unfinished work or deferred to the next window.

It is not retried inside the same window: the cycle fence is claimed before the attempt, so the next
call before `next_at` is deferred. Retrying would ask the same kernel the same question.

### The other lane

Memory compaction asks the same question and refuses the same way, with
`MEMORY_EXCLUSION_UNPROVABLE`, and records that code verbatim on its run row - distinct from the
generic `MEMORY_COMPACTION_FAILED`, so which refusal happened survives in the record.

It does not store the process ids, deliberately. A list of pids written an hour ago says nothing
about now: those processes may be gone and others may have arrived. What is durable is *which*
refusal occurred; what is live is *who* is holding the file, and that is read from the kernel at the
moment the operator asks, by the command below. The scheduled retention service returns its list
directly to the caller of the cycle for the same reason - it is fresh because it is not kept.

## What this host actually answers

Measured on 2026-09-14 on this host, with `stat` and a read of `/proc/<pid>/fd`:

| Measurement | Value |
| --- | --- |
| processes in `/proc` | 648 |
| owned by this user (uid 1000) | 443 |
| owned but unreadable | **15** |
| `unshare -Urpf` | fails: `/proc/self/uid_map: operation not permitted` |

An earlier report recorded 16 of 377. Both are true of the moments they were taken; the count drifts
with whatever the machine is running, and the shape of the answer - a non-empty hole - does not.

So on this host, in this account, a destructive retention swap will refuse every time. That is the
contract working, not a defect to code around.

## The options, and what each costs

1. **A dedicated user.** Run the authority under an account that owns nothing else. Every process
   that user owns is then the product's own, and the unreadable set is empty by construction. Costs a
   service account, file ownership migration, and whatever else currently runs as this user losing
   access.
2. **A PID namespace.** Run it where `/proc` shows only its own processes. Same effect, no account
   change. This host cannot enter one unprivileged - the measurement above - so it needs either
   privilege at start-up or a container runtime.
3. **Neither.** Retention keeps refusing, the database keeps growing, and the operator prunes by hand
   on a schedule they choose. Nothing is lost and nothing is destroyed; the cost is unbounded growth.

Option 3 is the current state and it is safe. It is not a decision that has to be made today, which
is why nothing here blocks on it.

## The one thing only the operator can decide

**EXTERNAL_INPUT_REQUIRED (operator):** which of the three options this deployment takes, and if it
is (1) or (2), the account or runtime to use.

Everything else in this area is closed internally: the refusal, its preservation guarantees, the
distinct `unprovable` outcome with the unreadable process ids, the command that reports them, and
the regressions that pin all of it.

## Reading the answer

`jarvis timeline retention-preflight <db> --db <db>` reports what the swap would find: whether
exclusion is provable now, and if not, the reason and the process ids that could not be read. It
reports identifiers and counts only - no command lines, no environment, no file contents - because
the operator needs to know which processes to look at, not what they are doing.
