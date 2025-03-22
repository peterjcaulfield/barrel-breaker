import { Project } from 'ts-morph';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';

/**
 * Determines whether the given source file is a "pure" barrel file.
 * A pure barrel file is defined as a file that contains at least one export declaration,
 * and every statement in the file is an export declaration with a module specifier.
 *
 * @param {import("ts-morph").SourceFile} sourceFile - The ts-morph source file to check.
 * @returns {boolean} - True if the file is a pure barrel file; otherwise, false.
 */
function isPureBarrelFile(sourceFile) {
  const statements = sourceFile.getStatements();
  if (statements.length === 0) return false;
  return statements.every(stmt => {
    if (stmt.getKindName() === "ExportDeclaration") {
      return !!stmt.getModuleSpecifierValue();
    }
    return false;
  });
}

/**
 * Scans a directory recursively for barrel files and purges them.
 * If a barrel file only contains re-exports (a pure barrel), it is deleted.
 * If the file contains its own code in addition to re-exports, a warning is logged.
 * If the --dry-run flag is passed, the file paths are only logged.
 *
 * @param {string} directory - The directory to scan.
 * @param {boolean} dryRun - If true, only log the actions rather than deleting files.
 */
export function purgeBarrels(directory, dryRun) {
  const cwd = process.cwd();
  console.log(chalk.bold.blue(`Scanning directory: ${path.relative(cwd, directory)}`));
  // Create a new ts-morph Project (for analysis only).
  const project = new Project();
  // Add all .ts, .tsx, .js, and .jsx files recursively.
  const sourceFiles = project.addSourceFilesAtPaths(path.join(directory, '**/*.{ts,tsx,js,jsx}'));
  const pureBarrelFiles = [];
  const impureBarrelFiles = [];

  sourceFiles.forEach(sourceFile => {
    const exportDecls = sourceFile.getExportDeclarations();
    if (exportDecls.length > 0) {
      if (isPureBarrelFile(sourceFile)) {
        pureBarrelFiles.push(sourceFile);
      } else {
        impureBarrelFiles.push(sourceFile);
      }
    }
  });

  console.log(chalk.green(`Found ${pureBarrelFiles.length} pure barrel file(s).`));
  console.log(chalk.yellow(`Found ${impureBarrelFiles.length} impure barrel file(s) (containing additional code).`));

  if (dryRun) {
    console.log(chalk.blue("Dry run: The following pure barrel files would be deleted:"));
    pureBarrelFiles.forEach(file => {
      console.log(path.relative(cwd, file.getFilePath()));
    });
    impureBarrelFiles.forEach(file => {
      console.warn(chalk.red(`Warning: Cannot delete impure barrel file: ${path.relative(cwd, file.getFilePath())}`));
    });
  } else {
    pureBarrelFiles.forEach(file => {
      const filePath = file.getFilePath();
      fs.unlinkSync(filePath);
      console.log(chalk.green(`Deleted: ${path.relative(cwd, filePath)}`));
    });
    impureBarrelFiles.forEach(file => {
      console.warn(chalk.red(`Warning: Skipped impure barrel file: ${path.relative(cwd, file.getFilePath())}`));
    });
  }
}
