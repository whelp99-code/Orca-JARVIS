# 취소 DB 교체 전 중단 재구축

recoverCancellation에서 아직 결과 inode가 기록되지 않았고 현재 DB inode/device/세대가 저장된 source와 일치하는 경우 기존 입력으로 재구축한다. beginCancellationCompaction의 명시적 resume 분기는 저장 결과 digest, correction/lane/대상/범위/삭제 이력, layout, source/result 세대, source inode, 미완료 run/job 상태와 영수증 부재를 transaction 안에서 검사한다.

검사가 통과하면 기존 job의 fence를 증가시키고 상태를 compacting/building으로 전환하며 현재 DB에서 새 파일을 다시 만든다. 기존 입력·체크포인트를 재사용하고 job/input/receipt를 중복 생성하지 않는다. current provider 신뢰 검증과 runtime quiesce, 본문 재료/체크포인트 대조, fresh 생성/처분/swap/로컬 검사는 기존 경로를 따른다.

build 전 실패뿐 아니라 spool 처분 뒤 swap 직전 실패도 처리한다. 원문이 사라졌으면 기존 검증 체크포인트가 필요하며 증거 없는 부재를 성공 처리하지 않는다. 경로가 달라지면 재구축 전 거부한다. 최초 compact 호출을 무조건 재실행하는 기능은 아니다.

rename 완료 후 run의 결과 inode 저장 전 중단은 현재 source/result 어느 분기에도 들어가지 않으므로 NOT_SWAPPED로 보류한다. 이 구간의 교체 증거/복구는 후속 과제다. 외부 직접 DB writer와 별도 runtime의 전역 배제, 전체 settlement/cursor 완료도 여전히 범위 밖이다.
