# 기억 화면의 조회·선택 수명

상태: 구현·격리 HTTP/Chromium 검증 완료, 운영 인수 미완료. 기존 대시보드의 개인정보 전환 경합을 보강한다.

검색·상세·충돌은 provider await 전후 같은 로컬 개인정보 snapshot 및 dashboard session이어야
결과를 내보낸다. 조회 뒤 새 상태로 이전 응답을 재표시하지 않는다. 최종 검사·suppression·token
발급은 한 동기 SQLite read transaction에 둔다. 변경 시 MEMORY_SURFACE_READ_CHANGED로 거부한다.
충돌은 어느 한쪽이 억제된 경우 전체 항목을 제외한다. provider 세대의 전후 원격 fence 확장이나
프로젝트 ACL 구현을 의미하지 않는다.

화면 선택은 원문 record의 별도 state 사본 대신 현재 검색 결과 안의 token으로만 식별한다.
결과가 사라지면 상세·수정 draft·삭제 확인도 함께 사라진다. 데이터 만료 및 개인정보 SSE는
검색 결과를 폐기하며 지연 응답이 되살리지 못하도록 기존 요청 epoch/abort를 유지한다.
새 검색 결과가 현재 status의 privacy_epoch와 다르면 빈 상태로 거부한다.
로컬 view_revision은 store 요청 epoch로만 계산하고 detail key/완료 callback에 결합한다.
같은 object/token의 즉시 응답도 새 검색에서 이전 완료를 재사용하지 않는다. 별도 clear_revision은
개인정보 clear/만료에 증가해 검색어 입력란도 재생성한다. 이 값들은 서버 권한 claim이 아니다.
전체 충돌이 억제된 경우와 원래 빈 충돌 목록은 모두 no_data로 내보낸다.

검증: 지연 provider 중 정책 변경·세션 교체·충돌 억제, 정상 검색/상세/충돌 회귀; 화면 선택 후
privacy clear/만료/다른 결과 전환; 실제 Chromium 화면 및 격리 HTTP API. native 자동 전달과
외부 로그 보존·앱 실행 plan 확장은 별도 작업이며 완료로 계산하지 않는다.

결과: dashboard 전체34파일211 passed, 최종 메시지 복구 보강 뒤 집중6 passed. backend관련5파일15
passed, 최종 conflict no_data 후2파일6 passed. 타입/변경lint/격리build 통과. Chromium1440/1024에서
검색→상세선택→수정draft→privacy SSE→내용/검색어제거, console오류0/overlay없음/가로넘침없음.
실제HTTP policy race409/본문부재 확인. provider는 합성adapter이며 native모델/운영데이터는 사용하지 않았다.

초기 backend 재현4실패 중 detail은 fixture tombstone root불일치로 provider 호출 전에 종료됐으므로
누출 재현 증거로 세지 않는다. root를 바로잡은 최종 검사는 provider I/O 후 세션변경 거부를 검증한다.
초기 frontend3실패는 상세/draft잔류·검색만료누락·epoch불일치 수용을 직접 재현했다.
DB 읽기 transaction 종료와 HTTP 전송까지 외부프로세스 변경에 대한 전역 원자성을 보장하지 않는다.
서비스 status의 ready는 adapter구성 상태이며 실제 provider/전체관제 연결준비 보장이 아니다.
자세한 증거: `/home/jm/orca/projects/second-brain-app/DASHBOARD-MEMORY-LIFETIME-2026-09-08.md`.
