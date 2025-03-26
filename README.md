<div align="center">
  <img src="./icon.png" width="75" alt="icon" />
  <h1>Barrel Breaker</h1>
</div>

Barrel Breaker is a CLI tool that helps you eliminate both barrel files and imports in your TypeScript (and JavaScript) codebases.

It rewrites import statements that reference barrel files to point directly to the underlying module file(s). 

```diff
- import { button } from '@components';
+ import { button } from '@components/button';
```

After re-writing imports you can use the purge command to automatically remove barrel files that contain only re‑exports.

## Motivation

Barrel files are handy for defining short concise import paths but can cause problems once your application grows:

- Slower build times
- Treeshaking issues
- Increased risk of circular dependencies
- Inabilty to optimise test execution based on what changed  due to entagled module dependency graph

By the time your application grows to the point where you experience these problems refactoring things to be barrel file free can be
extremely painful to do by hand. That's where barrel breaker comes in.

## Features

- **Named and Default Export Handling:** Will tackle both named and default exports.
- **Type Only Import Handling:** Type-only imports (`import { type MyType...}`) will be translated correctly.
- **Alias & Re-Export Handling:** Supports import aliasing and re-export aliasing so that renamed symbols are handled correctly.
- **Recursive Resolution:** Detects and resolves nested barrel files (using `export * from ...`).
- **Support for Typescript Path Aliases:** Reads your tsconfig.json to honor path aliases.
- **Dry Run Mode:** Preview changes without modifying files.


## Installation
Install the package via npm:

```bash
npm install -g barrel-breaker
```
Or add it to your project:

```bash
npm install --save-dev barrel-breaker
```

## Usage

Barrel Breaker can be run via the command line.

### Rewriting Imports


```
Usage: brl [options] [command] <path>

Rewrite barrel imports and purge barrel files.

Arguments:
  path                    file or directory to process

Options:
  --pattern <pattern>     only process files that match the pattern
  --dry-run               preview changes without writing (default: false)
  --tsconfig <path>       Path to tsconfig.json (default: "tsconfig.json")
  --verbose               Enable verbose logging (default: false)
  --colors                Enable colors in logging (default: false)
  -h, --help              display help for command

Commands:
  purge [options] <path>  Scan a directory for barrel files and purge those that only contain re-exports.
```

Run the tool to rewrite barrel imports so they point to the file where the symbol is defined.

```sh
> $ brl --dry-run --colors                                                                                                                                                                                    [±main ●]
```

```diff
- import defaultExport, { named, nested, aliasedImport as custom, aliasedExport, type MyType } from './modules';
- import { button } from '@components';
- import { badge } from './modules/components';
+ import defaultExport from './modules/index';
+ import { named } from './modules/named-export';
+ import { nested } from './modules/nested/nested-export';
+ import { aliasedImport as custom } from './modules/aliased-import';
+ import { aliased as aliasedExport } from './modules/aliased-export';
+ import { type MyType } from './modules/types';
+ import { button } from '@components/button';
+ import { badge } from './modules/components/badge';
```

### Purge Barrel Files

```
Usage: brl purge [options] <path>

Scan a directory for barrel files and purge those that only contain re-exports.

Arguments:
  path        file or directory to process

Options:
  --dry-run   Log the files that would be deleted, without deleting them (default: false)
  -h, --help  display help for command

```

The purge subcommand scans a directory recursively for barrel files and deletes those that contain only re‑exports. 
If a barrel file includes additional code, a warning is logged.

```sh
> $ brl purge --dry-run                                                                                                                                                                                       [±main ●]
Scanning directory: fixture
Found 3 pure barrel file(s).
Found 1 impure barrel file(s) (containing additional code).
Dry run: The following pure barrel files would be deleted:
modules/index.ts
modules/components/index.ts
modules/nested/index.ts
Warning: Cannot delete impure barrel file: modules/impure-barrel/index.ts
```

The impure barrel file in this case looks like:

```ts
export * from './module';
 // we cannot delete this barrel as it also defines it's own exports
export const impure = 'impure';
```

> [!TIP]
> Once you have eliminated barrel files from your codebase use an [eslint rule](https://www.npmjs.com/package/eslint-plugin-no-barrel-files) to keep them gone!

## License

This project is licensed under the MIT License.
