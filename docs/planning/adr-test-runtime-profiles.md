# 검증 프로필과 GUI 프로세스 수명

2026-09-08. 개선 15/18. 서버·대시보드의 검증은 Electron 바이너리 다운로드나 화면을 요구하지 않는다.
실제 Electron 패키지와 GUI 드라이버는 별도 `test:gui`에서 필수로 실행하고 CI에서도 별도 단계로 유지한다.
GUI를 제외한 계약·오류·소스 검사는 기본 backend 검증에 남긴다. 전체 제품 인수에는 두 경로가 모두 필요하다.

테스트 프로필·제외 경로는 중앙 구성에 두고 unit/integration/전체 backend/dashboard/GUI 명령을 제공한다.
호출마다 쓰기·읽기를 확인한 private 임시 루트를 만들고 자식 프로세스에 전달한다.
명시 TMPDIR는 이미 존재하는 절대 디렉터리여야 하며, 유효하지 않으면 다른 곳으로 바꾸지 않는다.
기본 경로는 `~/.cache/orca-jarvis/tests`다. 각 run 디렉터리는 0700이며 실제 4 KiB 쓰기·fsync·읽기 비교 후 사용한다.
외부 runner의 AbortController는 TERM→1초 뒤 KILL을 전달한다. 내부 helper는 Vitest 종료 처리보다 먼저
자신이 생성한 별도 그룹을 정리한다. 정상 종료·실패·시간 초과·SIGTERM/SIGINT 후 임시 루트를 제거한다.
Linux headless의 PID namespace를 제외하면 최상위 SIGKILL·호스트 종료까지 정리를 보장하지 않는다.

실측: 기본 xvfb-run은 `/tmp/.tX99-lock` PID 쓰기 실패로 대기했으며 GUI 회귀가 60초 뒤 abort됐다.
Xvfb -displayfd만 사용해도 `/tmp/server-2.xkm` 생성에 실패했다. 설치된 Xvfb의 `-nolock`은 root 전용이므로 사용하지 않는다.
Linux headless GUI는 bubblewrap의 private /tmp와 PID namespace에서 Xvfb를 실행한다.
접속 인증은 테스트별 MIT cookie와 private Xauthority로 유지한다. 네트워크 TCP 리스닝은 비활성화한다.
이 mount는 테스트 환경 분리이며 제품의 보안 sandbox나 운영 환경 전환을 뜻하지 않는다.
명시 DISPLAY는 연결을 검사하고 사용한다. 사용자 화면을 임의 탐색하거나 실행 중인 Xserver를 종료하지 않는다.

## 개발 명령

| 명령 | 범위·사전 조건 |
|---|---|
| `npm ci` | 서버/대시보드 개발 의존성 설치. Electron 패키지는 있지만 바이너리는 자동 다운로드하지 않음 |
| `npm run build:backend` | 서버·CLI·계약/fixture 빌드 |
| `npm run build:dashboard` | 브라우저 대시보드 빌드 |
| `npm run test:unit -- <파일>` | 빠른 단위 검사. 전체 backend의 대체가 아님 |
| `npm run test:integration -- <파일>` | GUI를 제외한 통합 검사. dist를 사용하는 검사는 backend 빌드 선행 |
| `npm run test:backend` | unit/integration/longitudinal 전체. dist를 사용하는 검사 때문에 빌드 선행 |
| `npm run test:dashboard` | 브라우저 컴포넌트/API/store 검사 |
| `npm test` | 서버·대시보드 빌드 후 backend와 dashboard 전체 검사 |
| `npm run verify` | runtime/lint/typecheck/build/backend/dashboard/고정 clock acceptance/CLI smoke |
| `npm run test:gui` | Electron 명시 설치 + backend 빌드 + 실제 Electron 패키지·notification driver 검사 |
| `npm run test:e2e` | 빌드 + Playwright fixture 브라우저 인수. Chromium 설치 선행 |
| `npm run product:package-electron` | Electron 명시 설치 후 desktop 패키징 |

Linux headless GUI에는 `bubblewrap`, `Xvfb`, `xauth`, `xdpyinfo`가 필요하다. namespace 실행을 허용하는 호스트여야 한다.
기존 DISPLAY 경로는 해당 화면의 접속 권한과 `xdpyinfo`가 필요하다. GUI 시작은 15초, 전체 GUI는 180초로 제한한다.
나머지 실행은 20분 제한이다. Windows/macOS에서 새 실행 경로를 직접 검증한 결과는 아직 없다.
CI는 서버 verify, 실제 GUI, Chromium E2E를 각각 필수 단계로 실행한다. 여기의 CI 변경은 로컬 검증이며 원격 실행 결과는 아니다.
GUI driver의 소스 계약 검사는 `task33-driver-contract.test.ts`로 옮겨 기본 backend 검사에 유지했다.

## 실측 및 검증 범위

- 격리 디렉터리에 manifest/lock만 복사한 offline `npm ci`: 348 packages, 3초, exit 0.
  Electron dist 없음, native SQLite 메모리 DB의 `SELECT 1` 결과 1. 설치 probe 디렉터리 삭제 확인.
- 기존 DISPLAY=:102와 headless 자동 시작에서 실제 패키지/driver 통과. 잘못된 DISPLAY=:9876은
  `TEST_DISPLAY_UNAVAILABLE`, exit 2로 종료하며 다른 화면을 검색하지 않는다.
- `/proc`의 존재하지 않는 경로에 recursive mkdir가 정체하는 사례를 확인했다. 명시 TMPDIR는 stat으로 검사하여
  즉시 `TEST_TMPDIR_UNAVAILABLE`로 종료한다. 이 호스트의 실제 `/tmp` 쓰기는 여전히 errno -122로 실패한다.
- 중첩 bubblewrap로 `/tmp` 실패 환경을 재현하려던 추가 probe는 호스트의 namespace 생성 거부로 종료됐다.
  기본 headless 실행과 private `/tmp`에 remap한 GUI entry 실행은 별도로 검사한다. 제한을 우회하는 fallback은 추가하지 않았다.
- 소유 프로세스의 성공 종료, 시작/전체 시간 초과, 사전 취소, 내부 owner 종료, 최상위 SIGTERM/SIGINT에서
  SIGTERM을 무시하는 별도 그룹의 잔존 여부를 실제 Node 프로세스로 검사한다.
- 최종 관련 회귀 4파일 20개, dashboard 29파일 160개, Chromium E2E 26개(1.2분) 통과.
  GUI source 계약 2개를 backend로 이동한 뒤 실제 GUI 검사는 2파일 2개이며 private `/tmp`와 DISPLAY=:102에서 통과했다.
  최상위 GUI runner 중단 실측: driver/Electron 포함 7프로세스 관측 → SIGTERM → exit 130,
  남은 대상 프로세스 0개, 실행 임시 디렉터리 삭제. 기존 Xserver는 종료하지 않았다.
- 검색된 전체 backend 378파일(unit 152, integration 216, longitudinal 10) + GUI 2파일.
  파일시스템 검사 대상 대비 누락 0개·예상 밖 포함 0개·backend/GUI 중복 0개다.
- typecheck/lint/빌드 및 새 MJS 4파일 구문 검사 exit 0. 전체 verify는 별도 실행 중이며,
  초기 Task32 migration 목록 검사는 당시 기대값 064 이후의 065/066을 포함하지 않아 실패했다.
  전체 gate 통과나 병행 기억 계약 변경의 인수 완료로 보고하지 않는다.
- 증거: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`의 install.json, discovery.json, gui-paths.json,
  gui-interrupt.json, e2e.log, verify.log.
  단위/GUI/전체 verify의 결과를 서로 다른 검증 수준으로 유지한다.
