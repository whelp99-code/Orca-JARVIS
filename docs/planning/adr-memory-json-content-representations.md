# 삭제된 기억의 JSON 저장 표현 검사

상태: 구현·격리 검증 완료, native 제품 연결·운영 배포 미완료. 기존 관리형 삭제·재유입 검사의 국소 보강이다.

native 세션 인수에서 provider 삭제 후 rollout JSONL 및 thread_history SQLite에 기억이
남았다. 기존 외부 파일 삭제는 원문 바이트만 찾으며 영구 forbidden identity도 원문에서만
만든다. 줄바꿈·따옴표·역슬래시를 JSON 문자열로 저장하면 두 검사 모두 누락할 수 있다.

공통 내부 함수로 비어 있지 않은 원문과, 유효한 UTF-8 원문의 JSON 문자열 내부 표현을
1회 및 2회 이스케이프한 바이트를 만든다. 외부 JSON 따옴표는 포함하지 않아 객체·배열·중첩
문자열 안에서도 찾는다. 중복 표현은 제거한다. 잘못된 UTF-8은 대체 문자로 변환하지 않고
원문만 검사한다. 깊이는 2로 고정하며 임의 코덱 추측·재귀 디코딩은 도입하지 않는다.

material 최대 100,000개, 원문 합계와 생성한 두 단계 Buffer의 누적 byte 합계 최대 64 MiB를
검사한다. 초과하면 해당 할당/consumer 실행 전에 MEMORY_CONTENT_REPRESENTATION_LIMIT로 거부한다.
이 상한은 프로세스 RSS나 파일 scanner의 읽기 크기 상한이 아니다. 큰 purge는 완료로 처리하지
않고 reconciling에 남으므로 별도 분할/운영 복구가 필요하다. 자동 축약·검사 생략은 하지 않는다.
JSON 이스케이프는 UTF-8 Buffer의 ASCII 제어 바이트를 직접 변환해 추가 평문 JS 문자열을
만들지 않는다. 생성 Buffer는 동기 callback의 성공·오류 및 생성 도중 오류에 finally로 0을
채우며 caller 원문은 건드리지 않는다. allocator/crypto/OS의 전체 메모리 소거 증명은 아니다.

기존 관리형 파일 제거/확인과 새 forbidden identity 생성이 같은 표현을 사용한다.
원문 identity 계산과 기존 DB 스키마는 유지한다. 재시작 이후 검사는 기존 SHA-256 window와
rolling hash를 이용하며 원문 또는 이스케이프 평문을 DB에 추가 저장하지 않는다.
window 일치는 보수적 거부 신호이며 원문 전체의 동일성 증명이 아니다.
fresh-authority 초기 검사는 기존 원문 검사이며, 새 파일로 교체한 뒤 실행하는 전체 scanner가
확장 identity를 읽어 물리 바이트를 검사한다. 초기 검사만으로 모든 표현을 검증했다고 보지 않는다.

이미 삭제되어 원문이 없는 과거 identity에서 새로운 표현을 복구할 수 없다. 이 변경 이후
원문을 전달받는 purge부터 확장되며 과거 purge 일괄 보강 완료로 보고하지 않는다.
JSON의 모든 동등한 직렬화(예: 비ASCII unicode escape), 3중 이상, 압축·암호화·SQLite
overflow-page 분절은 이번 표현 집합의 보장 범위가 아니다.

native root 소유권·출처 연결·외부 writer 종료·열린 FD·백업/복원의 제품 연결은 별도 미완료다.
이 함수로 현재 사용자 Codex 홈을 자동 삭제하거나 native 자동 주입을 활성화하지 않는다.
기존 파일 traversal의 경합·읽기 크기 제한도 별도 문제로 유지한다.

검증: 수정 전 중첩 JSON/SQLite 실패 재현, 수정 후 raw·1중·2중 삭제 및 재시작 후 재유입
거부, 잘못된 UTF-8과 무관한 내용 보존, 기존 compactor/inventory 회귀, 격리 빌드 실사용.

결과: 수정 전 3 failed, 관련8파일35 passed, 최종 thenable 거부 추가 후3파일10 passed.
backend tsc/격리 emit/변경lint 통과. 생성 buffer의 성공/예외 소거와 caller 원문 보존,
과대 입력/확장 거부를 검사했다. 독립 검토의 세 지적 및 동기 callback 제한을 반영했다.
실제5개별 Node 프로세스에서 영구지문 저장·재시작 검사·중첩SQLite 재유입 거부를 확인했다.
삭제에는 원문을 다시 전달하며 지문만으로 삭제하는 경로는 아니다. 자세한 인수 및 후속 목록:
`/home/jm/orca/projects/second-brain-app/JSON-RETENTION-ACCEPTANCE-2026-09-08.md`.
