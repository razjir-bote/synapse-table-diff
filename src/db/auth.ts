import type * as vscode from 'vscode';
import type * as mssql from 'mssql';
import type { ConnectionProfile, ProfileStore } from '../profiles/profileStore';
import { openRunner, type SideConnector } from './runner';
import { engineEditionQuery } from '../sql/queries';
import type { PoolType } from '../core/types';

export type TokenProvider = (tenantId?: string) => Promise<string>;

export function entraTokenProvider(auth: typeof vscode.authentication): TokenProvider {
  return async (tenantId) => {
    const scopes = ['https://database.windows.net//.default'];
    if (tenantId) scopes.push(`VSCODE_TENANT:${tenantId}`);
    const session = await auth.getSession('microsoft', scopes, { createIfNone: true });
    return session.accessToken;
  };
}

export function buildMssqlConfig(
  p: ConnectionProfile,
  database: string,
  secret: { token?: string; password?: string },
): mssql.config {
  const base: mssql.config = {
    server: p.server,
    database,
    options: { encrypt: true, trustServerCertificate: p.trustServerCertificate === true },
  };
  if (p.auth === 'entra') {
    return {
      ...base,
      authentication: { type: 'azure-active-directory-access-token', options: { token: secret.token ?? '' } },
    };
  }
  return { ...base, user: p.user, password: secret.password };
}

async function configFor(p: ConnectionProfile, database: string, store: ProfileStore, tokens: TokenProvider): Promise<mssql.config> {
  if (p.auth === 'entra') return buildMssqlConfig(p, database, { token: await tokens(p.tenantId) });
  return buildMssqlConfig(p, database, { password: await store.password(p.id) });
}

export async function makeConnector(
  p: ConnectionProfile,
  database: string,
  store: ProfileStore,
  tokens: TokenProvider,
  timeoutSeconds: number,
): Promise<SideConnector> {
  const open = async () => openRunner(await configFor(p, database, store, tokens), timeoutSeconds);

  // openRunner already maps connect errors via mapConnectError.
  const probe = await open();
  let poolType: PoolType;
  try {
    const rows = await probe.query<{ engine_edition: number }>(engineEditionQuery());
    const edition = Number(rows[0]?.engine_edition);
    poolType = edition === 6 ? 'dedicated' : edition === 11 ? 'serverless' : 'other';
  } finally {
    await probe.close();
  }

  return { label: `${p.name} (${database})`, poolType, open };
}
