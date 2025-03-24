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
 */

import { Project, StructureKind } from "ts-morph";
import path from "path";
import fs from "fs";
import chalk from "chalk";
import process from 'node:process';
import { diffLines } from "diff";
import pino from "pino";
import cliProgress from "cli-progress";

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT. Cancelling...');
  cancelled = true;
});

/**
 * @typedef {import("ts-morph").Project} Project
 * @typedef {import("ts-morph").SourceFile} SourceFile
 * @typedef {import("ts-morph").ImportDeclaration} ImportDeclaration
 * @typedef {import("ts-morph").StructureKind} StructureKind
 */

/**
 * Global cache to store re-export maps by file path.
 * @type {Map<string, Map<string, {localName: string, resolvedPath: string}>>}
 */
const reExportCache = new Map();

/**
 * Helper function for indentation.
 * @param {string} text
 * @param {number} spaces
 * @returns {string}
 */
function indent(text, spaces) {
  return " ".repeat(spaces) + text;
}

/**
 * Helper to build a string representation for a rewritten import.
 * @param {{defaultImport?: string, named: Array<[string, string]>, specifier: string}} rewritten
 * @returns {string}
 */
function buildImportString(rewritten) {
  const parts = [];
  if (rewritten.defaultImport) parts.push(rewritten.defaultImport);
  if (rewritten.named.length > 0) {
    const namedPart = rewritten.named
      .map(([name, alias]) => (name === alias ? name : `${name} as ${alias}`))
      .join(", ");
    parts.push(`{ ${namedPart} }`);
  }
  return `import ${parts.join(", ")} from '${rewritten.specifier}';`;
}

// Initialize progress bar (drawn on stdout)
const getAnalysisProgress = () =>
  new cliProgress.SingleBar({
    format: 'Analyzing imports |{bar}| {percentage}% || {value}/{total} Files',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
  });

const getWriteProgress = () =>
  new cliProgress.SingleBar({
    format: 'Writing imports   |{bar}| {percentage}% || {value}/{total} Imports',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
  });

let bindingsUpdated = 0;

/**
 * Entrypoint for CLI.
 * @param {string} inputPath - File or directory to process.
 * @param {boolean} isDryRun - Whether to print a diff or write changes.
 * @param {string} [tsconfigPath="tsconfig.json"] - Path to tsconfig.json.
 * @param {boolean} [verbose=false] - Enable verbose logging.
 * @param {boolean} [colorsEnabled=false] - Enable colorized output.
 * @param {RegExp|string} [pattern] - Optional pattern to filter file paths.
 */
export async function runBarrelBreaker(
  inputPath,
  isDryRun,
  tsconfigPath = "tsconfig.json",
  verbose = false,
  summary = false,
  colorsEnabled = false,
  pattern
) {
  // Set chalk's color level based on colorsEnabled flag.
  chalk.level = colorsEnabled ? 3 : 0;

  // Write logger output to stderr so stdout remains free for our progress bar.
  const logger = pino(
    {
      level: verbose ? "debug" : "info",
      transport: {
        target: "pino-pretty",
        options: {
          colorize: colorsEnabled,
          translateTime: false,
          ignore: "pid,hostname,level,time",
        },
      }
    },
    pino.destination(2)
  );

  // --- Initialization Section ---
  logger.debug(chalk.bold.blue("=== Initialization ==="));
  logger.debug(indent(`Input path: ${inputPath}`, 2));
  logger.debug(indent(`tsconfig path: ${tsconfigPath}`, 2));
  const tsconfigDir = path.dirname(tsconfigPath);
  logger.debug(indent(`tsconfig directory: ${tsconfigDir}`, 2));

  let tsconfig;
  if (fs.existsSync(tsconfigPath)) {
    const tsconfigContent = fs.readFileSync(tsconfigPath, "utf-8");
    tsconfig = JSON.parse(tsconfigContent);
  } else {
    console.warn(`Warning: tsconfig.json not found at ${tsconfigPath}. Be sure to pass a path to the tsconfig.json via --tsconfig if you are executing in a Typescript project. Proceeding with default configuration.`);
    tsconfig = { compilerOptions: { paths: {} } };
  }

  const pathsConfig = tsconfig.compilerOptions?.paths || {};
  const aliasPrefixes = Object.keys(pathsConfig).map((p) => p.replace("/*", ""));
  logger.debug(indent(`Alias prefixes: ${JSON.stringify(aliasPrefixes)}`, 2));
  logger.debug(indent(`Paths: ${JSON.stringify(pathsConfig)}`, 2));
  let project;
  if (fs.existsSync(tsconfigPath)) {
    project = new Project({
      tsConfigFilePath: tsconfigPath,
      skipAddingFilesFromTsConfig: false,
    });
  } else {
    console.warn(`Warning: tsconfig.json not found at ${tsconfigPath}. Proceeding with default configuration.`);
    project = new Project();
  }


  let sourceFiles = collectSourceFiles(project, inputPath);
  logger.debug(indent(`Found ${sourceFiles.length} source file(s) to process.`, 2));

  // Filter files by pattern if provided.
  if (pattern) {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    sourceFiles = sourceFiles.filter(file => regex.test(file.getFilePath()));
    logger.debug(indent(`After filtering, ${sourceFiles.length} file(s) match pattern "${regex}".`, 2));
  }

  const totalFiles = sourceFiles.length;
  const analysisProgress = getAnalysisProgress();
  // start the progress bar
  analysisProgress.start(totalFiles, 0);
  // Process files in a for-loop so we can update the progress bar using log-update.
  const writes = sourceFiles.map(file => {
    const change = rewriteImportsInFile(file, {
      project,
      aliasPrefixes,
      paths: pathsConfig,
      isDryRun,
      tsconfigDir,
      verbose,
      logger,
    });
    analysisProgress.increment();
    return change;
  }).filter(_ => _);
  analysisProgress.stop();

  const writeProgress = getWriteProgress();
  if (!isDryRun) {
    writeProgress.start(writes.length, 0);
  }
  writes.forEach(write => {
    write();
    if (!isDryRun) {
      writeProgress.increment();
    }
  })
  if (!isDryRun) {
    writeProgress.stop();
  }

  if (summary) {
    // --- Summary Section ---
    logger.info(chalk.bold.blue("=== Summary ==="));
    logger.info(indent(`Total source files processed: ${totalFiles}`, 2));
    logger.info(indent(`Total import declarations updated: ${writes.length}`, 2));
    logger.info(indent(`Total import symbols updated: ${bindingsUpdated}`, 2));
  }
}

/**
 * Resolve path input to a list of source files.
 * @param {Project} project
 * @param {string} inputPath
 * @returns {SourceFile[]}
 */
function collectSourceFiles(project, inputPath) {
  const resolved = path.resolve(inputPath);
  const stats = fs.statSync(resolved);
  return stats.isFile()
    ? [project.addSourceFileAtPath(resolved)]
    : project.addSourceFilesAtPaths(`${resolved}/**/*.{ts,tsx}`);
}

/**
 * Resolve a path alias from tsconfig.json, given the directory of tsconfig.
 * @param {Record<string, string[]>} paths
 * @param {string} resolvedPath
 * @param {string} tsconfigDir
 * @returns {string|null}
 */
function resolveAlias(paths, resolvedPath, tsconfigDir) {
  for (const alias of Object.keys(paths)) {
    const basePaths = paths[alias];
    if (!basePaths) continue;
    const absolute = path.resolve(tsconfigDir, basePaths[0].replace("/*", ""));
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
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function getRelativePath(from, to) {
  let relativePath = path.relative(path.dirname(from), to).replace(/\.tsx?$/, "");
  if (!relativePath.startsWith(".")) {
    relativePath = "./" + relativePath;
  }
  return relativePath.replace(/\\/g, "/");
}

/**
 * Recursively collect re-exported aliases from a barrel file and all its transitive exports.
 * Uses caching to avoid reprocessing files.
 * @param {Project} project
 * @param {SourceFile} sourceFile
 * @param {Set<string>} [seen]
 * @returns {Map<string, {localName: string, resolvedPath: string}>}
 */
function getReExportMapRecursive(project, sourceFile, seen = new Set()) {
  const filePath = sourceFile.getFilePath();
  if (reExportCache.has(filePath)) {
    return reExportCache.get(filePath);
  }
  const reExportMap = new Map();
  if (seen.has(filePath)) return reExportMap;
  seen.add(filePath);

  sourceFile.getExportDeclarations().forEach((exportDecl) => {
    const specifier = exportDecl.getModuleSpecifierValue?.();
    let targetSource = exportDecl.getModuleSpecifierSourceFile?.();

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
  reExportCache.set(filePath, reExportMap);
  return reExportMap;
}

/**
 * Rewrites imports in a single file by resolving barrels and applying alias rewrites.
 * Returns the number of updates made in this file.
 * @param {SourceFile} sourceFile
 * @param {{ project: Project, aliasPrefixes: string[], paths: Record<string, string[]>, isDryRun: boolean, tsconfigDir: string, verbose: boolean, logger: any }} options
 * @returns {() => void|null}
 */
function rewriteImportsInFile(sourceFile, { project, aliasPrefixes, paths, isDryRun, tsconfigDir, verbose, logger }) {
  let updatesCount = 0;
  let processedBarrelImports = 0;
  const importGroups = {};
  const importsToRemove = [];
  const originalImportTexts = [];
  let changed = false;
  sourceFile.getImportDeclarations().forEach((importDecl) => {
    // this is from path in the original import declaration 
    const moduleSpecifier = importDecl.getModuleSpecifierValue();
    logger.debug(indent(`[IMPORT] ${moduleSpecifier}`, 2));
    logger.debug(indent(chalk.blueBright(`Original import: ${importDecl.getFullText().trim()}`), 2));

    if (!moduleSpecifier.startsWith(".") && !aliasPrefixes.some(prefix => moduleSpecifier.startsWith(prefix))) {
      logger.debug(indent("Detected node module import. Skipping rewriting.", 4));
      return;
    }

    // resolve the actual file that the import points to
    const declarations = importDecl.getModuleSpecifierSourceFile();
    if (!declarations) {
      logger.debug(indent("Could not resolve source file. Skipping rewriting.", 4));
      return;
    }

    // check if this file has re-exports aka whether it's a barrel file
    const isBarrel = declarations.getExportDeclarations().length > 0;
    if (!isBarrel) {
      logger.debug(indent("Import path resolved to a non-barrel file. No update needed.", 4));
      return;
    } else {
      logger.debug(indent("Barrel file detected.", 4));
      processedBarrelImports++;
    }

    // create a map of all exports of the barrel file recursively
    const reExportMap = getReExportMapRecursive(project, declarations);
    // update the current import as needed
    const result = processImportDeclaration({
      importDecl,
      declarations,
      sourceFile,
      moduleSpecifier,
      reExportMap,
      aliasPrefixes,
      paths,
      tsconfigDir,
      isAliasImport: !moduleSpecifier.startsWith(".") && aliasPrefixes.some(prefix => moduleSpecifier.startsWith(prefix)),
      verbose,
      logger,
    });

    if (result.changed) {
      updatesCount++;
      changed = true;
      logger.debug(chalk.bold.yellow(indent(`--> Updating import for '${moduleSpecifier}'`, 4)));
      result.rewrittenImports.forEach((rewritten) => {
        const newImportLine = buildImportString(rewritten);
        logger.debug(chalk.bold.yellow(indent(`New import: ${newImportLine}`, 6)));
      });
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

  if (processedBarrelImports === 0) {
    logger.debug(indent("No barrel imports found in this file.", 2));
  }

  if (changed) {
    return () => {
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
      if (isDryRun) {
        printImportDiff(sourceFile, originalImportTexts, importGroups);
      } else {
        sourceFile.saveSync();
        logger.debug(indent(`Updated imports in ${sourceFile.getFilePath()}`, 2));
      }
    }
  } else {
    logger.debug(indent(`No changes needed for ${sourceFile.getFilePath()}`, 2));
  }
  return null;
}

/**
 * Processes a single import declaration:
 * - Determines which symbols should be rewritten
 * - Preserves aliases
 * - Returns grouped rewritten imports by resolved path
 * @param {Object} options
 * @param {ImportDeclaration} options.importDecl
 * @param {SourceFile} options.declarations
 * @param {SourceFile} options.sourceFile
 * @param {string} options.moduleSpecifier
 * @param {Map<string, {localName: string, resolvedPath: string}>} options.reExportMap
 * @param {string[]} options.aliasPrefixes
 * @param {Record<string, string[]>} options.paths
 * @param {string} options.tsconfigDir
 * @param {boolean} options.isAliasImport
 * @param {boolean} options.verbose
 * @param {any} options.logger
 * @returns {{changed: boolean, rewrittenImports: Array<{specifier: string, named: Array<[string, string]>, defaultImport?: string}>}}
 */
function processImportDeclaration({
  importDecl,
  declarations,
  sourceFile,
  moduleSpecifier,
  reExportMap,
  paths,
  tsconfigDir,
  isAliasImport,
  logger,
}) {
  // A map to allow us to group imports if they are already grouped e.g:
  // import { foo, bar } from 'baz';
  // structure is Map<filepath, { named: string[], defaultImport: string | undefined }>
  const rewrittenBySpecifier = new Map();
  // Remember that a barrel can have both re-exports as well as exports of symbols
  // defined in the barrel file itself!
  // Therefore we need an array to store any named imports that do not require updating
  // in a barrel file as they are defined in the barrel itself.
  // The user will be notified to rewrite this file via the separate purge command.
  const keptNamed = [];
  let changed = false;

  // first handle any default imports
  const defaultImport = importDecl.getDefaultImport()?.getText();
  if (defaultImport) {
    logger.debug(indent(chalk.magenta("[DEFAULT] Found default import."), 4));
    const defaultDecl = declarations.getDefaultExportSymbol()?.getDeclarations()?.[0];
    if (defaultDecl) {
      const resolvedFile = defaultDecl.getSourceFile().getFilePath();
      // resolve where the filepath where the symbol is actually defined
      const resolved = isAliasImport
        // it's using a tsconfig alias 
        ? resolveAlias(paths, resolvedFile, tsconfigDir)
        // otherwise it's using a relative import path
        : getRelativePath(sourceFile.getFilePath(), resolvedFile);
      logger.debug(indent(`Original '${moduleSpecifier}', resolved file '${resolvedFile}', computed import '${resolved}'`, 6));
      if (resolved !== moduleSpecifier) {
        bindingsUpdated++;
        rewrittenBySpecifier.set(resolved, { named: [], defaultImport });
        changed = true;
      }
    }
  }

  // now handle named imports
  importDecl.getNamedImports().forEach((namedImport) => {
    const name = namedImport.getName();
    const alias = namedImport.getAliasNode()?.getText();
    const usedName = alias || name;
    logger.debug(indent(chalk.magenta(`[NAMED] Processing symbol '${name}'${alias ? ` as '${alias}'` : ""}.`), 4));

    // get the declaration of the named import in the barrel file
    const decls = declarations.getExportedDeclarations().get(name);
    if (!decls?.[0]) {
      logger.debug(indent(`Symbol '${name}' not found in exports; leaving as is.`, 6));
      keptNamed.push({ name, alias });
      return;
    }

    const resolvedFile = decls[0].getSourceFile().getFilePath();
    // resolve the filepath where the symbol is actually defined
    const resolved = isAliasImport
      // it's using a tsconfig alias 
      ? resolveAlias(paths, resolvedFile, tsconfigDir)
      // otherwise it's using a relative import path
      : getRelativePath(sourceFile.getFilePath(), resolvedFile);
    logger.debug(indent(`Resolved file: '${resolvedFile}', computed import: '${resolved}'`, 6));

    // the import may be re-exported from some nested barrel file so resolve it in the re-export map if so
    let originalExportName = name;
    const reExport = reExportMap.get(name);
    if (reExport && reExport.resolvedPath === resolvedFile) {
      originalExportName = reExport.localName;
      logger.debug(indent(`Re-export mapping applied: '${name}' becomes '${originalExportName}'`, 6));
    }

    // if the resolved filepath for the symbol is different to the origianl import path declaration rewrite the import
    if (resolved !== moduleSpecifier) {
      if (!rewrittenBySpecifier.has(resolved)) {
        rewrittenBySpecifier.set(resolved, { named: [], defaultImport: undefined });
      }
      rewrittenBySpecifier.get(resolved).named.push([originalExportName, usedName]);
      bindingsUpdated++;
      changed = true;
    } else {
      // resolved matches the original import declaration so add to unchanged import collection
      keptNamed.push({ name, alias });
    }
  });

  if (changed) {
    if (keptNamed.length > 0) {
      sourceFile.addImportDeclaration({
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
 * @param {SourceFile} sourceFile
 * @param {string[]} originalImportTexts
 * @param {Record<string, {named: Map<string, string>, default: string|undefined}>} importGroups
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

  const cwd = process.cwd();
  const diff = diffLines(originalImportText, updatedImportText);
  console.log(`\n${chalk.cyan("\nFile changed:")} ${path.relative(cwd, sourceFile.getFilePath())}`);
  diff.forEach((part) => {
    const color = part.added ? chalk.green : part.removed ? chalk.red : chalk.dim;
    const prefix = part.added ? "+" : part.removed ? "-" : " ";
    process.stdout.write(
      part.value
        .split("\n")
        .map((line) => (line ? color(`${prefix} ${line}`) : ""))
        .join("\n") + "\n"
    );
  });
  process.stdout.write('\n');
}
