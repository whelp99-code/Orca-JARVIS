# 상태별 단건 scoped 재조정 실행

`reconcileMemoryScopedOnce`는 이미 전송된 outbox 한 개만 명시적으로 처리한다. 새 dispatch·큐 탐색·자동 재시도는 하지 않는다. 기존 완료 기록이 있으면 검증된 replay를 반환하고 네트워크 호출을 생략한다. 다른 worker가 점유했거나 claim 대상이 아니면 not_claimed를 반환한다.

claim 후 journal acceptance를 복구한다. provider 상태 proved일 때만 기존 settleMemoryScopedCompletion을 호출한다. 이 경로는 별도로 현재 status→artifact→status와 권한/원작업/lease를 검증하고 원자적 완료를 기록한다. journal proof 자체를 완료 증거로 승격하지 않는다. pending/failed/not_found는 deferred를 반환하고 lease를 해제하며 outbox는 reconciling을 유지한다. 조회·완료 실패는 호출자에게 전파하고 lease는 정상 만료/복구 절차에 남긴다.

검증:
- 관련3파일 **20개 통과 / 19.69초**. 새8개는 pending/failed/not_found/proved/busy/cancelled/read_error/completion_error를 검사한다. 완료 replay에서 네트워크 추가 호출0, 보류 경로의 completion 호출0, 오류 시 lease 보존, attempt1/FK0.
- 격리 TypeScript emit·변경 ESLint·diff 및 수정된 인수 스크립트 문법 검사 통과.
- 실제 journal worker 인수: pending/failed 각각 원래 수락 기록 후 exit73→다른 Node/MCP 실행에서 재조회·재claim·replay. attempt1/acceptance event1/FK0, deferred·lease 해제·reconciling 유지.
- 실제 proved worker 인수: 원래 자비스 DB dispatch/spool→Python provider→journal MCP 및 read v5 MCP→단건 재조정→현재 artifact/권한 검증·원자 완료. 이후 exit73→독립 재생에서 outbox/candidate settled, control completed, settlement1/attempt1/FK0. 기존 SQL compaction 인수도 source 각1→target0/무결성 ok로 통과했으며 물리적 원문 삭제 인수는 아니다.

재현(JARVIS cwd, 격리 빌드):
`TMPDIR=/var/tmp node /home/jm/orca/projects/second-brain-app/scripts/scoped-journal-recovery-acceptance.mjs <build> --once`
`TMPDIR=/var/tmp node /home/jm/orca/projects/second-brain-app/scripts/scoped-ack-loss-mcp-acceptance.mjs <build> --once`

원래 쓰기 권한·읽기 세션·시계는 fixture다. 운영 인증 세션 공급/명령 진입점/서비스 설정과 실제 클라이언트 A→B 인수는 남는다. 이 단위는 서버에서 호출할 수 있는 실행 함수이며 운영 daemon이나 CLI 명령을 배포한 것이 아니다. 기존 전체 M1–M14 범위는 유지한다. SB 제품 변경은 없으므로 이전 전체1,354통과/2skip은 이번20개와 합산하지 않는다. 운영 DB/서비스/설정·push 변경은 없다.
