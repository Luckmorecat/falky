import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { setLanguage } from '../strings';
import { RecoveryWords } from './RecoveryKit';
let host: HTMLDivElement;
let root: Root;
function Words() { const [words, setWords] = useState(Array<string>(12).fill('')); return createElement(RecoveryWords, { words, onChange: setWords, onError: vi.fn() }); }
beforeEach(async () => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); setLanguage('en'); host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(createElement(Words))); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function paste(index: number, value: string) { const event = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: { getData: () => value } }); host.querySelectorAll('input')[index]!.dispatchEvent(event); }
it('pastes a full phrase at any cell, normalizes whitespace and case, and accepts actual hyphenated words', async () => { await act(async () => paste(5, ' ONE\nTWO three four five six seven eight nine ten eleven YO-YO ')); expect([...host.querySelectorAll('input')].map(i => i.value)).toEqual(['one','two','three','four','five','six','seven','eight','nine','ten','eleven','yo-yo']); });
it('pastes partial words at the selected position without overwriting on excess paste', async () => { await act(async () => paste(9, 'ten eleven')); expect(host.querySelectorAll('input')[9]!.value).toBe('ten'); await act(async () => paste(10, 'a b c')); expect(host.querySelectorAll('input')[10]!.value).toBe('eleven'); });
it('moves with Enter and empty Backspace without submitting a phrase', async () => { await act(async () => paste(0, 'one two')); const inputs = host.querySelectorAll('input'); inputs[0]!.focus(); await act(async () => inputs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))); expect(document.activeElement).toBe(inputs[1]); inputs[2]!.focus(); await act(async () => inputs[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))); expect(document.activeElement).toBe(inputs[1]); });

it('exports both permanent ID and phrase and requires deliberate acknowledgement before continuing', async () => {
  const { SaveRecoveryKit } = await import('./RecoveryKit');
  const done = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const phrase = 'one two three four five six seven eight nine ten eleven yo-yo';
  await act(async () => root.render(createElement(SaveRecoveryKit, { accountId: 'lasting-account', phrase, busy: false, onContinue: done })));
  const buttons = [...host.querySelectorAll('button')];
  const continueButton = buttons.find(button => button.textContent === 'Continue')!;
  expect(continueButton.disabled).toBe(true);
  await act(async () => continueButton.click()); expect(done).not.toHaveBeenCalled();
  await act(async () => buttons.find(button => button.textContent === 'Copy recovery kit')!.click());
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Account ID: lasting-account\nRecovery phrase: one two three four five six seven eight nine ten eleven yo-yo'));
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(continueButton.disabled).toBe(false);
  await act(async () => continueButton.click()); expect(done).toHaveBeenCalledOnce();
  await act(async () => root.render(createElement(SaveRecoveryKit, { accountId: 'lasting-account', phrase, busy: true, onContinue: done })));
  expect(continueButton.disabled).toBe(true);
});

it('ignores a clipboard completion after the kit is replaced', async () => {
  const { SaveRecoveryKit } = await import('./RecoveryKit');
  let finish!: () => void;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise<void>(resolve => { finish = resolve; }) } });
  const phrase = 'one two three four five six seven eight nine ten eleven yo-yo';
  await act(async () => root.render(createElement(SaveRecoveryKit, { key: 'first', accountId: 'first-owner', phrase, busy: false, onContinue: vi.fn() })));
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Copy recovery kit')!.click());
  await act(async () => root.render(createElement(SaveRecoveryKit, { key: 'next', accountId: 'next-owner', phrase, busy: false, onContinue: vi.fn() })));
  await act(async () => finish());
  expect(host.textContent).not.toContain('Recovery kit copied');
});

it('downloads both ID and phrase and releases the temporary file URL', async () => {
  const { SaveRecoveryKit } = await import('./RecoveryKit');
  const createURL = vi.fn((_blob: Blob) => 'blob:recovery-kit');
  const revokeURL = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: createURL, revokeObjectURL: revokeURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const phrase = 'one two three four five six seven eight nine ten eleven yo-yo';
  await act(async () => root.render(createElement(SaveRecoveryKit, { accountId: 'download-owner', phrase, busy: false, onContinue: vi.fn() })));
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Download recovery kit')!.click());
  const blob = createURL.mock.calls[0]![0] as Blob;
  const content = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob); });
  expect(content).toContain('Account ID: download-owner'); expect(content).toContain(`Recovery phrase: ${phrase}`);
  expect(click).toHaveBeenCalledOnce(); expect(revokeURL).toHaveBeenCalledWith('blob:recovery-kit');
  click.mockRestore();
});
