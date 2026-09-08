# DB 재구성 전체 구간의 runtime 배제

기존 compactor는 fresh DB 생성과 관리 사본 처분을 수행한 뒤 swap() 내부에서만 runtime.quiesce를 사용했다. 따라서 fresh DB를 만든 직후 runtime.write가 성공해도 그 변경은 이미 만들어진 fresh DB에 없으며 파일 교체 때 사라질 수 있다. 취소 완료 근거에 영향을 줄 수 있는 키 철회도 같은 경로다.

compact() 진입에서 기존 runtime lease를 drain한 후 authority 확인·본문 수집·fresh DB 생성·관리 사본 처분·swap·전체 검사·완료 기록까지 하나의 quiesce 안에서 수행한다. private swap은 외부 구간의 배제를 이어 사용한다. recover()의 검사/완료 기록도 같은 배제 안에서 실행한다. finally로 정상/실패 후 runtime을 다시 사용할 수 있게 한다.

회귀 검사는 실제 builder 직후 runtime 쓰기를 주입해 수정 전 허용과 수정 후 AUTHORITY_DATABASE_QUIESCING 거부를 확인한다. 먼저 시작한 writer는 drain 전에 변경을 commit하며 새 DB에도 보존되어야 한다. 완료 후 새 쓰기는 성공해야 한다. 기존 독립 프로세스 old-FD 보존→drain 복구 검사도 유지한다.

보호 범위는 이 AuthorityDatabaseRuntime을 통하는 lease다. 별도 AuthorityDb 연결·직접 SQLite 연결·외부 파일 작성자에 대한 전역 writer 차단은 이 변경으로 보장하지 않는다. native 작성자 정지/등록과 취소 완료 계약의 운영 인수는 계속 남는다. 가상 provider inventory를 실제 provider 취소의 전체 완료 증거로 사용하지 않는다.
