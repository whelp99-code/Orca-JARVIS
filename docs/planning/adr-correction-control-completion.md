# V2 정정 완료 증거의 control 상태 복구

2026-09-08. 기존 correction 원장과 control 승인·효과 원장을 연결한다. 새 승인 또는 provider 전송 권한은 만들지 않는다.

발견: correction settled commit 후 control commit 실패/종료, lease 만료, compaction 후 이전 시각 재사용, settled 요청의 주기 조회 누락. compaction은 원 control target/args를 마스킹하므로 정상 완료도 단순 원 command 재검증에 실패할 수 있다.

변경: 전송 전 기존 schema3 명령의 원문 없는 target/args(후보 ID와 digest, lane/provider ID, 만료)를 immutable binding에 보존한다. 나머지 원 control 열과 재구성한 command digest를 기존 서명 receipt·redemption의 원 fence/전송 시각에 대조한다. 지워진 원문과 control target/args는 복원하지 않는다. provider proof와 동일 correction의 compaction receipt/원장/이벤트를 검증한 뒤 control effect·상태·event·preparation을 한 immediate transaction으로 갱신한다.

주기 복구는 cursor로 bounded 순환한다. 취소/철회·다른 fence·손상/누락 증거는 완료로 승격하지 않는다. callback 이후 실제 clock을 재조회한다. 예전 settled+마스킹 상태에서 binding도 없는 행은 추론으로 복구하지 않고 오류로 남긴다. provider 재전송과 approval TTL 갱신은 없다. 명령 완료 투영을 복구해도 삭제된 개인정보 화면을 다시 노출하지 않는다.

검증 계획은 전송 1회, compaction 뒤 정상 완료, lease 만료·uncertain, 최종 event 실패/rollback 재개, 다른 lane purge·proof/receipt 변조·철회, 순환 공정성 및 실제 SB 정정 proved→두 클라이언트 회수까지 수행한다. 운영 DB migration/서비스 배포는 이 소스 단위에 포함하지 않는다.


구현 검증: 새 회귀 11개 포함 관련 34개/9파일 통과(50.15초), backend build·변경 lint 통과. 후속 `60ee750`과 병합한 격리 소스에서 핵심 24개/4파일 통과(42.49초). 두 실행은 중복이다. 독립 Reviewer가 local recovery 선행/cursor rollback 누락을 지적했고 수정 후 추가 blocker 없음으로 재검토했다.

SB 실제 하네스 `../second-brain-app/scripts/jarvis-correction-acceptance.mjs <isolated-jarvis-root> --control-cycle`: 합성 owner 승인→실제 correction dispatch→provider proved→DB compaction→최종 event 실패→20분 뒤 provider 추가 관측 없이 completed. 전송/compaction 각 1회, 두 MCP 클라이언트가 같은 정정 문장 4개 회수, 이전 기억 0개. 상세 보고서는 `../second-brain-app/CORRECTION-CONTROL-COMPLETION-2026-09-08.md`.

다중 행 복구의 공정성은 cursor 순서로 구현했지만 이번 회귀는 단일 행의 재개/실패 경계를 검사했다. 다른 lane의 정상 purge 영수증을 바꿔 끼우는 별도 fixture도 미수행이다(동일 lane digest 재구성과 변조 purge digest 거부는 검사). 이 둘과 전체 canonical verify·정정 UI·운영 migration/release 인수는 추가 범위로 남긴다.
