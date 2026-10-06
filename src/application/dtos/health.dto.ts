export type DependencyStatus = 'up' | 'down';

/**
 * - `ok`        every dependency is up
 * - `degraded`  only non-critical dependencies are down (still serving: HTTP 200)
 * - `down`      a critical dependency is down (HTTP 503)
 */
export type HealthStatus = 'ok' | 'degraded' | 'down';

export type HealthOutput = {
  readonly status: HealthStatus;
  readonly uptimeSeconds: number;
  readonly checks: Readonly<Record<string, DependencyStatus>>;
};
