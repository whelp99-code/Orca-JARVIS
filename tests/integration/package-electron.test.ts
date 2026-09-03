import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "package-electron.mjs");

function run(env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function cssDeclarations(block: string): Record<string, string> {
  return Object.fromEntries(block.split(";").map((item) => item.trim()).filter(Boolean).map((item) => {
    const separator = item.indexOf(":");
    return [item.slice(0, separator).trim(), item.slice(separator + 1).trim()];
  }));
}

function cssRule(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css);
  if (match?.[1] === undefined) throw new Error(`missing CSS rule: ${selector}`);
  return cssDeclarations(match[1]);
}

async function unavailableHtml(code: string): Promise<string> {
  const moduleUrl = pathToFileURL(join(process.cwd(), "scripts", "lib", "print-surfaces.mjs")).href;
  const loaded: unknown = await import(moduleUrl);
  if (typeof loaded !== "object" || loaded === null) throw new TypeError("invalid print surfaces module");
  const render: unknown = Reflect.get(loaded, "electronUnavailableHtml");
  if (typeof render !== "function") throw new TypeError("missing unavailable surface renderer");
  const html: unknown = Reflect.apply(render, undefined, [code]);
  if (typeof html !== "string") throw new TypeError("invalid unavailable surface");
  return html;
}

describe("Electron package contract", () => {
  it("renders a self-contained responsive dark operational failure surface", async () => {
    const html = await unavailableHtml("AUTHORITY_42");
    const viewport = /<meta name="viewport" content="([^"]+)">/u.exec(html)?.[1];
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/gu)];
    const css = styles[0]?.[1] ?? "";
    const roots = [...css.matchAll(/:root\s*\{([^}]*)\}/gu)];
    const expectedTokens = {
      "--color-canvas": "#0b0e11",
      "--color-surface": "#11161a",
      "--color-border": "#29323a",
      "--color-text": "#edf2f5",
      "--color-text-muted": "#a3afb8",
      "--color-danger": "#e17f78",
      "--color-focus": "#b1e1eb",
      "--font-sans": '"Avenir Next", Avenir, "Segoe UI", "Noto Sans CJK KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
      "--font-mono": '"SFMono-Regular", Consolas, "Liberation Mono", "Noto Sans Mono CJK KR", monospace',
      "--type-body": "0.9375rem",
      "--type-panel": "1rem",
      "--type-title": "clamp(1.5rem, 2.5vw, 2rem)",
      "--line-tight": "1.2",
      "--line-body": "1.5",
      "--weight-regular": "400",
      "--weight-medium": "600",
      "--space-3": "0.75rem",
      "--space-4": "1rem",
      "--space-6": "1.5rem",
      "--size-reading": "40rem",
      "--border-width": "1px",
      "--radius": "0.25rem",
    };

    expect(html).toMatch(/<html lang="en">/u);
    expect(viewport).toMatch(/width=device-width/u);
    expect(viewport).toMatch(/initial-scale=1/u);
    const body = /<body ([^>]+)>/u.exec(html)?.[1] ?? "";
    expect(body).toContain('data-surface="electron"');
    expect(body).toContain('data-authority-mode="remote-only"');
    expect(body).toContain('data-execution-mode="remote-only"');
    expect(html.match(/<main>/gu)).toHaveLength(1);
    const alerts = [...html.matchAll(/<[^>]+role="alert"[^>]+data-error-code="([^"]+)"[^>]*>/gu)];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.[1]).toBe("AUTHORITY_42");

    for (const unsafe of ["lowercase", "<script>AUTHORITY_42</script>", "A".repeat(65)]) {
      const unsafeHtml = await unavailableHtml(unsafe);
      const alert = /<[^>]+role="alert"[^>]+data-error-code="([^"]+)"[^>]*>/u.exec(unsafeHtml);
      const machineCode = /<code class="authority-code">([^<]*)<\/code>/u.exec(unsafeHtml)?.[1];
      expect(alert?.[1]).toBe("LINUX_AUTHORITY_UNAVAILABLE");
      expect(machineCode).toBe("LINUX_AUTHORITY_UNAVAILABLE");
      expect(unsafeHtml).not.toMatch(/<script(?:\s|>)/iu);
    }

    expect(styles).toHaveLength(1);
    expect(roots).toHaveLength(1);
    expect(cssDeclarations(roots[0]?.[1] ?? "")).toEqual({ "color-scheme": "dark", ...expectedTokens });
    const dashboardCss = readFileSync(join(process.cwd(), "dashboard", "src", "styles.css"), "utf8");
    const dashboardRoot = cssRule(dashboardCss, ":root");
    expect(Object.fromEntries(Object.keys(expectedTokens).map((key) => [key, dashboardRoot[key]]))).toEqual(expectedTokens);

    const implementationCss = css.replace(roots[0]?.[0] ?? "", "");
    expect(implementationCss).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/iu);
    expect(implementationCss).not.toMatch(/-?\d*\.?\d+(?:px|rem)\b/iu);
    expect(cssRule(css, "body")).toMatchObject({
      "min-block-size": "100dvb",
      "overflow-x": "hidden",
      "place-items": "center",
      "font-family": "var(--font-sans)",
    });
    expect(cssRule(css, ".authority-status")).toMatchObject({
      "inline-size": "100%",
      "max-inline-size": "var(--size-reading)",
      "border": "var(--border-width) solid var(--color-border)",
      "border-radius": "var(--radius)",
      "overflow-wrap": "anywhere",
    });
    expect(cssRule(css, ".authority-code")).toMatchObject({
      "color": "var(--color-danger)",
      "font-family": "var(--font-mono)",
      "overflow-wrap": "anywhere",
    });

    expect(html).not.toMatch(/<(?:script|link|img)(?:\s|>)/iu);
    expect(html).not.toMatch(/(?:https?:)?\/\/|css\s*url\s*\(|\shref\s*=|\ssrc\s*=/iu);
  });

  it("pins every locked install script and runs the locked Electron installer before packaging", () => {
    const packageJson: unknown = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const packageLock: unknown = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8"));
    expect(packageJson).toBeTypeOf("object");
    expect(packageLock).toBeTypeOf("object");

    const metadata = packageJson as {
      allowScripts?: Record<string, boolean>;
      scripts?: Record<string, string>;
    };
    const lock = packageLock as {
      packages?: Record<string, { hasInstallScript?: boolean; version?: string }>;
    };
    const lockedInstallers = Object.entries(lock.packages ?? {})
      .filter(([path, entry]) => path.includes("node_modules/") && entry.hasInstallScript === true)
      .map(([path, entry]) => {
        const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
        return `${name}@${entry.version}`;
      })
      .sort();

    expect(lockedInstallers).toEqual([
      "better-sqlite3@12.11.1",
      "esbuild@0.28.2",
      "fsevents@2.3.2",
      "fsevents@2.3.3",
    ]);
    expect(metadata.allowScripts).toEqual(Object.fromEntries(lockedInstallers.map((key) => [key, true])));
    expect(metadata.scripts?.["product:install-electron"]).toBe("install-electron");
    expect(metadata.scripts?.["preproduct:package-electron"]).toBe("npm run product:install-electron");
  });

  it("describes a sandboxed remote-only CLI-JAW shell", () => {
    // Given
    const env = {
      ELECTRON_DESCRIBE: "1",
      JARVIS_AUTHORITY_URL: "https://linux-authority.example.test",
    };

    // When
    const result = run(env);
    const described: unknown = JSON.parse(result.stdout);

    // Then
    expect(result.status).toBe(0);
    expect(described).toMatchObject({
      authority_mode: "remote-only",
      authority_url: env.JARVIS_AUTHORITY_URL,
      shell: "cli-jaw",
      client_host: "host:pos:mac-client",
      protocol_scheme: "jarvis",
      electron_version: "44.0.0",
      web_preferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
  });

  it("rejects an invalid explicit Electron resolution", () => {
    // Given
    const env = {
      ELECTRON_BINARY: "/definitely/missing/electron",
      JARVIS_AUTHORITY_URL: "https://linux-authority.example.test",
      JARVIS_PRODUCT_HOME: "/tmp/task-5-invalid-electron",
    };

    // When
    const result = run(env);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ELECTRON_BINARY_INVALID");
  });

  it("rejects authority-bearing local runtime configuration", () => {
    // Given
    const env = {
      ELECTRON_DESCRIBE: "1",
      JARVIS_AUTHORITY_URL: "https://linux-authority.example.test",
      JARVIS_RUNTIME_HOME: "/tmp/local-runtime",
    };

    // When
    const result = run(env);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ELECTRON_LOCAL_AUTHORITY_FORBIDDEN");
  });
});
