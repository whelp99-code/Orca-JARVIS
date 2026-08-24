# Security boundaries

- Authority DB, signing keys, and receipts stay on the JARVIS side.
- CLI-JAW stores opaque intent IDs only. Remote callbacks cannot approve T3/T4.
- T0–T2 runners never receive secret bytes. T3 credentials redeem once, executor-only.
- Knowledge retrieval is untrusted text and is never executed.
- Channel ingress keys bind channel/account/sender/thread/message/generation/content digest.
