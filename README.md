# express-slonik

[![npm](https://img.shields.io/npm/v/express-slonik?style=flat-square)][npm]
[![CircleCI](https://img.shields.io/circleci/build/github/AndrewJo/express-slonik/master?style=flat-square)][circleci]
[![Codecov branch](https://img.shields.io/codecov/c/github/AndrewJo/express-slonik/master?style=flat-square)][codecov]
[![GitHub](https://img.shields.io/github/license/AndrewJo/express-slonik?style=flat-square)](./LICENSE)
[![npm](https://img.shields.io/npm/dw/express-slonik?style=flat-square)][npm]

[Slonik][slonik] transaction middleware for [Express.js][expressjs] with zero dependencies.

## Table of Contents

- [Getting started](#getting-started)
- [Usage](#usage)
  - [Basic usage](#basic-usage)
  - [Sharing transaction with multiple route handlers or middleware](#sharing-transaction-with-multiple-route-handlers-or-middleware)
  - [Setting isolation levels](#setting-isolation-levels)
- [Version compatibility](#version-compatibility)
- [Other projects](#other-projects)

## Getting started

Install the middleware as a dependency in your [Express.js](https://expressjs.com) project:

```shell
npm i -S slonik express-slonik
```

## Usage

You can use the `createMiddleware` function to create a request transaction context that contains
methods to wrap your route handlers in a PostgreSQL transaction.

### Basic usage

Use the `transaction.begin()` and `transaction.end()` middleware to wrap your request handlers in a
transaction.

**`app.ts`**:

```typescript
import express from "express";
import createMiddleware from "express-slonik";
import { createPool, sql } from "slonik";

const pool = createPool("postgres://localhost:5432/example_db");
const transaction = createMiddleware(pool);
const app = express();

app.get(
  "/user/:id",
  transaction.begin(),
  async (req, res, next) => {
    try {
      const user = await req.transaction.one(
        sql`SELECT * FROM users WHERE users.id = ${req.params.id}`
      );

      res.json(user);
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({
          name: error.name,
          message: `User with given id (${req.params.id}) not found.`,
        });
        return;
      }

      next(error);
    }
  },
  transaction.end()
);

app.listen(8080);
```

This is functionally equivalent to using `pool.transaction` in your handler:

```typescript
import express from "express";
import { createPool, sql } from "slonik";

const pool = createPool("postgres://localhost:5432/example_db");
const app = express();

app.get("/user/:id", async (req, res, next) => {
  try {
    const user = await pool.transaction(async (transaction) => {
      return await transaction.one(sql`SELECT * FROM users WHERE users.id = ${req.params.id}`);
    });

    res.json(user);
  } catch (error) {
    if (error instanceof NotFoundError) {
      res.status(404).json({
        name: error.name,
        message: `User with given id (${req.params.id}) not found.`,
      });
      return;
    }

    next(error);
  }
});

app.listen(8080);
```

### Sharing transaction with multiple route handlers or middleware

Suppose you had a middleware that returns the current user from the session or JWT. You can make
sure the user edit handler are on the same database transaction as the current user middleware.
This can prevent concurrent user updates from causing inconsistent the query result between the
time the current user middleware and your user edit handler executes.

**`middleware/current-user.ts`**:

```typescript
export default function currentUser() {
  return async function (req, res, next) {
    try {
      req.currentUser = await req.transaction.one(
        sql`SELECT * FROM users WHERE users.id = ${req.session.userId}`
      );
      next();
    } catch (error) {
      next(error);
    }
  };
}
```

**`app.ts`**:

```typescript
import express, { json } from "express";
import createMiddleware from "express-slonik";
import { createPool, sql } from "slonik";
import currentUser from "./middleware/current-user";

const pool = createPool("postgres://localhost:5432/example_db");
const transaction = createMiddleware(pool);
const app = express();

app
  .use(json())
  .put(
    "/user/:id",
    transaction.begin(),
    currentUser(),
    async (req, res, next) => {
      try {
        // Same transaction as currentUser middleware
        await req.transaction.query(
          sql`UPDATE users SET email = ${req.body.email} WHERE users.id = ${req.params.id}`
        );

        const updatedUser = await req.transaction.one(
          sql`SELECT * FROM users WHERE users.id = ${req.params.id}`
        );
        res.json(updatedUser);
      } catch (error) {
        next(error);
      }
    },
    transaction.end()
  )
  .use((error, req, res, next) => {
    res.status(401).end();
  });

app.listen(8080);
```

This behavior is especially helpful when you are using a custom validator or sanitizor in libraries
like [express-validator](https://express-validator.github.io/):

```typescript
import express, { json } from "express";
import createMiddleware from "express-slonik";
import { body, validationResult } from "express-validator";
import { createPool, sql } from "slonik";
import currentUser from "./middleware/current-user";

const pool = createPool("postgres://localhost:5432/example_db");
const transaction = createMiddleware(pool);
const app = express();

app
  .use(json())
  .put(
    "/user/:id",
    transaction.begin(),
    body("email").isEmail().normalizeEmail(),
    body("team_id")
      .toInt()
      .custom(async (value, { req }) => {
        // Fail validation if client is attempting to add user to a non-existant team
        const isValidTeam = await req.transaction.exists(
          sql`SELECT * FROM teams WHERE teams.id = ${req.body.team_id}`
        );

        if (!isValidTeam) {
          throw new Error("Invalid team");
        }
      }),
    async (req, res, next) => {
      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        res.status(422).json(errors.array());
        return;
      }

      // We can assume the request body is valid and sanitized by the time we reach this point.
      try {
        await req.transaction.query(sql`
          UPDATE users SET
            email = ${req.body.email},
            team_id = ${req.body.team_id}
          WHERE
            users.id = ${req.params.id}
        `);

        const user = await req.transaction.one(
          sql`SELECT * FROM users WHERE users.id = ${req.params.id}`
        );

        res.status(200).json(user);
      } catch (error) {
        next(error);
      }
    },
    transaction.end()
  )
  .use((error, req, res, next) => {
    res.status(401).end();
  });

app.listen(8080);
```

### Setting isolation levels

The `transaction.begin` can take an optional argument to specify transaction isolation levels. It
defaults to READ COMMITTED isolation level is left empty.

There are three isolation levels: `READ COMMITTED`, `REPEATABLE READ`, and `SERIALIZABLE`.

```typescript
import createMiddleware, { IsolationLevels } from "express-slonik";
import { createPool } from "slonik";

const transaction = createMiddleware(createPool("postgres://localhost:5432/example_db"));

app.get(
  "/posts/:postId/comments",
  transaction.begin(IsolationLevels.SERIALIZABLE),
  // ...
  transaction.end()
);
```

For more information on the differences between transaction isolation levels, please refer to:
[13.2. Transaction Isolation — PostgreSQL documentation](https://www.postgresql.org/docs/current/transaction-iso.html).

## Version compatibility

express-slonik follows [Semantic Versioning][semver] specification. Each major version breaks
backwards compatibility with [Slonik][slonik] and [Express.js][expressjs] versions (although
Express v5 has been extremely slow to come out of beta).

Refer to the compatibility chart below for picking the express-slonik version that works with Slonik
versions in your project.

| express-slonik |                            slonik |
| -------------: | --------------------------------: |
|         ^2.0.0 | ^30.0.0 \|\| ^31.0.0 \|\| ^32.0.0 |
|         ^1.1.0 |              ^28.0.0 \|\| ^29.0.0 |
|  ≥1.0.0 <1.1.0 |                           ^28.0.0 |

Minor version will always add support for Slonik versions that doesn't introduce major backwards
incompatibility that breaks interoperability with this library. For instance, the breaking changes
introduced between Slonik v28 and v29 are fairly minor and can be used with express-slonik without
any major refactor to how you use this middleware. However, the difference between v29 and v30
introduces a major change to the API surface (which also affects
[other Slonik utility packages][slonik-tools-issue-407]). In this case, the major version of
express-slonik will be bumped up to indicate that there will be backwards breaking changes.

## Other projects

Need to isolate database calls in your tests? Check out [mocha-slonik][mocha-slonik]!

[npm]: https://www.npmjs.com/package/express-slonik
[circleci]: https://circleci.com/gh/AndrewJo/express-slonik/tree/master
[codecov]: https://app.codecov.io/gh/AndrewJo/express-slonik/
[slonik]: https://github.com/gajus/slonik
[expressjs]: https://expressjs.com
[semver]: https://semver.org/
[slonik-tools-issue-407]: https://github.com/mmkal/slonik-tools/issues/407
[mocha-slonik]: https://github.com/AndrewJo/mocha-slonik
