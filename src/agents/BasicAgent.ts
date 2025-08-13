// src/agents/BasicAgent.ts
import { Agent as UndiciAgent, ProxyAgent as UndiciProxyAgent, fetch as undiciFetch, RequestInit } from 'undici';

type TogetherChoice = {
  message?: { content?: string };
};

type TogetherResponse = {
  choices?: TogetherChoice[];
};

export class BasicAgent {
  private apiKey: string;
  // Fast, widely-available Together model to reduce latency
  private model = 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generateCompletion(
    prompt: string,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<string> {
    const body = {
      model: this.model,
      messages: [{ role: 'user' as const, content: prompt }],
      max_tokens: options?.maxTokens ?? 2048,
      temperature: options?.temperature ?? 0.7
    };

    // ---- Networking setup (proxy-aware + sane timeouts) ----
    const dispatcher =
      process.env.HTTPS_PROXY || process.env.HTTP_PROXY
        ? new UndiciProxyAgent(process.env.HTTPS_PROXY || process.env.HTTP_PROXY!)
        : new UndiciAgent({
            connectTimeout: 10_000, // fail fast on connect
            headersTimeout: 60_000, // server must send headers within 60s
            bodyTimeout: 0,         // control overall with AbortController below
            keepAliveTimeout: 30_000
          });

    const controller = new AbortController();
// BasicAgent.ts
const overallTimeout = setTimeout(() => controller.abort(), 60_000);

    const req: RequestInit = {
      method: 'POST',
      dispatcher,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'AI-Coder-Pro/1.0'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    };

    const url = 'https://api.together.xyz/v1/chat/completions';
    console.log('Debug: POST', url, 'model:', body.model);

    try {
      const res = await undiciFetch(url, req);
      clearTimeout(overallTimeout);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Together API HTTP ${res.status} - ${text.slice(0, 600)}`);
      }

      const data = (await res.json()) as TogetherResponse;

      if (Array.isArray(data?.choices) && data.choices[0]?.message?.content) {
        return data.choices[0].message.content!;
      }

      throw new Error('Together API returned no choices.message.content');
    } catch (err: any) {
      clearTimeout(overallTimeout);

      if (err?.name === 'AbortError') {
        throw new Error('Request to Together AI API timed out after 90 seconds.');
      }

      const msg = String(err?.message || err);

      if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
        throw new Error('DNS error resolving api.together.xyz from VS Code. Check proxy/Firewall/DNS.');
      }
      if (msg.includes('ECONNREFUSED')) {
        throw new Error('Connection refused to api.together.xyz. Check firewall or corporate proxy rules.');
      }
      if (msg.includes('401')) {
        throw new Error('Together API rejected the key (401). Double-check the key in Settings.');
      }
      if (msg.includes('403')) {
        throw new Error('Access forbidden (403). The model may be restricted for your account.');
      }
      if (msg.includes('407')) {
        throw new Error('Proxy authentication required (407). Configure proxy settings in VS Code.');
      }

      throw new Error(`Network error contacting Together API: ${msg}`);
    }
  }
}
