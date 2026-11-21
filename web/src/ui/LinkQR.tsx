import { useEffect, useState } from 'react';

/** A link as a QR code a phone camera opens; the encoder loads only when one is shown. */
export function LinkQR({ url, label }: { url: string; label: string }) {
  const [shape, setShape] = useState<{ size: number; path: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import('@zxing/library').then(({ QRCodeEncoder, QRCodeDecoderErrorCorrectionLevel }) => {
      if (cancelled) return;
      const matrix = QRCodeEncoder.encode(url, QRCodeDecoderErrorCorrectionLevel.M).getMatrix();
      const size = matrix.getWidth();
      let path = '';
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (matrix.get(x, y) === 1) path += `M${x} ${y}h1v1h-1z`;
      setShape({ size, path });
    }, () => {});
    return () => { cancelled = true; };
  }, [url]);
  // A quiet zone of four modules on every side, as scanners expect.
  return (
    <div className="link-qr">
      {shape && (
        <svg viewBox={`-4 -4 ${shape.size + 8} ${shape.size + 8}`} role="img" aria-label={label} shapeRendering="crispEdges">
          <rect x="-4" y="-4" width={shape.size + 8} height={shape.size + 8} fill="#fff" />
          <path d={shape.path} fill="#000" />
        </svg>
      )}
    </div>
  );
}
