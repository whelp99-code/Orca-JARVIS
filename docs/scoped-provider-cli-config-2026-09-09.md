# Gateway CLI에서 현재 쓰기 검증기 활성화

기존 phone-gateway-main은 memoryProviderVerifier 서버 옵션을 전달할 수 없었다. 명시적 옵션 7개로 기존 검증기를 연결한다. 모두 없으면 비활성, 일부만 있거나 빈 값·상대 경로·제어문자·잘못된 agent/provider ID면 시작을 거절한다.

| CLI 옵션 | 서버에서 지정할 기존 자원 |
|---|---|
| --provider-verify-db | authority DB 절대 경로 |
| --provider-verify-agent | gateway가 사용할 agent ID |
| --provider-verify-provider | 대상 SB provider ID |
| --provider-verify-policy | 현재 쓰기 범위 정책 파일 |
| --provider-verify-spool | 원래 scoped 요청 spool |
| --provider-verify-dispatch-spool | 원작업 dispatch spool |
| --provider-verify-review-spool | 원작업 review spool |

기존 host/port/upstream/static-root/env-file과 함께 지정한다. context와 reconcile 옵션은 독립적으로 유지한다. 로그인 세션은 기존 gateway session store에서만 공급한다. 설정 parser는 형식을 검사하며 파일 내용·현재 정책·원래 dispatch는 기존 검증기가 요청마다 확인한다.

CLI는 자체 AuthorityDb 연결을 소유하고 시작 실패·출력 실패·종료 때 닫는다. 기존 호출자가 소유한 연결은 닫지 않는다. AuthorityDb의 선택적 fileMustExist 옵션은 SQLite 열기 자체에서 경로 오타에 의한 빈 DB 생성을 막고 reopen에도 유지된다. 기본 호출의 생성 동작은 유지한다. 이 경로는 DB initialize/migration을 호출하지 않는다. 기존 AuthorityDb의 WAL/연결 PRAGMA 구성은 적용되므로 읽기 전용 SQLite 연결이라고 표현하지 않는다.

관련5파일 64개 통과(8.31초), 타입 emit/변경 lint 통과. 실제 TLS→gateway→별도 MCP→일반 SB CLI 검사에서 parser로 구성한 독립 authority 연결을 사용했다. 정상 proved/HTTPS5회, 수락 중 철회 미수락/2회, 실행 전 철회 및 만료 failed·활성 세대 없음/각3회. 모두 dispatch attempt1/FK0. 실제 임시 서버·로그인·SQLite·프로세스 전송이며 시계·CA·전달자 identity·원작업은 fixture다. 고정 운영4176의 독립 실행물 배포 인수는 아니다.

확대 검사에서 memory-cancellation-db의 직접 cursor 순번 변경 fixture가 migration076에 거절되어 1건 실패했다. 정식 claim→accepted로 상태를 준비하고 직접 순번 변경 거부도 검증하도록 별도 수정했다. 마이그레이션이나 제품 무결성 검사는 완화하지 않았다. 최종 검사 수치는 SB 보고서를 참조한다.

운영 릴리스·키/정책/세션 자격증명 공급·DB 전환 및 실제 에이전트 A→B 인수는 남는다. 운영 파일/DB/서비스 변경과 push는 수행하지 않았다.
