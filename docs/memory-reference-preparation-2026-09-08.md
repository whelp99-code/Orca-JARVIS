# Second Brain 참고 문맥 준비 구현

`prepareMemoryReference`는 검증된 SecondBrainReadAdapter 결과의 원문·출처·세대를
보존하는 bounded JSON을 만든다. 기존 추천 조립기와 frozen MCP를 변경하지 않는다.
항상 untrusted/authority=none이며, 준비 결과를 실제 모델 전달 영수증으로 취급하지 않는다.

설계: [ADR](planning/adr-memory-reference-context.md).
상세 증거/한계: [SB 인수 보고서](../../second-brain-app/MEMORY-REFERENCE-PREPARATION-2026-09-08.md).

- LF/CRLF/CR/tab·text digest 보존, 원문 단위 선택, 중복/상충 출처·세대·만료/가림 검사.
- 최종 canonical JSON 전체 byte 예산 및 명시적 tokenizer 주입. 미설정 tokens=null.
- 최종 관련 회귀 94 passed / 17 files (15.54초), tsc 격리 build·변경 lint 통과.
- 실제 SB MCP search/page/빈 검색 3회, record 1개·본문/출처/세대 일치, 2,843 bytes.
- 독립 모델 gpt-5.6-sol 리뷰의 중복 출처 비교 결함 1건 수정 및 8개 회귀 추가.
  같은 모델의 최종 read-only 재검토는 추가 actionable finding 없음. 검토자가 테스트를
  실행했다고 주장하지 않으며 실행 검증은 구현 작업의 native 결과로 별도 보존한다.

실제 client 전송·로컬 suppression/범위·전송 직전 fence/만료 확인·기존 projection에
결합한 session/compaction receipt는 아직 남는다. 자동 공급·배포·운영 DB 변경 없음.
동시 작업의 dashboard/AGENTS/인계 문서 변경은 이 구현 커밋에 포함하지 않는다.
