/**
 * Share one in-flight promise between concurrent identical calls on the same instance.
 * Entries live only while the promise is pending (nothing is cached afterwards), so this never
 * serves stale data; it only stops N simultaneous callers (cold cache, parallel loaders on one
 * page) from each running the same query.
 *
 * `scope` partitions entries by caller identity (e.g. the Supabase client) so a result produced
 * under one client's RLS context is never handed to a caller using a different one.
 */
const inflightByScope = new WeakMap<object, Map<string, Promise<unknown>>>();

export function dedupeInflight<T>(scope: object, key: string, run: () => Promise<T>): Promise<T> {
  let entries = inflightByScope.get(scope);
  if (!entries) {
    entries = new Map();
    inflightByScope.set(scope, entries);
  }
  const existing = entries.get(key);
  if (existing) return existing as Promise<T>;

  const promise = run().finally(() => {
    if (entries.get(key) === promise) entries.delete(key);
  });
  entries.set(key, promise);
  return promise;
}
