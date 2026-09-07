# P1-13 관측 실패 격리의 구현 경계

2026-09-08 소스 대조. 상태: 구현 미완료, 전체 supervisor 예외 무시 방식 HOLD.

`GjcRuntimeService.processOnce`는 supervisor 콜백을 await한 뒤 GJC pending intent를
claim한다. 그러나 `cli-gjc-commands.ts`의 실제 콜백은 순수 조회가 아니다.
`LiveSupervisor.cycleWithShadow`는 `drainStructured`로 구조화된 입력을 처리하고,
결과를 stdout/주입 출력기로 전달한 후 `acknowledgeReport`를 기록한다.
따라서 콜백의 모든 예외를 일시적 관측 장애로 취급하면 권한 처리 오류와 불확실한
보고서 확인까지 숨길 수 있다. 기존 요청 재전송/확인 규칙을 우회하는 catch는 도입하지 않는다.

현재 `observeBound`는 `ORCA_CLI_FAILED`를 unknown으로 변환하고 명시적인
JSON/schema/binding JarvisError는 전파한다. 관련 기존 회귀는
`tests/integration/gjc-runtime.test.ts`의 persisted binding 관측 시나리오다.
별도의 재시도 예산·회로 차단·원인 상태는 아직 없다.

추가 주의: `orca.ts`의 defaultRunner는 subprocess 예외를 일괄 ORCA_CLI_FAILED로
변환하고 parsePayload 역시 `ok !== true`를 같은 코드로 바꾼다. 따라서 바깥 catch에서
권한 코드만 제외해도 원래 실패 원인이 보존된다고 가정할 수 없다. 후속 구현은 실제
구조화 오류 계약을 확인해 transport unavailable과 거절/신원/스키마 오류를 구분해야 한다.
이 문서의 근거는 코드 경로이며 실제 권한 거절을 운영 환경에서 발생시킨 결과는 아니다.

필수 후속 작업:

1. 순수 Orca 읽기 경계에서 실패 원인을 보존하고 명시적인 일시적 오류만 격리한다.
2. 읽기 시도에 timeout·재시도 횟수·다음 시도 시각을 두고 incarnation 변경 시 낡은
   회로 상태가 새 binding을 차단하지 않게 한다. 장시간 관측이 runtime lease를 소진하는
   경우에는 dispatch 직전 fencing을 그대로 유지한다.
3. 관측 건강 상태와 coordinator 실행 상태를 별도 저장·노출한다. 한쪽 성공이 다른
   쪽 오류를 지우지 않아야 한다. 상태 조회 자체는 쓰지 않는다.
4. 테스트와 실제 격리 CLI 실행으로 일시적 읽기 실패 중 큐 처리, 제한된 재시도·복구,
   권한/신원/스키마 오류의 coordinator 호출0, 보고서 출력 실패의 무단 ack0,
   lease 상실 후 외부 호출0을 검증한다.

P1-13을 완료 처리하지 않는다. 별도 기억 자동 수집의 원본 차단 전파 HOLD도 유지한다.

## 2026-09-08 읽기 경계 초안 검토

현재 리포 밖 초안의 subprocess 검사는 22개였으나 독립 검토에서 세 결함을 발견했다.
공통 strict JSON 파서의 `__proto__` 키 유실/prototype 변경은 기존 자비스 MCP 경로에서도
재현되어 먼저 수정했다. own data property로 보존하므로 상위 schema의 extra-key 검사가
작동한다. 실제 격리 MCP 자식의 잘못된 초기 응답 2종에서 도구 호출0을 확인했다.

초안의 나머지 두 결함은 미해결이다: 성공 분기 이전의 중복 `ok` 키 검증이 없으며,
execFile timeout만으로는 wrapper 자손이 상속한 파이프의 종료 시간이 제한되지 않는다.
Orca 읽기 경계의 제품 적용은 이 두 결함을 해결한 뒤 진행한다. 이 선행 파서 수정은
관측 재시도·backoff·별도 건강 상태 또는 P1-13 완료를 뜻하지 않는다.
