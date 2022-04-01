import { promisify } from "util";

import chai, { expect, use } from "chai";
import chaiHttp from "chai-http";

import express, { Express, NextFunction, Request, Response, json, Router } from "express";
import { createPool, DatabasePool, DatabaseTransactionConnection, sql } from "slonik";
import { createQueryLoggingInterceptor } from "slonik-interceptor-query-logging";

import createMiddleware, { IsolationLevels, SlonikRequestContext } from "../src";
import { timeout } from "@tests/helper";

use(chaiHttp);

describe("createMiddleware", function () {
  let pool: DatabasePool;
  let app: Express;
  let router: Router;
  let transaction: SlonikRequestContext;
  let request: ChaiHttp.Agent;

  before(async function () {
    pool = createPool(process.env.DATABASE_URL || "postgres://localhost:5432", {
      interceptors: [createQueryLoggingInterceptor()],
    });

    transaction = createMiddleware(pool);

    await pool.query(sql`CREATE TABLE IF NOT EXISTS test (foo INTEGER NOT NULL);`);
  });

  beforeEach(async function () {
    router = Router();

    app = express();
    app.use(json());
    app.use(router);
    app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
    });
    request = chai.request(app).keepOpen();
  });

  afterEach(async function () {
    await promisify(request.close)();
    await pool.query(sql`TRUNCATE TABLE test;`);
  });

  after(async function () {
    await pool.query(sql`DROP TABLE test;`);
    await pool.end();
  });

  context("when transaction context is created", function () {
    it("should create transaction context", async function () {
      let transactionContext: DatabaseTransactionConnection;

      router.get(
        "/",
        transaction.begin(),
        async (req: Request, res: Response, next: NextFunction) => {
          transactionContext = req.transaction;
          next();
        },
        transaction.end()
      );

      await request.get("/");

      expect(transactionContext).to.have.all.keys(
        "any",
        "anyFirst",
        "exists",
        "many",
        "manyFirst",
        "maybeOne",
        "maybeOneFirst",
        "one",
        "oneFirst",
        "query",
        "stream",
        "transaction"
      );
    });

    it("should commit transaction when there are no errors", async function () {
      const oldVal = 1;
      const newVal = 2;

      router.put(
        "/",
        transaction.begin(),
        async (req: Request, res: Response, next: NextFunction) => {
          await req.transaction.query(sql`UPDATE test SET foo = ${newVal} WHERE foo = ${oldVal}`);
          next();
        },
        transaction.end(),
        transaction.begin(),
        async (req: Request, res: Response) => {
          // Previous transaction should've committed so we should be able to query by req.body.foo
          const { foo } = await req.transaction.one(sql`SELECT foo FROM test`);
          res.json(foo);
        }
      );

      await pool.oneFirst(sql`INSERT INTO test (foo) VALUES (${oldVal}) RETURNING foo`);
      const response = await request.put("/").send({ foo: 2 });
      expect(response.body).to.equal(2);
    });

    it("should autocommit transaction when response is sent", async function () {
      router.post(
        "/",
        transaction.begin(),
        async (req: Request, res: Response) => {
          await req.transaction.query(sql`INSERT INTO test (foo) VALUES (999) RETURNING foo`);
          res.end();
        }
        // Omit transaction.end() so we can test if autocommit works when response is sent.
      );

      await request.post("/");

      const result = await pool.oneFirst(sql`SELECT foo FROM test WHERE foo = 999`);
      expect(result).to.equal(999);
    });

    it("should rollback transaction when there are errors in the request handler chain", async function () {
      router.post(
        "/",
        transaction.begin(IsolationLevels.READ_COMMITTED, 1),
        async (req: Request, res: Response, next: NextFunction) => {
          try {
            await req.transaction.query(sql`INSERT INTO test (foo) VALUES (100) RETURNING foo`);
            throw new Error("some error");
          } catch (error) {
            next(error);
          }
        },
        transaction.end()
      );

      await request.post("/");

      const result = await pool.maybeOneFirst(sql`SELECT foo FROM test WHERE foo = 100`);
      expect(result).to.be.null;
    });

    context("when isolation level is READ COMMITTED", function () {
      beforeEach(async function () {
        await pool.query(
          sql`INSERT INTO test (foo) SELECT * FROM ${sql.unnest(
            [[101], [102]],
            ["int4"]
          )} RETURNING foo`
        );

        router
          .get(
            "/:foo",
            transaction.begin(IsolationLevels.READ_COMMITTED, 5),
            async (req: Request, res: Response) => {
              // Artificially wait while the other transaction updates the values
              await timeout(50);

              const result = await req.transaction.one(
                sql`SELECT foo FROM test WHERE foo = ${req.params.foo}`
              );

              res.json(result);
            },
            transaction.end()
          )
          .put(
            "/:foo",
            transaction.begin(IsolationLevels.READ_COMMITTED, 5),
            async (req: Request, res: Response) => {
              await req.transaction.query(
                sql`UPDATE test SET foo = ${req.body.foo} WHERE foo = ${req.params.foo}`
              );

              // Update but don't commit so the other transaction can read uncommitted data.
              await timeout(100);

              const result = await req.transaction.one(
                sql`SELECT foo FROM test WHERE foo = ${req.body.foo}`
              );

              res.json(result);
            },
            transaction.end()
          );
      });

      it("should isolate against dirty reads", async function () {
        // Send concurrent requests to update and read the same row
        const [putResponse, getResponse] = await Promise.all([
          request.put("/101").send({ foo: 201 }),
          request.get("/101"),
        ]);

        // If there was a dirty read, response from GET request should be updated to 201.
        expect(getResponse.body.foo).to.equal(101);
        expect(putResponse.body.foo).to.equal(201);
      });
    });
  });

  context("when outside of transaction context", function () {
    it("should throw TransactionOutOfBoundsError on commit", async function () {
      router.get(
        "/",
        async (req: Request, res: Response, next: NextFunction) => {
          next();
        },
        transaction.commit()
      );
      const response = await request.get("/");
      expect(response).to.have.status(500);
      expect(response.body).to.have.property("name", "TransactionOutOfBoundsError");
    });

    it("should pass error through to next middleware on catchError", async function () {
      router.get(
        "/",
        async (req: Request, res: Response, next: NextFunction) => {
          next(new Error("Test error"));
        },
        transaction.catchError()
      );
      const response = await request.get("/");
      expect(response).to.have.status(500);
      expect(response.body).to.have.property("name", "Error");
      expect(response.body).to.have.property("message", "Test error");
    });
  });
});
