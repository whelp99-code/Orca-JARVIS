import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Inspect emitted static ESM edges: type-only imports, dynamic imports and external
// packages do not participate. This is an architecture check, not a call graph.
const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../src", import.meta.url)));
function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path)
      : entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(path) && !/\.d\.(ts|mts|cts)$/.test(path) ? [path] : [];
  });
}
try {
  const files = filesUnder(root).sort();
  if (!files.length) throw new Error("NO_SOURCE_MODULES");
  const names = new Set(files);
  const edges = new Map();
  for (const file of files) {
    const emitted = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext,
        verbatimModuleSyntax: true, jsx: ts.JsxEmit.Preserve },
    }).outputText;
    const ast = ts.createSourceFile(`${file}.js`, emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const targets = new Set();
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
      const path = resolve(dirname(file), specifier.text);
      const target = [path, path.replace(/\.js$/, ".ts"), path.replace(/\.js$/, ".tsx"),
        path.replace(/\.mjs$/, ".mts"), path.replace(/\.cjs$/, ".cts")].find(candidate => names.has(candidate));
      if (target) targets.add(target);
    }
    edges.set(file, [...targets].sort());
  }
  const visited = new Set(), active = new Set(), stack = [], cycles = [];
  function visit(file) {
    if (active.has(file)) {
      cycles.push([...stack.slice(stack.indexOf(file)), file].map(path => relative(root, path)));
      return;
    }
    if (visited.has(file)) return;
    visited.add(file); active.add(file); stack.push(file);
    for (const target of edges.get(file)) visit(target);
    stack.pop(); active.delete(file);
  }
  for (const file of files) visit(file);
  console.log(JSON.stringify({ ok: cycles.length === 0, scope: "static_internal_esm",
    modules: files.length, edges: [...edges.values()].reduce((sum, targets) => sum + targets.length, 0), cycles }));
  process.exitCode = cycles.length ? 1 : 0;
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: "IMPORT_GRAPH_CHECK_FAILED", message: error.message }));
  process.exitCode = 1;
}
