// QR code generation. Returns a module matrix and a compact SVG path that is
// reused for on-screen SVGs and for the vector drawing inside label PDFs.
import qrcode from 'qrcode-generator';

/**
 * Error correction level Q (25 %) keeps codes readable when a label is
 * scratched or dirty, at the cost of slightly more modules.
 */
export function qrMatrix(text, level = 'Q') {
  const code = qrcode(0, level);
  code.addData(text, 'Byte');
  code.make();
  const size = code.getModuleCount();
  let path = '';
  for (let row = 0; row < size; row++) {
    let start = -1;
    for (let col = 0; col <= size; col++) {
      const dark = col < size && code.isDark(row, col);
      if (dark && start === -1) start = col;
      else if (!dark && start !== -1) {
        path += `M${start} ${row}h${col - start}v1h-${col - start}z`;
        start = -1;
      }
    }
  }
  return { size, path };
}

/** Stand-alone SVG markup; `margin` is the quiet zone in modules. */
export function qrSvg(text, { margin = 2, title = '' } = {}) {
  const { size, path } = qrMatrix(text);
  const total = size + margin * 2;
  const label = title ? `<title>${title.replace(/[&<>]/g, '')}</title>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img">` +
    `${label}<rect width="${total}" height="${total}" fill="#fff"/>` +
    `<path transform="translate(${margin} ${margin})" fill="#000" d="${path}"/></svg>`
  );
}
