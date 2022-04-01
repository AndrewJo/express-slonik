# express-slonik

[Slonik](https://github.com/gajus/slonik) transaction middleware for [Express.js](https://expressjs.com).

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
