function escapePrintText(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[char]));
}

export function renderHighResolutionQr(canvas, value) {
  if (!canvas || !value) throw new Error('A QR canvas and URL are required.');
  if (!globalThis.QRCode?.toCanvas) throw new Error('QR renderer is still loading. Please try again.');

  canvas.width = 512;
  canvas.height = 512;
  canvas.style.width = '220px';
  canvas.style.height = '220px';
  return new Promise((resolve, reject) => {
    globalThis.QRCode.toCanvas(canvas, value, {
      width: 512,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: { dark: '#0f172a', light: '#ffffff' },
    }, (error) => error ? reject(error) : resolve(canvas));
  });
}

export async function copyText(value) {
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (_) {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}

export function downloadCanvas(canvas, filename) {
  if (!canvas) return false;
  const anchor = document.createElement('a');
  anchor.href = canvas.toDataURL('image/png');
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
}

export async function shareQr({ title, text, url }) {
  if (navigator.share) {
    await navigator.share({ title, text, url });
    return 'shared';
  }
  return (await copyText(url)) ? 'copied' : 'failed';
}

export function printQrCanvas(canvas, platformName, cleanUrl) {
  if (!canvas) return false;
  const printWindow = window.open('', '_blank', 'noopener,noreferrer');
  if (!printWindow) return false;
  const image = canvas.toDataURL('image/png');
  printWindow.document.write(`<!doctype html><html><head><title>${escapePrintText(platformName)} QR Code</title><style>
    @page { size: A4; margin: 18mm; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, sans-serif; color: #0f172a; background: #fff; }
    main { text-align: center; width: 100%; }
    img { width: 512px; height: 512px; max-width: 82vw; max-height: 65vh; image-rendering: pixelated; }
    h1 { margin: 16px 0 8px; font-size: 28px; }
    p { margin: 0; font-size: 16px; word-break: break-all; }
  </style></head><body><main><img src="${image}" alt="QR code"><h1>${escapePrintText(platformName)}</h1><p>${escapePrintText(cleanUrl)}</p></main></body></html>`);
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => {
    printWindow.print();
    window.setTimeout(() => printWindow.close(), 500);
  }, 120);
  return true;
}
