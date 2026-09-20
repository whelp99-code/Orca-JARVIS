# J04 HOLD

**Status:** unblocked by Mail M04 (`6a9c26f` on `core5-m01-m04`)  
**Landed:** see [`J04.md`](./J04.md) — JARVIS draft create + GET + card states.  
**Still Mail-owned:** human auth, CSRF, origin, digest, approve, cancel, Graph send.

Do not:

- register `mail.send`
- flip personal-connector `mail.configured` to true
- approve or send from JARVIS
