# 격리 프로세스 순환 검증의 준비 신호

2026-09-08. 전체 verify(27c1fd8)는 process-stress Unix socket ECONNREFUSED 1건으로 실패했다.
기존 fs.watch+existsSync는 socket 파일 생성만 확인하며 listen 완료를 증명하지 않는다.

실제 staged-execstart 자식의 IPC 채널에서 listen 완료 이후 준비 신호를 보낸다.
부모는 socket 경로까지 일치하는 신호를 받은 뒤 연결하며, 조기 종료·spawn 오류·제한시간을
실패로 처리하고 관련 listener/timer를 해제한다. stdout/stderr는 소비하되 준비 증거로 사용하지 않는다.
준비 신호는 fixture control channel 전용이며 운영 서비스의 준비·업무 완료 증거가 아니다.
기존 순환 cursor와 재시작 중복 방지 계약은 유지한다.

검증: 준비 전 상태/잘못된 경로/실패/타임아웃/정리 단위 검사와 실제 10,000회 순환·SIGKILL
1회·재시작·중복0·잔여 프로세스0을 확인한다. 전체 gate는 수정 후 다시 실행해야 한다.

## 검증 결과

- 최종4파일8개 통과(5.27초), 실제 staged-execstart 순환10,000회, SIGKILL1회,
  재시작1회, logical duplicates0, owned processes/listeners/handles0.
- backend build, lint, typecheck exit0, diff check exit0.
- fresh readonly review `cycle_ready_review`: ship, blocking0/nonblocking0.
  요청 모델 gpt-5.6-luna/high, 실제 모델·effort·토큰 사용량은 도구에서 관측 불가.
- 증거: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/cycle-ready-final-{build,tests,lint,types}.log`.
- 전체 verify의 이전 실패 결과는 보존하며 통합 브랜치에서 새로 검증한다.
