import chai, { expect, use } from "chai";
import chaiHttp from "chai-http";

import express, { Express, NextFunction, Request, Response, json } from "express";
import { createPool, DatabasePool } from "mocha-slonik";
import { DatabaseTransactionConnection, sql } from "slonik";

import createMiddleware, { SlonikRequestContext } from "../src";

use(chaiHttp);

describe("createMiddleware", function () {
  let pool: DatabasePool;
  let app: Express;
  let transaction: SlonikRequestContext;

  before(async function () {
    app = express();
    app.use(json());
    pool = createPool(process.env.DATABASE_URL || "postgres://localhost:5432");
    transaction = createMiddleware(pool);
  });

  beforeEach(async function () {
    await pool.query(sql`CREATE TABLE test (foo INTEGER NOT NULL);`);
  })

  afterEach(function () {
    pool.rollback();
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
      transaction.end()
    );

    await chai.request(app).put("/").send({ foo: 2 });

    const result = await pool.oneFirst(sql`SELECT foo FROM test`);
    expect(result).to.equal(2);
  });

  it("should autocommit transaction when response is sent", async function () {
    app.post(
      "/",
      transaction.begin(),
      async (req: Request, res: Response, next: NextFunction) => {
        await req.transaction.query(sql`INSERT INTO test (foo) VALUES (999) RETURNING foo`);
        res.end();
      },
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
      async (req: Request, res: Response) => {
        await req.transaction.query(sql`INSERT INTO test (foo) VALUES (100) RETURNING foo`);
        throw new Error("some error");
      },
      transaction.end()
    );

    await chai.request(app).post("/");

    const result = await pool.maybeOneFirst(sql`SELECT foo FROM test WHERE foo = 100`);
    expect(result).to.be.null;
  });
});
