# 등록된 scoped 요청 복원과 현재 권한 재검사

2026-09-09. 이전 단위는 범위 검토 사용 기록과 outbox 등록을 원자적으로 결합했다. 이번에는 등록 후 queued 상태의 요청을 원본 자료·현재 권한과 함께 다시 읽는 내부 경로를 구현했다.

## 실제 발견·수정

등록 전 준비 경로는 미사용 검토와 approved 후보를 요구한다. 등록 후에는 검토가 소비되고 후보가 queued이므로 그 경로를 재사용하면 실패한다. 이를 해결하려고 일반 준비/쓰기 검사의 상태 조건을 풀지 않았다.

추가로 기존 `readMemoryCandidate`에서 두 결함을 재현했다. 첫 검사에서는 queued가 상태 목록에 없어 `MEMORY_CANDIDATE_INPUT_INVALID`, 목록 보완 후에는 분류 해시에 현재 queued 상태를 넣어 `MEMORY_CANDIDATE_INTEGRITY_FAILURE`가 발생했다. 최초 분류 해시는 당시 상태를 포함한다. DB의 전달 상태들과 최초 분류를 구분해야 한다.

- 후보 조회 타입에 기존 DB의 queued/delivering/accepted_unsettled/settled/uncertain을 반영했다.
- 현재 상태로 분류 해시가 일치하지 않으면 불변 생성 감사 기록에서 최초 분류 상태를 복원한다. 감사 event ID/digest와 전체 분류 digest를 모두 확인한다. 무결성 검사를 생략하지 않는다.
- `readRegisteredMemoryScopeReview`는 해당 outbox에 결합된 검토만 현재 서명·만료·철회와 함께 검사한다. 일반 `readApprovedMemoryScopeReview`는 사용된 검토를 계속 거부한다.
- `hasRegisteredScopedSourceAuthority`는 정확한 scoped outbox/source ID/digest 및 queued 후보에 한정해 기존 원본 권한 검사를 재사용한다. 일반 `hasSecondBrainWriteAuthority`가 queued를 허용하도록 바꾸지 않았다.
- `readCurrentMemoryScopedOutbox`는 불변 binding/outbox, v4 파일의 전체 digest, 원본 v3 spool, 기대 artifact, 범위 서명, 현재 원본 검증과 dispatch 권한을 대조한다. 현재 provider/owner/agent/session/project/revision도 검사한다.
- 마지막 파일 읽기 후 정책 resolver를 호출하고 DB의 검토·원본 권한을 다시 확인한다. 만료·시각 역행도 거부한다. 결과는 codec이 동결한 요청 자료다.

## 검사

- 초기 28개 검사에서 정상 복원 1개 실패: 후보 상태 누락 재현.
- 상태 목록 보완 후 47개 검사에서 정상 복원 1개 실패: 최초 분류와 현재 상태의 해시 불일치 재현.
- 두 문제 수정 후 등록/범위/원본 권한/control/후보 저장·중복/경계 **64 passed / 41.46초**.
- 감사 기록 누락·손상, 형식과 해시가 유효하지만 등록 원장과 다른 요청 파일 교체 사례를 추가한 최종 집중 검사 **18 passed / 14.74초**. 앞 검사와 중복이 있어 합산하지 않는다.
- 최종 TypeScript noEmit, 변경 파일 ESLint(max-warnings=0), 제품 코드 격리 emit 통과. 이후 변경은 추가 테스트뿐이다.

## 별도 프로세스 인수

컴파일한 제품 API와 fixture의 실제 CLI/서명/DB/spool을 이용했다. 정책은 private 파일에서 읽으며 자식 프로세스는 DB를 새로 연다.

1. 독립 reader가 등록된 outer v4와 원본 v3 ID/digest 및 한국어 본문 **51바이트**를 정확히 복원했다.
2. 두 번째 v4 파일 읽기 직후 정책 파일을 철회하면 reader가 반환을 거부했다.
3. 새 프로세스에서도 그 정책 철회가 유지되어 거부했다.
4. 정책을 복구하고 원본 verification을 실제 DB에서 철회하면 또 다른 프로세스가 거부했다.

총 자식 프로세스 **4개**, provider 호출 **0**, outbox는 queued 유지, foreign_key_check 오류 **0**. [기계 판독 결과](../../second-brain-app/SCOPED-OUTBOX-READER-2026-09-09.json).

재현: JARVIS 작업공간에서 `TMPDIR=/var/tmp node /home/jm/orca/projects/second-brain-app/scripts/scoped-outbox-reader-acceptance.mjs <격리 TypeScript 빌드 경로>`.

## 보류 및 잔여 조건

- 이 API는 등록 자료의 현재 검증·복원이며 outbox claim이나 전송 권한 토큰을 발급하지 않는다. 미래 worker는 실제 lease/fence와 전송 직전 재검사를 수행해야 한다. 읽은 자료를 나중에 무조건 보내는 경로는 개방하지 않았다.
- 아직 provider 전송, 공개 v4 MCP/status/receipt 계약, 자비스 완료 소비와 운영 권한 검증기를 연결하지 않았다. legacy worker 분리를 유지한다.
- fixture 서명과 파일 정책의 검증이며 실제 운영자·native 에이전트 세션 인수가 아니다. 테스트 callback 안에서 DB 철회를 주입한 실패 트랜잭션은 rollback된다. 별도 프로세스 인수의 원본 철회는 호출 전에 실제 commit한 별도 증거다.
- 전체 M1~M14, 세션/compaction/삭제 수명, 실제 클라이언트 지원표, 검색 품질, GUI·운영·복구 목표를 유지한다. 운영 배포·서비스 재시작·push는 수행하지 않았다.
