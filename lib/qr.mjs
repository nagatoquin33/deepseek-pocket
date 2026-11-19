/**
 * 二维码（可选依赖 qrcode）。
 * 未安装时：/api/qr 返回 503 并给出安装提示；启动横幅跳过二维码，不影响服务运行。
 */
let cached;

/**
 * 懒加载 qrcode 模块（纯 JS 可选依赖）。
 * @returns {Promise<any | null>}
 */
export async function loadQrModule() {
  if (cached !== undefined) return cached;
  try {
    const mod = await import('qrcode');
    const api = mod && typeof mod.toBuffer === 'function' ? mod : mod?.default;
    cached = api && typeof api.toBuffer === 'function' ? api : null;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * 生成 PNG 二维码。
 * @param {string} data
 * @param {{width?: number, margin?: number}} [options]
 * @returns {Promise<Buffer | null>} 未安装 qrcode 时返回 null
 */
export async function renderQrPng(data, options = {}) {
  const api = await loadQrModule();
  if (!api) return null;
  const { width = 320, margin = 2 } = options;
  return api.toBuffer(data, {
    type: 'png',
    width,
    margin,
    errorCorrectionLevel: 'M',
  });
}

/**
 * 生成终端可打印的二维码（Unicode 块字符）。
 * @param {string} data
 * @returns {Promise<string | null>} 未安装 qrcode 时返回 null
 */
export async function renderQrTerminal(data) {
  const api = await loadQrModule();
  if (!api) return null;
  return api.toString(data, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
}
