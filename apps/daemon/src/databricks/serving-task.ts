function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** Captured Foundation list/detail responses put task at the root (2026-09-29).
 * Nested tasks are a compatibility fallback only; ignore pending/zero-traffic config.
 */
export function servingTask(metadata: Record<string, unknown>): string | undefined {
  if (typeof metadata.task === 'string') return metadata.task;
  const config = record(metadata.config);
  const entities = config.served_entities ?? config.served_models;
  if (!Array.isArray(entities)) return undefined;
  const routes = record(config.traffic_config).routes;
  const active = Array.isArray(routes) ? routes.map(record).filter(route => route.traffic_percentage !== 0 && route.is_deleted !== true) : undefined;
  const tasks: string[] = [];
  for (const raw of entities) {
    const entity = record(raw);
    if (entity.is_deleted === true || entity.traffic_percentage === 0) continue;
    if (active && !active.some(route => (route.served_entity_name ?? route.served_model_name) === entity.name)) continue;
    const task = record(entity.foundation_model).task ?? record(entity.external_model).task;
    if (typeof task !== 'string') return undefined;
    tasks.push(task);
  }
  return tasks.length && tasks.every(task => task === tasks[0]) ? tasks[0] : undefined;
}
