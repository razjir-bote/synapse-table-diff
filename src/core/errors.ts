export class CompareCancelledError extends Error {}
export class PausedPoolError extends Error {
  constructor(public server: string, public database: string) {
    super(`Pool for ${server}/${database} is paused`);
  }
}
export class PoolUnavailableError extends Error {}
export class ComparePlanError extends Error {} // e.g. key column missing/incompatible
