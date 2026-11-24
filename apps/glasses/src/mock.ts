import type { Alert } from '@pagerline/shared'

const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()

/** Offline demo data used when no server is configured (VITE_MOCK=1 or no VITE_API_BASE). */
export const MOCK_ALERTS: Alert[] = [
  {
    id: 'mock-1',
    seq: 1,
    source: 'github',
    kind: 'workflow_run.failure',
    severity: 'high',
    status: 'open',
    title: 'CI failed: CI / test on main',
    summary: 'acme/checkout-api · by rina · "Bump payment SDK to 4.2"',
    scope: 'acme/checkout-api',
    url: null,
    createdAt: ago(14),
  },
  {
    id: 'mock-2',
    seq: 2,
    source: 'sentry',
    kind: 'sentry.issue.created',
    severity: 'high',
    status: 'open',
    title: "TypeError: Cannot read properties of undefined (reading 'amount')",
    summary: 'checkout-api · src/payments/capture.ts in captureCharge · CHECKOUT-API-7F',
    scope: 'checkout-api',
    url: null,
    createdAt: ago(6),
  },
  {
    id: 'mock-3',
    seq: 3,
    source: 'sentry',
    kind: 'sentry.event_alert',
    severity: 'critical',
    status: 'open',
    title: 'Error rate spike on /v1/checkout',
    summary: 'rule: Error rate > 5% for 5m · POST /v1/checkout',
    scope: null,
    url: null,
    createdAt: ago(2),
  },
]
