# Today 저녁 보고서의 외부 신뢰 키

2026-09-08. latestCloseout은 artifact.envelope의 공개키 자체로 서명을 검증하고
latest_verified_closeout을 반환한다. 이는 서명자의 신뢰를 독립적으로 확인하지 못한다.
DashboardServerOptions의 선택적 trustedCloseoutKey를 read model과 Today에 전달한다.
미설정이면 검증된 저녁 보고서를 노출하지 않는다. 키 설정이 있으면 독립 키로 검증하고
원장 무결성과 run/correlation/date/phase 일치를 확인한다. 미완료 run과 미래 보고서는
현재 검증된 완료로 표시하지 않는다. 과거 완료 보고서의 역사적 조회는 유지한다.

예산/게시에도 같은 외부 신뢰 키가 필요하다. 이번에는 서버 조립 옵션과 실제 HTTP 경로까지
연결하지만 운영 키 파일·배포 구성과 실제 저녁 생산자는 아직 미연결이다. 임의 키 등록,
운영 재시작, 자동화 활성화는 수행하지 않는다. 기존 API 응답 형태는 유지한다.

검증: 키 미설정/불일치가200으로 허용되던 것을2fail/8skip로 재현했다. 첫 관련3파일25통과,
정상키/미래시각과 기존 privacy 조회를 포함한 최종3파일14통과. 중복이 있어 합산하지 않는다.
lint/typecheck/backend build exit0. 실제 compiled Node PID4076083에서 HTTP 서버를
세 키 구성으로 순차 실행했다: 미설정200/null, 불일치500/안전오류, 정상200/검증완료1건.
합성 서명 보고서이며 실제 운영 작업의 저녁 보고를 인수한 것은 아니다.
증거 /home/jm/.cache/jarvis-test-runtime-qa-20260908/closeout-dashboard-trust-*.log/mjs/json.

실제 원본 대조: task_completions의 readTaskCompletion은 기존 publication/verification/
workflow 효과를 결합한다. CloseoutVerification은 별도 서명 domain을 요구한다.
기존 task 증거 서명을 closeout 서명으로 재명명하거나 새 사실 확인 없이 임의 재서명하지 않는다.
원래 증거를 보존하는 연결 계약과 별도 신뢰 키 구성이 후속 생산자 구현에 필요하다.

독립 검토 /root/closeout_dashboard_trust_review: ship, 지적0. 요청gpt-5.6-sol/high, 실제모델·effort미노출.
