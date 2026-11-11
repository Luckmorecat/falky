import { expect, type Page, type CDPSession } from '@playwright/test';
import type { MockState } from '../mock/protocol';

export async function virtualAuthenticator(page: Page, transport: 'internal' | 'usb' = 'internal', existing?: CDPSession) {
  const client = existing ?? await page.context().newCDPSession(page);
  if (!existing) await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport, hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { client, authenticatorId };
}
export async function authPreferences(page: Page, url: string, scenario = 'signed-out') {
  const state: MockState = await (await page.request.post(url + '/__mock/reset', { data: { scenario } })).json();
  await page.addInitScript((state) => {
    localStorage.setItem(`falky.mock-generation.${state.instanceId}`, String(state.generation));
    localStorage.setItem(`falky.mock.${state.instanceId}.language`, 'en');
  }, state);
  return state;
}
export async function registerFixture(page: Page, url: string, name = 'Taylor') {
  await page.goto(`${url}/?scenario=signed-out#invite=mock-invitation`);
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create your passkey', exact: true }).click();
  const kit = page.getByRole('dialog', { name: 'Keep your way back.', exact: true });
  await expect(kit).toBeVisible();
  const accountId = await kit.locator('dd').innerText();
  const phrase = (await kit.locator('ol strong').allTextContents()).join(' ');
  return { kit, accountId, phrase };
}
export async function acknowledgeKit(page: Page) {
  await page.getByRole('checkbox', { name: 'I saved both my account ID and recovery phrase', exact: true }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Keep your way back.', exact: true })).not.toBeVisible();
}
export async function accountSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Passkeys', exact: true })).toBeVisible();
}
