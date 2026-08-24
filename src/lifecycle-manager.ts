import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JarvisError } from "./db.js";
import { buildManifest, type ProductManifest } from "./product-manifest.js";

export type LifecycleHome = {
  readonly root: string;
};

export class LifecycleManager {
  private acceptedWork = false;
  private activeLegacy = false;
  constructor(private readonly home: LifecycleHome) {
    mkdirSync(join(home.root, "releases"), { recursive: true });
    mkdirSync(join(home.root, "data"), { recursive: true });
    mkdirSync(join(home.root, "backups"), { recursive: true });
  }

  requireNode24(): void {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 24) throw new JarvisError("PRODUCT_NODE_TOO_OLD");
  }

  install(version: string, hashes: Record<string, string>, backwardReadable = true): ProductManifest {
    this.requireNode24();
    if (this.activeLegacy) throw new JarvisError("PRODUCT_LEGACY_OWNER");
    const dir = join(this.home.root, "releases", version);
    mkdirSync(dir, { recursive: true });
    const manifest = buildManifest(version, hashes, backwardReadable);
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    writeFileSync(join(this.home.root, "data", "user.txt"), "keep-me");
    this.point("current", version);
    return manifest;
  }

  current(): string {
    return readFileSync(join(this.home.root, "current"), "utf8").trim();
  }

  doctor(): { readonly owner: "jarvis"; readonly version: string; readonly healthy: boolean } {
    const manifest = this.readManifest(this.current());
    if (manifest.owner !== "jarvis") throw new JarvisError("PRODUCT_SPLIT_OWNER");
    return { owner: "jarvis", version: manifest.version, healthy: true };
  }

  update(next: string, hashes: Record<string, string>, backwardReadable = true): void {
    this.drain();
    this.backup();
    this.install(next, hashes, backwardReadable);
    this.acceptedWork = false;
  }

  acceptWork(): void {
    this.acceptedWork = true;
  }

  rollback(target: string): void {
    const currentManifest = this.readManifest(this.current());
    if (this.acceptedWork && !currentManifest.backwardReadable) throw new JarvisError("PRODUCT_ROLLBACK_INCOMPATIBLE");
    this.point("current", target);
  }

  uninstall(): void {
    rmSync(join(this.home.root, "releases"), { recursive: true, force: true });
    rmSync(join(this.home.root, "current"), { force: true });
  }

  userData(): string {
    return readFileSync(join(this.home.root, "data", "user.txt"), "utf8");
  }

  setLegacyOwner(active: boolean): void {
    this.activeLegacy = active;
  }

  private drain(): void {}

  private backup(): void {
    const stamp = `bak-${Date.now()}`;
    const dest = join(this.home.root, "backups", stamp);
    mkdirSync(dest, { recursive: true });
    if (existsSync(join(this.home.root, "data", "user.txt"))) {
      writeFileSync(join(dest, "user.txt"), readFileSync(join(this.home.root, "data", "user.txt")));
    }
  }

  private point(name: string, version: string): void {
    const tmp = join(this.home.root, `${name}.tmp`);
    writeFileSync(tmp, `${version}\n`);
    renameSync(tmp, join(this.home.root, name));
  }

  private readManifest(version: string): ProductManifest {
    const path = join(this.home.root, "releases", version, "manifest.json");
    if (!existsSync(path)) throw new JarvisError("PRODUCT_MANIFEST_MISSING");
    return JSON.parse(readFileSync(path, "utf8")) as ProductManifest;
  }
}
