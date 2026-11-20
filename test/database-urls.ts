/**
 * Where the test databases are. TEST_DATABASE_URL names a superuser and the
 * template database; each worker gets `<template>_w<n>`.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/medora_test';

/** The password the test API role is given. Local and CI only. */
export const TEST_API_PASSWORD = 'medora_api';

export function workerDatabaseName(workerId: string | number): string {
  return `${new URL(TEST_DATABASE_URL).pathname.slice(1)}_w${workerId}`;
}

export function urlFor(database: string, login?: { user: string; password: string }): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  if (login) {
    url.username = login.user;
    url.password = login.password;
  }
  return url.toString();
}
