# 본문 없는 정정 취소 의향의 계약

2026-09-08. 상태: 복구 계약의 첫 구현 단위. 실행·MCP 노출은 아직 보류.

V2 혼합 delta를 허용하거나 checkpoint를 건너뛰지 않는다. 별도 kind
`memory_correction_cancellation_intent`, schema_version 1로 원본 정정의 본문을 제외한
취소·provider-local suppression 의향을 표현한다. 기존 MCP/요청 union에는 넣지 않는다.
이름의 intent는 중요하다. 서명 검증은 발신자의 주장을 검증하며 provider 미수신이나 삭제
완료를 증명하지 않는다. 이 객체만으로 DB 상태·cursor·generation을 변경할 수 없다.

원본의 단일 correction tombstone, 정확한 target/scope, 기존 owner delegation 서명,
request/idempotency/envelope 식별자를 결합한다. 원본 서명의 역사적 유효성을 검사하며
새 의향에는 별도의 현재 허용 키와 5분 이하의 유효기간을 요구한다. 키 저장소는 호출자가
명시적으로 제공한다. 기존 요청의 만료는 허용하지만 미래 발급·손상·대상 교체는 거부한다.
원본 content와 payload 객체는 계약에서 허용하지 않는다. 원본 request/envelope digest는
본문 없이 재계산할 수 없으므로 각각 원본 delegation 및 새 현재 서명의 결합으로 표현한다.

미전송 근거는 후보 ID·suppression event digest·fence0·attempt0·cursor 미점유의 발신자
attestation이다. 후속 구현은 이를 자비스 immediate transaction의 실제 DB 사실에서
생성해야 한다. provider도 original request/alias/pending 파일/실행 흔적을 independently
검사해야 하며 이미 수신된 요청을 이 의향만으로 취소하지 않는다.

후속 단계: provider accept와 취소의 같은 lock/원장 transaction 경쟁, 원본 alias 영구 거부,
원본 target 차단/재유입 방지, suppression generation의 봉인·활성화, 서명된 결과와 JARVIS
cursor의 결합. 수신 완료와 physical purge는 구분한다. 독립적으로 처리된 sequence 1의
checkpoint를 확인한 다음 sequence 2만 V2로 전달할 수 있으므로 혼합 delta 허용은 선행
필수로 가정하지 않는다. 이를 실제 양쪽 end-to-end 검증으로 확인해야 한다.
