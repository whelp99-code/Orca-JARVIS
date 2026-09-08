# Orca 조회 프로세스 종료 검증 — 2026-09-08

## 발견과 수정

커밋 `00d6835` 전체 verify의 backend shard 1에서 1,333개 중 1개가 실패했다.
실패는 descendant stdout 종료 뒤 `/proc/PID/stat`의 상태가 즉시 `Z`여야 한다는 조건이다.
Linux `do_exit()`는 `PF_EXITING`을 설정한 뒤 파일/pipe를 닫고, 이후 `exit_notify()`에서
zombie 상태를 설정한다. 따라서 pipe close 통지를 받은 시점에도 커널 종료 처리 중인
프로세스가 `R`로 보일 수 있다.

테스트는 close 이벤트를 기다린 후 `/proc`를 한 번 읽는다. PID가 없거나 `Z`, 또는
`PF_EXITING`이 설정된 경우를 인정한다. `R`/`S` 등 상태만으로 통과시키지 않으며,
정상 실행 중인 프로세스는 실패한다. sleep·재시도·polling·허용 timeout 확대는 추가하지 않는다.
제품의 SIGKILL/프로세스 그룹/close grace/cleanup 실패 정책은 변경하지 않는다.
이는 커널 종료 경로 진입의 증거이며 PID 1의 수거 완료나 임의의 탈출 프로세스까지
종료됐다는 증거가 아니다. detached escape의 cleanup failure 회귀는 유지한다.

근거: [Linux PF_EXITING 정의](https://github.com/torvalds/linux/blob/master/include/linux/sched.h),
[do_exit 순서](https://github.com/torvalds/linux/blob/master/kernel/exit.c).

## 실측

증거 경로: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`.

- 첫 실제 자식 프로세스 재현 30회 중 1회에서 close 직후 `R`, 약 1.13ms 뒤 PID 소멸.
- 플래그 포함 추가 200회 중 10회가 close 직후 `R`; 10회 모두 `PF_EXITING` 설정.
  별도 후속 조회에서 해당 10개 PID 소멸. 단순 kill 호출 spy 결과가 아니다.
- 원자료: `orca-child-exit-observation.json`, `orca-child-exit-flags-200.json`,
  `orca-child-exit-final.json`. 관측용 script의 bounded sampling은 진단 전용이며 제품/테스트에 포함하지 않는다.
- 소스 동결 중 cache의 수정 초안 실행: 1파일/15테스트 pass, 2.67초.
  `orca-exit-draft-test.log`; 리포 적용 후 검증은 별도로 기록한다.

기존 전체01–25 개발 범위를 유지한다. daemon 실행본의 lease·process incarnation·build
연결은 다음 개발 단위이며, 본 테스트 수정은 목록18 검증 신뢰성의 후속 보정이다.

## 리포 적용 검증

- 변경 전 전체 verify 종료: 401파일/2,643테스트 중2,642pass/1fail, exit1.
  shard1 560.68초, shard2 571.83초. 전후HEAD `00d6835` 동일, 추적 파일 bytes 변경0.
  backend 실패로 dashboard/acceptance/smoke 후속 단계는 실행되지 않았다.
- 수정 적용 후 해당 테스트15pass/2.64초. lint, typecheck, build:backend 모두 exit0.
  로그: `orca-exit-applied-test.log`, `orca-exit-lint.log`, `orca-exit-typecheck.log`,
  `orca-exit-build.log`. 현재 환경 커널은 `7.0.0-29-generic`이다.
- 전체 verify 재실행 결과는 후속 증거를 따른다. 관련 테스트 통과를 전체 통과로 표현하지 않는다.
