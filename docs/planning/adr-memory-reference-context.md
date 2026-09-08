# 기억 참고 문맥: 본문 공급과 추천 권한 분리

2026-09-08. Second Brain 인계 C1~C5 구현 결정. 기존 `ContextSnapshotV1`은
live Linux 관측과 confirmed 기억에 근거한 추천 입력이며 그 조건을 변경하지 않는다.

새 `memory-reference-v1`은 기존 Second Brain read adapter가 검증한 generation-bound
record를 모델에게 참고 자료로 제공하기 위한 순수 JSON 묶음이다. 원문 LF/CRLF/CR/tab,
text digest, record/source/citation 식별자와 유효 시점을 보존한다. trust는 untrusted,
authority는 none이며 실행 성공이나 사용자 확인으로 승격하지 않는다.

선택은 adapter 순서를 보존하고 동일 record를 중복 제거한다. stale/정책 가림/미결 충돌/
binding 없는 근거는 현재 답의 사실로 공급하지 않는다. 여러 세대나 같은 ID의 상충
version을 혼합하지 않는다. 최종 직렬화 JSON(출처·경고·분량 정보 포함)에 UTF-8 byte
예산을 적용한다. 선택적 tokenizer는 모델/버전 ID와 실제 count 함수를 함께 주입하고,
미설정 시 token 수는 null이다. UTF-8 byte를 token 수로 부르지 않는다.

이 모듈은 I/O, 원문 DB, 전달 영수증, 세션 중복 상태를 만들지 않는다. 준비된 JSON은
전달 완료가 아니다. 실제 전송 연결은 기존 context/projection 삭제 계보와 사용자 범위,
전송 직전 freshness/fence 재확인을 거쳐야 한다. CLI/모델 전역 자동 주입은 그 경계가
완성되기 전 활성화하지 않는다. 기존 frozen MCP/추천 계약에는 필드를 추가하지 않는다.

검증: 여러 줄 digest 보존, 출처 binding, 실제 최종 payload byte/token 경계, 중복/상충
record, stale/만료/미확인/민감 정보 처리 및 실제 SB MCP 출력의 묶음 변환을 확인한다.
이는 최종 자동 문맥 전달 인수의 선행 구성요소이며 B5 전체 완료 조건은 유지한다.
