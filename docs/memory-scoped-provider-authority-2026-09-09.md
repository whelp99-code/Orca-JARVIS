# Scoped provider current authority

SB 인계 방향을 유지하면서 기존 전송 시도의 현재 권한을 검사하는 경로를 추가했다. `verifyMemoryScopedProviderWrite`는 private spool, 기존 outbox/attempt, 원본 검증, 소비된 범위 검토, 현재 resolver 정책을 대조한다. 기존 등록 reader의 queued/claimed 제한은 유지한다. 새 claim/재전송/승인 소비/최종 완료를 만들지 않는다.

호출자는 서버 소유 인증 세션으로 `resolveWriteScope`를 구성해야 한다. 입력 요청의 agent/session 문자열은 인증이 아니다. 반환값은 재사용 가능한 자격 증명이 아니며 request/provider/scope/fence와 결합하고 `valid_until`을 사용 시점에 검사해야 한다. 별도 프로세스 사이의 철회를 원자적으로 보장하지 않는다.

검증: 권한/reader/worker 32 passed(25.79초), 기존 authority/saga/등록/수락 소비 20 passed(16.89초), 격리 TypeScript emit·변경 ESLint exit 0. SB 관련 수락/실행/walking skeleton 21 passed(9.38초), 전체 Ruff 통과. SB 제품 코드 변경은 없다.

실제 Python 내부 API와 별도 Node 권한 검사 프로세스에서 정상 요청은 proved, 수락 도중 정책 철회는 accepted 행 없음, 수락 후 실행 전 철회는 failed/활성 세대·proof 없음. 각 시나리오 attempt 1개, FK 오류 0. 세션·시계는 fixture이고 운영용 공개 전송은 미연결이다. 정상 경로도 JARVIS는 reconciling이며 settled/control completed가 아니다.

[통합 보고서·남은 P0/P1/P2](../../second-brain-app/SCOPED-PROVIDER-AUTHORITY-2026-09-09.md), [실제 결과](../../second-brain-app/SCOPED-PROVIDER-AUTHORITY-2026-09-09.json). 재현 도구는 SB `scripts/scoped-provider-authority-acceptance.mjs/.py`; JARVIS cwd에서 격리 build 경로를 인자로 실행한다. 운영 dist/DB/서비스는 변경하지 않았다.
