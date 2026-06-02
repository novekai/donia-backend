// Validation middleware — runs a zod schema on body / params / query
import type { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

type Source = 'body' | 'params' | 'query';

export function validate<S extends ZodSchema>(schema: S, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) return next(result.error);
    // Replace req[source] with the parsed/coerced data
    (req as unknown as Record<Source, unknown>)[source] = result.data;
    next();
  };
}
