// Metro configuration.
//  - ../playkit holds the Core API contract (type-only imports today).
//  - ../core-ts is the in-app core (`@ajwf/client-core`, a `file:` dependency, so node_modules has a symlink to it).
//    Its sources import each other with explicit `.ts` paths and use `export type *`; Metro resolves an exact path
//    with a source extension as is, and babel-preset-expo strips the type-only exports.
// The web bundle never reaches these native-only files: the app imports create-local.ts on the web and
// create-local.native.ts on Android and iOS.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../playkit'), path.resolve(__dirname, '../core-ts')];
// Packages imported from ../core-ts resolve from this app's node_modules (core-ts has no runtime dependencies).
config.resolver.nodeModulesPaths = [...(config.resolver.nodeModulesPaths ?? []), path.resolve(__dirname, 'node_modules')];

module.exports = config;
