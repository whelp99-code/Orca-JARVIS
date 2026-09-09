# 실제 로그인 세션 기반 HTTP 기억 복구

`POST /api/v1/memory/reconcile`를 명시적인 서버 `memoryReconcile` 설정에서 제공한다. 본문은 schema_version=1과 `memout:scoped:v4:<64hex>` outbox_id 두 필드, 최대512바이트다. duplicate key·추가 session/authority 필드·잘못된 ID를 거절한다. 전역 기본 활성화나 upstream proxy는 없다.

기존 게이트웨이 쿠키·Tailnet owner·Origin·CSRF·요청 제한 검사를 재사용한다. `createPhoneMemorySessionSource`가 실제 서버 session store의 현재 인증을 매 검사에 제공하고, 기존 CLI execute→production scoped reconciler로 전달한다. 요청 본문의 신원을 인증 세션으로 사용하지 않는다. 동시 실행은 서비스당8개로 제한한다. 완료 응답 직전에도 현재 로그인을 확인하고 이 경로는 로그인 쿠키를 갱신하지 않는다.

수락/완료가 이미 commit된 후 연결 또는 인증이 사라지면 HTTP 오류가 반환될 수 있다. 이 오류를 미실행 증거로 삼거나 쓰기를 재전송해서는 안 된다. 같은 원래 outbox ID로 상태/기존 완료를 복구한다. failed/not_found의 자동 재전송·임의 최종 처분은 보류한다.

검증:
- 관련5파일 **48개 통과 / 13.15초**. 새 body/route2개, 기존 gateway/인증 verifier/CLI 회귀 포함.
- 격리 TypeScript emit·변경 ESLint·diff 및 인수 스크립트 문법 검사 통과.
- 실제 HTTP 로그인→쿠키/CSRF→새 POST→CLI→production issuer→별도 journal/read MCP를 pending/failed/proved에서 실행했다. 쿠키 없음401, 잘못된 CSRF403, 다른 Origin403, session_id 삽입400, 정책 철회403, 로그인 만료401을 검사했다. 동일 요청의 정상 재조회 및 upstream 미전달·로그의 cookie 부재도 확인했다.
- pending/failed: HTTP 원래 수락 복구→deferred/reconciling 및 lease 해제. 커밋 후 exit73→새 Node/MCP/게이트웨이 로그인에서 replay, attempt1/event1/FK0.
- proved: HTTP 원장 상태 조회와 현재 status→artifact→status 검증→outbox/candidate settled, control completed. exit73→독립 DB replay에서 settlement1/attempt1/FK0. 기존 SQL compaction까지 통과했지만 물리적 원문 삭제 검증은 아니다.

재현(JARVIS cwd, 격리 빌드):
`TMPDIR=/var/tmp node /home/jm/orca/projects/second-brain-app/scripts/scoped-journal-recovery-acceptance.mjs <build> --http`
`TMPDIR=/var/tmp node /home/jm/orca/projects/second-brain-app/scripts/scoped-ack-loss-mcp-acceptance.mjs <build> --http`

실제 서버 session store와 HTTP를 사용했으며, Tailnet 전달 헤더/시계/읽기 정책·원래 쓰기 권한은 시험 구성이다. 운영 Tailnet 배포·실제 사용 계정·native 에이전트 A→B 인수를 완료한 것은 아니다. 독립 gateway CLI의 새 설정 필드 공급과 운영 서비스 설정·사용자 흐름은 다음 작업이다. 로그인 세션을 JSON으로 복사해 신뢰하는 구성은 보류한다.

SB 제품은 변경하지 않았다. 이전 전체1,354통과/2skip(embeddings 제외)은 이번48개와 합산하지 않는다. 삭제/복원·클라이언트 수집/주입·검색 평가·GUI 등 M1–M14 전체 목표를 유지하며, 운영 DB/서비스/설정·push 변경은 없다.
