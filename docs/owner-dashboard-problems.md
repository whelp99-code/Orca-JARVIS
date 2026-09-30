# Owner dashboard problems (2026-09-30)

Source: live loopback `http://127.0.0.1:4173` captures in `/home/jm/.local/state/omonyang/jarvis-dashboard-shots/before-*.png`. Owner is a non-developer, mostly on the phone gateway.

1. Home is a dead English page: `Today` / `Today is unavailable`. The published bundle does not pass a personal runtime. Current source does; it is not what 4173 serves.
2. Phone width crushes the 8-item nav (`한눈에` clipped). Tap targets wrap instead of scrolling.
3. Memory, Approvals, Tasks, Agents, and proposal chrome are English, including buttons (`Search memory`, `Submit signed receipt`).
4. Approvals show raw request ids and a signed-receipt paste box. There was no owner button that signs the staged request.
5. Recent rows use command ids and raw UTC timestamps instead of Korean labels and KST.
6. Phone gateway served only Today, Memory, and Security, and had no `memory.confirm` route (`PHONE_ROUTE_NOT_FOUND`).
7. Connection stays `연결 중` on the published server, so the owner cannot tell live data from a stuck socket.
8. Footer attribution hash wraps into the reading line on a 390px screen.

PR #34 (`purpose-workboard`) is open and `CONFLICTING` with main. It was not merged. Landing it would not by itself give the owner an approval button.

This change adds an owner inbox (`GET /api/v1/owner-inbox`, `POST /api/v1/owner-inbox/decide`) that signs one staged allowlisted request with the server decision key. The phone route requires the existing Tailscale owner session and CSRF. The key is not returned. Bulk approve is not a route. Digest mismatch, expiry, foreign actions, and a missing signer fail closed and are tested in `tests/unit/owner-inbox.test.ts`.
