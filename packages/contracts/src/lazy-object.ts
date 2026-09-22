import { z } from 'zod';

/** Keep ZodObject's concrete type and methods, but build its fields only on use. */
export function lazyObject<Shape extends z.ZodRawShape>(createShape: () => Shape): z.ZodObject<Shape, 'strip'> {
  // Zod caches parsing, but .shape and derived objects also need the same fields.
  let shape: Shape | undefined;
  return z.late.object(() => (shape ??= createShape()));
}
