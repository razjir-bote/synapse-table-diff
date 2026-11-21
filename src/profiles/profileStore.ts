import type * as vscode from 'vscode';

export interface ConnectionProfile {
  id: string;
  name: string;
  server: string;
  database: string;
  auth: 'entra' | 'sql';
  user?: string;
  tenantId?: string;
  /** Opt-in: accept a self-signed server certificate (local/dev servers only). */
  trustServerCertificate?: boolean;
}

const PROFILES_KEY = 'tableDiff.profiles';
const pwdKey = (id: string) => `tableDiff.pwd.${id}`;

export class ProfileStore {
  constructor(private readonly state: vscode.Memento, private readonly secrets: vscode.SecretStorage) {}

  list(): ConnectionProfile[] {
    return this.state.get<ConnectionProfile[]>(PROFILES_KEY, []) ?? [];
  }

  get(id: string): ConnectionProfile | undefined {
    return this.list().find((p) => p.id === id);
  }

  async save(p: ConnectionProfile, password?: string): Promise<void> {
    const all = this.list();
    const i = all.findIndex((x) => x.id === p.id);
    if (i >= 0) all[i] = p; else all.push(p);
    await this.state.update(PROFILES_KEY, all);
    if (password !== undefined) await this.secrets.store(pwdKey(p.id), password);
  }

  async remove(id: string): Promise<void> {
    await this.state.update(PROFILES_KEY, this.list().filter((p) => p.id !== id));
    await this.secrets.delete(pwdKey(id));
  }

  password(id: string): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(pwdKey(id)));
  }
}
