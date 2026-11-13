import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AccountFixture, FixtureError } from './account-fixture.ts';
import type { Schema } from './protocol.ts';

type Request = { view: Schema['SignInRequest']; binding: string; code?: string; qr?: string; approver?: string; delivery?: string };
type Link = { view: Schema['SignInLink']; issuer: string; token: string; attempts: number; notifiedAt: number; codes: Set<string> };
const secret = () => randomBytes(32).toString('base64url');
const fail = (code = 'invalid_proof', status = 403): never => { throw new FixtureError(status, code); };

/** Contract simulator, not a model of backend cryptography or transactional security. */
export class DeviceFixture {
  private requests = new Map<string, Request>();
  private links = new Map<string, Link>();
  fault: 'none' | 'rate-limited' | 'finish-lost' = 'none';
  constructor(private hooks: { id(): string; accounts: AccountFixture; cookieName: string; token(req: IncomingMessage): string; publish(issuer: string, request: Schema['SignInRequest']): void }) {}
  reset() { this.requests.clear(); this.links.clear(); this.fault = 'none'; }
  expire(requestId?: string, linkId?: string) {
    for (const request of this.requests.values()) if (!requestId && !linkId || request.view.id === requestId || request.view.linkId === linkId) request.view.expiresAt = new Date(Date.now() - 1000).toISOString();
    for (const link of this.links.values()) if (!requestId && !linkId || link.view.id === linkId) link.view.expiresAt = new Date(Date.now() - 1000).toISOString();
  }
  initial(issuer: string): Schema['SignInRequest'][] {
    return [...this.links.values()].filter(link => link.issuer === issuer && Date.parse(link.view.expiresAt) > Date.now()).flatMap(link => this.linkView(link).requests);
  }
  private live(view: { expiresAt: string }) { if (Date.parse(view.expiresAt) <= Date.now()) fail(); }
  private account(req: IncomingMessage) {
    const session = this.hooks.accounts.resolve(req);
    if (session?.kind !== 'account') fail('visitor_required', 401);
    return session!;
  }
  private binding(req: IncomingMessage) {
    return req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(this.hooks.cookieName + '='))?.slice(this.hooks.cookieName.length + 1) ?? '';
  }
  private bind(req: IncomingMessage, res: ServerResponse) {
    const binding = this.binding(req) || secret();
    res.setHeader('Set-Cookie', `${this.hooks.cookieName}=${binding}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600`);
    return binding;
  }
  private linkView(link: Link): Schema['SignInLink'] {
    return { ...link.view, requests: [...this.requests.values()].filter(request => request.view.linkId === link.view.id).map(request => ({ ...request.view })) };
  }
  private issuer(req: IncomingMessage, id: string) {
    this.account(req);
    const link = this.links.get(id);
    if (!link || link.issuer !== this.hooks.token(req)) return fail();
    this.live(link.view);
    return link;
  }
  private bound(req: IncomingMessage, id: string) {
    const request = this.requests.get(id);
    if (!request || !this.binding(req) || request.binding !== this.binding(req)) return fail();
    this.live(request.view);
    const link = request.view.linkId ? this.links.get(request.view.linkId) : undefined;
    if (link && (link.view.state === 'revoked' || !this.hooks.accounts.sessions.has(link.issuer)) && ['pending', 'approved'].includes(request.view.state)) this.change(request, 'cancelled');
    if (request.view.state === 'approved' && (!request.approver || !this.hooks.accounts.sessions.has(request.approver))) {
      this.change(request, 'cancelled');
    }
    if (request.view.state === 'consumed' && (!request.delivery || !this.hooks.accounts.sessions.has(request.delivery))) fail();
    return request;
  }
  private conflict(req: IncomingMessage, accountId?: string, exactDelivery?: string) {
    const current = this.hooks.accounts.resolve(req);
    if (!current || exactDelivery && this.hooks.token(req) === exactDelivery) return;
    if (current.kind === 'account') fail(current.visitor.id === accountId ? 'already_signed_in' : 'account_switch_required', 409);
    if (exactDelivery) fail('signin_conflict', 409);
  }
  private change(request: Request, state: Schema['SignInRequest']['state']) {
    request.view = { ...request.view, state, version: request.view.version + 1,
      ...(state === 'approved' ? { approvedAt: new Date().toISOString() } : {}),
      ...(state === 'consumed' ? { consumedAt: new Date().toISOString() } : {}) };
    if (request.view.linkId) {
      const link = this.links.get(request.view.linkId)!;
      this.hooks.publish(link.issuer, request.view);
    }
  }
  private revoke(link: Link) {
    if (link.view.state === 'consumed') return fail('signin_conflict', 409);
    link.view = { ...link.view, state: 'revoked', version: link.view.version + 1 };
    for (const request of this.requests.values()) if (request.view.linkId === link.view.id && ['pending', 'approved'].includes(request.view.state)) this.change(request, 'cancelled');
  }
  private create(type: 'qr' | 'link', binding: string, req: IncomingMessage, link?: Link): Request {
    const createdAt = new Date().toISOString();
    const request: Request = { binding, view: { id: this.hooks.id(), type, state: 'pending', version: 1, requesterIp: req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '', requesterUserAgent: [...(req.headers['user-agent'] ?? 'Browser')].slice(0, 256).join(''), createdAt, expiresAt: link?.view.expiresAt ?? new Date(Date.now() + 300_000).toISOString(), ...(link ? { linkId: link.view.id } : {}) } };
    if (link) {
      for (let number = 0; number < 10000; number++) {
        const code = String(number).padStart(4, '0');
        if (!link.codes.has(code)) { request.code = code; link.codes.add(code); break; }
      }
      link.notifiedAt = Date.now();
    } else request.qr = secret();
    this.requests.set(request.view.id, request);
    if (link) this.hooks.publish(link.issuer, request.view);
    return request;
  }
  private begin(request: Request, origin: string) {
    return { request: request.view, ...(request.qr ? { token: request.qr, url: `${origin}/#qr-signin=${request.qr}` } : { code: request.code }) } satisfies Schema['SignInBegin'];
  }
  handle(path: string, req: IncomingMessage, res: ServerResponse, input: Record<string, unknown>, origin: string): { status: number; value?: unknown; lost?: boolean } | undefined {
    if (!/^\/api\/accounts\/(signin-links|signin-requests|qr-signins)(\/|$)/.test(path)) return;
    if (this.fault === 'rate-limited') { this.fault = 'none'; res.setHeader('Retry-After', '5'); fail('rate_limited', 429); }
    const bearer = () => { if (typeof input.token !== 'string' || !input.token || input.token.length > 256) return fail('invalid_request', 400); return input.token; };
    const ok = (value: unknown = {}) => ({ status: 200, value });
    if (path === '/api/accounts/signin-links' && req.method === 'POST') {
      this.account(req);
      for (const link of this.links.values()) if (link.issuer === this.hooks.token(req) && ['open', 'approved'].includes(link.view.state)) this.revoke(link);
      const createdAt = new Date().toISOString();
      const link: Link = { issuer: this.hooks.token(req), token: secret(), attempts: 0, notifiedAt: 0, codes: new Set(), view: { id: this.hooks.id(), state: 'open', version: 1, createdAt, expiresAt: new Date(Date.now() + 300_000).toISOString(), approvalGrantsRecentProof: false, requests: [] } };
      this.links.set(link.view.id, link);
      return ok({ link: this.linkView(link), token: link.token, url: `${origin}/#signin=${link.token}` } satisfies Schema['SignInLinkResult']);
    }
    const linkPath = /^\/api\/accounts\/signin-links\/([^/]+)(?:\/(approve|requests\/([^/]+)\/deny))?$/.exec(path);
    if (linkPath) {
      const link = this.issuer(req, linkPath[1]!);
      if (req.method === 'GET' && !linkPath[2]) return ok(this.linkView(link));
      if (req.method === 'DELETE' && !linkPath[2]) { this.revoke(link); return ok(); }
      if (req.method === 'POST' && linkPath[2] === 'approve') {
        if (typeof input.code !== 'string' || !/^[0-9]{4}$/.test(input.code)) return fail('invalid_request', 400);
        if (link.view.state !== 'open') return fail();
        const request = [...this.requests.values()].find(request => request.view.linkId === link.view.id && request.view.state === 'pending' && request.code === input.code);
        if (!request) { link.attempts++; if (link.attempts >= 5) this.revoke(link); return fail(); }
        request.approver = link.issuer; this.change(request, 'approved');
        link.view = { ...link.view, state: 'approved', version: link.view.version + 1 };
        for (const other of this.requests.values()) if (other !== request && other.view.linkId === link.view.id && other.view.state === 'pending') this.change(other, 'cancelled');
        return ok(request.view);
      }
      if (req.method === 'POST' && linkPath[3]) {
        const request = this.requests.get(linkPath[3]);
        if (!request || request.view.linkId !== link.view.id || request.view.state !== 'pending' || link.view.state !== 'open') return fail();
        this.change(request, 'denied'); return ok();
      }
      return fail('not_found', 404);
    }
    if (path === '/api/accounts/signin-requests' && req.method === 'POST') {
      const link = [...this.links.values()].find(link => link.token === bearer());
      if (!link || !this.hooks.accounts.sessions.has(link.issuer)) return fail(); this.live(link.view);
      this.conflict(req, this.hooks.accounts.sessions.get(link.issuer)?.visitor.id);
      const binding = this.bind(req, res);
      const previous = [...this.requests.values()].find(request => request.binding === binding && request.view.linkId === link.view.id);
      if (previous) {
        if (['denied', 'cancelled'].includes(previous.view.state)) return fail();
        return ok(this.begin(previous, origin));
      }
      if (link.view.state !== 'open') return fail();
      if (this.linkView(link).requests.filter(request => request.state === 'pending').length >= 3) return fail('pending_request_cap', 409);
      return ok(this.begin(this.create('link', binding, req, link), origin));
    }
    if (path === '/api/accounts/qr-signins' && req.method === 'POST') {
      this.conflict(req);
      if (input.replace !== undefined && typeof input.replace !== 'boolean') return fail('invalid_request', 400);
      const oldBinding = this.binding(req);
      const previous = [...this.requests.values()].reverse().find(request => request.binding === oldBinding && request.view.type === 'qr');
      if (input.replace && (!oldBinding || !previous)) return fail();
      if (previous && Date.parse(previous.view.expiresAt) > Date.now()) {
        if (!input.replace) {
          if (['denied', 'cancelled'].includes(previous.view.state)) return fail();
          this.bind(req, res); return ok(this.begin(previous, origin));
        }
        if (previous.view.state === 'consumed') return fail('signin_conflict', 409);
        this.change(previous, 'cancelled');
      }
      return ok(this.begin(this.create('qr', this.bind(req, res), req), origin));
    }
    const qrAction = /^\/api\/accounts\/qr-signins\/(preview|approve|deny)$/.exec(path);
    if (qrAction && req.method === 'POST') {
      this.account(req);
      const request = [...this.requests.values()].find(request => request.qr === bearer());
      if (!request || request.view.state !== 'pending') return fail(); this.live(request.view);
      if (qrAction[1] === 'preview') return ok({ request: request.view, approvalGrantsRecentProof: false } satisfies Schema['SignInPreview']);
      if (qrAction[1] === 'approve') { request.approver = this.hooks.token(req); this.change(request, 'approved'); return ok(request.view); }
      this.change(request, 'denied'); return ok();
    }
    const qrCancel = /^\/api\/accounts\/qr-signins\/([^/]+)$/.exec(path);
    if (qrCancel && req.method === 'DELETE') {
      const request = this.bound(req, qrCancel[1]!);
      if (request.view.type !== 'qr') return fail();
      if (request.view.state === 'consumed') return fail('signin_conflict', 409);
      if (['pending', 'approved'].includes(request.view.state)) this.change(request, 'cancelled');
      return ok();
    }
    const candidate = /^\/api\/accounts\/signin-requests\/([^/]+)(?:\/(finish|resend))?$/.exec(path);
    if (candidate) {
      const request = this.bound(req, candidate[1]!);
      if (!candidate[2] && req.method === 'GET') return ok(request.view);
      if (req.method !== 'POST') return fail('not_found', 404);
      if (request.view.type === 'link') {
        const link = this.links.get(request.view.linkId!)!;
        if (link.token !== bearer() || !['open', 'approved', 'consumed'].includes(link.view.state)) return fail();
        if (candidate[2] === 'resend') {
          if (request.view.state !== 'pending' || link.view.state !== 'open') return fail();
          const wait = Math.ceil((link.notifiedAt + 10000 - Date.now()) / 1000);
          if (wait > 0) { res.setHeader('Retry-After', String(wait)); return fail('rate_limited', 429); }
          link.notifiedAt = Date.now(); this.hooks.publish(link.issuer, request.view); return ok();
        }
      } else if (input.token || candidate[2] === 'resend') return fail();
      if (candidate[2] !== 'finish' || !['approved', 'consumed'].includes(request.view.state)) return fail();
      const approver = request.delivery ? this.hooks.accounts.sessions.get(request.delivery) : this.hooks.accounts.sessions.get(request.approver!);
      if (!approver) return fail();
      this.conflict(req, approver.visitor.id, request.delivery);
      const delivery = this.hooks.accounts.deviceSession(res, approver.visitor, request.delivery);
      request.delivery = delivery.token;
      if (request.view.state !== 'consumed') {
        this.change(request, 'consumed');
        if (request.view.linkId) { const link = this.links.get(request.view.linkId)!; link.view = { ...link.view, state: 'consumed', version: link.view.version + 1 }; }
      }
      const lost = this.fault === 'finish-lost'; this.fault = 'none';
      return { status: 200, value: delivery.session, lost };
    }
    return fail('not_found', 404);
  }
}
