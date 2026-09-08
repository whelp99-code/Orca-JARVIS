# 범위 쓰기 요청의 영속 자료 검증 경계

2026-09-09. v4 요청 생성기에 독립 JSON codec을 연결했다. 세컨드브레인에 이미 존재하는 구조·원본 v3·scope/payload/provider/만료/hash 결합을 자비스도 저장·재개 경계에서 검증할 수 있도록 한다. 승인 소비 또는 outbox 등록은 아직 수행하지 않는다.

`parseMemoryScopedWriteRequestJson`은 32,768 bytes 이내의 canonical JSON만 받는다. 중복 키·비정규 JSON·추가 필드·잘못된 provider·원본/준비값 불일치·외부 해시만 다시 계산한 변조를 거부한다. 별도 JSON 파싱 결과를 깊게 freeze해 반환한다. 현재 정책과 승인 증거의 유효성을 이 codec으로 대체할 수 없다.

생성기 `prepareMemoryScopedWriteRequest`도 반환 전에 이 검사를 실행한다. 기존 승인 검토·정책·원본 권한 재검사와 DB 불변성은 유지한다. 공개 자료형을 명시했다. 처음에는 생성기 ReturnType을 codec이 역참조해 TS7023/TS7024가 발생했으며 명시 자료형으로 해소했다. control-character regex의 lint 오류는 코드포인트 검사로 수정했다.

검증: Vitest codec13 + scope integration5 = 18 passed, 최종 backend 타입 검사·변경 파일 ESLint·격리 outDir emit 통과. 실제 v3 한국어 다중 행 spool→승인 검토→현재 파일 정책→v4 생성 경로가 새 검사를 통과하고 DB 행 수가 유지됨을 확인했다. SB codec29통과. 별도 컴파일 Node/Python 프로세스 대조13건(정상1/거부12)에서 판정·정상 canonical bytes 일치. 전체 JARVIS/운영 CLI/실제 모델 인수를 실행한 것은 아니다.

기존 memory_outbox는 dispatch control redemption과 원본 요청 재구성에 결합돼 있다. scope review 영수증을 기존 dispatch 또는 memory_confirmation으로 위장하거나 candidate UNIQUE를 완화하는 접근은 보류한다. 이후 기존 outbox와 명시적 v4 자료 저장·승인 단일 소비를 원자적으로 연결하고, provider의 실제 권한 확인·공개 계약·영수증 소비를 완성해야 한다. 새 승인 엔진·운영 DB migration·서비스 재시작은 이번 변경에 없다.
