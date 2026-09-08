# DB 근거의 미전송 정정 취소 의향

기존 취소 의향 계약을 실제 AuthorityDb에 연결한다. 정정 materialization과 같은 transaction에서 본문 없는 원래 delegation/target/scope/tombstone과 envelope/idempotency 메타데이터를 보존한다. 별도 기억 DB를 만들지 않는다. 원문 spool을 읽거나 과거 개인키로 서명을 재생성할 필요가 없도록 한다.

발급은 BEGIN IMMEDIATE 안에서 queued/dispatch_fence=0, attempt 부재, 해당 lane의 비활성 cursor 및 아직 통과하지 않은 sequence, 실제 후보 suppression link와 event, 준비/정정/삭제 chain/request binding을 확인한다. 단순 quarantine만으로 suppression_event_digest를 만들어내지 않는다. 기존 키 registry의 활성 owner Ed25519 키와 유효 기간을 현재 발급 권한으로 사용하고, 과거 키는 원래 delegation 검증에만 사용한다.

새 migration072는 취소 원문 없는 source와 불변 intent를 저장하고, 저장된 intent의 원래 정정에 대한 cursor claim·dispatch transition·attempt를 차단한다. 과거에 철회한 자동 retirement/migration072 시제품과 다른 새 migration이며 lane을 건너뛰거나 accepted_through_sequence를 변경하지 않는다. 출하된 001~071 bytes는 유지한다.

의향은 하나의 정정당 한 번 저장하고 재시작 중복 발급은 같은 bytes를 반환한다. 재접수 TTL이 만료되거나 현재 키가 철회된 의향은 자동 재발급하지 않고 provider 상태와 조정한다. 이미 저장된 원래 source가 없는 과거 queued 요청은 정확한 원 요청을 검증해 명시적으로 등록해야 하며, 유실된 메타데이터를 추정하지 않는다.

이 단계는 발급/보존/원 요청의 후속 전송 차단이다. provider 취소 전송·처분 결과·로컬 사본 억제·cursor 완료는 후속 인수 전까지 미완료다. 실행·승인 정책의 우회나 자동 취소 route 활성화는 하지 않는다.
