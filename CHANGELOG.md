# [3.2.0](https://github.com/AndrewJo/express-slonik/compare/v3.1.0...v3.2.0) (2023-10-16)

### Features

- add support for Slonik v35, v36, v37 ([#7](https://github.com/AndrewJo/express-slonik/issues/7)) ([98bd100](https://github.com/AndrewJo/express-slonik/commit/98bd100270c02e018c7f8672d87c21947ec4c961))

# [3.1.0](https://github.com/AndrewJo/express-slonik/compare/v3.0.1...v3.1.0) (2023-09-29)

### Features

- add support for slonik v34 and isDatabasePool narrows type ([#6](https://github.com/AndrewJo/express-slonik/issues/6)) ([52e67f5](https://github.com/AndrewJo/express-slonik/commit/52e67f5ac7547a1b6bae2fab8d5851160bc472ae))

## [3.0.1](https://github.com/AndrewJo/express-slonik/compare/v3.0.0...v3.0.1) (2023-02-01)

### Bug Fixes

- allow build target to be ES2020 ([3424144](https://github.com/AndrewJo/express-slonik/commit/3424144cbe98f05d01edaef099ca3df354d9c13b))

# [3.0.0](https://github.com/AndrewJo/express-slonik/compare/v2.0.1...v3.0.0) (2023-01-29)

- feat(deps)!: upgrade to Slonik v33 (#4) ([75615df](https://github.com/AndrewJo/express-slonik/commit/75615df562d1770fffe316bd1865b3ee17624894)), closes [#4](https://github.com/AndrewJo/express-slonik/issues/4)

### BREAKING CHANGES

- Slonik v33 introduces changes to the library API that is not backwards compatible.

- feat: export convenience sql tag that includes void type alias

- refactor: change all untyped sql string template functions to type safe template string

- refactor: re-export `IsolationLevels` directly

- fix: move convenience sql tag to middleware module

- test: update test schema's column to be an integer

- docs: update example code to use the new typed sql template string

- docs: update slonik version compatibility table

## [2.0.1](https://github.com/AndrewJo/express-slonik/compare/v2.0.0...v2.0.1) (2023-01-29)

### Bug Fixes

- typo in the dependency version qualifier for slonik ([6b01833](https://github.com/AndrewJo/express-slonik/commit/6b01833da470a96c662a13efa0c33b6ae69fc444))
