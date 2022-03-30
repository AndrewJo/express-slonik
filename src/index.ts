import { DatabaseTransactionConnection } from "slonik";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      transaction: DatabaseTransactionConnection
    }
  }
}

export { default } from "express-slonik/middleware";
export type { SlonikRequestContext } from "express-slonik/middleware";
