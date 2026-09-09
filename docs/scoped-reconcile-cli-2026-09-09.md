# 인증 문맥을 받는 scoped 복구 CLI 연결

`memory reconcile-scoped <outbox-id> --once [--worker ID]`를 기존 execute 명령 경로에 추가했다. `CliDependencies.scopedMemoryReconcileOptions`로 호스트의 현재 인증 세션 callback·기존 읽기 키·파일 정책·spool/원본 경로·journal/read-v5 전송 설정을 제공한다. 독립 바이너리 기본 실행은 이 호스트 구성이 없으면 MEMORY_SCOPED_RECONCILE_CONFIG_REQUIRED로 거절한다. --session_id/--input/--key-file을 권한 전달 수단으로 받지 않는다.

새 `createProductionScopedReconciler`는 원래 요청과 현재 프로젝트 범위를 먼저 대조하고 lease claim 전에 현재 권한을 확인한다. journal status와 read v5를 각각 명시된 프로필로 구성해 기존 단건 재조정 실행에 연결한다. 키/정책/로그인은 생성하지 않는다. 자신이 만든 전송만 종료하고 호스트가 주입한 전송은 호스트가 관리한다. close 이후 실행은 거절한다.

검증:
- 관련4파일 **22개 통과 / 22.07초**. 신규6개는 정상 CLI, 설정 누락, 세션 누락, 다른 프로젝트, CLI 세션 삽입, --once 누락이다. 거절 시 provider 호출0·lease fence 불변; injected transport close0·닫힌 runtime 재실행 거절도 확인했다.
- 초기 정상 fixture 실패는 정책 methods 배열의 정렬 규칙 위반을 수정했다. production 정책 검증을 완화하지 않았다.
- 격리 TypeScript emit, 변경 ESLint, diff·인수 스크립트 문법 검사 통과.
- 실제 CLI execute→production 구성→별도 journal/read MCP로 pending/failed/proved를 실행했다. pending/failed는 원래 수락 복구→deferred/lease 해제/reconciling, proved는 현재 artifact 확인→outbox/candidate settled·control completed. 각 커밋 후 exit73→별도 프로세스 재생에서 attempt1, 수락 event1 또는 settlement1, FK0.

재현(JARVIS cwd, 격리 빌드):
`TMPDIR=/var/tmp node /home/jm/orca/projects/second-brain-app/scripts/scoped-journal-recovery-acceptance.mjs <build> --cli`
`TMPDIR=/var/tmp node /home/jm/orca/projects/second-brain-app/scripts/scoped-ack-loss-mcp-acceptance.mjs <build> --cli`

인수는 execute API에 호스트 dependency를 전달한 실제 명령 처리 경로다. 별도 독립 바이너리 로그인 인증을 구현했다는 의미는 아니다. 읽기 세션 callback·시계·원래 쓰기 authority는 시험 구성이고 운영 Tailnet/실제 계정/서비스 설정은 변경하지 않았다. 권한 세션 JSON 복사로 독립 CLI를 활성화하거나 CLI 라벨로 인증하는 우회는 보류한다.

남은 우선 과제는 실제 인증 gateway가 이 명령에 세션을 공급하는 진입점, 운영 설정·배포 인수, 실제 A 저장→B 새 세션 조회다. 삭제/복원·수집/주입 지원표·검색 평가·GUI 등 M1–M14 전체 목표를 유지한다. SB 제품은 변경하지 않아 이전 전체1,354통과/2skip(embeddings 제외)을 이번 검사 수와 합산하지 않는다.
