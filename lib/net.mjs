/**
 * 网络信息工具：枚举局域网 IPv4、挑选主网卡、拼 URL、校验二维码目标。
 */
import os from 'node:os';

const VIRTUAL_HINTS = [
  'vethernet', 'virtualbox', 'vmware', 'hyper-v', 'loopback', 'docker',
  'tap', 'tun', 'zt', 'tailscale', 'radmin', 'npcap',
];
const PRIMARY_HINTS = ['wi-fi', 'wifi', 'wlan', 'ethernet', '以太网', '无线', 'en0', 'eth'];

/**
 * 列出所有非内网的 IPv4 网卡地址。
 * @returns {{name: string, address: string, internal: boolean}[]}
 */
export function listLanIPv4() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list || []) {
      const family = typeof item.family === 'string' ? item.family : String(item.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (item.internal) continue;
      const address = item.address;
      if (!address || address.startsWith('169.254.')) continue; // 链路本地地址不可用
      result.push({ name, address, internal: false });
    }
  }
  return result;
}

/** 判断网卡名是否像虚拟网卡（用于排序，不直接排除，避免误杀真实网卡）。 */
function isVirtual(name) {
  const lower = String(name).toLowerCase();
  return VIRTUAL_HINTS.some((hint) => lower.includes(hint));
}

/**
 * 选“主网卡”：优先常见家用网段（192.168/10/172.16-31）、物理网卡（Wi-Fi / 以太网命名），
 * 降权虚拟网卡与 198.18/198.19（VPN / TUN 常占用的基准测试网段）。
 * @param {ReturnType<typeof listLanIPv4>} [lan]
 * @returns {{name: string, address: string} | null}
 */
export function pickPrimaryIPv4(lan = listLanIPv4()) {
  if (lan.length === 0) return null;
  const scored = lan.map((item) => {
    const name = String(item.name).toLowerCase();
    let score = 0;
    if (PRIMARY_HINTS.some((hint) => name.includes(hint))) score += 4;
    if (!isVirtual(item.name)) score += 2;
    if (isPrivateLanAddress(item.address)) score += 3;
    // 198.18.0.0/15 常被代理软件用作 TUN 地址，手机通常无法直连
    if (/^198\.(18|19)\./.test(item.address)) score -= 8;
    return { item, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].item;
}

/** 是否属于常见局域网私有网段 */
function isPrivateLanAddress(address) {
  return (
    /^192\.168\./.test(address) ||
    /^10\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

/**
 * 根据端口与协议生成手机访问 URL 列表。
 * @param {number} port
 * @param {boolean} secure 是否 HTTPS
 * @param {ReturnType<typeof listLanIPv4>} [lan]
 * @returns {{ip: string, url: string}[]}
 */
export function buildUrls(port, secure, lan = listLanIPv4()) {
  const scheme = secure ? 'https' : 'http';
  const urls = lan.map((item) => ({ ip: item.address, url: `${scheme}://${item.address}:${port}` }));
  // 把主网卡放最前：启动横幅与手机二维码都用第一条
  const primary = pickPrimaryIPv4(lan);
  if (primary) {
    const index = urls.findIndex((item) => item.ip === primary.address);
    if (index > 0) {
      const [first] = urls.splice(index, 1);
      urls.unshift(first);
    }
  }
  if (urls.length === 0) urls.push({ ip: '127.0.0.1', url: `${scheme}://127.0.0.1:${port}` });
  return urls;
}

/**
 * 判断二维码目标 URL 是否属于“本站 host 或局域网 IP”。
 * 允许：localhost、回环地址、本机局域网 IPv4、与本请求 Host 相同的主机名。
 * @param {string} raw 二维码内容
 * @param {{hostHeader?: string, lan?: ReturnType<typeof listLanIPv4>}} context
 * @returns {{ok: true, url: URL} | {ok: false, reason: string}}
 */
export function validateQrTarget(raw, context = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: '缺少 data 参数' };
  }
  if (raw.length > 1024) {
    return { ok: false, reason: 'data 参数过长（上限 1024 字符）' };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'data 不是合法的 URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: '仅支持 http/https URL' };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  for (const item of context.lan || listLanIPv4()) allowedHosts.add(item.address.toLowerCase());

  // 允许与当前请求 Host 完全一致的主机名（含端口一并比较时只比 hostname）
  if (context.hostHeader) {
    try {
      allowedHosts.add(new URL(`http://${context.hostHeader}`).hostname.toLowerCase());
    } catch {
      /* Host 头异常时忽略，不影响局域网白名单 */
    }
  }

  if (!allowedHosts.has(hostname)) {
    return { ok: false, reason: `不允许为非本站域名生成二维码：${hostname}` };
  }
  return { ok: true, url };
}
