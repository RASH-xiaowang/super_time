/**
 * 常见厂商「官方模型」内置参考清单。
 *
 * 背景：几乎各家 /models 接口都需要鉴权，未填 API Key 时直接失败，
 * 用户连「先看看有哪些模型可选」都做不到。模型 id 本身是公开信息，
 * 这里按 base_url 主机名提供内置清单：
 *   - 拉取失败（401/403）且未填 Key → 返回内置清单（source='catalog'）
 *   - 网络不可达且未填 Key → 同样回退内置清单（并如实说明原因）
 *   - 填了 Key 的失败 → 照常报错（用户已经有凭据，错误更有价值）
 * 清单仅供选择参考，实时列表以厂商接口为准。
 */

/** @type {Array<{ hosts: string[]; vendor: string; models: string[] }>} */
const CATALOG = [
  {
    hosts: ['api.deepseek.com'],
    vendor: 'DeepSeek',
    // 以 /models 实时返回为准（实测 2026-09：deepseek-flash / deepseek-v4-pro）。
    // 旧值 deepseek-chat / deepseek-reasoner 已下线，未填 Key 的用户会照单全收那个错名字。
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  },
  {
    hosts: ['dashscope.aliyuncs.com'],
    vendor: '通义千问（阿里百炼）',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'],
  },
  {
    hosts: ['api.moonshot.cn'],
    vendor: 'Moonshot Kimi',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2-0711-preview'],
  },
  {
    hosts: ['api.siliconflow.cn'],
    vendor: '硅基流动 SiliconFlow',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1'],
  },
  {
    hosts: ['api.hunyuan.cloud.tencent.com'],
    vendor: '腾讯混元',
    models: ['hunyuan-lite', 'hunyuan-standard', 'hunyuan-pro'],
  },
  {
    hosts: ['qianfan.baidubce.com'],
    vendor: '百度千帆（文心）',
    models: ['ernie-4.0-turbo-8k', 'ernie-3.5-8k', 'ernie-speed-128k'],
  },
  {
    hosts: ['api.openai.com'],
    vendor: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini'],
  },
];

/**
 * 按 base_url 查找内置清单。
 * @param {string} baseUrl - 用户填写的 API 地址（任意后缀均可，只按主机名匹配）。
 * @returns {{ vendor: string, models: string[] } | null}
 */
function findByBaseUrl(baseUrl) {
  let host = '';
  try {
    host = new URL(String(baseUrl)).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  for (const entry of CATALOG) {
    if (entry.hosts.some((h) => host === h || host.endsWith('.' + h))) {
      return { vendor: entry.vendor, models: [...entry.models] };
    }
  }
  return null;
}

module.exports = { CATALOG, findByBaseUrl };
