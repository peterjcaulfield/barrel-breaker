import defaultExport, { named, nested, aliasedImport as custom, aliasedExport, type MyType } from './modules';
import { button } from '@components';
import { badge } from './modules/components';
import { badge as nonBarrelImport } from './modules/components/badge';
import { type MyType as MySecondType } from './modules/types';
import { nonRelative } from 'modules';
