import { randomUUID } from "crypto";
import EventEmitter from "events";

import { ErrorRequestHandler, Handler } from "express";
import { createPool, DatabasePool, DatabaseTransactionConnection, sql } from "slonik";
import { TransactionOutOfBoundsError, UndefinedPoolError } from "express-slonik/errors";

type EventEmitterOptions = ConstructorParameters<typeof EventEmitter>[0];

/**
 * PostgreSQL transaction isolation levels.
 * @see {@link https://www.postgresql.org/docs/current/transaction-iso.html | PostgreSQL Documentation} for detailed
 * information.
 */
export const IsolationLevels = {
  /**
   * Default isolation level in PostgreSQL. Guarantees dirty reads never happen.
   *
   * @see {@link https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED | READ COMMITTED}
   */
  READ_COMMITTED: sql`READ COMMITTED`,

  /**
   * Higher isolation level than READ COMMITTED. Guarantees repeatable reads _in addition to_
   * never allowing dirty reads.
   *
   * @see {@link https://www.postgresql.org/docs/current/transaction-iso.html#XACT-REPEATABLE-READ | REPEATABLE READ}
   */
  REPEATABLE_READ: sql`REPEATABLE READ`,

  /**
   * Highest isolation level. Guarantees phantom reads and serialization anomalies never happen
   * _in addition to_ never allowing non-repeatable reads and dirty reads.
   *
   * @see {@link https://www.postgresql.org/docs/current/transaction-iso.html#XACT-SERIALIZABLE | SERIALIZABLE}
   */
  SERIALIZABLE: sql`SERIALIZABLE`,
} as const;

export type IsolationLevel = typeof IsolationLevels[keyof typeof IsolationLevels];

interface TransactionEvents {
  commit: () => void;
  rollback: (error: Error) => void;
}

declare interface TransactionContext {
  emit<K extends keyof TransactionEvents>(
    event: K,
    ...args: Parameters<TransactionEvents[K]>
  ): boolean;
  on<K extends keyof TransactionEvents>(event: K, listener: TransactionEvents[K]): this;
  once<K extends keyof TransactionEvents>(event: K, listener: TransactionEvents[K]): this;
}

/**
 * Transaction context that wraps the Slonik transaction as an EventEmitter.
 *
 * @param transaction DatabaseTransactionConnection instance
 */
class TransactionContext extends EventEmitter {
  public error: unknown;

  constructor(
    public readonly transactionId: string,
    public readonly transaction: DatabaseTransactionConnection,
    protected readonly options?: EventEmitterOptions
  ) {
    super(options);
  }

  public commit() {
    this.emit("commit");
  }

  public rollback(error: Error) {
    this.error = error;
    this.emit("rollback", error);
  }
}

export class RequestTransactionContext {
  private static instance: RequestTransactionContext;
  private transactionContext: Record<string, TransactionContext>;

  private constructor(private readonly pool: DatabasePool) {
    this.transactionContext = {};
  }

  public static getOrCreateContext(pool: DatabasePool): RequestTransactionContext {
    if (!RequestTransactionContext.instance) {
      RequestTransactionContext.instance = new RequestTransactionContext(pool);
    }

    return RequestTransactionContext.instance;
  }

  /**
   * Middleware function for starting a transaction context. While the transaction context is open,
   * Slonik DatabaseTransactionConnection object is available under req.transaction.
   *
   * @param isolationLevel - PostgreSQL [transaction isolation level](https://www.postgresql.org/docs/current/transaction-iso.html). Defaults to read committed isolation level.
   * @param retryLimit - Number of times to retry transaction. Defaults to `5`.
   */
  public begin(
    isolationLevel: IsolationLevel = IsolationLevels.READ_COMMITTED,
    retryLimit = 5
  ): Handler {
    return async (req, res, next) => {
      if (!this.pool) {
        return next(new UndefinedPoolError("Pool is not instantiated"));
      }

      const transactionId = randomUUID();

      try {
        await this.pool.transaction(async (transaction) => {
          await transaction.query(sql`SET TRANSACTION ISOLATION LEVEL ${isolationLevel};`);

          this.transactionContext[transactionId] = new TransactionContext(transactionId, transaction);
          const transactionContext = this.transactionContext[transactionId];
          req.transactionId = transactionId;
          req.transaction = transaction;

          const autoCommit = transactionContext.commit.bind(transactionContext);
          const autoRollback = transactionContext.commit.bind(transactionContext);

          // Allow transaction to be automatically committed or rolled back when response is sent.
          // These event handlers must be removed when the promise below is either resolved or
          // rejected.
          res.on("finish", autoCommit).on("error", autoRollback);

          // Hold the transaction open until committed or on error.
          await new Promise<void>((resolve, reject) => {
            // We use .once (as opposed to .on) because we want to commit or rollback at most
            // once.
            transactionContext
              .once("commit", () => {
                // Prevent the response events from being registered multiple times if
                // transaction.begin() is called again down the middleware chain.
                res.off("finish", autoCommit).off("error", autoRollback);
                resolve();
              })
              .once("rollback", (error) => {
                // Prevent the response events from being registered multiple times if
                // transaction.begin() is called again down the middleware chain.
                res.off("finish", autoCommit).off("error", autoRollback);
                reject(error);
              });

            // While the transaction is held open, hand off control to next middleware.
            next();
          });
        }, retryLimit);

        // Hand control over to the next middleware in the pipeline when transaction is completed.
        next();
      } catch (error) {
        next(error);
      } finally {
        // Outside of transaction context, the req.transaction is undefined.
        delete req.transaction;
        delete req.transactionId;
        delete this.transactionContext[transactionId];
      }
    };
  }

  /**
   * Commit the current transaction.
   */
  public commit(): Handler {
    return (req, res, next) => {
      if (!req.transactionId) {
        return next(new TransactionOutOfBoundsError("Cannot commit outside of transaction"));
      }

      // No need to call next() here since this.beginn handler will call next() when the promise
      // resolves.
      this.transactionContext[req.transactionId].commit();
    };
  }

  /**
   * Catch any errors in the request handler stack to rollback transaction.
   */
  public catchError(): ErrorRequestHandler {
    return (error, req, res, next) => {
      if (req.transactionId) {
        // No need to call next(error) here since this.begin handler will call next(err) when
        // promise rejects.
        this.transactionContext[req.transactionId].rollback(error);
      } else {
        // Hand off control to next error handler if outside of transaction context.
        next(error);
      }
    };
  }

  /**
   * Ends the transaction. If there are no errors in the request handler chain, the transaction is
   * automatically committed. Otherwise, it is rolled back.
   */
  public end(): [Handler, ErrorRequestHandler] {
    return [this.commit(), this.catchError()];
  }
}

function isDatabasePool(poolLike: unknown): boolean {
  const slonikPoolInstance = createPool("");
  return Object.keys(slonikPoolInstance).every(
    (method) => typeof poolLike[method] === typeof slonikPoolInstance[method]
  );
}

/**
 * Request handler wrapped in express-slonik context.
 * @param pool - Slonik {@link DatabasePool} instance
 */
function createMiddleware(pool: DatabasePool): RequestTransactionContext {
  if (!isDatabasePool(pool)) {
    throw new TypeError(
      "First argument must be an instance of Slonik pool instance or connection URI"
    );
  }

  return RequestTransactionContext.getOrCreateContext(pool);
}

export default createMiddleware;
