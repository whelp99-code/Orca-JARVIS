# V2 정정 후보 차단의 준비·전송 경계

2026-09-08. 구현 전 결정. V1에서 적용한 후보 ID 차단을 V2 정정의 독립 경로에도 적용한다.
기존 projection ID 차단 의미를 재사용하며 새로운 승인이나 schema를 추가하지 않는다.

prepare의 spool 전과 publication 후 writer transaction 안에서 검사한다. 각 준비 시도는 고유한
spool 파일을 사용하여 실패 보상이 기존 preparation의 파일을 삭제하거나 덮어쓰지 않게 한다.
새 파일 publication 이후 거부하면 해당 시도 파일만 기존 cleanup receipt 경로로 제거한다.

destructive preparation은 DB의 correction/candidate 결합을 writer lock 안에서 검사한 뒤
tombstone/materialization을 수행한다. 삭제 lane은 이 후보 검사 대상이 아니다.
queued→dispatching은 후보 검사와 전역 dispatch cursor claim을 같은 transaction에 묶는다.
직접 V2 adapter도 correction row의 candidate 차단을 검사한다. 차단 검사는 이미 전송된 요청의
관측/증거 보존/삭제·정정 복구를 중단하는 용도로 사용하지 않는다.

정정 자체의 target tombstone을 무조건 예외 처리하지 않는다. candidate에 실제 같은 원본 계보가
연결돼 차단되면 거부하고, 단순히 이전 target을 정정하는 정상 후보는 기존 계약대로 진행한다.
원task→candidate→provider record 계보와 DB 검사→외부 수신 사이 원자성은 별도 미완료 조건이다.
이미 커밋된 tombstone 뒤 차단된 queued lane의 운영 처리/후속 lane 순서도 별도로 확인한다.

최종 결정: 미전송 lane의 자동 retirement/skip 시제품은 철회한다. 실제 JARVIS validateChain과
SB _verify_chain이 delta의 각 entry를 현재 요청의 lane/operation/payload 등에 결합하므로,
이전 정정과 후속 삭제를 delta[1,2]로 묶으면 EFFECT_TOMBSTONE_DELTA_INVALID로 거부된다.
합성 AcceptedWriter의 통과는 실제 계약 인수가 아니었다. migration072, retired view, prefix status
예외를 제품에서 제거했다. 기존 schema/contract/검사 강도는 유지한다.

차단된 queued 요청은 tombstone·spool과 함께 보류되며 provider accepted sequence를 전진시키지
않는다. 후속 destructive 작업도 local/provider high-water 불일치에서 보류된다. 운영 자동복구는
미완료다. 새 계약에는 원본 target별 삭제 전파·처분 증거·상태 전이·구버전 거부·재시작을 함께
정의해야 하며 digest/hash 검사만 약화하지 않는다. cleanup 실패 시 orphan spool 복구도 남는다.
