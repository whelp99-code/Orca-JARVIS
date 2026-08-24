#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, command: "rehearse-migration", cutover: "blocked_pending_owner" }) + "\n");
