/* global process */
const entry = process.env.PROGRESS_MODULE_URL;
if (!entry) throw new Error("PROGRESS_MODULE_URL is required");
const { AuthorityDb } = await import(entry);
const [filename, encoded] = process.argv.slice(2);
process.stdout.write("ATTEMPT\n");
const db = new AuthorityDb(filename);
try { const result = db.stageProgressBatch(JSON.parse(encoded)); db.close(); process.stdout.write(`${JSON.stringify({ ok: true, report_id: result.report?.report_id ?? null })}\n`); process.exitCode = 0; }
catch (error) { db.close(); process.stdout.write(`${JSON.stringify({ ok: false, code: error?.code === "PROGRESS_PENDING_REPORT" ? "PROGRESS_PENDING_REPORT" : "PROGRESS_STORAGE_FAILED" })}\n`); process.exitCode = 2; }
