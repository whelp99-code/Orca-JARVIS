# DevSpace Project Inventory
> Generated: 2026-07-31 (updated after full re-index verification) | Tool: codebase-memory MCP

## Summary

| Category | Count |
|----------|-------|
| Total indexed projects | 29 |
| With substantial code (>100 nodes) | 7 |
| Small content (27-96 nodes) | 3 |
| Empty repos (2 nodes, verified 0 source files) | 19 |
| Total graph nodes | ~113,100 |
| Total graph edges | ~580,100 |

## Substantial Projects (active code)

| Project | Path | Nodes | Edges | Branch | Notes |
|---------|------|-------|-------|--------|-------|
| dify | /Volumes/DevSpace/dify | 78,861 | 483,812 | main | LLM app platform (fork) |
| sangfor-os (main-fork) | ~/orca/workspaces/sangfor-os/main-fork | 23,782 | 60,805 | local-recovery/main-fork | Sangfor OS monorepo |
| wiki-spike (qwen-works) | ~/orca/workspaces/wiki-spike/qwen-works | 5,020 | 22,409 | whelp99-code/qwen-works | Wiki spike experiment |
| sangfor-engineer-mcp | /Volumes/DevSpace/Playground/whelp99-code-sangfor-engineer-mcp | 2,876 | 6,765 | main | Sangfor MCP engineer tools |
| Documents_Playground | /Volumes/DevSpace/Documents_Playground | 1,995 | 5,332 | codex/memory | Multi-project workspace |
| AI-Engine | /Volumes/DevSpace/Playground/AI-Engine | 220 | 220 | main | Turborepo monorepo |
| blro-homepage-sites-preview | /Volumes/DevSpace/blro-homepage-sites-preview | 144 | 179 | main | BLRO homepage preview |

## Small Projects (some content)

| Project | Path | Nodes | Edges | Notes |
|---------|------|-------|-------|-------|
| me-wiki | /Volumes/DevSpace/me-wiki | 96 | 95 | Personal wiki (markdown) |
| Orca-JARVIS | /Volumes/DevSpace/Orca-JARVIS | 46 | 45 | JARVIS automation hub |
| BLRO-Website | /Volumes/DevSpace/Playground/BLRO-Website | 27 | 26 | Config/workers only (full mode) |

## Empty Repos (verified: 0 source files on disk)

These 19 repos were re-indexed with `mode: "full"` and independently verified with
`find` — they contain **zero** parseable source files (.ts/.tsx/.py/.go/.rs/.java).
They are scaffolds, docs-only repos, binary distributions, or stripped worktrees.

| Project | Path | Verified Content |
|---------|------|------------------|
| sangfor-vibe-coding | Playground/sangfor-vibe-coding | Empty |
| oh-my-agent | Playground/oh-my-agent | Empty (benchmarks/assets only) |
| AIOSv2_integration | Playground/AIOSv2_integration | Empty (dist/node_modules only) |
| sangfor-mcp-workflow | Playground/sangfor-mcp-workflow | Empty (dist/node_modules only) |
| ragflow | Playground/ragflow | Empty (.git only) |
| angeles-dating-app | Playground/angeles-dating-app | Empty (docs only) |
| vibe-coding-os | Playground/vibe-coding-os | Empty (deploy config only) |
| mail-intelligence | Playground/mail-intelligence | Empty (scripts only) |
| sangfor-os-w0-w6 | Playground/sangfor-os-w0-w6 | Empty (archive snapshot) |
| AIOS v1 | Playground/AIOS v1 | Empty (legacy workspace) |
| aios-jarvis | Playground/aios-jarvis | Empty (vendor/tools only) |
| proofgraph_claude_mvp | Playground/proofgraph_claude_mvp_v0_2_0 | Empty (bin/docs only) |
| ai-automation-work-portal | Playground/ai-automation-work-portal | Empty (dist/node_modules only) |
| orca | Playground/orca | Binary distribution (no source) |
| cfo-dashboard | Playground/cfo-dashboard | Empty |
| Evo-Hervest | Playground/Evo-Hervest | Empty (__pycache__/.venv only) |
| CFO-AIOS | Playground/CFO-AIOS | Empty (dist/node_modules only) |
| Graph-R1 | Playground/Graph-R1 | Empty (verl fork, no source) |
| chatgpt2codex | Playground/chatgpt2codex | Empty (assets only) |

## Excluded (backups/archives — not indexed)

- `whelp99-code-sangfor-engineer-mcp.broken-pre-restore-20260731041743`
- `sangfor-os.git-hollow-backup-20260731041742`
- `blro-sites-build-20260728-2205`
- `blro-sites-rebuild-20260728-2218`
- `001. Fork Repo`
- `ProofGraph-release-workspace`
- `ProofGraph-v1.1.0`
- `BLRO-Website-worktrees`
- `Scripts_and_StrayCode`
- `notion-export`
- `docs`
- `scripts`

## Usage

Query any indexed project:
```
search_graph(query="...", project="Volumes-DevSpace-dify")
get_architecture(project="Volumes-DevSpace-Playground-whelp99-code-sangfor-engineer-mcp")
trace_path(project="...", mode="calls", symbol="...")
```

## Notes

- All 19 empty repos were verified on 2026-07-31: `find` confirmed 0 source files
  even with `mode: "full"` indexing. No indexer bug — repos genuinely lack source.
- BLRO-Website improved from 2→27 nodes after `mode: "full"` (config/workers files).
- sangfor-os canonical repo is at `/Volumes/DevSpace/Playground/sangfor-os` but
  indexed via worktree at `~/orca/workspaces/sangfor-os/main-fork`.
- dify is the largest project by far (78K nodes, 484K edges, 283MB graph).
- To re-index after adding source: `index_repository(repo_path="...", mode="full")`.
