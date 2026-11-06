import type { ShareTrack } from '../voice/types';

/** A local canvas stream, never a screen/device capture or an RTP connection. */
export class SyntheticShare implements ShareTrack {
  readonly id = crypto.randomUUID();
  private stream: MediaStream | null = null;
  private frame = 0;
  private elements = new Set<HTMLVideoElement>();

  constructor(private readonly name: string) {}
  get mediaStreamTrack(): MediaStreamTrack | undefined { return this.stream?.getVideoTracks()[0]; }

  attach(element: HTMLVideoElement): void {
    if (!this.stream) {
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 540;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const draw = (time: number) => {
        const gradient = ctx.createLinearGradient(0, 0, 960, 540);
        gradient.addColorStop(0, '#17243b');
        gradient.addColorStop(1, '#45245a');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 960, 540);
        ctx.fillStyle = '#92dfcb';
        ctx.beginPath();
        ctx.arc(480 + Math.sin(time / 1300) * 230, 275 + Math.cos(time / 1800) * 90, 65, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = '28px sans-serif';
        ctx.fillText(`${this.name} · Simulated screen`, 38, 60);
        ctx.font = '18px sans-serif';
        ctx.fillText('Synthetic preview · no device capture', 38, 500);
        this.frame = requestAnimationFrame(draw);
      };
      draw(performance.now());
      this.stream = canvas.captureStream(30);
    }
    this.elements.add(element);
    element.srcObject = this.stream;
    void element.play().catch(() => {});
  }

  detach(element: HTMLVideoElement): void {
    element.srcObject = null;
    this.elements.delete(element);
    if (!this.elements.size) this.stopStream();
  }
  stop(): void {
    for (const element of this.elements) element.srcObject = null;
    this.elements.clear();
    this.stopStream();
  }
  private stopStream(): void {
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}
