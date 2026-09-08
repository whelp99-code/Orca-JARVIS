# Scoped provider 수락 응답 검증·원장 기록

2026-09-09. 기존 scoped worker가 기록한 단일 전송 시도에 provider의 수락 응답을 연결하는 내부 구현이다. 공개 전송 활성화 또는 저장 완료 판정은 아니다.

## 변경

- `parseSecondBrainScopedWriteAccepted`: 세컨드브레인 내부 v4 수락 형식의 정확한 필드·버전·시간을 검사한다. 기대 요청을 실제 수락 시각에 다시 decode하고 provider/request/key/scope/path 및 canonical pending envelope 파일 해시를 대조한다. 응답 관측이 늦어도 원래 수락 시각이 유효하면 처리할 수 있다.
- `recordMemoryScopedOutboxAcceptance`: 소비한 dispatch fence·attempt·invocation·불변 scoped binding에 일치하는 결과만 기록한다. attempt accepted, 수락 event, outbox reconciling 전환을 한 트랜잭션으로 묶었다. 복구가 먼저 reconciling으로 옮긴 뒤 늦은 응답이 도착해도 원래 시도에 연결한다.
- 재전송 응답의 `replayed` 차이는 같은 수락 사건으로 정규화한다. 수락 시각이나 파일 해시가 다른 별도 수락은 거부한다. 같은 응답 재소비는 수락 event를 중복 생성하지 않는다.
- 기존 v1/v3 parser와 일반 writer는 변경하지 않았다. v4를 지원한다고 선언만 바꾸거나 기존 계약 검사를 완화하지 않았다.

## 검사

- 신규 수락·worker·기존 saga: **16 passed / 14.89초**.
- 유효한 형식이지만 기존 수락과 다른 응답의 충돌 사례 추가 후 집중 **3 passed / 4.19초**. 앞 검사와 중복이다.
- 다른 provider/scope/request/key/path/file digest, proved로 위장한 수락, 구형 버전, 미래 시간, 추가 필드, 잘못된 replay 타입, 다른 fence 거부.
- outbox 전환 실패 시 attempt accepted와 수락 event도 rollback됨을 확인.
- 최종 TypeScript noEmit·변경 파일 ESLint(max-warnings=0) 통과. 제품 코드 격리 emit 후 실제 프로세스 검증. 이후 소스 변경은 없고 충돌 테스트만 추가했다.

## 실제 양쪽 코드·별도 프로세스 인수

JARVIS 실제 CLI/서명 fixture → v4 등록·lease·dispatch marker → 별도 Python의 `accept_scoped_request` → 별도 Node 소비 프로세스로 전달했다. 네트워크/MCP를 거치지 않는 내부 API 인수다.

1. 세컨드브레인이 생성한 수락 응답과 파일 해시를 자비스가 검증했다.
2. 원래 worker lease와 요청 만료 후의 늦은 응답을 기록했다. 소비 commit 직후 응답 전에 exit73으로 종료했다.
3. 새 자비스 프로세스가 같은 acceptance receipt를 재조회했다.
4. 별도 세컨드브레인 실행기가 같은 요청을 실제 내부 `proved`까지 처리했다. request digest가 일치했다.
5. provider의 replay 수락을 다시 가져와 새 자비스 프로세스가 중복 없이 소비했다.

Python **3개**, 소비 Node **3개**, 수락 event **1개**, FK 오류 **0**. provider 내부 상태 proved, 자비스 상태 reconciling. 이는 아직 처리 proof를 자비스가 완료 증거로 소비하지 않았기 때문이다. [기계 판독 결과](../../second-brain-app/SCOPED-OUTBOX-RESULT-2026-09-09.json).

첫 실행은 위 기능 검증 후 봉인된 임시 디렉터리 정리에서 EACCES로 종료했다. 시험 도구가 자신의 임시 트리만 symlink를 따라가지 않고 권한을 복구해 정리하도록 수정했고, 최종 재실행은 exit0으로 완료했다. 운영 vault 권한은 변경하지 않았다.

재현: JARVIS 작업공간에서 `TMPDIR=/var/tmp node /home/jm/orca/projects/second-brain-app/scripts/scoped-outbox-result-acceptance.mjs <격리 TypeScript 빌드 경로>`.

## 보류·잔여

- 해시 일치는 발신자 인증을 대신하지 않는다. 이 API는 신뢰된 내부 소비 포트다. 공개 v4 전송에는 인증된 provider와 현재 정책/등록 증거를 검증하는 실제 연결이 필요하다.
- Python 인수는 명시적인 fixture authority callback을 사용한다. 실제 운영 권한 검증기나 native 모델 세션 인수로 확대 해석하지 않는다.
- accepted/pending만으로 settled나 control completed를 기록하지 않는다. 처리 상태·proof·독립 artifact/범위 증거의 소비를 연결해야 한다.
- 공개 MCP 계약·패키징/버전 호환·실제 worker 전송·완료 소비 및 M1~M14의 운영/클라이언트/삭제 수명/검색 품질 목표는 남는다.
- 운영 배포·서비스 재시작·운영 DB 변경·push는 수행하지 않았다.
