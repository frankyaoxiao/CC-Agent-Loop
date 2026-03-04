/**
 * CLAUDE CODE — Anthropic SDK ToolRunner (deobfuscated from binary v2.1.68)
 *
 * This is the Anthropic TypeScript SDK's built-in tool runner loop.
 * Claude Code does NOT use this directly for its main loop — it implements
 * its own loop (see 01-core-agent-loop.js). But this SDK class is bundled
 * in the binary and used for simpler sub-tasks (e.g., compaction calls).
 *
 * The SDK loop is simpler:
 *   while (iterations < max_iterations):
 *     call messages.create or messages.stream
 *     if response has tool_use → generate tool_results → push messages → continue
 *     if end_turn → break
 */

class ToolRunner {
  #params;           // CreateMessageParams (model, messages, tools, etc.)
  #requestOptions;   // HTTP-level options (headers, signal, etc.)
  #iteration = 0;
  #consumed = false;
  #shouldContinue = false;
  #pendingToolResponse;
  #currentMessage;
  #donePromise;

  constructor(client, params, requestOptions) {
    this.client = client;
    this.#params = { params };
    this.#requestOptions = requestOptions;
    this.#donePromise = createDeferredPromise();
  }

  /**
   * The core async iterator — this IS the agentic loop at the SDK level.
   * Each iteration yields either a MessageStream or a Message.
   */
  async *[Symbol.asyncIterator]() {
    if (this.#consumed) {
      throw new Error("Cannot iterate over a consumed stream");
    }
    this.#consumed = true;
    this.#shouldContinue = true;
    this.#pendingToolResponse = undefined;

    try {
      while (true) {
        let stream;

        try {
          // ── Check max iterations ──
          if (this.#params.params.max_iterations &&
              this.#iteration >= this.#params.params.max_iterations) {
            break;
          }

          this.#shouldContinue = false;
          this.#pendingToolResponse = undefined;
          this.#iteration++;
          this.#currentMessage = undefined;

          const { max_iterations, compactionControl, ...createParams } = this.#params.params;

          // ── Call the Anthropic Messages API ──
          if (createParams.stream) {
            // Streaming mode: yields a MessageStream for real-time processing
            stream = this.client.beta.messages.stream({ ...createParams }, this.#requestOptions);
            this.#currentMessage = stream.finalMessage();
            this.#currentMessage.catch(() => {}); // prevent unhandled rejection
            yield stream;
          } else {
            // Non-streaming mode: yields the complete Message
            this.#currentMessage = this.client.beta.messages.create(
              { ...createParams, stream: false }, this.#requestOptions
            );
            yield this.#currentMessage;
          }

          // ── Check if we should continue (tool_use in response) ──
          const shouldLoop = await this.#checkForToolUse();

          if (!shouldLoop) {
            // No tool_use blocks or end_turn → we're done
            if (!this.#shouldContinue) {
              const { role, content } = await this.#currentMessage;
              this.#params.params.messages.push({ role, content });
            }

            // Generate tool response if needed
            const toolResponse = await this.#generateToolResponse(
              this.#params.params.messages.at(-1)
            );

            if (toolResponse) {
              this.#params.params.messages.push(toolResponse);
            } else if (!this.#shouldContinue) {
              break; // ← EXIT: No more tool calls, model is done
            }
          }
        } finally {
          if (stream) stream.abort();
        }
      }

      // Resolve the done promise with the final message
      if (!this.#currentMessage) {
        throw new Error("ToolRunner concluded without a message from the server");
      }
      this.#donePromise.resolve(await this.#currentMessage);

    } catch (error) {
      this.#consumed = false;
      this.#donePromise.promise.catch(() => {});
      this.#donePromise.reject(error);
      this.#donePromise = createDeferredPromise();
      throw error;
    }
  }

  /**
   * Check the response for tool_use blocks and generate tool_result messages.
   * This is the SDK's automatic tool response generation.
   */
  async #generateToolResponse(lastMessage) {
    if (this.#pendingToolResponse !== undefined) {
      return this.#pendingToolResponse;
    }
    // Uses the tool definitions' execute functions to auto-generate responses
    this.#pendingToolResponse = generateToolResultMessage(this.#params.params, lastMessage);
    return this.#pendingToolResponse;
  }

  /** Update the message params (used for compaction, context injection) */
  setMessagesParams(updater) {
    if (typeof updater === "function") {
      this.#params.params = updater(this.#params.params);
    } else {
      this.#params.params = updater;
    }
    this.#shouldContinue = true;
    this.#pendingToolResponse = undefined;
  }

  /** Get a promise that resolves when the runner is done */
  done() {
    return this.#donePromise.promise;
  }

  /** Run until done and return the final message */
  async runUntilDone() {
    if (!this.#consumed) {
      for await (const _ of this) { /* consume */ }
    }
    return this.done();
  }

  get params() {
    return this.#params.params;
  }

  /** Push additional messages into the conversation */
  pushMessages(...messages) {
    this.setMessagesParams(p => ({ ...p, messages: [...p.messages, ...messages] }));
  }

  /** Thenable interface — await runner to get final message */
  then(onFulfilled, onRejected) {
    return this.runUntilDone().then(onFulfilled, onRejected);
  }
}
