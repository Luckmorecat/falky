import type { IScannerControls } from '@zxing/browser';

export interface QRScanner { stop(): void }
export function startQRScanner(video: HTMLVideoElement, onResult: (value: string) => void, onError: (error: unknown) => void): QRScanner {
  let stopped = false;
  let stream: MediaStream | undefined;
  let decoder: IScannerControls | undefined;
  const stop = () => {
    stopped = true; decoder?.stop(); decoder = undefined;
    stream?.getTracks().forEach(track => track.stop()); stream = undefined;
    video.srcObject = null;
  };
  void (async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('Camera unavailable', 'NotFoundError');
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      if (stopped) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired; video.srcObject = stream;
      await video.play();
      if (stopped) return;
      const [{ BrowserQRCodeReader }, { NotFoundException, ChecksumException, FormatException }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
      if (stopped) return;
      const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 250, delayBetweenScanSuccess: 500 });
      const controls = reader.scan(video, (result, error) => {
        if (stopped) return;
        if (result) { stop(); onResult(result.getText()); }
        else if (error && !(error instanceof NotFoundException || error instanceof ChecksumException || error instanceof FormatException)) { stop(); onError(error); }
      });
      if (stopped) controls.stop(); else decoder = controls;
    } catch (error) { if (!stopped) { stop(); onError(error); } }
  })();
  return { stop };
}
