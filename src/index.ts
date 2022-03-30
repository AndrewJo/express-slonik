import { DatabaseTransactionConnection } from "slonik";

import slonik from "express-slonik/middleware";
import { IsolationLevels } from "express-slonik/middleware";
import type { IsolationLevel, SlonikRequestContext } from "express-slonik/middleware";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      transaction: DatabaseTransactionConnection
    }
  }
}

export { IsolationLevels };
export type { IsolationLevel, SlonikRequestContext };

export default slonik;
