# 후보 차단의 쓰기 경계 적용

2026-09-08. 구현·검증 진행. 기존 readCandidateReview는 projection ID가 차단/격리되면 숨기지만
classify 재생·owner 결정·outbox claim/dispatch·직접 provider adapter는 같은 차단을 검사하지 않는다.
허용된 dashboard_projection kind와 후보 ID를 사용한 회귀 4개로 누락을 재현했다.
첫 fixture의 잘못된 candidate projection kind 실패 4개는 결함 재현에 포함하지 않는다.

기존 MemoryProjectionAuthority.isProjectionIdSuppressed(candidate_id) 계약을 쓰기 경로에도 적용한다.
후보 ID는 memcand:pos:v1 namespace이며 종류와 무관한 동일 ID 차단은 기존 읽기와 동일하게 거부한다.
compaction inventory의 candidate/outbox는 MemoryProjectionKind와 별도 분류이므로 이번에는 새 enum이나
SQL migration을 추가하지 않는다. pending/failed projection authority도 기존 assertReady로 거부한다.

분류 writer transaction의 재생/중복/신규 후보, decision 준비와 owner confirm 적용, outbox enqueue/
claim/dispatch transaction, 최종 V1 write authority에 검사를 둔다. 이미 준비된 승인으로 차단을
우회하지 않는다. reject 결정은 새로운 기억 저장을 허용하지 않으므로 유지한다.

이는 candidate ID에 이미 연결된 차단의 집행이다. 원 task→후보→provider record의 영속 계보를
새로 만든 것이 아니며 task-memory-source-privacy-hold의 자동 collector 보류는 유지한다.
DB 검사 후 외부 I/O 사이 삭제 경합, 이미 전송된 결과의 관측/폐기/복구는 별도 수신 fence와
계보 계약이 필요하다. 기존 uncertain 상태를 미전송 또는 성공으로 임의 변경하지 않는다.

독립 검토 반영: legacy correction confirmation도 guard·승인·settlement를 immediate transaction으로
묶었다. 두 SQLite 연결로 검사 시 다른 writer는 SQLITE_BUSY, 완료 뒤 quarantine은 성공함을 검증했다.
이번 전송 수정은 V1 remember 경로이며 V2 correction의 별도 preparation/materialization/
beginDispatch/dedicatedAuthority까지 수정한 것은 아니다. 아래는 다음 필수 수정 범위다.

- MemoryCorrectionSaga.prepare의 spool 전 검사와 preparation INSERT transaction 안 재검사.
- MemoryDestructivePreparationStore의 materialization/tombstone transaction 안 candidate 검사.
- MemoryCorrectionStore.beginDispatch 및 adapter dedicatedAuthority(correct)의 마지막 검사.
- correction이 스스로 추가하는 이전 target tombstone과 후보 원본의 독립 차단을 구분하는 계보 검증.
- 이미 전송했거나 uncertain인 요청은 관측·삭제를 계속하며 원래 전송을 다시 하지 않는 인수.

실제 인수 중 기존 outbox fixture의 placeholder request digest가 parser에서 거부됨을 발견했다.
직접 adapter 회귀/인수는 digest를 재계산하고 정상 입력의 transport 진입을 먼저 확인한 후 같은
입력을 차단해 호출 증가 0을 확인하도록 보강했다. 최초 invalid 요청의 거부는 차단 근거로 세지 않는다.
