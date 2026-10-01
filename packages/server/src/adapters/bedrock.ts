// Text model backed by Amazon Bedrock Converse. The provider-neutral PromptMessages {system, user}
// map to a Converse request: the system string becomes one system block, the user string becomes a
// single user message. maxTokens and temperature go in inferenceConfig; a timeout and the caller's
// AbortSignal are honoured through one AbortController; the reply's text content blocks are joined.
//
// AWS runs only when a live run selects OVERHEAR_MODELS=aws. The deterministic twin in ./mock/model.ts
// covers the default test run, so this file never sits on the no-keys path and never spends money there.

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type {
  ContentBlock,
  ConverseCommandInput,
  Message,
  SystemContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { MODEL_TIMEOUT_MS } from "@overhear/core";
import type { PromptMessages } from "@overhear/core";
import type { Logger, ModelAdapter, ModelCallOpts } from "../contracts.js";

/** Build a Bedrock-backed text model. `modelId` is chosen by the caller (config.bedrock.*). */
export function makeBedrockModel(modelId: string, region: string, log: Logger): ModelAdapter {
  const client = new BedrockRuntimeClient({ region });
  const logger = log.child({ adapter: "bedrock", model: modelId });

  return {
    id: modelId,
    async generate(messages: PromptMessages, opts?: ModelCallOpts): Promise<string> {
      const system: SystemContentBlock[] = [{ text: messages.system }];
      const converseMessages: Message[] = [{ role: "user", content: [{ text: messages.user }] }];

      const inferenceConfig: NonNullable<ConverseCommandInput["inferenceConfig"]> = {};
      if (opts?.maxTokens !== undefined) inferenceConfig.maxTokens = opts.maxTokens;
      if (opts?.temperature !== undefined) inferenceConfig.temperature = opts.temperature;

      const input: ConverseCommandInput = { modelId, system, messages: converseMessages };
      if (Object.keys(inferenceConfig).length > 0) input.inferenceConfig = inferenceConfig;

      // One controller folds the timeout and the caller's signal into the signal the SDK aborts on.
      const controller = new AbortController();
      const timeoutMs = opts?.timeoutMs ?? MODEL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        controller.abort(new Error(`bedrock converse timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();

      const external = opts?.signal;
      const onExternalAbort = (): void => {
        controller.abort(external?.reason);
      };
      if (external) {
        if (external.aborted) controller.abort(external.reason);
        else external.addEventListener("abort", onExternalAbort, { once: true });
      }

      try {
        const resp = await client.send(new ConverseCommand(input), {
          abortSignal: controller.signal,
        });
        const content: ContentBlock[] = resp.output?.message?.content ?? [];
        let text = "";
        for (const block of content) {
          if (typeof block.text === "string") text += block.text;
        }
        if (text.length === 0) {
          logger.warn("bedrock converse returned no text content", { stopReason: resp.stopReason });
        }
        return text;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error("bedrock converse failed", { message: error.message });
        throw error;
      } finally {
        clearTimeout(timer);
        if (external) external.removeEventListener("abort", onExternalAbort);
      }
    },
  };
}
