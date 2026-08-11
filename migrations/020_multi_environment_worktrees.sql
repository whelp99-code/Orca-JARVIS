-- Dual-host live supervision (local Mac + remote Orca environments such as jm-server).
-- Raise the worktree cap so local and remote paths can be registered together.
DROP TRIGGER IF EXISTS live_supervisor_worktrees_limit;
CREATE TRIGGER live_supervisor_worktrees_limit BEFORE INSERT ON live_supervisor_worktrees
WHEN (SELECT COUNT(*) FROM live_supervisor_worktrees) >= 10
BEGIN SELECT RAISE(ABORT,'live supervisor supports at most ten worktrees'); END;
