# 취소 복구를 위한 JARVIS 로컬 관측

취소 provider 결과는 기존 40개 provider inventory와 다른 범위다. 이를 기존 70개 완료 inventory에 대입하지 않는다. 기존 scanner의 파일/SQLite 검사를 재사용하는 scanLocal()은 JARVIS 소유 20개 영역의 현재 관측만 반환한다.

검사 대상 금지 본문의 저장된 해시 집합이 없으면 거부한다. 결과에는 로컬 catalog digest, 검사한 identity manifest digest, 실제 관측 20개와 전체 digest를 넣는다. 누락·읽기 오류·본문 일치가 있으면 실패한다. 반환 객체와 각 entry는 동결한다. 기존 70개 검사 타입과 반환 타입을 구분한다.

이 결과는 특정 취소의 완료 영수증이 아니다. 원 의향/서명 결과/삭제 이력/DB 교체·작성자 정지와 결합한 durable settlement를 후속 구현해야 한다. 현재 관측 이후의 파일 변경·외부 작성자 활동을 막는 보장은 추가하지 않는다. cursor를 진행시키지 않는다.

실제 취소 fixture를 기존 전체 compactor에 통과시켜 inode 교체 뒤에도 결과/체크포인트가 유지되고 사본이 제거되는지 검사한다. 이 통합 검사의 provider/guard inventory는 synthetic이며 실제 취소 provider inventory의 인수로 표시하지 않는다. 별도 프로세스 인수는 실제 로컬 20개 검사에 provider/guard fixture를 넘기지 않는다.
