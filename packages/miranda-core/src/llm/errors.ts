/**
 * Provider request errors with enough structure for the caller to explain
 * them: which provider and model, the HTTP status, the provider's own message
 * (the `error.message` of an OpenAI-style error body when present), and a
 * hint for the common cases. API keys never appear in the message.
 */

export interface ProviderErrorDetails {
  provider: string;
  model: string;
  url: string;
  status: number;
  /** Raw response text, truncated. */
  body: string;
}

export class ProviderRequestError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly url: string;
  readonly status: number;
  /** The provider's own message when the body was an OpenAI/Anthropic-style error object. */
  readonly providerMessage: string;
  readonly hint: string | undefined;

  constructor(details: ProviderErrorDetails) {
    const providerMessage = extractProviderMessage(details.body);
    const hint = providerHint(details.status, providerMessage, details.model);
    super(
      `API error ${details.status} from ${details.provider} (model ${details.model || "unset"}): ${providerMessage}` +
        (hint ? ` — ${hint}` : ""),
    );
    this.name = "ProviderRequestError";
    this.provider = details.provider;
    this.model = details.model;
    this.url = details.url;
    this.status = details.status;
    this.providerMessage = providerMessage;
    this.hint = hint;
  }
}

export function extractProviderMessage(body: string): string {
  const text = String(body ?? "").trim();
  if (!text) return "unknown error";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown; type?: unknown } | string; message?: unknown };
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.error === "string") return parsed.error.slice(0, 500);
      const message = parsed.error && typeof parsed.error === "object" ? parsed.error.message : parsed.message;
      if (typeof message === "string" && message.trim()) {
        const type = parsed.error && typeof parsed.error === "object" && typeof parsed.error.type === "string" ? ` [${parsed.error.type}]` : "";
        return `${message.trim().slice(0, 500)}${type}`;
      }
    }
  } catch {
    // not JSON
  }
  return text.slice(0, 500);
}

export function providerHint(status: number, providerMessage: string, model: string): string | undefined {
  const msg = providerMessage.toLowerCase();
  if (status === 401 || status === 403) return "authentication failed: check the provider's API key in Settings";
  if (status === 404 || /not[_ ]found|unknown model|does not exist|no such model/.test(msg)) {
    return `the endpoint or the model ID "${model}" was not found: check the provider's base URL and that the model ID exists for this provider`;
  }
  if (status === 400 && /temperature|top_p|top_k|sampling/.test(msg)) return "this model rejects sampling parameters; Orca omits them for recognised Anthropic generations — check the model ID";
  if (status === 400 && /enable_thinking|thinking/.test(msg)) return "this provider does not accept the thinking field; turn off the role's thinking override";
  if (status === 400 && /max_tokens|context length|too long|maximum context/.test(msg)) return "the request exceeds the model's limits: lower the role's max tokens or shorten the input";
  if (status === 429) return "rate limited or out of quota at the provider";
  if (status >= 500) return "provider-side error; retry later";
  return undefined;
}
