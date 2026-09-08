# 검증된 취소 완료와 처리 위치

settleCancellation은 기존 runtime quiesce 안에서 로컬 복구/현재 검사를 실행하고, 같은 배제 구간의 immediate transaction에서 현재 provider 신뢰와 exact 로컬 영수증을 다시 대조한다. 원 정정이 queued/fence0/proof 없음/전송 attempt 없음이며 실제 억제 근거가 있어야 한다.

진행 중인 다른 lane이 없고 처리 위치가 취소 sequence-1일 때만 신규 완료를 허용한다. migration076의 불변 settlement와 cursor 이동을 같은 transaction에 저장한다. cursor 갱신 실패 시 settlement도 롤백한다. 동일 결과 재생은 이미 기록된 완료를 반환하며 진행 위치가 뒤로 갔거나 증거가 달라지면 거부한다.

SQL binding은 저장 provider 결과·로컬 입력/영수증·삭제 이력·직전 cursor를 대조한다. idle cursor의 직접 순번 증가에는 인접 sequence의 settlement가 필요하다. 일반 active lane의 accepted 전이는 유지한다. 원 취소 요청의 재전송 금지도 유지한다.

완료 범위는 미전송 취소의 provider 결과와 JARVIS 로컬 처분에 대한 처리 순번이다. 기존 전체70 purge 완료 영수증이나 모든 외부 사본 삭제를 뜻하지 않는다. 실제 후속 V2 seq2 처리·외부 writer 전역 배제·앱/세션 수명 인수는 별도 요구로 유지한다.
