import { afterEach, expect, it, vi } from 'vitest';
import { createCredential, getCredential } from './webauthn';

afterEach(() => vi.unstubAllGlobals());

it('decodes registration bytes for the native browser and serializes its attestation', async () => {
  const create = vi.fn(async (input: CredentialCreationOptions) => {
    expect(Array.from(new Uint8Array(input.publicKey!.challenge as ArrayBuffer))).toEqual([0, 255, 128]);
    expect(Array.from(new Uint8Array(input.publicKey!.user.id as ArrayBuffer))).toEqual([1, 2]);
    expect(Array.from(new Uint8Array(input.publicKey!.excludeCredentials![0]!.id as ArrayBuffer))).toEqual([255]);
    return { id: 'key', rawId: new Uint8Array([255]).buffer, type: 'public-key', authenticatorAttachment: 'platform',
      response: { clientDataJSON: new Uint8Array([1]).buffer, attestationObject: new Uint8Array([2, 255]).buffer, getTransports: () => ['internal'] },
      getClientExtensionResults: () => ({ credProps: { rk: true } }) };
  });
  vi.stubGlobal('navigator', { credentials: { create } });
  const result = await createCredential({ publicKey: { challenge: 'AP-A', user: { id: 'AQI', name: 'Alex', displayName: 'Alex' }, rp: { name: 'Falky' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [{ type: 'public-key', id: '_w' }] } });
  expect(result).toEqual({ id: 'key', rawId: '_w', type: 'public-key', authenticatorAttachment: 'platform', response: { clientDataJSON: 'AQ', attestationObject: 'Av8', transports: ['internal'] }, clientExtensionResults: { credProps: { rk: true } } });
});

it('sends discoverable assertions and nullable user handles without fabricated verification', async () => {
  const get = vi.fn(async (input: CredentialRequestOptions) => {
    expect(Array.from(new Uint8Array(input.publicKey!.challenge as ArrayBuffer))).toEqual([0, 255, 128]);
    expect(input.publicKey!.allowCredentials).toBeUndefined();
    return { id: 'key', rawId: new Uint8Array([255]).buffer, type: 'public-key', response: { clientDataJSON: new Uint8Array([1]).buffer, authenticatorData: new Uint8Array([2]).buffer, signature: new Uint8Array([3]).buffer, userHandle: null }, getClientExtensionResults: () => ({}) };
  });
  vi.stubGlobal('navigator', { credentials: { get } });
  expect(await getCredential({ publicKey: { challenge: 'AP-A', userVerification: 'required' } })).toEqual({ id: 'key', rawId: '_w', type: 'public-key', authenticatorAttachment: null, response: { clientDataJSON: 'AQ', authenticatorData: 'Ag', signature: 'Aw', userHandle: null }, clientExtensionResults: {} });
});

it('reports cancellation and unsupported browsers as distinct retryable errors', async () => {
  vi.stubGlobal('navigator', { credentials: { get: async () => { throw new DOMException('cancel', 'NotAllowedError'); } } });
  await expect(getCredential({ publicKey: { challenge: 'AQ' } })).rejects.toMatchObject({ code: 'cancelled' });
  vi.stubGlobal('navigator', {});
  await expect(getCredential({ publicKey: { challenge: 'AQ' } })).rejects.toMatchObject({ code: 'unsupported' });
});
