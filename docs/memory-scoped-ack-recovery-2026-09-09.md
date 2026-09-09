# Read v5 수락 응답 유실 복구

`client.recoverRequestStatus(request)`를 추가했다. 원래 요청과 현재 issuer scope를 대조하고, 명시적 read v5의 서명된 요청 조회로 journal acceptance를 회수한다. 기존 v4 상태 응답·기본 v2 설정은 유지한다. 새 checksum은 `4aaadbd6c5670c6f69e811567e2a93abcd746112d86697cfd391ef49aa4853c3`다.

수락 결과는 기존 parser로 원래 요청/시각/파일 해시를 검증한다. found 요청에서만 반환하며 not_found를 재전송 허가로 해석하지 않는다. existing requestStatus(request, acceptance)도 v5에서 알려진 수락과 회수한 수락의 동일성을 확인한다. 현재 권한은 전송 전과 응답 검증 뒤 재검사한다.

실제 기존 outbox의 accepted_result_json=NULL인 attempt를 만들고, provider fixture 저장 후 acknowledgement를 읽기 client에 전달하지 않았다. 감독되는 stdio MCP로 회수해 원래 attempt에 기록한 직후 별도 프로세스를 exit73으로 종료했다. 새 기록 프로세스 2회에서 replay, attempt1/event1/FK오류0/재claim 거절을 확인했다. 자비스 상태는 reconciling이고 자동 완료는 아니다.

J 확대78통과/25.53초, 최종20통과/0.978초(중복), 격리 emit·변경 lint 통과. SB 전체1,260통과/2skip/242.39초·Ruff·상태 reader 정적검사 통과. v1~v5 격리 패키징 해시 일치와 실제 v2/v3/v4 호환 인수도 통과했다.

인증 세션·키·시계·provider 내부 쓰기 callback은 fixture다. 운영 공개 쓰기 및 최종 완료/초기 generation 부재 인수는 남는다. 운영 설정·DB·서비스를 변경하지 않았다.

[상세 보고서](../../second-brain-app/SCOPED-ACK-RECOVERY-2026-09-09.md), [실제 프로세스 결과](../../second-brain-app/SCOPED-ACK-RECOVERY-2026-09-09.json).
