# 취소 spool 검증 재료와 재시작 체크포인트

기존 compactor의 DB projection 본문 수집만으로는 취소된 정정 spool을 찾지 못한다. 별도 collector가 실제 취소 의향/source·원 요청·삭제 chain과 spool digest를 대조하고, spool의 target/scope/content로 원 요청 payload digest를 재계산한다. 다른 파일이나 변경된 본문은 거부한다.

검증한 원문은 기존 compactor의 메모리 내 처분 재료에 포함한다. 파일 제거 전에 기존 forbidden content identities와 본문 없는 immutable checkpoint를 같은 DB transaction에 보존한다. checkpoint는 원 요청·spool·payload 및 실제 저장된 식별자 집합에 결합하며 원문이 사라진 뒤에도 식별자 검사를 유지한다. 증거 없는 spool 부재는 성공으로 처리하지 않는다.

기존 전체70표면 검사 영수증은 계속 요구한다. 이번 변경을 provider40표면 없는 취소의 전체 로컬 처분/cursor 완료로 해석하지 않는다. 새로운 자동 skip이나 운영 activation을 추가하지 않는다.
