# Scoped 재조정 lease와 원래 요청 복원

만료된 scoped-v4 쓰기의 원래 binding/attempt/private spool을 대조하여 읽기 확인용 요청을 복원한다. 재조정 lease를 원자적으로 claim/검사/해제하고 dispatch fence는 보존한다. 새 쓰기 권한이나 현재 provider 읽기 권한을 부여하지 않는다.

관련 33개/4파일 통과(27.52초), 격리 TypeScript emit 및 변경 ESLint 통과. 실제 7개 프로세스에서 동시 claim 승자1, fence2→3 회수, stale release 거절, dispatch attempt1/FK0. 실제 stdio MCP 수락 복구와 기록 commit 직후 exit73/재시작에서도 현재 lease 보존을 확인했다. 인증과 provider 내부 쓰기는 fixture이며 운영 인수는 아니다.

영구 완료 증거·scoped settlement/control 원자 완료는 후속 작업이다. legacy receipt 재사용 우회는 보류한다. 운영 DB/설정/서비스는 변경하지 않았다.

[상세 보고서](../../second-brain-app/SCOPED-RECONCILIATION-LEASE-2026-09-09.md), [실제 결과](../../second-brain-app/SCOPED-RECONCILIATION-LEASE-2026-09-09.json).
