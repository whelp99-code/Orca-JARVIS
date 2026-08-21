import { cp, mkdir, rm } from "node:fs/promises";
await rm("dist/migrations", { recursive: true, force: true });
await mkdir("dist/migrations", { recursive: true });
await cp("migrations", "dist/migrations", { recursive: true });
