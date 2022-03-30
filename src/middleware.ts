import EventEmitter from "events";
import { ErrorRequestHandler, Handler } from "express";
import {
  ClientConfigurationInput,
  createPool,
  DatabasePool,
  DatabaseTransactionConnection,
  sql,
} from "slonik";
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
  error: (error: Error) => void;
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
  public isStarted = false;
  public error: unknown;

  constructor(
    public readonly transaction: DatabaseTransactionConnection,
    protected readonly options?: EventEmitterOptions
  ) {
    super(options);
  }
}

export class SlonikRequestContext {
  private static instance: SlonikRequestContext;
  private transactionContext: TransactionContext;

  private constructor(private readonly pool: DatabasePool) {}

  public static getOrCreateContext(pool: DatabasePool): SlonikRequestContext {
    if (!SlonikRequestContext.instance) {
      SlonikRequestContext.instance = new SlonikRequestContext(pool);
    }

    return SlonikRequestContext.instance;
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

      try {
        await this.pool.transaction(async (transaction) => {
          await transaction.query(sql`SET TRANSACTION ISOLATION LEVEL ${isolationLevel};`);

          const transactionContext = new TransactionContext(transaction);
          transactionContext.isStarted = true;
          this.transactionContext = transactionContext;
          req.transaction = transaction;

          // Hold the transaction open until committed or on error.
          await new Promise<void>((resolve, reject) => {
            transactionContext
              .once("commit", () => {
                resolve();
              })
              .once("error", (error) => {
                transactionContext.error = error;
                reject(error);
              });

            // While the transaction is held open, hand off control to next middleware.
            next();

            res.once("finish", () => {
              if (transactionContext.isStarted && !transactionContext.error) {
                transactionContext.emit("commit");
              }
            });
          });

          transactionContext.isStarted = false;
        }, retryLimit);
      } catch (error) {
        next(error);
      } finally {
        // Outside of transaction context, the req.transaction is undefined.
        delete req.transaction;
      }
    };
  }

  /**
   * Commit the current transaction.
   */
  public commit(): Handler {
    return (req, res, next) => {
      if (!this.transactionContext) {
        return next(
          new TransactionOutOfBoundsError("Cannot commit outside of transaction context")
        );
      }

      this.transactionContext.emit("commit");
      next();
    };
  }

  /**
   * Catch any errors in the request handler stack to rollback transaction.
   */
  public catchError(): ErrorRequestHandler {
    return (error, req, res, next) => {
      if (this.transactionContext) {
        // No need to call next(error) here since this.transaction handler will call next(err) when
        // promise rejects.
        this.transactionContext.emit("error", error);
      } else {
        // Hand off control to next error handler if outside of transaction context.
        next(error);
      }
    };
  }

  public end(): [Handler, ErrorRequestHandler] {
    return [
      this.commit(),
      this.catchError(),
    ];
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
 * @param connectionUri - PostgreSQL [Connection URI](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING)
 * @param clientConfigurationInput
 */
function createMiddleware(
  connectionUri: string,
  clientConfigurationInput?: ClientConfigurationInput
): SlonikRequestContext;

/**
 * Request handler wrapped in express-slonik context.
 * @param pool - Slonik {@link DatabasePool} instance
 */
function createMiddleware(pool: DatabasePool): SlonikRequestContext;

function createMiddleware(
  poolOrConnectionUri: string | DatabasePool,
  clientConfigurationInput?: ClientConfigurationInput
): SlonikRequestContext {
  if (typeof poolOrConnectionUri !== "string" && !isDatabasePool(poolOrConnectionUri)) {
    throw new TypeError(
      "First argument must be an instance of Slonik pool instance or connection URI"
    );
  }

  const pool =
    typeof poolOrConnectionUri === "string"
      ? createPool(poolOrConnectionUri, clientConfigurationInput)
      : poolOrConnectionUri;

  return SlonikRequestContext.getOrCreateContext(pool);
}

export default createMiddleware;
