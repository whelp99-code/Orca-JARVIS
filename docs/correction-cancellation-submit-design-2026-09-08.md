# DB 의향의 명시적 provider 접수

Second Brain cancellation-submit-schema7의 sb_submit_cancellation을 기존 stdio transport에 연결한다. 접수는 write queue를 사용하고 응답 유실은 uncertain이며 자동 read retry를 적용하지 않는다. schema4/5/6과 기본 선택은 유지한다.

submitDatabaseCorrectionCancellation은 기존 DB issuer에서 불변 의향을 얻고, handshake/queue 대기 후 stdin 발행 직전 beforeSend에서 현재 DB 키·시각·미전송 상태를 다시 검증한다. 거부하면 의향은 보존하고 전송을 중단한다. provider의 현재 취소 목적 공개키·철회 상태는 접수 잠금 내부에서 다시 확인된다.

응답은 원 의향·provider·원 요청·삭제 sequence/root·접수 시각이 일치한 suppression_pending만 허용한다. unsigned 접수 응답은 삭제 결과나 cursor 완료의 근거가 아니다. 정확한 서명 결과·JARVIS 로컬 억제 증거를 연결하기 전에는 seq1 완료/seq2 진행을 하지 않는다.

실제 프로세스 인수 기록은 Second Brain의 CANCELLATION-SUBMISSION-ACCEPTANCE-2026-09-08.md를 따른다. 별도 fixture clock/target을 이용하며 운영 config와 DB, dist, 서비스는 변경하지 않는다.
