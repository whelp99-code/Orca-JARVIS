# 취소 결과에 결합된 로컬 DB 처분

기존 70개 완료 inventory를 취소 provider 결과로 대체하지 않는다. MemoryAuthorityCompactor.compactCancellation(correctionId)는 현재 신뢰로 검증된 저장 결과에서 원 lane/대상/범위/삭제 이력을 얻고 기존 fresh DB 생성·사본 처분·runtime quiesce·swap을 재사용한다. provider/guard inventory를 입력받지 않는다.

새 migration075의 기존 AuthorityDb 내 입력/영수증 테이블에 결과 digest와 관리 layout을 먼저 저장한다. 실제 로컬20 검사·결과 세대/inode·physical scan·reader drain·현재 provider 신뢰를 확인하고 불변 로컬 영수증을 저장한다. 기존 purge 상태는 verifying이며 전체70 영수증·cursor 완료는 생성하지 않는다.

recoverCancellation은 현재 inode/세대, 저장 입력/layout, 현재 provider 신뢰, 검증 재료 체크포인트, 실제 로컬20 부재 검사를 다시 확인하고 동일 영수증을 반환한다. 교체 후 영수증 저장 전 실패도 복구한다. 원본 spool이 재등장하거나 증거가 없으면 거부한다. 과거 inode 번호의 재사용을 오인하지 않도록 swap에서 실제 old-FD 0 확인 직후 그 digest를 DB에 보존한다. 그 증거가 없으면 old-FD 검사를 다시 수행한다.

실제 새 프로세스 검증에서 runtime이 항상 1세대로 초기화되어 2세대 교체 DB를 거부하는 결함을 재현했다. runtime은 기존 DB의 단일 활성 세대를 검증해 초기화하도록 수정했다.

범위: 로컬 처분 기록이며 전체 취소 settlement가 아니다. pre-swap 실패·swap 후 run 메타데이터 저장 이전 강제 종료는 이 recover 경로에서 NOT_SWAPPED로 보류한다. 관리 root/DB 세대가 달라지거나 직접 외부 작성자가 있는 운영 환경의 전역 차단은 별도 과제다. cursor seq1 완료→정상 V2 seq2 및 일반 작업의 최종 완료는 후속 검증이 필요하다.
