# 범위 요청 발행의 hardlink 직후 종료 복구

2026-09-09. 기존 publisher는 임시 파일 fsync 후 최종 이름으로 hardlink한다. 최종 link 생성 뒤 finally의 임시 link 삭제 전에 종료되면 같은 inode에 link2개가 남아 정상 reader가 거부했다.

범위 spool의 명시적 publish 재시도에서만 `recoverPrivateSpoolPublication`을 호출한다. 현재 provider·시각·v4 codec을 먼저 검증하며, 일반 read는 nlink1 제한을 유지한다. 복구 조건은 private root·정규 파일·link2개·요청과 동일한 bounded bytes·동일 inode를 가리키는 정확한 publisher 임시 이름1개·해당 PID의 ESRCH다. UUID/PID 형식과 최대4096개 directory entry 검사를 적용한다. live/reused PID, 알 수 없는 link, 내용 충돌은 그대로 거부한다.

삭제 직전에 최종/임시 이름과 bytes/root identity를 다시 확인하고, 인식된 임시 이름만 삭제한 뒤 directory fsync 및 nlink1/bytes 재검사를 수행한다. 기존 최종 이름·inode·bytes와 idempotency를 바꾸지 않는다. 이 helper를 일반 legacy 읽기에 자동 적용하지 않는다.

검증: scoped spool9·기존 private4·자동 발행6 = 19 passed(6.45초), backend 타입·변경 파일 ESLint·격리 emit 통과. 실제 기존/수정 compiled Node 각각3개 프로세스에서 fs.linkSync 직후 exit73을 주입했다. 수정 전 재시도 MEMORY_SPOOL_FILE_INVALID/link2, 수정 후 created=false·request 일치/link1·임시 파일0·동일 inode/bytes. 별도 기존 정상 발행/FIFO 인수3프로세스도 통과했다. SB scripts/scoped-spool-crash-acceptance.py로 재현한다.

범위: POSIX/Linux 실제 파일시스템의 해당 종료 지점과 살아 있는 PID·불명 link 거부를 검증했다. PID 재사용은 안전하게 거부하므로 자동 복구 가용성 제한이 남는다. 최종 link 생성 전의 단독 임시 파일, 오래된 요청 만료/삭제 inventory, 외부 비협조 writer 및 모든 OS의 복구까지 완료한 것은 아니다. 승인 단일 소비·outbox 원자적 확정·공개 MCP·실제 권한 연결은 계속 미완료다. 운영 DB/서비스는 변경하지 않았다.
