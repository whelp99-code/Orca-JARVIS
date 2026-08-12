# 폐기됨: Buzz Collaboration Workspace 통합안

이 문서는 2026-08-12 컨셉 교정으로 폐기됐다.

JARVIS 안에 별도 Room·Identity·Membership·Message Store·Buzz Bridge를 만드는 방향은 제품 경계를 벗어난다. Migration `025_collaboration_workspace.sql`은 운영 이력 보존을 위해 수정하지 않지만, migration `026_task_timeline.sql`부터 신규 쓰기가 차단된다.

현재 정본 문서:

- [TASK_TIMELINE_KO.md](TASK_TIMELINE_KO.md)

Buzz에서 유지한 아이디어는 **기존 JARVIS 작업·승인·Agent·검증 기록을 하나의 읽기 전용 Task Timeline으로 보여주는 UX**뿐이다.
