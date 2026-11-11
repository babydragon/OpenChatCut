import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Plugin } from 'vite';
import { getKey, type KeyName } from '../keystore.ts';
import {
  requireLlmProvider,
  llmProviderPreset,
  protocolForProvider,
  type LlmProvider,
} from '../../shared/llm-providers.ts';
import { resolveLlmProviderConfig } from '../llm-config.ts';
import { xaiOauthAccessToken } from '../xai-oauth-session.ts';
import { proxyMiddleware } from '../proxy.ts';

function keyReader(name: string): string {
  return getKey(name as KeyName);
}

export function llmProviderForRequest(req?: IncomingMessage): LlmProvider {
  const requested = req?.headers['x-openchatcut-provider'];
  return requireLlmProvider(requested === undefined ? getKey('LLM_PROVIDER') : requested);
}

export function llmTarget(req?: IncomingMessage): string {
  return resolveLlmProviderConfig(llmProviderForRequest(req), keyReader).baseUrl;
}

// OpenCode Go rejects requests without a stable session id (400 MissingSessionID)
// and asks clients to identify themselves instead of a generic SDK/browser user
// agent. Both headers are forbidden or unavailable to browser fetch, so the
// local proxy owns them; one id per server process is enough for routing and
// prompt-cache affinity.
const OPENCODE_SESSION_ID = randomUUID();
const OPENCODE_USER_AGENT = 'openchatcut-agent/1.0';

export function opencodeHeaders(apiKey: string): Record<string, string> {
  return {
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    'user-agent': OPENCODE_USER_AGENT,
    'x-opencode-session': OPENCODE_SESSION_ID,
  };
}

export function llmHeaders(req?: IncomingMessage): Record<string, string> {
  const config = resolveLlmProviderConfig(llmProviderForRequest(req), keyReader);
  if (config.provider === 'xai-oauth') {
    // OAuth requests only trust the active in-memory session. API-key accounts
    // use the separate xai provider and LLM_XAI_API_KEY slot.
    const token = xaiOauthAccessToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }
  if (config.provider === 'opencode') return opencodeHeaders(config.apiKey);
  if (!config.apiKey) return {};
  const protocol = protocolForProvider(config.provider);
  if (protocol === 'anthropic') return { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' };
  if (protocol === 'google') return { 'x-goog-api-key': config.apiKey };
  return { authorization: `Bearer ${config.apiKey}` };
}

export function llmErrorMessage(status: number, req?: IncomingMessage): string {
  const provider = llmProviderForRequest(req);
  const label = llmProviderPreset(provider).label;
  if (provider === 'xai-oauth' && (status === 401 || status === 403)) {
    return status === 403
      ? 'xAI 拒绝了订阅会话的 API 访问（当前订阅档位可能未开放）。可升级订阅，或改在“设置 → Agent 模型 → xAI Grok”页配置 API Key 使用。'
      : 'xAI 订阅会话已失效。请在终端运行 grok login 重新登录，然后在“设置 → Agent 模型 → xAI Grok (订阅登录)”页点击导入。';
  }
  if (provider === 'opencode' && (status === 400 || status === 403)) {
    // The gateway returns 400 for missing session headers and for region/privacy
    // gating (DeepSeek V4.1 Flash / V4 Pro need Regions = Global in the console),
    // so point at both instead of the generic "check your settings" copy.
    return 'OpenCode Go 拒绝了请求。请确认订阅档位与模型可用性；'
      + 'DeepSeek V4.1 Flash / V4 Pro 还需在控制台隐私设置中把 Regions 设为 Global。上游原始原因见终端日志。';
  }
  if (status === 401 || status === 403) {
    return `${label} 认证失败。请在“设置 → Agent 模型”中检查 API Key。`;
  }
  if (status === 402 || status === 429) {
    return `${label} 额度不足或请求过于频繁。请检查账户额度，稍后重试。`;
  }
  if (status === 404) {
    return `${label} 的接口或模型不存在。请检查 Base URL 和模型名称。`;
  }
  if (status >= 500) {
    return `${label} 服务暂时不可用（HTTP ${status}）。请稍后重试或切换模型。`;
  }
  return `${label} 请求失败（HTTP ${status}）。请检查“设置 → Agent 模型”中的连接配置。`;
}

/** One dynamic proxy implementation shared by Vite dev and Electron production. */
export function llmProxyPlugin(): Plugin {
  return {
    name: 'openchatcut-llm-proxy',
    configureServer(server) {
      server.middlewares.use('/llm', (req, res, next) => {
        try {
          llmProviderForRequest(req);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Unsupported LLM provider' } }));
          return;
        }
        next();
      });
      server.middlewares.use('/llm', proxyMiddleware({
        target: llmTarget,
        headers: llmHeaders,
        forceJsonContentType: true,
        errorMessage: llmErrorMessage,
      }));
    },
  };
}
