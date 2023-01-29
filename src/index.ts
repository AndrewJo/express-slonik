import { createSqlTag, DatabaseTransactionConnection } from "slonik";
import { z } from "zod";

import createMiddleware from "express-slonik/middleware";
import { IsolationLevels } from "express-slonik/middleware";
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

export const sql = createSqlTag({
  typeAliases: {
    void: z.object({}).strict(),
  },
});

export { IsolationLevels };
export type { IsolationLevel, RequestTransactionContext as SlonikRequestContext };

export default createMiddleware;
