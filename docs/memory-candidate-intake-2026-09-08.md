# 기억 후보 CLI 접수와 원문/원장 원자성

2026-09-08. 기존 `MemoryCandidateStore.classify`의 제품 호출자가 없어 추가한 입력 경로다. 기존 후보 분류/출처/정책 검사를 그대로 사용하며 저장 승인을 대신하지 않는다.

## 사용 계약

```bash
node dist/src/cli.js memory classify /absolute/input.json /absolute/policy.json --db /absolute/authority.sqlite
```

- 기존 schema 1 입력 전체와 배포에 사용할 명시적 Personal OS policy 파일을 받는다. authority DB는 기존 초기화/마이그레이션이 완료되어 있어야 한다.
- 각 JSON 파일은 32,768바이트 이하의 일반 파일이어야 한다. symlink/FIFO/디렉터리·중복 JSON 키·손상 UTF-8·읽는 중 변경·과대 입력을 거부한다. 검증한 fd를 읽고 파일을 이동·수정·삭제하지 않는다.
- 출력은 후보 ID/digest·분류·이유·만료·delivery와 `stored=false`다. 원문·주제·정책 본문·파일 경로를 출력하지 않는다. 거부 분류는 명령 실패와 구분한다. `ok=true`는 분류 실행 성공이며 기억 저장 성공이 아니다.
- `JARVIS_MEMORY_REVIEW_SPOOL_ROOT` / `JARVIS_MEMORY_DISPATCH_SPOOL_ROOT`를 기존 CLI/dashboard/outbox와 공유한다. 미설정이면 authority DB 옆 `memory-review-spool` / `memory-dispatch-spool`을 사용한다.
- `labeled_inference`는 출처 references를 갖춘 검토 후보일 뿐이며 owner 확인이 필요하다. 확인 뒤 앞서 구현한 `memory stage-dispatch`, 기존 승인, outbox 순환으로 이어진다. `explicit_user_instruction`, `approved_decision`, `verified_outcome`의 authority를 파일의 주장만으로 생성하지 않는다.

## 추가 결함과 수정

1. **시각 불일치:** 기존 Store가 원문 작성 전과 DB transaction 안에서 classification을 다시 계산했다. 실제 시각이 달라지면 digest가 달라져 접수 후 원문 검토가 막혔다. 읽기 전용 authority preflight를 유지하고 writer lock에서 하나의 computation으로 원문/DB를 만든다. 파일 fsync 뒤에는 실제 시각으로 authority·분류 상태·만료를 재검증한다. 시간 검사를 고정해 우회하지 않는다.
2. **DB commit 전 남은 원문:** 동일 후보 재시도 시 새 시각의 digest로 덮으려다 충돌했다. durable candidate가 없는 경우에만 현재 입력/정책/권한을 원래 created_at으로 재구성해 기존 envelope 전체 digest와 비교한다. 유효한 동일 원문을 그대로 채택하며 수정·덮어쓰기·기한 연장은 하지 않는다. 만료·손상·다른 요청의 orphan은 보존하고 거부한다. rollback 정리도 writer lock을 다시 잡고 다른 writer의 채택 여부를 확인한다.
3. **부적격 원문 발행:** `required_confirmation`만으로 원문을 발행해 rejected/expired/no_data 분류가 예외로 끝났다. `awaiting_confirmation`만 원문을 발행한다.
4. **만료 감사행:** 과거 source expiry와 기존 SQL의 confirmation timestamp > created 제약이 충돌했다. rejected/expired 감사행에만 now+1ms 최소값을 사용한다. 유효 후보 TTL은 그대로이고 terminal 후보는 기존 상태 전이 제약상 승인할 수 없다. shipped SQL bytes는 변경하지 않았다.

## 검증

격리 archive `c4c5c98` + 이 변경에서 backend build·변경 ESLint, CLI/후보 UI/승인 인계/authority 회귀 **37 passed / 5 files (30.11초)**. 로그 `/var/tmp/jarvis-memory-intake-tests.log`. 신규 7개에는 실제 CLI dispatcher→원문 검토→서명 fixture 결정→확인 명령 완료→저장 명령 준비, 재시도·원문 보존·변조·시각 이동·orphan·fsync 중 만료·거부 분류·파일 경계를 포함한다. 독립 검토의 시각/복구 두 지적 반영 후 추가 actionable 없음.

추가 정책·상태·개인정보·동시성 회귀 **123 passed / 13 files (88.51초)**, `/var/tmp/jarvis-memory-intake-regression.log`. 최종 task completion `7129b9d` 커밋을 격리 기준에 반영한 뒤 backend build 및 접수/권한/저장 **14 passed / 3 files (11.96초)**를 확인했다. `/var/tmp/jarvis-memory-intake-final-build.log`, `/var/tmp/jarvis-memory-intake-final-tests.log`. 14개는 앞 회귀와 중복이며 합산하지 않는다. 이 단위의 소스는 검증 복제본과 바이트 일치한다. 동시 작업이 남은 원래 checkout 전체 `npm run verify`의 성공으로 표현하지 않는다.

실제 프로세스 `node dist/src/cli.js memory classify`를 실제 wall clock에서 두 번 실행했다. 원문 검토 일치, 동일 출력 재시도, review 파일 1개, 입력 파일 보존을 확인했다. `/var/tmp/jarvis-memory-intake-live-clock.log`. 합성 한국어 입력과 격리 DB/정책을 사용했으며 운영 데이터를 수정하지 않았다.

Second Brain 하네스의 `--candidate-intake` 경로는 기존 Store 직접 호출 대신 CLI dispatcher의 파일 접수에서 시작한다. 민감 record 64개→실제 MCP→provider proved→outbox settled→control completed→dashboard stored=true, 두 독립 클라이언트 current, 재전송 추가 dispatch 0, 원문 정리 0개 잔존, 삭제 fence 및 rollback 복구 통과. `/var/tmp/sb-jarvis-memory-intake-acceptance.log`. 합성 승인·주입된 시계이며 실제 에이전트 앱 자동 수집 검증이 아니다.

## 남은 연결과 보류

- 유효 authority의 public/personal 후보는 기존 정책상 approved로 바로 분류될 수 있으나 해당 경로의 본문 dispatch publication은 아직 없다. `no_data` classified 역시 후속 재개가 없다. 입력 파일은 보존되며 분류 결과를 저장 완료로 표시하지 않는다. 일반 입력 전체를 자동 수집 완료로 처리하지 않는다.
- 자비스의 실제 task completion→기억용 verifier authority 결합은 별도 작업이다. 실행 완료 커밋 `7129b9d`가 이번 단위 중 확정됐다. 그 결과와 기억 content digest·독립 verifier의 관계를 검증해 연결해야 하며, 요약을 signed verification으로 바꾸지 않는다.
- 일반 LF/V2 정정, 실제 앱별 수집·공유·주입, project/user 범위, 문맥 전달/예산, 운영 릴리스·복구·검색 평가는 기존 계획에 남는다.
- 운영 배포·재시작·push 없음. 동시 작업의 AGENTS·인계 문서·task 소스는 보존한다.
