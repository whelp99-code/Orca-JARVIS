# Price operating finance read

The dashboard entrypoint accepts `--price-read-credential PATH`. Unset keeps
the finance-read route explicitly unconfigured. The protected descriptor is
issued by Price for its dedicated JARVIS viewer, not a human owner session.
The backend uses only the fixed operating loopback origin, authenticates its
own viewer session, and permits only the three company-scoped native GETs.
There is no financial write endpoint, reconciliation action, redirect or
automatic retry. Responses retain the exact body and its SHA-256; the SHA
is integrity evidence, not a signed receipt or a freshness claim.

The `/finance-read` card displays producer flags without promotion or numeric
rewriting. Missing fields stay missing. Empty source obligations are allowed,
and absent CRM workspace registration stays RT UNBOUND.

## Credential custody

The Price registration receipt is the source of the credential path and
company scope. The source file must remain a regular 0600 file owned by its
issuing account. Do not print, commit, copy into evidence, or pass credential
values through a command argument or an environment variable.

For a different operating service account, the approved mechanism is systemd
`LoadCredential`: reference the existing Price-issued file in the unit, and
pass `%d/price-reader` to `--price-read-credential`. The runtime accepts a
service-owned 0400 file only inside the exact `CREDENTIALS_DIRECTORY` supplied
by systemd. It rejects symlinks, foreign owners, permissive modes, another
origin, a non-dedicated username, and a login outside the one viewer company.
No original credential mode or owner change is required.

Configure the existing dashboard unit only after the approved release is
published. Preserve its current interpreter, state roots, database, static
root and hardening settings. Do not install a development worktree as a
production bind mount.

## Delivery and recovery boundary

This change stops at a verified commit, push and one draft PR targeting main.
Yun requests Cursor review; any merge is a later head-pinned operation.
Production activation is NOT performed by creating that PR.

After the merge, follow `release.md`: retain the preceding release identity,
perform the required migration rehearsal and backup, verify the published
candidate, and keep publishing separate from pointer switching. The legacy
control-center publish script activates internally, so it is not itself the
approved split publish/switch procedure. Use the existing runtime verifier's
publish-artifact and activate-release stages separately under that release
procedure; do not invent a second publisher or weaken its gates.

Before switching, verify the approved `LoadCredential` unit configuration and
the operating service account's native reads. After switching, measure all
three GETs, raw response SHA, producer flags, RT state, and the real dashboard.
If activation or those checks fail, restore the recorded previous release
using the existing rollback procedure and compatible backup when needed.
Measure the restored service and its business reads; a moved pointer or a
running process alone is not rollback acceptance.
