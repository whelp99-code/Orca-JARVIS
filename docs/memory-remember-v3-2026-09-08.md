# 일반 여러 줄 기억 — 명시적 V3 계약

Second Brain 기반 공통 기억의 일반 Enter 입력을 연결했다. 새 후보는 입력 schema2 + `body_profile: plain-text-v1`, review schema2, dispatch/provider schema3을 사용한다. Control Plane의 digest 기반 spool command는 기존 schema2이며 correction 전용 args schema3로 보내지 않는다.

본문의 LF·CRLF·CR·탭·가장자리 공백을 원문 그대로 검토/승인/digest/CAS/재조회에 연결한다. NFC·Unicode scalar, 원문 4096바이트, 인용 이스케이프 후 1~64개 record·각 4096바이트 검사를 후보와 요청에서 동일 적용한다. 제목·ID와 기존 V1 검증은 그대로다.

새 입력 프로필을 재분류해 같은 원문·출처를 다른 후보로 중복 저장하는 경로를 차단했다. 기존 승인·spool·pending을 전송 시 변환하지 않으며, 불확실한 전송은 기존 observation/control 복구를 사용한다. migration066은 publication의 remember1/3·correction2를 명시하고 기존 행/FK/immutable trigger를 보존한다.

새 transport는 `contractProfile: "remember-schema5"` 또는 명시적 환경변수로 선택한다.

```bash
JARVIS_SECOND_BRAIN_CONTRACT_PROFILE=remember-schema5
```

미설정은 기존 schema4. 빈 값/알 수 없는 값과 구형 profile의 V3 요청은 자식 프로세스 실행 전에 거부한다. 옵션이 환경변수보다 우선하며 선택한 계약/hash는 transport 생성 시 고정한다. 읽기 adapter의 `schema4`는 record/fence의 논리 형식으로 재사용한다. MCP 계약 schema5와 다른 계층의 이름이며 읽기 필드가 완화된 것이 아니다.

새 `contracts/second-brain-mcp-v3.json`은 별도 fixture다. 기존 schema4 bytes/hash는 유지한다. 실제 Python의 schema5 tools/list를 fixture로 검사하고 다른 profile·body_profile 변조를 거부한다. 64개 완료 관측은 기존 `record-set-v1` 예산을 사용한다. 기존 UI는 원문과 `white-space: pre-wrap`을 사용해 별도 변경 없이 여러 줄을 표시한다.

최종 빌드 기준은 커밋 `24de897ebb0244d0fb96ae7310f53d8733ebbcde`와 이 단위 소유 파일 38개를 격리 병합한 소스다. Backend build·대상 lint 통과. 관련 결합 검사 245개 통과/기존 만료 경계 검사 1개 5초 timeout. 같은 설정으로 동시 SB 전체 검사 종료 후 해당 검사만 재실행하여 1개 통과(4.955초)를 확인했다. 원 실행을 전체 통과로 표기하지 않는다. 로그 `/var/tmp/jarvis-remember-v3-final-tests.log`, `/var/tmp/jarvis-remember-v3-final-timeout-after-sb.log`.

후속 `d6cfdd1`의 제품 소스 변경 없는 migration 호환 검사 갱신도 격리 경로에 반영해 3개 파일 15개 통과를 확인했다. `/var/tmp/jarvis-remember-v3-latest-migration-verified.log`.

실제 별도 Python MCP·자비스 CLI에서 혼합 줄바꿈 4개 및 일반 LF sensitive 64개 record가 candidate intake→승인→provider proved→outbox settled→control completed→두 클라이언트 재조회에 성공했다. 환경변수 선택, dashboard stored=true, 삭제 후 과거/무서명 fence 거부, rollback 복구, 컴파일 중 조회, 재전송 추가 dispatch 0과 원문 정리를 검사했다. 합성 owner 서명·임시 DB/vault이며 실제 운영자/에이전트 앱 인수는 아니다.

상세 provider 변경·원장 복구·검사·재현 명령은 [Second Brain V3 인수 보고서](../../second-brain-app/REMEMBER-V3-ACCEPTANCE-2026-09-08.md)를 따른다. 운영 DB migration·서비스 전환·push는 수행하지 않았다. V3 pending이 있는 DB를 구형 provider로 실행하는 rollback은 지원 완료로 보고하지 않는다. 실제 앱별 공급·범위·context pack·운영 복원은 별도 완료 조건으로 유지한다.
