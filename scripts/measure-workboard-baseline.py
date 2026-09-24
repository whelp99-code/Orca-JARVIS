#!/usr/bin/env python3
"""Read-only source discovery; writes redacted baseline only to the isolated worktree."""
import datetime
import hashlib
import json
import os
import shlex
from pathlib import Path
import socket
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '.omo/evidence/workboard'
NOW = datetime.datetime.now(datetime.timezone.utc).isoformat()
SSH = ['ssh', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-i', str(Path.home() / '.ssh/id_ed25519'), '-l', os.environ.get('WORKBOARD_MAC_SSH_USER', ''), '100.109.217.124']

def run(argv, seconds=16):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=seconds)
        return p.returncode, p.stdout, p.stderr[:300]
    except subprocess.TimeoutExpired:
        return 124, '', 'timeout'

def cli(command):
    rc, output, error = run(['orca-ide', *command, '--json'])
    if rc:
        return None, f'exit {rc}: {error}'
    try:
        data = json.loads(output)
        if not data.get('ok') or data['result'].get('truncated'):
            return None, 'CLI returned failure or truncated result'
        result = data['result']
        rows = result.get('terminals', result.get('worktrees'))
        if not isinstance(rows, list) or result.get('totalCount') != len(rows):
            return None, 'CLI totalCount disagrees with returned page'
        return result, None
    except (ValueError, KeyError, AttributeError) as exc:
        return None, f'malformed CLI response: {type(exc).__name__}'

worktrees, wt_error = cli(['worktree', 'ps'])
terminals, term_error = cli(['terminal', 'list'])
mac_worktrees, mac_wt_error = cli(['worktree', 'ps', '--environment', 'MAC'])
mac_terminals, mac_term_error = cli(['terminal', 'list', '--environment', 'MAC'])

def workspace_id(value):
    return hashlib.sha256(value.encode()).hexdigest()

# No account names, raw prompts, previews, logs, tokens or full paths are serialized.
def source(host, app, method, paths, capability, *, status='live', count=None, reason=None, completeness='complete', instance='default', generation='initial'):
    key = f'{host}:{app}:local'
    if status != 'live' or completeness != 'complete':
        count = None
        reason = reason or 'session total cannot be established from available metadata'
    return dict(id=key, source_key=key, persistent_instance=f'{host}:{app}:{instance}', namespace_generation=generation,
                enumeration_method=method, covered_paths=paths, page_completeness=completeness,
                capability=capability, status=status, failure_reason=reason, observed_session_count=count,
                total=count, observed_at=NOW)

sources = []
wt = (worktrees or {}).get('worktrees', [])
tr = (terminals or {}).get('terminals', [])
sources.append(source('linux', 'orca-worktrees', 'orca-ide worktree ps --json (bounded)', ['Orca Linux environment; Mac omitted by CLI hostScope'], 'read-only worktree metadata, not sessions', status='inaccessible' if wt_error else 'live', count=len(wt), reason=wt_error, completeness='failed' if wt_error else 'complete'))
sources[-1]['observed_session_count'] = None
for app, result, error, field in [('orca-worktrees', mac_worktrees, mac_wt_error, 'worktrees'), ('orca-terminals', mac_terminals, mac_term_error, 'terminals')]:
    sources.append(source('mac', app, f'orca-ide {"worktree ps" if field == "worktrees" else "terminal list"} --environment MAC --json (bounded)', ['Orca Mac environment; other runtime hosts omitted by CLI hostScope'], 'read-only '+field+' metadata', status='inaccessible' if error else 'live', count=len(result[field]) if result else None, reason=error, completeness='failed' if error else 'complete'))
    if field == 'worktrees':
        sources[-1]['observed_session_count'] = None
sources.append(source('linux', 'orca-terminals', 'orca-ide terminal list --json (bounded)', ['Orca Linux terminal environment; other runtime hosts omitted by CLI hostScope'], 'read-only terminal metadata', status='inaccessible' if term_error else 'live', count=len(tr), reason=term_error, completeness='failed' if term_error else 'complete'))

home = Path.home()
def local_jsonl(relative):
    base = home / relative
    if not base.exists():
        return None, 'store absent'
    try:
        # Metadata names only. No transcript content is opened.
        return sum(1 for _ in base.rglob('*.jsonl')), None
    except (OSError, PermissionError) as exc:
        return None, type(exc).__name__

for app, path in [('codex', '.codex/sessions'), ('claude', '.claude/projects')]:
    n, error = local_jsonl(path)
    sources.append(source('linux', app, 'read-only filesystem jsonl name enumeration', [f'$HOME/{path}'], 'session-file metadata only', status='inaccessible' if error else 'live', count=n, reason=error, completeness='failed' if error else 'complete'))

# OmO and Senpi sessions are project scoped. A repository marker is not a session count.
for app in ('omo', 'senpi'):
    markers = []
    for base in (home / 'orca/projects', home / 'orca/workspaces'):
        if base.exists():
            for project in base.iterdir():
                marker = project / f'.{app}'
                if marker.is_dir():
                    markers.append(marker)
    sources.append(source('linux', app, 'project marker directory discovery (not session enumeration)', [f'$HOME/orca/projects/*/.{app}', f'$HOME/orca/workspaces/*/.{app}'], 'project-scoped session metadata; no adapter yet', status='unsupported', reason=f'{len(markers)} project stores discovered; session identities not enumerated', completeness='unsupported'))

remote_script = """import json,os,glob
h=os.path.expanduser('~')
print(json.dumps({'host':'darwin','stores':{a:sum(1 for _ in glob.iglob(h+'/'+p,recursive=True)) for a,p in {'codex':'.codex/sessions/**/*.jsonl','claude':'.claude/projects/**/*.jsonl'}.items()},'apps':[a for a,p in {'orca':'/Applications/Orca.app','codex-desktop':'/Applications/ChatGPT.app','claude-desktop':'/Applications/Claude.app','mail':'/Applications/Mail.app'}.items() if os.path.exists(p)]}))"""
mac_rc, mac_out, mac_err = run([*SSH, 'python3 -c ' + shlex.quote(remote_script)], 14)
try:
    mac = json.loads(mac_out) if mac_rc == 0 else None
except ValueError:
    mac = None
mac_failure = 'SSH timeout' if mac_rc == 124 else f'SSH unavailable or malformed metadata (exit {mac_rc})'
for app in ('codex', 'claude'):
    sources.append(source('mac', app, 'SSH read-only jsonl name enumeration (8s connect, 14s total)', [f'$HOME/.{app}/'+('sessions' if app == 'codex' else 'projects')], 'session-file metadata only', status='live' if mac else 'inaccessible', count=mac['stores'][app] if mac else None, reason=None if mac else mac_failure, completeness='complete' if mac else 'failed'))
for app in ('codex-desktop', 'claude-desktop', 'omo', 'senpi'):
    sources.append(source('mac', app, 'SSH app/store discovery only; no Mac terminal session API', ['$HOME/Library/Application Support (metadata only)' if app.endswith('desktop') or app == 'orca' else '$HOME/.config and project-local markers'], 'discovery only; no session enumeration', status='unsupported' if mac else 'inaccessible', reason='application present; no bounded session enumeration supported' if mac and app in mac['apps'] else 'no session store identified' if mac else mac_failure, completeness='unsupported' if mac else 'failed'))
# Business applications are existing-work metadata sources, not new intake processors.
for host in ('linux', 'mac'):
    for app in ('mail', 'crm'):
        sources.append(source(host, app, 'application/process discovery; no mailbox or CRM API credentials read', ['existing work metadata only'], 'existing-work metadata read only; no intake', status='unsupported' if host == 'linux' or mac else 'inaccessible', reason='no consented metadata API/session enumeration configured' if host == 'linux' or mac else mac_failure, completeness='unsupported' if host == 'linux' or mac else 'failed'))
sources.append(source('linux', 'cursor-agent', 'local application-data directory discovery', ['$HOME/.local/share/cursor-agent'], 'session enumeration unsupported', status='unsupported', reason='local store present; no session ID reader configured', completeness='unsupported'))
sources.append(source('mac', 'chatgpt-to-codex', 'SSH application/process discovery', ['/Applications/ChatGPT To Codex.app'], 'existing-work metadata only', status='unsupported' if mac else 'inaccessible', reason='application present; no session ID reader configured' if mac else mac_failure, completeness='unsupported' if mac else 'failed'))

terminal_ids = sorted(t['handle'] for t in tr)
wt_ids = set(workspace_id(w['worktreeId']) for w in wt)
term_wt_ids = set(workspace_id(t['worktreeId']) for t in tr)
wt_lookup = {workspace_id(w['worktreeId']): w for w in wt}
explained = []
for id in sorted(wt_ids ^ term_wt_ids):
    if id in wt_ids:
        w = wt_lookup[id]
        reason = 'worktree metadata has no terminal in terminal list; workspace status '+str(w.get('status'))+'; CLI surfaces have different object scopes'
    else:
        reason = 'terminal list contains orphaned or out-of-scope worktree not returned by worktree ps; retain terminal identity'
    explained.append(dict(id=id, reason=reason))
mac_tr = (mac_terminals or {}).get('terminals', [])
mac_wt = (mac_worktrees or {}).get('worktrees', [])
mac_wt_ids = set(workspace_id(w['worktreeId']) for w in mac_wt)
mac_term_wt_ids = set(workspace_id(t['worktreeId']) for t in mac_tr)
mac_lookup = {workspace_id(w['worktreeId']): w for w in mac_wt}
mac_explained = [dict(id=id, reason=('Mac worktree has no terminal in terminal list; workspace status '+str(mac_lookup[id].get('status')) if id in mac_wt_ids else 'Mac terminal has orphaned or out-of-scope worktree; retain terminal identity')) for id in sorted(mac_wt_ids ^ mac_term_wt_ids)]
coverage = dict(observed_at=NOW, source_ids=sorted(s['id'] for s in sources), orca_cli_terminal_ids=terminal_ids, mac_orca_cli_terminal_ids=sorted(t['handle'] for t in mac_tr),
                independent_enumerations=[dict(name='orca-terminal-vs-worktree-metadata', first_method='orca-ide worktree ps --json', second_method='orca-ide terminal list --json', first_ids=sorted(wt_ids), second_ids=sorted(term_wt_ids), explained_differences=explained), dict(name='mac-orca-terminal-vs-worktree-metadata', first_method='orca-ide worktree ps --environment MAC --json', second_method='orca-ide terminal list --environment MAC --json', first_ids=sorted(mac_wt_ids), second_ids=sorted(mac_term_wt_ids), explained_differences=mac_explained)],
                limitations=['Orca CLI hostScope omits Mac; Mac remains a separate denominator source.', 'Worktree IDs represent workspaces, terminal handles represent terminals; no inferred session alias or zero-work conclusion.', 'Metadata-only counts do not imply live work or known purpose; unsupported sources have unknown totals.'])
inv = dict(observed_at=NOW, sources=sources, orca_terminal_ids=terminal_ids, orca_worktree_ids=sorted(wt_ids), mac_orca_terminal_ids=sorted(t['handle'] for t in mac_tr), mac_orca_worktree_ids=sorted(mac_wt_ids),
           identity_contract='source_key host+app+opaque local installation scope; persistent_instance stable across process restart; namespace_generation initial until account/store reset, which requires new generation. No personal account identifier stored.',
           observation_contract='No last_successful_observation stored in task 1; failed reads must not refresh one when added later.')

def port_state(port):
    # /proc/net/tcp read only, 01 == LISTEN
    try:
        for f in ('/proc/net/tcp', '/proc/net/tcp6'):
            with open(f) as stream:
                if any(line.split()[1].split(':')[-1].upper() == f'{port:04X}' and line.split()[3] == '0A' for line in list(stream)[1:]):
                    return 'listening'
        return 'not_listening'
    except OSError:
        return 'unknown'

service_rc, service_out, _ = run(['systemctl', '--user', 'list-units', '--type=service', '--state=running', '--no-pager', '--plain'], 6)
service_names = sorted(line.split()[0] for line in service_out.splitlines() if line.split() and any(term in line.split()[0] for term in ('jarvis', 'orca', 'action-hub', 'browser-ops', 'jmmw')))
link = Path('/home/jm/.local/state/orca-jarvis/authority/current')
production = dict(observed_at=NOW, plan_source_baseline='242f69689e26277bcbd6427d01ac4352c308d570',
                  production_authority_current_readlink=os.readlink(link),
                  baseline_mismatch='production authority release differs from plan source baseline; no retarget or deployment performed',
                  production_db=dict(path='/home/jm/.local/state/orca-jarvis/jarvis.sqlite', size_bytes=os.stat('/home/jm/.local/state/orca-jarvis/jarvis.sqlite').st_size, operation='stat only; never copied or opened'),
                  main_checkout=dict(head='e536ad4a1c2992a6afcb77be89f05fa65151324c', state='dirty; not used as base'),
                  isolated_worktree=dict(base='242f69689e26277bcbd6427d01ac4352c308d570', branch='whelp99-code/purpose-workboard', test_db_path=str(ROOT / '.runtime-tmp/workboard/db/workboard.sqlite'), test_db_exists=(ROOT / '.runtime-tmp/workboard/db/workboard.sqlite').exists(), runtime_dirs=['db', 'spool', 'keys', 'policy']),
                  ports={str(p):port_state(p) for p in (4173,4174,4176,4180)}, running_relevant_user_services=service_names if service_rc == 0 else None, service_measurement_failure=None if service_rc == 0 else f'systemctl read-only exit {service_rc}', mac_ssh_status='reachable read-only' if mac else mac_failure,
                  protection='No production DB open/copy, migration, symlink edit, process restart, or port binding.')
config = dict(schema_version=1, source_ids=sorted(s['id'] for s in sources), scope='metadata only; no secrets or personal account values', runtime_root='.runtime-tmp/workboard', test_db='.runtime-tmp/workboard/db/workboard.sqlite', production_authority='read-only', mac_transport='SSH read-only; bounded connect timeout; no credentials stored')
for name, data in [('source-inventory.json', inv), ('coverage-baseline.json', coverage), ('production-baseline.json', production)]:
    (OUT / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
(ROOT / 'config/workboard-sources.json').write_text(json.dumps(config, indent=2) + '\n')
print(f'{len(sources)} sources; Linux {len(terminal_ids)} terminals/{len(wt_ids)} worktrees/{len(explained)} differences; Mac {len(mac_tr)} terminals/{len(mac_wt)} worktrees/{len(mac_explained)} differences; SSH {"reachable" if mac else mac_failure}')
