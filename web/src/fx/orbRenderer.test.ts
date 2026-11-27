import { describe, expect, it, vi } from 'vitest';
import { oklchToRgb, isDue } from './orbRenderer';

describe('isDue', () => {
  it('gives a voice every frame', () => {
    expect(isDue(0.5, 0.001)).toBe(true);
  });

  it('keeps a silent orb to a few pictures a second', () => {
    expect(isDue(0, 0.016)).toBe(false);
    expect(isDue(0, 0.07)).toBe(true);
  });
});

describe('oklchToRgb', () => {
  it('reads a colour as parts of one', () => {
    const [r, g, b] = oklchToRgb('oklch(0.672 0.148 254)');
    expect([r * 255, g * 255, b * 255].map(Math.round)).toEqual([79, 152, 238]);
  });

  it('keeps colours out of gamut within one', () => {
    expect(oklchToRgb('oklch(1 0.4 150)').every((c) => c >= 0 && c <= 1)).toBe(true);
  });
});

it('keeps the orb program bound between draws and rebinds on look and context changes', async () => {
  vi.resetModules();
  const { addOrb, setOrbLook } = await import('./orbRenderer');
  const noop = () => {};
  const gl = {
    createProgram: vi.fn(() => ({})),
    createShader: () => ({}),
    createBuffer: () => ({}),
    getUniformLocation: () => ({}),
    getProgramParameter: () => true,
    shaderSource: noop,
    compileShader: noop,
    attachShader: noop,
    bindAttribLocation: noop,
    linkProgram: noop,
    bindBuffer: noop,
    bufferData: noop,
    enableVertexAttribArray: noop,
    vertexAttribPointer: noop,
    useProgram: vi.fn(),
    viewport: noop,
    uniform1f: noop,
    uniform3fv: noop,
    drawArrays: vi.fn(),
  };
  const copy = vi.fn();
  let surface: HTMLCanvasElement | undefined;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string) {
    if (type === 'webgl') {
      surface = this;
      return gl as unknown as WebGLRenderingContext;
    }
    return { clearRect: noop, drawImage: copy } as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext);

  let pendingFrame: FrameRequestCallback | undefined;
  const cancelFrame = vi.fn();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => { pendingFrame = frame; return 1; });
  vi.stubGlobal('cancelAnimationFrame', cancelFrame);

  let resize: (width: number) => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) {
      resize = (width) => callback([{ contentRect: { width } }] as ResizeObserverEntry[], this as unknown as ResizeObserver);
    }
    observe = noop;
    disconnect = disconnect;
  });

  const tick = (time: number) => {
    const frame = pendingFrame;
    pendingFrame = undefined;
    expect(frame).toBeDefined();
    frame!(time);
  };
  const stop = addOrb({
    root: document.createElement('div'), canvas: document.createElement('canvas'), seed: 1,
    colors: ['oklch(0.6 0.1 250)', 'oklch(0.7 0.1 250)', 'oklch(0.5 0.1 250)', 'oklch(0.8 0.1 250)'],
    still: true,
  });
  try {
    resize(32);
    expect(gl.useProgram).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledTimes(1);

    tick(16);
    expect(gl.useProgram).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledTimes(1);

    resize(40);
    expect(gl.useProgram).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledTimes(2);

    setOrbLook('volume');
    tick(32);
    expect(gl.useProgram).toHaveBeenCalledTimes(2);
    expect(gl.useProgram).toHaveBeenLastCalledWith(gl.createProgram.mock.results[1]?.value);
    expect(copy).toHaveBeenCalledTimes(3);

    surface!.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    tick(48);
    expect(copy).toHaveBeenCalledTimes(3);

    surface!.dispatchEvent(new Event('webglcontextrestored'));
    tick(64);
    expect(gl.useProgram).toHaveBeenCalledTimes(3);
    expect(gl.useProgram).toHaveBeenLastCalledWith(gl.createProgram.mock.results[3]?.value);
    expect(copy).toHaveBeenCalledTimes(4);
    expect(gl.drawArrays).toHaveBeenCalledTimes(4);
  } finally {
    stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  expect(disconnect).toHaveBeenCalledOnce();
  expect(cancelFrame).toHaveBeenCalledWith(1);
});
