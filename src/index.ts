import { DatabaseTransactionConnection } from "slonik";

import createMiddleware from "express-slonik/middleware";
import type { IsolationLevel, RequestTransactionContext } from "express-slonik/middleware";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      transaction: DatabaseTransactionConnection;
      transactionId: string;
    }
  }
}

export { IsolationLevels, sql } from "express-slonik/middleware";
export type { IsolationLevel, RequestTransactionContext as SlonikRequestContext };

export default createMiddleware;
