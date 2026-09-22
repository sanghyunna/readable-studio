import { expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { lazyObject } from '../src/lazy-object.js';

it('retains the concrete object type when deferring a shape', () => {
  // Given a schema with distinct input and output types.
  const shape = { value: z.string().transform((value) => value.length), count: z.number().default(2) };
  const eager = z.object(shape);
  // When its shape is deferred.
  const deferred = lazyObject(() => shape);
  // Then the complete schema type, not just its output, is identical.
  const eagerType: typeof eager = deferred;
  const deferredType: typeof deferred = eager;
  expect(eagerType).toBe(deferred);
  expect(deferredType).toBe(eager);
  expectTypeOf<z.input<typeof deferred>>().toEqualTypeOf<z.input<typeof eager>>();
  expectTypeOf<z.output<typeof deferred>>().toEqualTypeOf<z.output<typeof eager>>();
  expect(deferred).toBeInstanceOf(z.ZodObject);
});

it('leaves fields unconstructed when creating optional and array wrappers', () => {
  // Given a factory observed without replacing its behavior.
  const createShape = vi.fn(() => ({ value: z.string() }));
  // When an unused schema is composed into other schemas.
  const schema = lazyObject(createShape);
  z.array(schema.optional().nullable());
  schema.passthrough().extend({ extra: z.boolean() });
  // Then composition has not paid for the fields.
  expect(createShape).not.toHaveBeenCalled();
});

it('caches one shape when introspection and derived parsing use it repeatedly', () => {
  // Given a factory and several consumers of the same schema.
  const createShape = vi.fn(() => ({ value: z.string() }));
  const schema = lazyObject(createShape);
  // When consumers inspect and parse the object and derived objects.
  const first = schema.shape;
  schema.parse({ value: 'first' });
  schema.passthrough().parse({ value: 'second', extra: true });
  schema.pick({ value: true }).parse({ value: 'third' });
  schema.partial().parse({});
  // Then all consumers share one constructed shape.
  expect(schema.shape).toBe(first);
  expect(createShape).toHaveBeenCalledTimes(1);
});

const inputs: readonly unknown[] = [
  undefined, null, [], 1, {}, { name: '' },
  { name: 'valid', extra: 1 },
  { name: 'valid', count: 0, tags: ['x'] },
  { name: 'valid', count: 1.5, tags: [3] },
  { name: 'valid', count: 2, optional: undefined },
  { name: 'valid', count: 10, nested: { value: 'bad' } },
];

it.each(inputs)('preserves parse results and issues when input is %j', (input) => {
  // Given identical real Zod field definitions in eager and deferred objects.
  const shape = {
    name: z.string().min(1),
    count: z.number().int().positive().default(3),
    optional: z.string().optional(),
    tags: z.array(z.string()).optional(),
    nested: z.object({ value: z.number() }).optional(),
  };
  const eager = z.object(shape).passthrough().refine((value) => value.count < 5)
    .transform(({ name, ...rest }) => ({ ...rest, name: name.toUpperCase() }));
  const deferred = lazyObject(() => shape).passthrough().refine((value) => value.count < 5)
    .transform(({ name, ...rest }) => ({ ...rest, name: name.toUpperCase() }));
  // When both validators process the same boundary input.
  const actual = deferred.safeParse(input);
  const expected = eager.safeParse(input);
  // Then parsed values and serialized error details match exactly.
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
});

it('preserves stripped fields when using default object behavior', () => {
  // Given the default object policy.
  const schema = lazyObject(() => ({ value: z.string() }));
  // When parsing an input with additional fields.
  const parsed = schema.parse({ value: 'kept', extra: true });
  // Then the same fields as z.object are retained.
  expect(parsed).toEqual({ value: 'kept' });
});

it('preserves async refinements when parsing asynchronously', async () => {
  // Given a real async refinement and transform.
  const shape = { value: z.string().refine(async (value) => value.length > 0).transform(Number) };
  const eager = z.object(shape);
  const deferred = lazyObject(() => shape);
  // When parsing through the async API.
  const actual = await deferred.safeParseAsync({ value: '42' });
  // Then the output is identical to the eager schema.
  expect(actual).toEqual(await eager.safeParseAsync({ value: '42' }));
});

it('preserves discriminator introspection when used as a union option', () => {
  // Given concrete object variants with deferred fields.
  const schema = z.discriminatedUnion('kind', [
    lazyObject(() => ({ kind: z.literal('a'), value: z.string() })),
    lazyObject(() => ({ kind: z.literal('b'), value: z.number() })),
  ]);
  // When parsing a tagged value.
  const parsed = schema.parse({ kind: 'b', value: 4 });
  // Then Zod's normal discriminator dispatch remains available.
  expect(parsed).toEqual({ kind: 'b', value: 4 });
});
