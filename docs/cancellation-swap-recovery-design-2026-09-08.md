# 파일 교체 직후 중단의 취소 복구

취소용 fresh DB를 닫은 뒤 그 파일 안의 기존 compaction run에 결과 device/inode·세대·논리 검사 digest·사전 물리 검사 digest를 기록한다. 다시 checkpoint/close하고 실제 금지 본문 hash로 검사한 뒤 파일과 디렉터리를 fsync한다. 정상 swap은 최종 파일 digest를 기록하며, post-rename 중단 복구는 사전 기록과 현재 로컬 물리 검사를 함께 사용한다. 이 digest는 자기 자신을 포함한 DB 전체 hash라고 해석하지 않는다.

기존 DB를 닫은 후 single-link source임을 확인하고 동일 디렉터리의 purge별 .retired hard link로 보존한다. 이 링크는 rename 직후 old inode가 새 WAL 등으로 재사용되는 것을 막는다. old-FD 0 관측을 DB에 저장한 뒤 정확한 device/inode의 보존 파일만 제거하고 디렉터리를 fsync한다. FD가 남거나 파일 정체성이 달라지면 제거/완료를 거부한다.

복구 시 source DB가 아직 active이면 보존 링크를 정리하고 기존 pre-swap 재구축 검증을 따른다. 결과 DB가 active이면 파일 내부에 기록한 inode/세대를 대조한다. 보존 링크가 남았으면 과거 FD0 기록이 있어도 다시 FD를 검사하고, 검증 후 링크를 제거한다. 이후 현재 provider 신뢰·검증 재료·로컬20 검사를 거쳐 동일 불변 영수증을 저장/재생한다.

중단 주입은 실제 rename 직후 observeOldInode 호출에서 process.exit(77)이다. 새 프로세스에서 실제 provider 결과와 DB를 다시 열어 복구한다. 이 인수는 전원 장애/파일시스템 손상을 시뮬레이션한 결과가 아니다.

전체 settlement/cursor 및 직접 DB/외부 작성자의 전역 배제는 별도 과제다. 기존 전체70 경로에 보존 링크를 추가하지 않는다. 새 사전 정보가 없는 과거의 미확정 교체 파일은 증거 부족으로 계속 보류한다. runtime을 통하지 않는 writer와 같은 경로의 디렉터리 교체를 이번 변경으로 통제했다고 주장하지 않는다.
