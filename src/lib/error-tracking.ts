import { createHash } from 'node:crypto';
import * as Sentry from '@sentry/node';
import { postgresError } from './database-errors.js';
import { maskText } from './redact.js';

/**
 * Error reports (ADR 0026), through the Sentry SDK to a Sentry-compatible
 * server in Australia. Off when SENTRY_DSN is unset.
 *
 * Nothing personal leaves: no request or response bodies, headers, cookies,
 * query strings, addresses, breadcrumbs or local variables; emails and long
 * numbers in messages are masked; a database error goes as its code only.
 * Reporting never changes what a request does: it can't throw, and the same
 * error is sent at most once every ten minutes per process.
 */
const RESEND_AFTER_MS = 10 * 60_000;
const lastSent = new Map<string, number>();
let enabled = false;

export function startErrorTracking(options: { dsn: string | undefined; environment: string; release: string | undefined; service: string }): void {
  if (!options.dsn || enabled) return;
  try {
    Sentry.initWithoutDefaultIntegrations({
      dsn: options.dsn,
      environment: options.environment,
      ...(options.release ? { release: options.release } : {}),
      // Collect nothing personal by default; scrub() below removes the rest.
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        mcp: { inputs: false, outputs: false },
        databaseQueryData: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      },
      includeLocalVariables: false,
      integrations: [
        Sentry.eventFiltersIntegration(),
        Sentry.functionToStringIntegration(),
        Sentry.linkedErrorsIntegration(),
        Sentry.onUncaughtExceptionIntegration(),
        Sentry.onUnhandledRejectionIntegration(),
      ],
      initialScope: { tags: { service: options.service } },
      beforeBreadcrumb: () => null,
      beforeSend: scrub,
    });
    enabled = true;
  } catch {
    enabled = false;
  }
}

function scrub(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  delete event.request;
  delete event.breadcrumbs;
  delete event.extra;
  if (event.user) event.user = event.user.id === undefined ? {} : { id: event.user.id };
  if (event.message) event.message = maskText(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = maskText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }
  return event;
}

/** What may be said about an error: a database error's code, or its message masked. */
function describe(error: unknown): { name: string; message: string } {
  const pg = postgresError(error);
  if (pg) return { name: 'DatabaseError', message: `Postgres error ${pg.code}` };
  if (error instanceof Error) return { name: error.name, message: maskText(error.message) };
  return { name: 'NonError', message: 'A value that is not an Error was thrown' };
}

export interface ReportContext {
  tags?: Record<string, string | undefined>;
  userId?: string;
}

export function reportError(error: unknown, context: ReportContext = {}): void {
  if (!enabled) return;
  try {
    const { name, message } = describe(error);
    const key = createHash('sha256').update(`${name}:${message}:${context.tags?.['route'] ?? ''}`).digest('hex');
    const now = Date.now();
    if (now - (lastSent.get(key) ?? 0) < RESEND_AFTER_MS) return;
    lastSent.set(key, now);
    const sent = new Error(message);
    sent.name = name;
    if (error instanceof Error && error.stack && !postgresError(error)) sent.stack = maskText(error.stack);
    Sentry.withScope((scope) => {
      for (const [tag, value] of Object.entries(context.tags ?? {})) if (value !== undefined) scope.setTag(tag, value);
      if (context.userId) scope.setUser({ id: context.userId });
      Sentry.captureException(sent);
    });
  } catch {
    // Reporting must never break the request or job that is reporting.
  }
}

export async function flushErrorTracking(): Promise<void> {
  if (!enabled) return;
  await Sentry.flush(2_000).catch(() => false);
}
