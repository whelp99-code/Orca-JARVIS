# ADR — 승인된 검증 결과의 Git 커밋 게시

- 날짜: 2026-09-08
- 상태: 구현 결정. 운영 활성화와 기존 브랜치/작업 트리 반영은 별도 범위.
- 근거: 사용자 승인 개발 목표의 TaskSpec→승인→코드 변경→독립 검증→최종 결과 연결.

기존 실행계획 v1의 isolated_candidate는 원본 변경 권한이 아니다. 파일 digest 확인 뒤 rename만으로는 다른 작성자의 변경과 원자적인 조건부 교체를 보장할 수 없다. 여러 파일을 직접 교체하면 중단 때 일부만 반영될 수도 있다.

v2 계획은 verified_git_commit 모드, 새 `refs/heads/codex/<name>` 게시 ref, repository_identity를 서명 대상으로 포함한다. identity는 승인 전에 확인한 root/git-dir/common-dir의 정규 경로와 device/inode에 결합한다. 같은 baseline을 가진 다른 저장소로 .git이 바뀌어도 허용하지 않는다. v1의 의미와 검증은 유지한다. 게시 ref는 생성만 허용하고 기존 ref, 현재 HEAD와 작업 트리는 변경하지 않는다. 작업 산출물은 실제 Git 코드 변경 커밋이며 결과 화면/PR에서 이 커밋을 참조한다. 작업 완료를 현재 브랜치 병합·배포 완료로 표시하지 않는다.

게시 전에 전체 선언 파일의 원본 bytes/mode가 승인된 Git baseline과 일치하는지 확인한다. 특히 검증에 사용한 read 파일이 커밋의 read 파일과 달라지는 것을 거부한다. 새 private index에서 baseline tree에 write 파일의 검증된 bytes만 반영하고 나머지는 보존한다. Git filters/hooks/서명 프로그램과 상속 Git 설정을 끄고 고정 plumbing 명령만 실행한다.

실제 재현에서 ref 부모의 파일시스템 symlink가 다른 저장소에 ref를 만들었다. 따라서 --no-deref만 사용하지 않는다. Git plumbing은 Linux bwrap namespace 안에서 실행하고 Git metadata는 읽기 전용, 고정 FD의 objects·codex ref 디렉터리·private index만 쓰기 가능하게 제공한다. 작업 파일·홈·DB·인증·호스트 네트워크는 제공하지 않는다. 호스트의 ref 디렉터리 준비도 common FD부터 부모/자식을 O_NOFOLLOW로 연결한다. 복구 조회는 쓰기 mount와 private index 생성 없이 동일 서명 identity를 검사한다.

현재 실행 승인, 독립 proof의 전체 PASS, 동일 후보·baseline·게시 ref를 결합한 단일 publication 기록을 먼저 생성한다. Git ref 생성 전 예상 tree/commit을 영속화한다. 새 ref는 Git create CAS로 생성하고 존재하는 ref는 덮어쓰지 않는다. Git ref와 SQLite는 하나의 트랜잭션이 아니므로 응답 유실/중단은 uncertain으로 보존하고 예상 commit과 실제 ref를 대조한다. 관측만으로 재실행 권한을 부여하거나 만료된 승인을 확장하지 않는다.

자동 작업 트리 덮어쓰기·기존 브랜치 fast-forward·merge·push·배포는 이 계획에 포함하지 않는다. 필요 시 별도 명시적 효과/승인/검증으로 연결한다. 전체 작업 목표는 게시된 커밋의 증거 기반 workflow 정산과 사용 UI까지 포함하며 Git 객체 생성만으로 완료 처리하지 않는다.

Git 동작 근거: [update-ref create](https://git-scm.com/docs/git-update-ref), [commit-tree](https://git-scm.com/docs/git-commit-tree), [private index](https://git-scm.com/docs/git-update-index).
