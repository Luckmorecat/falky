export type CredentialJSON = Record<string, unknown>;

export class CredentialError extends Error {
  constructor(readonly code: 'cancelled' | 'unsupported' | 'rejected' | 'invalid_options') {
    super(code);
    this.name = 'CredentialError';
  }
}

function decode(value: string): ArrayBuffer {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer;
}

function encode(value: ArrayBuffer): string {
  let raw = '';
  for (const byte of new Uint8Array(value)) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function json(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return encode(value);
  if (ArrayBuffer.isView(value)) return encode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer);
  if (Array.isArray(value)) return value.map(json);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item)]));
  return value;
}

type DescriptorJSON = Omit<PublicKeyCredentialDescriptor, 'id'> & { id: string };
function descriptors(items?: DescriptorJSON[]): PublicKeyCredentialDescriptor[] | undefined {
  return items?.map((item) => ({ ...item, id: decode(item.id) }));
}

function serialize(credential: PublicKeyCredential): CredentialJSON {
  const response = credential.response;
  const common = { clientDataJSON: encode(response.clientDataJSON) };
  let data: Record<string, unknown>;
  if ('attestationObject' in response) {
    const attestation = response as AuthenticatorAttestationResponse;
    data = { ...common, attestationObject: encode(attestation.attestationObject), ...(attestation.getTransports ? { transports: attestation.getTransports() } : {}) };
  } else {
    const assertion = response as AuthenticatorAssertionResponse;
    data = { ...common, authenticatorData: encode(assertion.authenticatorData), signature: encode(assertion.signature), userHandle: assertion.userHandle === null ? null : encode(assertion.userHandle) };
  }
  return { id: credential.id, rawId: encode(credential.rawId), type: credential.type, authenticatorAttachment: credential.authenticatorAttachment ?? null, response: data, clientExtensionResults: json(credential.getClientExtensionResults()) };
}

function browserError(error: unknown, signal?: AbortSignal): never {
  if (error instanceof CredentialError) throw error;
  if (signal?.aborted || (error && typeof error === 'object' && 'name' in error && (error.name === 'NotAllowedError' || error.name === 'AbortError'))) throw new CredentialError('cancelled');
  if (error && typeof error === 'object' && 'name' in error && error.name === 'NotSupportedError') throw new CredentialError('unsupported');
  throw new CredentialError('rejected');
}

export async function createCredential(options: Record<string, unknown>, signal?: AbortSignal): Promise<CredentialJSON> {
  if (globalThis.isSecureContext === false || !navigator.credentials?.create) throw new CredentialError('unsupported');
  let publicKey: PublicKeyCredentialCreationOptions;
  try {
    const source = options.publicKey as Omit<PublicKeyCredentialCreationOptions, 'challenge' | 'user' | 'excludeCredentials'> & { challenge: string; user: Omit<PublicKeyCredentialUserEntity, 'id'> & { id: string }; excludeCredentials?: DescriptorJSON[] };
    publicKey = { ...source, challenge: decode(source.challenge), user: { ...source.user, id: decode(source.user.id) }, excludeCredentials: descriptors(source.excludeCredentials) };
  } catch { throw new CredentialError('invalid_options'); }
  try {
    signal?.throwIfAborted();
    const credential = await navigator.credentials.create({ publicKey, signal }) as PublicKeyCredential | null;
    if (!credential) throw new CredentialError('cancelled');
    signal?.throwIfAborted();
    return serialize(credential);
  } catch (error) { return browserError(error, signal); }
}

export async function getCredential(options: Record<string, unknown>, signal?: AbortSignal): Promise<CredentialJSON> {
  if (globalThis.isSecureContext === false || !navigator.credentials?.get) throw new CredentialError('unsupported');
  let publicKey: PublicKeyCredentialRequestOptions;
  try {
    const source = options.publicKey as Omit<PublicKeyCredentialRequestOptions, 'challenge' | 'allowCredentials'> & { challenge: string; allowCredentials?: DescriptorJSON[] };
    publicKey = { ...source, challenge: decode(source.challenge), allowCredentials: descriptors(source.allowCredentials) };
  } catch { throw new CredentialError('invalid_options'); }
  try {
    signal?.throwIfAborted();
    const credential = await navigator.credentials.get({ publicKey, signal }) as PublicKeyCredential | null;
    if (!credential) throw new CredentialError('cancelled');
    signal?.throwIfAborted();
    return serialize(credential);
  } catch (error) { return browserError(error, signal); }
}
