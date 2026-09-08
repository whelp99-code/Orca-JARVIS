# 대시보드 정책의 시작 시 고정

상태: 구현·격리 실행 검증 완료. Memory 화면 인수에서 발견한 cwd 의존 서버 종료를 수정했다.

기본 정책은 실행 모듈에 상대적인 빌드 자산으로 로딩한다. backend copy 단계에서 정본
config/personal-os-policy.json을 출력 src/personal-os-policy.json으로 복사하여 기존 src artifact
manifest와 원자적 게시 범위에 넣는다. source TypeScript 실행은 정본 ../config 경로를 사용한다.
cwd나 부모 디렉터리 탐색으로 대체 정책을 선택하지 않는다. 호스트가 지정한 명시적 정책 경로는
절대 경로만 받으며 CLI --policy는 입력 경로를 시작 위치 기준으로 한번 resolve한다.

createDashboardServer는 기본 remote approval 서비스를 요청마다 만들지 않고 시작 시 한 번
구성한다. 잘못된/누락된 정책은 소켓·event observer 생성 전에 정규화된 시작 오류로 거부한다.
startDashboardCli도 정책 검증을 memory transport/spool 준비 전에 수행하고 실패 시 DB를 닫는다.
구성 이후 파일·환경 변경은 실행 중 서비스에 자동 반영되지 않는다. 반영에는 명시적 재시작이 필요하다.

기존 signer가 봉인된 key와 맞지 않으면 원격 승인 미준비라는 기존 경계를 유지한다. 이번 수정은
새 signer/ingress 권한이나 원격 승인 운영 활성화가 아니다. memory 정본/MCP/migration 변경은 없다.

검증: 다른 cwd의 source 및 compiled 실행, 명시적 경로, 누락/잘못된 정책의 시작 실패,
서비스 한번 구성·시작 후 정책파일 변경에도 기존 요청 정상 처리, 원격 승인 fail-closed 회귀,
격리 build에서 실제 HTTP/CLI 요청과 종료 확인.

결과: 수정 전 3개 실패를 재현했다. 관련 회귀 4파일 14개, build 게시 회귀 10개가 통과했다.
정규 backend build의 artifact manifest에 정책 자산이 포함됐고, 잘못된 cwd 정책이 있는
별도 디렉터리에서 실제 서버/CLI 실행·HTTP 200·정상 종료를 확인했다. 누락/잘못된 명시적
정책은 listen 전에 거부했고, CLI 누락 정책은 주소 출력 없이 exit 2로 종료했다.

정책 읽기는 일반 파일·256KiB 상한·최종 경로 symlink 거부·읽기 전후 metadata 비교를 적용한다.
metadata 비교는 동시 변경의 최선 노력 탐지이며 공격적 writer에 대한 원자적 snapshot 보장은
아니다. O_NOFOLLOW는 최종 경로 요소에 적용되며 부모 디렉터리 symlink까지 차단하지 않는다.
운영자는 배포 자산과 명시적 정책 경로의 소유권을 관리해야 한다. 독립 검토에서 차단 지적은 없었다.
