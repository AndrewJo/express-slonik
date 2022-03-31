import chai, { expect, use } from "chai";
import chaiHttp from "chai-http";

import express, { Express, NextFunction, Request, Response, json } from "express";
import { createPool, DatabasePool, DatabaseTransactionConnection, sql } from "slonik";
import { createQueryLoggingInterceptor } from "slonik-interceptor-query-logging";

import createMiddleware, { IsolationLevels, SlonikRequestContext } from "../src";
import { timeout } from "@tests/helper";

use(chaiHttp);

describe("createMiddleware", function () {
  let pool: DatabasePool;
  let app: Express;
  let transaction: SlonikRequestContext;

  before(async function () {
    app = express();
    app.use(json());
    pool = createPool(process.env.DATABASE_URL || "postgres://localhost:5432", {
      interceptors: [createQueryLoggingInterceptor()],
    });
    transaction = createMiddleware(pool);
  });

  beforeEach(async function () {
    await pool.query(sql`CREATE TABLE IF NOT EXISTS test (foo INTEGER NOT NULL);`);
  });

  afterEach(async function () {
    await pool.query(sql`DROP TABLE test;`);
  });

  after(async function () {
    await pool.end();
  });

  it("should create transaction context", async function () {
    let transactionContext: DatabaseTransactionConnection;

    app.get(
      "/",
      transaction.begin(),
      (req: Request, res: Response, next: NextFunction) => {
        transactionContext = req.transaction;
        next();
      },
      transaction.end()
    );

    await chai.request(app).get("/");

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
    await pool.query(sql`INSERT INTO test (foo) VALUES (1) RETURNING foo`);
    app.put(
      "/",
      transaction.begin(),
      async (req: Request, res: Response, next: NextFunction) => {
        await req.transaction.query(sql`UPDATE test SET foo = ${req.body.foo} WHERE foo = 1`);
        next();
      },
      transaction.end(),
      transaction.begin(),
      async (req: Request, res: Response) => {
        // Previous transaction should've committed so we should be able to query by req.body.foo
        const { foo } = await req.transaction.one(sql`SELECT foo FROM test WHERE foo = ${req.body.foo}`);
        res.json(foo);
      },
      transaction.end()
    );

    const { body } = await chai.request(app).put("/").send({ foo: 2 });
    expect(body).to.equal(2);
  });

  it("should autocommit transaction when response is sent", async function () {
    app.post(
      "/",
      transaction.begin(),
      async (req: Request, res: Response) => {
        await req.transaction.query(sql`INSERT INTO test (foo) VALUES (999) RETURNING foo`);
        res.end();
      }
      // Omit transaction.end() so we can test if autocommit works when response is sent.
    );

    await chai.request(app).post("/");

    const result = await pool.oneFirst(sql`SELECT foo FROM test WHERE foo = 999`);
    expect(result).to.equal(999);
  });

  it("should rollback transaction when there are errors in the request handler chain", async function () {
    app.post(
      "/",
      transaction.begin(),
      async (req: Request) => {
        await req.transaction.query(sql`INSERT INTO test (foo) VALUES (100) RETURNING foo`);
        throw new Error("some error");
      },
      transaction.end()
    );

    await chai.request(app).post("/");

    const result = await pool.maybeOneFirst(sql`SELECT foo FROM test WHERE foo = 100`);
    expect(result).to.be.null;
  });

  context("when isolation level is READ COMMITTED", function () {
    let request: ChaiHttp.Agent;

    beforeEach(async function () {
      await pool.query(
        sql`INSERT INTO test (foo) SELECT * FROM ${sql.unnest(
          [[101], [102]],
          ["int4"]
        )} RETURNING foo`
      );

      app
        .get(
          "/:foo",
          transaction.begin(IsolationLevels.READ_COMMITTED, 1),
          async (req: Request, res: Response) => {
            // Artificially wait while the other transaction updates the values
            await timeout(5);
            const result = await req.transaction.one(
              sql`SELECT foo FROM test WHERE foo = ${req.params.foo}`
            );
            res.json(result);
          },
          transaction.end()
        )
        .put(
          "/:foo",
          transaction.begin(IsolationLevels.READ_COMMITTED, 1),
          async (req: Request, res: Response) => {
            await req.transaction.query(
              sql`UPDATE test SET foo = ${req.body.foo} WHERE foo = ${req.params.foo}`
            );

            // Update but don't commit so the other transaction can read uncommitted data.
            await timeout(10);

            const result = await req.transaction.one(
              sql`SELECT foo FROM test WHERE foo = ${req.body.foo}`
            );
            res.json(result);
          },
          transaction.end()
        );

      request = chai.request(app).keepOpen();
    });

    afterEach(async function () {
      request.close();
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
