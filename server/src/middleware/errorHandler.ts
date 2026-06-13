import { Request, Response, NextFunction } from "express";
import { AppError } from "../errors";

/** Central error handler: known AppErrors map cleanly, everything else is 500. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required arity
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message },
    });
    return;
  }

  console.error("Unexpected error:", err);
  res.status(500).json({
    error: { code: "INTERNAL", message: "Internal server error" },
  });
}
