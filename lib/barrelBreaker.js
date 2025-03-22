/**
 * barrelBreaker
 *
 * CLI tool to rewrite "barrel file" imports by resolving them to their true source modules.
 *
 * ✅ Handles:
 *   - Breaking apart barrel files
 *   - Import aliasing (e.g. `import { X as Y }`)
 *   - Re-export aliasing (e.g. `export { A as B }`)
 *   - Recursive `export * from` barrels
 *   - TypeScript path aliases from tsconfig.json
 *
 * ❌ Does NOT (yet) handle:
 *   - Exporting from runtime-resolved files (dynamic exports)
 *   - Formatting rewritten files (use Prettier externally for now)
 *
 * Algorithm:
 *   1. Parse all files from input path using ts-morph and tsconfig.json
 *   2. For each import declaration:
 *      - If it's a local or aliased import
 *      - If the target module is a barrel file
 *        → resolve the real export locations
 *        → determine if aliasing occurred
 *        → rewrite imports to point to real files with original symbol names
 *   3. Optionally print a diff (dry-run) or overwrite the files (write mode)
 */

import { Project, StructureKind } from "ts-morph";
import path from "path";
import fs from "fs";
import chalk from "chalk";
import { diffLines } from "diff";

/**
 * Entrypoint for CLI.
 * @param {string} inputPath - File or directory to process
 * @param {boolean} isDryRun - Whether to print a diff or write changes
 */
export async function runBarrelBreaker(inputPath, isDryRun, tsconfigPath = "tsconfig.json") {
  const project = new Project({
    tsConfigFilePath: tsconfigPath,
    skipAddingFilesFromTsConfig: false,
  });

  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));
  const paths = tsconfig.compilerOptions?.paths || {};
  const aliasPrefixes = Object.keys(paths).map((p) => p.replace("/*", ""));

  const sourceFiles = collectSourceFiles(project, inputPath);

  sourceFiles.forEach((sourceFile) =>
    rewriteImportsInFile(sourceFile, { project, aliasPrefixes, paths, isDryRun })
  );
}

/**
 * Resolve path input to a list of source files.
 */
function collectSourceFiles(project, inputPath) {
  const resolved = path.resolve(inputPath);
  const stats = fs.statSync(resolved);

  return stats.isFile()
    ? [project.addSourceFileAtPath(resolved)]
    : project.addSourceFilesAtPaths(`${resolved}/**/*.{ts,tsx}`);
}

/**
 * Resolve a path alias from tsconfig.json, or return null.
 */
function resolveAlias(paths, resolvedPath) {
  for (const alias of Object.keys(paths)) {
    const basePaths = paths[alias];
    if (!basePaths) continue;
    const absolute = path.resolve(basePaths[0].replace("/*", ""));
    if (resolvedPath.startsWith(absolute)) {
      return resolvedPath
        .replace(absolute, alias.replace("/*", ""))
        .replace(/\.tsx?$/, "")
        .replace(/\\/g, "/");
    }
  }
  return null;
}

/**
 * Get a relative path from `from` to `to`, normalized and cleaned.
 */
function getRelativePath(from, to) {
  let relativePath = path
    .relative(path.dirname(from), to)
    .replace(/\.tsx?$/, "");
  if (!relativePath.startsWith(".")) {
    relativePath = "./" + relativePath;
  }
  return relativePath.replace(/\\/g, "/");
}

/**
 * Recursively collect re-exported aliases from a barrel file and all its transitive exports.
 */
function getReExportMapRecursive(project, sourceFile, seen = new Set()) {
  const reExportMap = new Map();
  if (seen.has(sourceFile.getFilePath())) return reExportMap;
  seen.add(sourceFile.getFilePath());

  sourceFile.getExportDeclarations().forEach((exportDecl) => {
    const specifier = exportDecl.getModuleSpecifierValue?.();
    let targetSource = exportDecl.getModuleSpecifierSourceFile?.();

    // Fallback: manually resolve the re-exported file if ts-morph can't
    if (!targetSource && specifier) {
      try {
        const resolvedPath = path.resolve(path.dirname(sourceFile.getFilePath()), specifier);
        const fullPath =
          fs.existsSync(`${resolvedPath}.ts`) ? `${resolvedPath}.ts` :
            fs.existsSync(`${resolvedPath}.tsx`) ? `${resolvedPath}.tsx` :
              fs.existsSync(path.join(resolvedPath, "index.ts")) ? path.join(resolvedPath, "index.ts") :
                fs.existsSync(path.join(resolvedPath, "index.tsx")) ? path.join(resolvedPath, "index.tsx") :
                  null;

        if (fullPath) {
          targetSource = project.addSourceFileAtPathIfExists(fullPath);
        }
      } catch (_) { }
    }

    if (!targetSource) return;
    const resolvedPath = targetSource.getFilePath();

    // Handle both named exports and "export * from ..."
    if (exportDecl.isNamespaceExport()) {
      const nestedMap = getReExportMapRecursive(project, targetSource, seen);
      for (const [exportedName, value] of nestedMap.entries()) {
        reExportMap.set(exportedName, value);
      }
    } else {
      exportDecl.getNamedExports().forEach((spec) => {
        const exportedName = spec.getAliasNode()?.getText() || spec.getNameNode().getText();
        const localName = spec.getNameNode().getText();
        reExportMap.set(exportedName, { localName, resolvedPath });
      });
    }
  });

  return reExportMap;
}

/**
 * Rewrites imports in a single file by resolving barrels and applying alias rewrites.
 */
function rewriteImportsInFile(sourceFile, { project, aliasPrefixes, paths, isDryRun }) {
  const importGroups = {};
  const importsToRemove = [];
  const originalImportTexts = [];
  let changed = false;

  sourceFile.getImportDeclarations().forEach((importDecl) => {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();

    const isLocalImport =
      moduleSpecifier.startsWith(".") ||
      aliasPrefixes.some((a) => moduleSpecifier.startsWith(a));
    if (!isLocalImport) return;

    const declarations = importDecl.getModuleSpecifierSourceFile();
    if (!declarations) return;

    const isBarrel = declarations.getExportDeclarations().length > 0;
    if (!isBarrel) return;

    const reExportMap = getReExportMapRecursive(project, declarations);

    const result = processImportDeclaration({
      importDecl,
      declarations,
      sourceFile,
      moduleSpecifier,
      reExportMap,
      aliasPrefixes,
      paths,
    });

    if (result.changed) {
      changed = true;
      importsToRemove.push(importDecl);
      originalImportTexts.push(importDecl.getFullText());

      for (const { specifier, named, defaultImport } of result.rewrittenImports) {
        if (!importGroups[specifier]) {
          importGroups[specifier] = { named: new Map(), default: undefined };
        }

        if (defaultImport) {
          importGroups[specifier].default = defaultImport;
        }

        named.forEach(([name, alias]) => {
          importGroups[specifier].named.set(name, alias);
        });
      }
    }
  });

  importsToRemove.forEach((decl) => decl.remove());

  Object.entries(importGroups).forEach(([specifier, { named, default: def }]) => {
    sourceFile.addImportDeclaration({
      kind: StructureKind.ImportDeclaration,
      moduleSpecifier: specifier,
      namedImports: Array.from(named.entries()).map(([name, alias]) =>
        name === alias ? name : { name, alias }
      ),
      defaultImport: def,
    });
  });

  if (changed) {
    if (isDryRun) {
      printImportDiff(sourceFile, originalImportTexts, importGroups);
    } else {
      sourceFile.saveSync();
      console.log("✅ Updated imports in", sourceFile.getFilePath());
    }
  }
}

/**
 * Processes a single import declaration:
 * - Determines which symbols should be rewritten
 * - Preserves aliases
 * - Returns grouped rewritten imports by resolved path
 */
function processImportDeclaration({
  importDecl,
  declarations,
  sourceFile,
  moduleSpecifier,
  reExportMap,
  aliasPrefixes,
  paths,
}) {
  const rewrittenBySpecifier = new Map();
  const keptNamed = [];
  let changed = false;

  const defaultImport = importDecl.getDefaultImport()?.getText();
  if (defaultImport) {
    const defaultDecl = declarations.getDefaultExportSymbol()?.getDeclarations()?.[0];
    if (defaultDecl) {
      const resolvedFile = defaultDecl.getSourceFile().getFilePath();
      const resolved = resolveAlias(paths, resolvedFile) || getRelativePath(sourceFile.getFilePath(), resolvedFile);
      if (resolved !== moduleSpecifier) {
        rewrittenBySpecifier.set(resolved, {
          named: [],
          defaultImport,
        });
        changed = true;
      }
    }
  }

  importDecl.getNamedImports().forEach((namedImport) => {
    const name = namedImport.getName();
    const alias = namedImport.getAliasNode()?.getText();
    const usedName = alias || name;

    const decls = declarations.getExportedDeclarations().get(name);
    if (!decls?.[0]) {
      keptNamed.push({ name, alias });
      return;
    }

    const resolvedFile = decls[0].getSourceFile().getFilePath();
    const resolved =
      resolveAlias(paths, resolvedFile) || getRelativePath(sourceFile.getFilePath(), resolvedFile);

    let originalExportName = name;
    const reExport = reExportMap.get(name);
    if (reExport && reExport.resolvedPath === resolvedFile) {
      originalExportName = reExport.localName;
    }

    if (resolved !== moduleSpecifier) {
      if (!rewrittenBySpecifier.has(resolved)) {
        rewrittenBySpecifier.set(resolved, { named: [], defaultImport: undefined });
      }
      rewrittenBySpecifier.get(resolved).named.push([originalExportName, usedName]);
      changed = true;
    } else {
      keptNamed.push({ name, alias });
    }
  });

  if (changed) {
    if (keptNamed.length > 0) {
      importDecl.getSourceFile().addImportDeclaration({
        kind: StructureKind.ImportDeclaration,
        moduleSpecifier,
        namedImports: keptNamed.map(({ name, alias }) =>
          alias ? { name, alias } : name
        ),
      });
    }

    const rewrittenImports = Array.from(rewrittenBySpecifier.entries()).map(
      ([specifier, { named, defaultImport }]) => ({
        specifier,
        named,
        defaultImport,
      })
    );

    return { changed: true, rewrittenImports };
  }

  return { changed: false, rewrittenImports: [] };
}

/**
 * Outputs a colored diff of before/after rewritten imports.
 */
function printImportDiff(sourceFile, originalImportTexts, importGroups) {
  const originalImportText = originalImportTexts.join("").trim();
  const updatedImportText = Object.entries(importGroups)
    .map(([specifier, { named, default: def }]) => {
      const parts = [];
      if (def) parts.push(def);
      if (named && named.size > 0) {
        const namedPart = Array.from(named.entries())
          .map(([name, alias]) =>
            name === alias ? name : `${name} as ${alias}`
          )
          .join(", ");
        parts.push(`{ ${namedPart} }`);
      }
      return `import ${parts.join(", ")} from '${specifier}';`;
    })
    .join("\n");

  const diff = diffLines(originalImportText, updatedImportText);
  console.log(`\n${chalk.cyan("File changed:")} ${sourceFile.getFilePath()}`);
  diff.forEach((part) => {
    const color = part.added
      ? chalk.green
      : part.removed
        ? chalk.red
        : chalk.dim;
    const prefix = part.added ? "+" : part.removed ? "-" : " ";
    process.stdout.write(
      part.value
        .split("\n")
        .map((line) => (line ? color(`${prefix} ${line}`) : ""))
        .join("\n") + "\n"
    );
  });
}
