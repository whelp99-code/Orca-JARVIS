# Scoped worker lease·단일 시도·불확실 결과 복구

2026-09-09. 등록·현재 요청 복원 다음 단계다. 기존 `memory_outbox`, attempt, audit/event 원장과 상태 전이 제약을 재사용했다. 새 큐·migration·서명 엔진은 추가하지 않았다.

## 구현

- `claimMemoryScopedOutbox`: 특정 scoped 등록의 현재 정책·원본을 검증하고 queued 또는 만료된 claimed lease를 가져온다. 동시에 유효한 lease는 하나이며 회수 시 fence가 증가한다. 요청 만료보다 긴 lease는 제한한다. 잘못된 세션의 정책 실패는 요청을 terminal 실패로 만들지 않는다.
- `markMemoryScopedOutboxDispatch`: 동일 worker/fence/lease 만료를 검사하고 현재 요청을 다시 검증한다. dispatching 전환, 단일 attempt 삽입, 기존 후보 projection, event/audit를 한 IMMEDIATE 트랜잭션에 기록한다. 이전 worker, 만료 lease, 중복 호출은 거부한다.
- `recoverMemoryScopedOutboxDispatches`: 전송 중 lease가 만료되면 현재 쓰기 권한과 무관하게 불확실 결과를 reconciling으로 옮긴다. 이미 기록한 시도를 재전송할 권한으로 되돌리지 않는다. 이후 실제 provider 상태·영수증 조회 연결이 필요하다.
- 정책 유효시간이 최종 읽기 뒤 만료되는 회귀를 추가로 재현했다. 요청/lease만 검사하면 mark가 성공했다(1 failed / 3 passed). worker가 관측한 정책 만료 시각을 후속 clock 검사에도 적용해 commit 직전 만료를 거부하도록 수정했다.

## 검증 결과

- 등록 요청 reader·worker·기존 saga/control 확대 검사: **50 passed / 37.49초**.
- 불확실 결과 복구 추가 후 worker·기존 saga: **13 passed / 11.40초**. 위 검사와 중복이므로 합산하지 않는다.
- 최종 TypeScript noEmit, 변경 파일 ESLint(max-warnings=0), 격리 emit 통과.
- 최종 컴파일 제품 API로 독립 자식 프로세스 **13개**, fixture 서명·임시 DB를 이용한 종료/재시작 검증. provider 호출 **0**.

### 실제 프로세스 시나리오

1. worker A가 fence1 획득 → B는 유효 lease 동안 가져가지 못함 → 만료 후 B가 fence2 획득 → A의 mark 거부 → B의 mark commit 직후 응답 전 exit73 → 새 프로세스의 같은 mark 거부. attempt1 보존.
2. 다른 임시 DB에서 mark의 후보 projection 이후 attempt INSERT 직전 exit74 → outbox claimed/candidate queued/attempt0으로 rollback → 새 프로세스의 mark 성공으로 attempt1.
3. 두 시나리오 모두 요청·정책 만료 이후 새 프로세스로 복구 → reconciling, 새 claim 불가, attempt1 보존. foreign_key_check 오류0.

[기계 판독 결과](../../second-brain-app/SCOPED-OUTBOX-WORKER-2026-09-09.json). 재현: JARVIS 작업공간에서 `TMPDIR=/var/tmp node /home/jm/orca/projects/second-brain-app/scripts/scoped-outbox-worker-acceptance.mjs <격리 TypeScript 빌드 경로>`.

## 보류와 다음 연결

- 이번 완료 범위는 worker의 lease·전송 시도 기록·불확실 상태 복구다. provider로 보내는 호출, v4 공개 MCP/상태/영수증 계약, provider의 운영 권한 검증기와 자비스 완료 소비는 아직 연결하지 않았다.
- 기존 후보 상태 이름 `accepted_unsettled`는 dispatch marker와 함께 변경되는 내부 projection이다. 이번에는 provider 호출 자체가 0회다. 이 상태를 provider 수락이나 저장 완료로 해석하거나 화면에 성공으로 표시하는 경로는 개방하지 않는다.
- commit 후 응답을 잃으면 전송되지 않았더라도 무조건 재실행하지 않는다. provider의 동일 request 조회로 결과를 확인하는 후속 경로가 필요하다. reconciling 상태를 임의로 settled로 올리지 않는다.
- fixture의 실제 API/서명/DB 프로세스 검증이며 운영자·native 모델 세션의 실제 사용 인수가 아니다. 실제 여러 에이전트 저장/회수, 삭제 수명, 검색 품질·GUI·운영/복구를 포함한 M1~M14를 유지한다.
- 운영 배포·서비스 재시작·운영 DB 변경·push는 수행하지 않았다.
