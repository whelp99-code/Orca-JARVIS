# Revalidate roots created by a competing publisher

2026-09-09. `secureRoot` checked existence then called mkdir. A competing process
could create the intended root between those operations, causing EEXIST and
rejecting an otherwise valid first publication.

Handle only EEXIST from creation as a possible successful competing creation.
Re-read the path with lstat and apply the existing owned-directory/non-symlink
checks before chmod. Other mkdir failures still propagate. The final stat and
identity result remain unchanged. Do not introduce recursive creation or weaken
owner/type checks.

Tests interpose an actual directory, symlink, or regular file immediately before
the creation attempt. Before correction all three returned EEXIST; afterwards only
the owned directory is accepted and chmodded to 0700. Rejected paths must not
change the outside directory mode or sentinel contents.

This fixes competing creation, not every hostile same-user path-swap race between
filesystem operations. Broader descriptor-relative filesystem hardening and
post-publication deletion remain separate work. Production roots are not touched.

Validation: the first build exposed a test mock return-type mismatch, corrected
without changing runtime semantics. The next run passed 18 tests but failed one
reviewability test on an existing 162-character condition; that condition was
wrapped without a behavior change. Final race/reviewability checks passed 5 tests,
and backend build, lint and three TypeScript configurations exited 0. The approved
executor (11) and state publication (3) tests passed in the preceding run.

Eight real compiled Node children, released together against one missing temporary
root, all exited 0 and returned one device/inode identity. PIDs: 950414, 950418,
950419, 950425, 950430, 950433, 950444, 950456. This demonstrates concurrent startup;
the deterministic interposition tests force the specific EEXIST timing.
