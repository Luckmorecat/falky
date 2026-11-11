import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Schema } from './protocol.ts';

export class FixtureError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
interface Session { visitor: Schema['Visitor']; kind: 'guest' | 'account'; expiresAt: string; proofAt: number; proofKey?: string }
interface Account { visitor: Schema['Visitor']; keys: Schema['AccountPasskey'][]; phrase: string }
interface Ceremony { kind: string; token: string; visitor?: Schema['Visitor']; account?: Account; challenge: string; proof?: string; invitation?: string }
const fixtureWords = 'acid acorn acre acts afar affix aged agent agile aging agony yo-yo'.split(' ');

/** Disposable contract fixtures; credential structure is checked, signatures are not verified. */
export class AccountFixture {
  readonly sessions = new Map<string, Session>();
  private accounts = new Map<string, Account>();
  private ceremonies = new Map<string, Ceremony>();
  private rotation = 0;
  private usedInvitations = new Set<string>();
  fault: 'none' | 'finish-expired' | 'finish-lost' | 'regenerate-lost' | 'last-passkey' | 'invalid-proof' = 'none';
  constructor(private hooks: { id(): string; visitor(name: string): Schema['Visitor']; name(value: unknown): string; token(req: IncomingMessage): string; issue(res: ServerResponse, visitor: Schema['Visitor'] | null, token?: string): string }) {}
  reset() { this.sessions.clear(); this.accounts.clear(); this.ceremonies.clear(); this.rotation = 0; this.usedInvitations.clear(); this.fault = 'none'; }
  guest(token: string, visitor: Schema['Visitor']) { this.sessions.set(token, { visitor, kind: 'guest', expiresAt: new Date(Date.now() + 86400_000).toISOString(), proofAt: 0 }); }
  resolve(req: IncomingMessage) { return this.sessions.get(this.hooks.token(req)); }
  private require(req: IncomingMessage, account = false) {
    const session = this.resolve(req);
    if (!session || (account && session.kind !== 'account')) throw new FixtureError(401, 'visitor_required');
    return session;
  }
  private proof(session: Session) {
    const account = this.accounts.get(session.visitor.id);
    if (Date.now() - session.proofAt > 300_000 || !account?.keys.some((key) => key.id === session.proofKey)) throw new FixtureError(403, 'recent_proof_required');
  }
  expireProof() { for (const session of this.sessions.values()) session.proofAt = 0; }
  private publicSession(session: Session) { return { kind: session.kind, visitor: session.visitor, expiresAt: session.expiresAt }; }
  private phrase() {
    const words = [...fixtureWords];
    let revision = this.rotation++;
    for (let i = 0; revision > 0 && i < words.length - 1; i++) {
      words[i] = fixtureWords[revision % fixtureWords.length]!;
      revision = Math.floor(revision / fixtureWords.length);
    }
    return words.join(' ');
  }
  private enroll(res: ServerResponse, account: Account, key: string) {
    for (const [token, session] of this.sessions) if (session.visitor.id === account.visitor.id) this.sessions.delete(token);
    const token = this.hooks.issue(res, account.visitor);
    const session: Session = { visitor: account.visitor, kind: 'account', expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString(), proofAt: Date.now(), proofKey: key };
    this.sessions.set(token, session);
    return this.publicSession(session);
  }
  deviceSession(res: ServerResponse, visitor: Schema['Visitor'], existingToken?: string) {
    const token = this.hooks.issue(res, visitor, existingToken);
    if (!existingToken) this.sessions.set(token, { visitor, kind: 'account', expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString(), proofAt: 0 });
    return { token, session: this.publicSession(this.sessions.get(token)!) };
  }
  handle(path: string, req: IncomingMessage, res: ServerResponse, input: Record<string, unknown>, origin: string): { status: number; value?: unknown; lost?: boolean } | undefined {
    if (!path.startsWith('/api/accounts/')) return;
    if (path === '/api/accounts/session' && req.method === 'GET') return { status: 200, value: this.publicSession(this.require(req)) };
    if (path === '/api/accounts/logout') {
      this.require(req); this.sessions.delete(this.hooks.token(req)); this.hooks.issue(res, null);
      return { status: 200, value: {} };
    }
    if (path === '/api/accounts/passkeys' && req.method === 'GET') {
      const session = this.require(req, true);
      return { status: 200, value: { passkeys: this.accounts.get(session.visitor.id)!.keys } };
    }
    if (path.startsWith('/api/accounts/passkeys/') && req.method === 'DELETE') {
      const session = this.require(req, true); this.proof(session);
      const account = this.accounts.get(session.visitor.id)!;
      const key = decodeURIComponent(path.slice('/api/accounts/passkeys/'.length));
      if (account.keys.length === 1 || this.fault === 'last-passkey') { this.fault = 'none'; throw new FixtureError(409, 'last_passkey'); }
      account.keys = account.keys.filter((candidate) => candidate.id !== key);
      return { status: 200, value: {} };
    }
    if (path === '/api/accounts/recovery-codes') {
      const session = this.require(req, true); this.proof(session);
      const account = this.accounts.get(session.visitor.id)!; account.phrase = this.phrase();
      const lost = this.fault === 'regenerate-lost'; this.fault = 'none';
      return { status: 200, value: { recoveryCodes: [account.phrase] }, lost };
    }
    const match = /^\/api\/accounts\/(registration|authentication|recovery|reauthentication|passkeys)\/(begin|finish)$/.exec(path);
    if (!match || req.method !== 'POST') throw new FixtureError(404, 'not_found');
    const kind = match[1]!;
    if (match[2] === 'begin') {
      let account: Account | undefined;
      let visitor: Schema['Visitor'] | undefined;
      if (kind === 'registration') {
        if (!['mock-invitation', 'mock-invitation-second'].includes(String(input.invitation)) || this.usedInvitations.has(String(input.invitation)) || this.fault === 'invalid-proof') { this.fault = 'none'; throw new FixtureError(403, 'invalid_proof'); }
        const chosen = typeof input.name === 'string' ? input.name.trim() : '';
        if (!chosen || [...chosen].length > 32 || /[\p{Cc}\p{Cf}]/u.test(chosen)) throw new FixtureError(400, 'invalid_name');
        const session = this.resolve(req);
        visitor = session?.kind === 'guest' ? { ...session.visitor, name: chosen } : this.hooks.visitor(chosen);
      } else if (kind === 'recovery') {
        account = this.accounts.get(String(input.accountId));
        const normalized = String(input.proof).trim().toLowerCase().split(/\s+/).join(' ');
        if (!account || (input.proof !== '  Mock-Operator-Proof+EXACT  ' && normalized !== account.phrase) || this.fault === 'invalid-proof') { this.fault = 'none'; throw new FixtureError(403, 'invalid_proof'); }
        visitor = account.visitor;
      } else if (kind !== 'authentication') {
        const session = this.require(req, true); account = this.accounts.get(session.visitor.id)!; visitor = account.visitor;
        if (kind === 'passkeys') this.proof(session);
      }
      const challenge = randomBytes(32).toString('base64url');
      const ceremonyId = this.hooks.id();
      this.ceremonies.set(ceremonyId, { kind, token: this.hooks.token(req), visitor, account, challenge, proof: kind === 'recovery' && input.proof !== '  Mock-Operator-Proof+EXACT  ' ? account?.phrase : undefined, invitation: kind === 'registration' ? String(input.invitation) : undefined });
      const create = ['registration', 'recovery', 'passkeys'].includes(kind);
      const publicKey = create ? { challenge, rp: { name: 'Falky fixture', id: new URL(origin).hostname }, user: { id: Buffer.from(visitor!.id).toString('base64url'), name: visitor!.name, displayName: visitor!.name }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, attestation: 'none', excludeCredentials: kind === 'passkeys' ? account!.keys.map((key) => ({ type: 'public-key', id: key.id })) : [], extensions: { credProps: true } } : { challenge, rpId: new URL(origin).hostname, userVerification: 'required', ...(account ? { allowCredentials: account.keys.map((key) => ({ type: 'public-key', id: key.id })) } : {}) };
      return { status: 200, value: { id: ceremonyId, expiresAt: new Date(Date.now() + 300_000).toISOString(), options: { publicKey } } };
    }
    const ceremony = this.ceremonies.get(String(input.ceremonyId));
    if (!ceremony || ceremony.kind !== kind || ceremony.token !== this.hooks.token(req)) throw new FixtureError(403, 'invalid_proof');
    this.ceremonies.delete(String(input.ceremonyId));
    if (kind === 'passkeys') {
      if (this.fault === 'finish-expired') { this.fault = 'none'; this.expireProof(); }
      this.proof(this.require(req, true));
    }
    const credential = input.credential as { id?: string; rawId?: string; type?: string; response?: Record<string, string> } | undefined;
    let client: { type?: string; challenge?: string; origin?: string };
    try { client = JSON.parse(Buffer.from(credential?.response?.clientDataJSON ?? '', 'base64url').toString()); } catch { throw new FixtureError(403, 'invalid_proof'); }
    const create = ['registration', 'recovery', 'passkeys'].includes(kind);
    if (!credential?.id || credential.type !== 'public-key' || credential.rawId !== credential.id || client.challenge !== ceremony.challenge || client.origin !== origin || client.type !== (create ? 'webauthn.create' : 'webauthn.get') || !(create ? credential.response?.attestationObject : credential.response?.signature && credential.response?.authenticatorData)) throw new FixtureError(403, 'invalid_proof');
    if (kind === 'authentication' || kind === 'reauthentication') {
      const account = [...this.accounts.values()].find((candidate) => candidate.keys.some((key) => key.id === credential.id));
      if (!account || (ceremony.account && ceremony.account !== account)) throw new FixtureError(403, 'invalid_proof');
      if (kind === 'reauthentication') { const session = this.require(req, true); session.proofAt = Date.now(); session.proofKey = credential.id; return { status: 200, value: this.publicSession(session) }; }
      const token = this.hooks.issue(res, account.visitor);
      const session: Session = { visitor: account.visitor, kind: 'account', expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString(), proofAt: Date.now(), proofKey: credential.id };
      this.sessions.set(token, session);
      return { status: 200, value: { session: this.publicSession(session), recoveryCodes: [] } };
    }
    if ([...this.accounts.values()].some((account) => account.keys.some((key) => key.id === credential.id))) throw new FixtureError(409, 'credential_exists');
    const key: Schema['AccountPasskey'] = { id: credential.id, label: typeof input.label === 'string' && input.label.trim() ? input.label.trim() : 'Passkey', createdAt: new Date().toISOString() };
    if (kind === 'passkeys') { ceremony.account!.keys.push(key); return { status: 201, value: key }; }
    if (kind === 'registration') {
      this.hooks.name(ceremony.visitor!.name);
      if (this.usedInvitations.has(ceremony.invitation!)) throw new FixtureError(403, 'invalid_proof');
      if ([...this.accounts.values()].some((account) => account.visitor.id !== ceremony.visitor!.id && account.visitor.name.toLowerCase() === ceremony.visitor!.name.toLowerCase())) throw new FixtureError(409, 'name_taken');
      this.usedInvitations.add(ceremony.invitation!);
    }
    if (kind === 'recovery' && ceremony.proof !== undefined && ceremony.proof !== ceremony.account!.phrase) throw new FixtureError(403, 'invalid_proof');
    const account: Account = ceremony.account ?? { visitor: ceremony.visitor!, keys: [], phrase: '' };
    account.keys = [key]; account.phrase = this.phrase(); this.accounts.set(account.visitor.id, account);
    const session = this.enroll(res, account, key.id);
    const lost = this.fault === 'finish-lost'; this.fault = 'none';
    return { status: 201, value: { session, recoveryCodes: [account.phrase] }, lost };
  }
}
