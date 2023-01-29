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
