# Provider-local 취소 결과 검증

제품 `cabfba2`, provider 제품 SB `44ab911`.
상세 인수: [SB 결과 인수 보고서](../../second-brain-app/CANCELLATION-RESULT-ACCEPTANCE-2026-09-08.md).

`requireCorrectionCancellationResult`는 exact 취소 intent를 기준으로 provider 서명/결과 digest,
원 request/envelope/lane/target/scope/세대/tombstone/시각을 검증한다. 반환 상태는
provider_local_suppressed이며 전체 native erasure 또는 자비스 cursor 완료가 아니다.
서명 키는 명시적인 provider_keys map에서 제공한다. 의향 서명 키를 자동 재사용하지 않는다.

실제 SB 실행에서 생성한 공통 vector는 contracts/cancellation-result-v1.json이다.
관련 5파일 38 tests passed, backend typecheck/변경 파일 ESLint/격리 TS emit 통과.
실제 Python 결과 저장 후 exit77→새프로세스 동일 결과 재생, 실제 Node와 Python에서 정상 및
재서명 변조 13입력의 수락/거부 일치. 결과 2,785 bytes, 실제 Node PID3918746.

외부 MCP 취소/결과 조회, 실제 DB snapshot의 unsent 의향 발급, 전송 경합, 로컬 suppression
증거를 포함한 cursor 완료, 취소seq1 뒤 정상V2seq2 연결은 아직 구현하지 않았다.
이 validator를 통과했다는 이유만으로 현재 차단된 lane을 건너뛰거나 전체 삭제 완료를 표시하지 않는다.
운영 dist/DB/서비스/배포는 변경하지 않았고 shipped migration도 변경하지 않았다.
