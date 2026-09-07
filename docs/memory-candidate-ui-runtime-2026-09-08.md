# 기억 후보 검토와 저장 진행 화면 — 2026-09-08

## 결과와 경계

기존 기억 목록에서 원문 검토·확인/거절·저장 명령 준비로 이어지는 연결을 구현했다. 기존 owner 승인과 outbox를 재사용한다. 후보 확인 명령의 완료와 실제 기억 저장 완료는 서로 다른 상태다. `control=completed`와 `outbox=settled`가 함께 성립할 때만 새 진행 API가 `stored=true`를 반환한다.

Second Brain을 기억 정본으로 유지하며 별도 OSS 서버·Proxy·기억 DB를 추가하지 않았다. SB frozen MCP V1/schema4, V2 effect 계약과 shipped migration SQL은 변경하지 않았다. UI의 reviewed-decision schema 2는 자비스 화면용 입력 버전이다.

## 변경

- `src/dashboard/memory-candidate-review.ts`: 후보 원문을 목록과 분리한 상세 조회. 영속 publication의 digest, 후보·분류·본문·주제·출처·정책·만료를 기존 spool과 대조한다. sensitive/restricted 원문은 기존 정책에 따라 노출하지 않는다. 조회는 spool 생성·권한 복구·삭제를 하지 않는다.
- `src/memory-private-spool-files.ts`: 검증한 파일 descriptor에서 읽어 경로 재개방 사이 교체 가능성을 줄인다.
- 후보 결정 API는 사용자가 열어 본 review digest를 재검증한다. storage 준비 API는 기존 `stageMemoryRememberDispatch`를 호출하여 동일 입력 재시도에 같은 명령을 돌려준다. 화면은 기존 Approvals로 이어진다.
- `src/memory-remember-confirmation.ts`: owner 결정이 이미 적용된 remember 명령을 기존 승인 실행기가 correct 전용 경로로 보내 실패시키던 문제를 수정한다. 영속 결정·receipt·command digest·적용 시도와 현재 후보 상태를 대조한 뒤 해당 명령만 완료한다.
- `src/dashboard/memory-remember-progress.ts`: bounded metadata 조회로 request ID, control/outbox 상태, 실패 코드를 표시한다. 원문이나 서명 원재료를 반환하지 않는다.
- 후보 목록은 만료·이미 저장 명령을 만든 항목을 LIMIT 전에 제외한다. 20개 과거 항목 뒤의 새 후보도 보인다. 추론 출처를 검증된 성공 결과로 표시하지 않는다.
- 화면은 상세 원문 만료, privacy 초기화, 늦게 도착한 응답, 화면 이탈, 중복 클릭을 처리한다. 저장 명령 상태는 새로고침 후에도 DB에서 회수한다. 375px 화면에서 긴 식별자가 가로 폭을 넘지 않도록 조정했다.
- `src/dashboard/read-model.ts`, `src/state-projection.ts`: health probe 대기 중 다른 HTTP 요청의 정상 DB 변경을 Overview 자체 쓰기로 오판하던 `DASHBOARD_READ_MUTATED`를 재현·수정했다. 비동기 진단 후 동기 투영 구간만 변경 여부를 검사하며, 투영 자체의 실제 쓰기는 여전히 거부한다. probe 결과는 한 번만 관측한다.

## 검증 증거

동시 작업의 task 소스를 섞지 않기 위해 임시 Git archive에 이 변경 파일만 복사하여 검사했다. 최초 기준은 `e61893e`, 최종 기준은 커밋된 Git publication 변경을 포함한 `49446db`다. 운영 checkout 전체의 canonical `npm run verify` 통과로 표현하지 않는다. 최종 검증 디렉터리는 `/var/tmp/jarvis-candidate-ui-final.8_drqe6d`이며 `node_modules`만 원래 저장소를 참조한다.

| 검사 | 관측 | 로그 |
|---|---|---|
| 기억·HTTP·대시보드 회귀 | 72 passed / 11 files | `/var/tmp/jarvis-candidate-ui-final-regression.log` |
| 공통 상태 투영 호출자 회귀 | 26 passed / 5 files | `/var/tmp/jarvis-candidate-ui-projection-regression.log` |
| 최종 probe 재사용 수정 후 Overview | 13 passed / 3 files, 앞 검사와 일부 중복 | `/var/tmp/jarvis-candidate-ui-final-overview.log` |
| frontend 전체 | 143 passed / 26 files | `/var/tmp/jarvis-candidate-ui-final-frontend.log` |
| 최종 49446db 기준 후보·HTTP·동시성 | 15 passed / 3 files | `/var/tmp/jarvis-candidate-ui-rebased-tests.log` |
| 최종 backend + dashboard build | 통과 | `/var/tmp/jarvis-candidate-ui-rebased-build.log` |
| 변경 TS/TSX ESLint, dashboard typecheck | 통과 | `/var/tmp/jarvis-candidate-ui-lint.log`, `/var/tmp/jarvis-candidate-ui-final-types.log` |

브라우저 검증은 Browser 플러그인이 없어 로컬 Playwright Chromium으로 수행했다. 합성 후보·로컬 authority DB·실제 HTTP 서버를 사용한다. 1440×1000 / 375×812에서 후보 검토 → 실제 Approvals 화면에 테스트 서명 receipt 입력 → 승인 실행 HTTP 200/completed → 저장 명령 pending → 새로고침 후 유지까지 통과했다. 콘솔 오류 0, serious/critical axe 위반 0, framework overlay 0, 모바일 가로 넘침 0이다. 브라우저의 provider read adapter는 fixture이므로 실제 저장 완료의 근거는 별도 MCP 인수 검사다. 최종 브라우저 로그: `/var/tmp/jarvis-candidate-ui-rebased-browser.log`.

독립 검토 지적을 반영했으며 최종 재검토의 추가 actionable 지적은 없었다. 실제 provider 완료 검사는 Second Brain의 [화면 연결 인수 보고서](../../second-brain-app/JARVIS-MEMORY-CANDIDATE-UI-2026-09-08.md)를 따른다.

## 남은 작업

실제 업무 입력/검증 결과의 후보 자동 수집, private 후보 UI 정책, 일반 LF·V2 정정, 실제 Codex/Claude 앱별 공유·수집·주입, project/user 접근 범위, 운영 설정·릴리스 전환과 복구 인수는 남아 있다. 이 화면 연결을 B4 전체 완료로 처리하지 않는다. 기존 서명 receipt 입력 UX도 그대로이므로 비전문 사용자용 승인 UX 개선은 별도 평가가 필요하다.

서비스 재시작·운영 마이그레이션·release/active generation 변경·push는 수행하지 않았다. 다른 작업의 AGENTS, 인계 문서, task completion 소스 및 미추적 자료는 이 커밋에서 제외한다.

## 화면 증거

- `/var/tmp/jarvis-candidate-review-desktop.png`
- `/var/tmp/jarvis-candidate-review-mobile.png`
- `/var/tmp/jarvis-candidate-storage-pending.png`

스크린샷과 임시 로그는 이 호스트의 QA 산출물이며 영구 보존 또는 운영 상태를 보장하지 않는다.
