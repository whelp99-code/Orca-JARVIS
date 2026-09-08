# v4 범위 요청의 불변 private spool

2026-09-09. 기존 outbox는 본문을 직접 보관하지 않고 private spool에서 요청을 재구성한다. v4 자료도 같은 파일 안전성 기반을 재사용하도록 `MemoryScopedWriteSpool`을 추가했다. 기존의 원본 v1/v3 dispatch spool을 덮어쓰지 않는다.

운영자가 제공한 기존 private root를 inspect만 하며 자동 생성·권한 보정은 하지 않는다. 파일명은 v4 idempotency key의 64자리 digest다. codec 검증 후 기존 임시 파일 fsync→hardlink publisher를 사용하고, 최종 bytes를 다시 읽어 정확히 비교한다. 같은 key·같은 bytes는 created=false, 같은 key·다른 유효 요청은 SCOPED_WRITE_SPOOL_CONFLICT이며 기존 파일은 유지된다. 읽기는 key·provider·현재 시각·canonical JSON·UTF-8를 검증한다. BOM도 자동 정규화하지 않는다.

공통 reader는 O_NONBLOCK으로 특수 파일 open 정지를 피하고, 크기 제한 확인 후 최대 초기 파일 크기+1만 읽는다. 종료 후 descriptor/경로의 inode·크기·mode·owner·link 수·mtime/ctime과 root identity를 다시 검사한다. v4 제한은 32,768 bytes, 기존 호출의 기본 상한은 기존 JSON character 예산의 UTF-8 최대치인 4,194,304 bytes다.

검증: 신규 spool6/codec13/기존 private4/scope5/자동 발행6/기존 정적 검사2 = 36 passed(10.62초). 타입·변경 파일 ESLint·격리 emit 통과. 수정 전 격리 compiled reader는 실제 FIFO에 READY 출력 후 2초 timeout, 수정 후 MEMORY_SPOOL_FILE_INVALID. 실제 새 프로세스3개로 발행 직후 exit73→새 reader/재발행→FIFO 거부 확인. 같은 request/body/inode, mode0600, created=false. SB `scripts/scoped-spool-acceptance.py`로 재현한다.

아직 DB 승인 소비·outbox enqueue·provider 호출은 연결하지 않았다. 발행 후 응답 유실의 재사용을 검증했으며 hardlink 생성과 임시 링크 삭제 사이 종료의 orphan 복구까지 검증한 것은 아니다. 운영 연결 전에는 임시/완성 파일의 수명·삭제 inventory, 승인 소비와 요청 자료 확정의 원자성, 종료 지점별 복구가 필요하다. 이 단계에서 scope review를 기존 confirmation으로 위장하거나 DB 중복 제약을 해제하는 방식은 보류한다. 운영 서비스·DB·설정은 변경하지 않았다.
