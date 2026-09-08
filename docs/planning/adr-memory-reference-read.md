# 참고 기억 읽기: 로컬 정책과 provider 세대 결합

2026-09-08. 기존 memory-reference-v1 준비 모듈을 명시적 로컬 CLI 읽기에 연결한다.
`memory context <query> [--limit N] [--max_bytes N]`는 기존 소유자 환경의 읽기이며
프로젝트 권한이나 모델 세션 전달 영수증을 발급하지 않는다.

웹 읽기에서 사용하던 surface/legacy suppression 판정을 공통 함수로 추출해 동일하게
사용한다. 기존 projection key는 고정 파일에서 읽기만 하며 없거나 안전하게 읽을 수 없으면
명령을 거부한다. 읽기를 위해 새 key·기억 DB·승인·원문 spool을 만들지 않는다.

기존 DB의 migration 070은 privacy 및 delegation key 관련 여섯 테이블의 변경마다 증가하는 읽기 revision을 추가한다.
COUNT/MAX만으로는 SQLite REPLACE의 같은 개수 교체를 식별할 수 없으므로 최종 비교에 revision을
포함하고 최종 로컬 검사에서 key 유효성도 다시 검사한다. 원문·권한 저장소가 아닌 같은 DB의 변경 계수이며 shipped migration은 수정하지 않는다.

순서: 일관된 로컬 privacy snapshot → status 목적 fence로 provider 상태 확인 → 기존 signed
read adapter 검색 → provider 상태 재확인 → 소유한 transport 정리 → 짧은 로컬 read transaction에서
정책 변화·suppression·만료 검사 → 최종 JSON 준비. 두 서버 상태 관측 사이의 generation/manifest/
head/tree/삭제 high-water 차이와 로컬 최종 검사까지의 privacy 변화는 원문 없는 오류로 반환한다.
DB 잠금을 provider RPC 동안 유지하지 않는다. `provider_status_received_at`은 최종 서버 상태 응답을
받은 로컬 시각이다. 그 관측 이후에도 provider가 변하지 않는다는 보장은 아니며, 모델에 재전달할
때는 다시 읽어야 한다. 전송 중/이후 삭제 무효화는 B5의 실제 세션 전달 계보 연결에서 계속 다룬다.
정책에 의해 차단한 자료가 있으면 이번 묶음을 거부하여 차단 본문·출처가 반환되지 않게 한다.

웹 공개 응답의 HMAC token 계약을 원문 identity로 바꾸지 않는다. CLI의 reference JSON은
소유자가 명시적으로 읽는 기존 MCP 수준의 근거 identity를 유지한다. 같은 OS 사용자 접근을
프로젝트/다중 사용자 보안 격리로 주장하지 않는다. 기존 frozen MCP와 추천 authority는 유지한다.

stdout 준비 결과와 모델 수신 확인은 별개다. 장기간 캐시하거나 실제 모델에 재공급하는 경로는
session/compaction/삭제 projection·재확인을 연결하기 전 활성화하지 않는다. 이번 검증은
CLI 호출/실제 MCP 및 조회 도중 정책·세대 변화 재현을 포함하고 운영 배포는 포함하지 않는다.
