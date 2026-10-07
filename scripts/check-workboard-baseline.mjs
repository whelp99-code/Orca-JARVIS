import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Coverage is a contract over discovered sources, not a sum of successful scans.
export function check(inventory, coverage, config) {
  assert(Array.isArray(inventory.sources) && inventory.sources.length > 0, 'sources required');
  assert(Array.isArray(coverage.source_ids), 'denominator required');
  const ids = new Set();
  for (const source of inventory.sources) {
    assert(typeof source.id === 'string' && source.id.length > 0, 'source missing id');
    assert(!ids.has(source.id), `duplicate source ${source.id}`);
    ids.add(source.id);
    assert(source.source_key && source.persistent_instance && source.namespace_generation, `identity missing: ${source.id}`);
    assert(source.enumeration_method && Array.isArray(source.covered_paths) && source.observed_at && source.capability && source.page_completeness, `metadata missing: ${source.id}`);
    assert(['live', 'inaccessible', 'unsupported'].includes(source.status), `invalid status: ${source.id}`);
    if (source.status !== 'live' || source.page_completeness !== 'complete') {
      assert(source.failure_reason, `failure reason missing: ${source.id}`);
      assert(source.total === null, `incomplete scan counted as zero: ${source.id}`);
    } else {
      assert(source.failure_reason === null, `successful scan cannot contain a failure: ${source.id}`);
      assert(Number.isInteger(source.total) && source.total >= 0, `complete scan missing total: ${source.id}`);
    }
    assert(source.observed_session_count === null || Number.isInteger(source.observed_session_count) && source.observed_session_count >= 0, `invalid observed count: ${source.id}`);
    assert(source.total === null || ['file_roster', 'current_work'].includes(source.total_kind), `total kind missing: ${source.id}`);
    assert(source.current_work_total === null || source.total_kind === 'current_work' && Number.isInteger(source.current_work_total) && source.current_work_total >= 0, `unfiltered current work claimed: ${source.id}`);
    if (source.session_ids !== null) {
      assert(Array.isArray(source.session_ids) && source.session_ids.length === source.total && new Set(source.session_ids).size === source.total, `session roster disagrees with total: ${source.id}`);
    }
  }
  assert.deepEqual([...coverage.source_ids].sort(), [...ids].sort(), 'discovered sources and denominator disagree');
  assert.deepEqual([...config.source_ids].sort(), [...ids].sort(), 'configured sources and denominator disagree');
  assert(Array.isArray(coverage.independent_enumerations), 'independent enumerations required');
  for (const comparison of coverage.independent_enumerations) {
    assert(Array.isArray(comparison.first_ids) && Array.isArray(comparison.second_ids) && Array.isArray(comparison.explained_differences), 'enumeration inputs missing');
    const first = new Set(comparison.first_ids), second = new Set(comparison.second_ids);
    assert.equal(first.size, comparison.first_ids.length, 'duplicate first enumeration id');
    assert.equal(second.size, comparison.second_ids.length, 'duplicate second enumeration id');
    const delta = [...first].filter(id => !second.has(id)).concat([...second].filter(id => !first.has(id))).sort();
    const explained = comparison.explained_differences.map(d => { assert(d.reason, 'difference missing reason'); return d.id; }).sort();
    assert.deepEqual(delta, explained, `unexplained independent enumeration disagreement: ${comparison.name}`);
  }
  const terminals = inventory.orca_terminal_ids ?? [];
  const orcaComparison = coverage.independent_enumerations.find(c => c.name === 'orca-terminal-vs-worktree-metadata');
  assert(orcaComparison, 'Orca comparison required');
  const represented = new Set([...terminals, ...orcaComparison.explained_differences.map(d => d.id)]);
  for (const id of coverage.orca_cli_terminal_ids ?? []) assert(represented.has(id), `Orca terminal dropped: ${id}`);
  assert.deepEqual([...terminals].sort(), [...(coverage.orca_cli_terminal_ids ?? [])].sort(), 'Orca CLI IDs must match inventory');
  assert.deepEqual([...(inventory.mac_orca_terminal_ids ?? [])].sort(), [...(coverage.mac_orca_cli_terminal_ids ?? [])].sort(), 'Mac Orca CLI IDs must match inventory');
}

function expectRejected(label, mutate, inventory, coverage) {
  const i = structuredClone(inventory), c = structuredClone(coverage);
  mutate(i, c);
  assert.throws(() => check(i, c, config), undefined, `${label} must fail closed`);
  console.log(`PASS fixture: ${label} rejected`);
}

const inventory = JSON.parse(readFileSync(new URL('../.omo/evidence/workboard/source-inventory.json', import.meta.url)));
const coverage = JSON.parse(readFileSync(new URL('../.omo/evidence/workboard/coverage-baseline.json', import.meta.url)));
const config = JSON.parse(readFileSync(new URL('../config/workboard-sources.json', import.meta.url)));
check(inventory, coverage, config);
expectRejected('unreachable Mac removed', (i, c) => { c.source_ids = c.source_ids.filter(id => id !== 'mac:codex:local'); }, inventory, coverage);
expectRejected('source dropped from inventory and coverage', (i, c) => { const dropped = i.sources.pop().id; c.source_ids = c.source_ids.filter(id => id !== dropped); }, inventory, coverage);
expectRejected('permission denied counted as zero', i => { const s = i.sources[0]; s.status = 'inaccessible'; s.failure_reason = 'permission denied'; s.total = 0; }, inventory, coverage);
expectRejected('new source omitted', i => { i.sources.push({ ...i.sources[0], id: 'linux:new-app:local', source_key: 'linux:new-app:local' }); }, inventory, coverage);
expectRejected('missing source id', i => { delete i.sources[0].id; }, inventory, coverage);
expectRejected('failed scan disguised as empty live list', i => { const s = i.sources[0]; s.status = 'live'; s.total = 0; s.page_completeness = 'complete'; s.failure_reason = 'permission denied'; }, inventory, coverage);
expectRejected('unexplained independent difference', (i, c) => { c.independent_enumerations[0].explained_differences = []; }, inventory, coverage);
console.log('GREEN: baseline and seven fail-closed fixtures passed; stale observation N/A: task 1 does not store last_successful_observation; action/race/UI classes N/A: no ingest or dispatch exists.');
