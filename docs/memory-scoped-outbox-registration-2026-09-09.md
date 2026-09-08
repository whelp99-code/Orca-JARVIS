# 범위 검토 단일 사용과 outbox 원자적 등록

2026-09-09. 세컨드브레인 중심·네 OSS 선별 흡수 인계에 따른 A3/M2 구현이다. JARVIS 기존 dispatch 권한·범위 검토·private spool·outbox를 재사용했다. 공개 전송이나 운영 서비스 활성화는 포함하지 않는다.

## 변경과 이유

이전에는 범위 검토와 v4 요청 자료 준비·발행이 있어도 검토 사용 기록과 실행 대기 등록을 함께 확정하는 경로가 없었다. `registerMemoryScopedOutbox`는 기존에 claim된 원본 `memory.outbox.dispatch`와 승인된 범위 검토를 검증하고, migration078의 본문 없는 binding과 기존 `memory_outbox`의 scoped-v4 행을 하나의 IMMEDIATE 트랜잭션에서 삽입한다.

- 검토/후보/요청/key의 유일성으로 한 검토의 재사용을 차단한다. 이미 사용한 검토는 기존 검토 조회에서도 거부한다.
- 지연 외래키는 outbox 없이 사용 기록만 commit하는 것을 막는다. 삽입 중 실패·프로세스 종료 시 두 행이 함께 rollback된다.
- 원본 v3 요청과 outer v4 요청을 분리해 보존한다. 원본 요청을 단순히 v4로 이름만 바꾸지 않는다.
- 현재 정책·범위 검토·원본 권한을 재검사하고 실제 claim의 내용/fence/만료를 대조한다. 바뀐 dispatch 인수는 거부한다.
- commit 후 응답 유실은 동일 등록 응답으로 복구한다. lease 복구로 만료 필드가 바뀌어도 원래 등록 사실을 조회할 수 있다.
- 기존 승인·후보 중복 제약·legacy worker 분리를 유지한다. migration077 이후의 worker는 scoped 행을 처리하지 않는다.

## 검증

- 등록/프로필/범위 검토/자료 발행/원본 권한/control/saga/migrations 확대 검사: **59 passed / 41.02초**.
- lease 복구 후 재조회 수정의 관련 3개 파일: **25 passed / 20.18초**. 앞의 59개와 중복이 있으므로 합산하지 않는다.
- 이후 미사용 변수 lint 수정 뒤 TypeScript noEmit, 변경 파일 ESLint(max-warnings=0), 격리 디렉터리 emit 통과. 운영 dist를 빌드 대상으로 사용하지 않았다.
- 최종 컴파일 코드로 독립 자식 프로세스 **6개** 실행. 실제 SQLite 트랜잭션 중 종료와 commit 직후 응답 전 종료를 주입했다. 최종 재조회는 lease 복구·범위 만료 시각 이후 새 프로세스에서 수행했다.

| 종료 지점 | 종료 직후 outbox / binding | 새 프로세스 복구 후 | 재시도 |
|---|---|---|---|
| binding 삽입 후 outbox 삽입 직전, exit74 | 0 / 0 | 1 / 1 | 최초 등록 후 동일 응답 |
| commit 후 응답 전, exit73 | 1 / 1 | 1 / 1 | 기존 등록 응답 |

두 경우 모두 foreign_key_check 오류 0, legacy claim 0, provider 호출 0. [기계 판독 증거](../../second-brain-app/SCOPED-OUTBOX-REGISTRATION-2026-09-09.json).

재현: JARVIS 작업공간에서 `TMPDIR=/var/tmp node /home/jm/orca/projects/second-brain-app/scripts/scoped-outbox-registration-acceptance.mjs <격리 TypeScript 빌드 경로>`.

## 제한과 다음 구현

1. fixture의 실제 서명·DB·CLI 자료를 사용한 내부 API 검사다. 실제 운영자/모델 세션 인수가 아니다.
2. 원본 dispatch claim은 호출 전에 기존 경로에서 수행한다. 이번 원자성 범위는 **범위 검토 사용 기록 + outbox 삽입**이다. 원본 claim까지 함께 rollback한다는 의미가 아니다.
3. `registered/queued`는 등록 당시의 확인 응답이다. 현재 처리 상태나 provider 수락·저장 완료·영수증 검증이 아니다. 재조회는 권한 갱신이나 재실행을 하지 않는다.
4. 검토 command의 기존 상태는 approved로 남고 사용 여부는 immutable binding으로 판정한다. UI에 이 사용 상태를 연결하는 작업이 남는다. 새 서명 엔진·일반 approval redemption 종류를 추가하지 않았다.
5. 실패 시 DB는 rollback해도 먼저 발행된 private 파일은 남을 수 있다. 같은 자료 재시도는 재사용하지만 orphan/삭제 수명 전체는 후속 과제다.
6. scoped worker의 요청 복원·전송, provider의 운영 권한 검증기, 공개 v4 계약과 영수증 소비가 남는다. 모든 실행 binary의 버전을 확인하기 전 활성화하지 않는다. 구형 worker는 새 profile을 모를 수 있다.
7. M1~M14 전체 목표, 실제 다중 에이전트 수집/주입·정정/삭제·검색 품질·운영/복구 인수는 유지한다. 이번에는 배포·서비스 재시작·운영 DB 변경·push를 수행하지 않았다.
