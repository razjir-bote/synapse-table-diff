export class CompareCancelledError extends Error {}
export class PausedPoolError extends Error {
  constructor(public server: string, public database: string) {
    super(`Pool "${database}" on ${server} is paused. Resume it in the Azure portal and try again.`);
  }
}
export class PoolUnavailableError extends Error {}
export class ComparePlanError extends Error {} // e.g. key column missing/incompatible
