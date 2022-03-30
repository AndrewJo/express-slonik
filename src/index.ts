import { DatabaseTransactionConnection } from "slonik";

import slonik from "express-slonik/middleware";
import type { SlonikRequestContext } from "express-slonik/middleware";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      transaction: DatabaseTransactionConnection
    }
  }
}

export type { SlonikRequestContext };
export default slonik;
