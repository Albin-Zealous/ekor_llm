/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";
import { Deferred } from "@web/core/utils/concurrency";
import { reactive } from "@odoo/owl";
import { registry } from "@web/core/registry";

/**
 * LLM Store Service - Integrates with existing mail.store
 * Provides LLM-specific functionality without breaking mail components
 */
export const llmStoreService = {
  dependencies: ["orm", "mail.store", "notification"],

  start(env, { orm, "mail.store": mailStore, notification }) {
    const llmStore = reactive({
      // NOTE: Threads are now loaded via standard mail.store, no need for separate Map
      // Map<id, LLMModel>
      llmModels: new Map(),
      // Map<id, LLMProvider>
      llmProviders: new Map(),
      // Map<id, LLMTool>
      llmTools: new Map(),
      // Set<threadId> currently streaming
      streamingThreads: new Set(),
      // Map<threadId, EventSource>
      eventSources: new Map(),
      // Resolves when LLM data is loaded
      isReady: new Deferred(),
      // Pending AI chat open from client action (bypasses unreliable bus)
      // { threadId, model, resId, autoGenerate }
      pendingOpenInChatter: null,

      // Computed properties - using mailStore as source of truth
      get activeLLMThread() {
        // Check if current active thread in mail.store is an LLM thread
        const activeThread = mailStore.discuss?.thread;
        return activeThread?.model === "llm.thread" ? activeThread : null;
      },

      get isLLMThread() {
        return this.activeLLMThread !== null;
      },

      get llmThreadList() {
        // Get all LLM threads from mailStore
        const allThreads = Object.values(mailStore.Thread.records || {});
        return allThreads
          .filter((thread) => thread.model === "llm.thread")
          .sort(
            (a, b) => new Date(b.write_date || 0) - new Date(a.write_date || 0)
          );
      },

      // LLM-specific methods using standard fetchData approach
      async ensureThreadLoaded(threadId) {
        // Check if thread already exists in mailStore
        const thread = mailStore.Thread.get({
          model: "llm.thread",
          id: threadId,
        });
        if (thread) {
          return thread;
        }

        // Not in the store yet (e.g. just created, or not loaded at init).
        // Odoo 18 relied on init_messaging/fetchData here; in 17 we ORM-read
        // the single record and insert it.
        try {
          const recs = await orm.read(
            "llm.thread",
            [threadId],
            ["id", "name", "provider_id", "model_id", "write_date"]
          );
          if (recs.length) {
            const rec = recs[0];
            return mailStore.Thread.insert({
              model: "llm.thread",
              id: rec.id,
              name: rec.name,
              write_date: rec.write_date,
            });
          }
        } catch (error) {
          console.warn(`Could not load thread ${threadId}:`, error.message);
        }

        console.warn(`Thread ${threadId} not found in mailStore`);
        return null;
      },

      async sendLLMMessage(threadId, content, attachmentIds = []) {
        if (!threadId || (!content?.trim() && attachmentIds.length === 0)) {
          return;
        }

        try {
          await this.startLLMStreaming(threadId, content, attachmentIds);
        } catch (error) {
          console.error("Error sending LLM message:", error);
          notification.add(
            _t(
              "Could not send your message. Please check your connection and try again."
            ),
            { type: "danger" }
          );
        }
      },

      async startLLMStreaming(threadId, message, attachmentIds = []) {
        this.stopStreaming(threadId);

        this.streamingThreads.add(threadId);

        try {
          let url = `/llm/thread/generate?thread_id=${threadId}`;
          if (message) {
            url += `&message=${encodeURIComponent(message)}`;
          }
          if (attachmentIds.length > 0) {
            url += `&attachment_ids=${attachmentIds.join(",")}`;
          }
          const eventSource = new EventSource(url);

          this.eventSources.set(threadId, eventSource);

          eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.handleStreamMessage(threadId, data);
          };

          eventSource.onerror = (error) => {
            console.error("EventSource error:", error);
            this.stopStreaming(threadId);
            notification.add(
              _t(
                "Lost connection to AI service. Please try sending your message again."
              ),
              {
                type: "danger",
              }
            );
          };
        } catch (error) {
          console.error("Error starting stream:", error);
          this.stopStreaming(threadId);
          notification.add(
            _t(
              "Could not start AI response. Please check your connection and try again."
            ),
            { type: "danger" }
          );
        }
      },

      stopStreaming(threadId) {
        const eventSource = this.eventSources.get(threadId);
        if (eventSource) {
          eventSource.close();
          this.eventSources.delete(threadId);
        }
        this.streamingThreads.delete(threadId);
      },

      handleStreamMessage(threadId, data) {
        switch (data.type) {
          case "message_create": {
            // Insert the message into the store. Odoo 18 used
            // mailStore.insert({"mail.message":[...]}) + mailStore.Message.get();
            // 17's pattern is Message.insert(flatDict, {html:true}), which
            // creates-or-updates by id and returns the record.
            const createdMessage = mailStore.Message.insert(data.message, {
              html: true,
            });

            // Add message to the correct thread's messages collection
            const createThread = mailStore.Thread.get({
              model: "llm.thread",
              id: threadId,
            });
            if (
              createThread &&
              createdMessage &&
              !createThread.messages.some((m) => m.id === createdMessage.id)
            ) {
              createThread.messages.push(createdMessage);
            }
            break;
          }

          case "message_chunk":
          case "message_update":
            // Create-or-update the streaming message (17 Message.insert).
            mailStore.Message.insert(data.message, { html: true });
            break;

          case "error":
            console.error("Stream error:", data.error);
            this.stopStreaming(threadId);
            notification.add(data.error || _t("AI response error"), {
              type: "danger",
            });
            break;

          case "done":
            this.stopStreaming(threadId);
            break;

          case "tool_called":
          case "tool_succeeded":
          case "tool_failed":
            // No-op: handled via message_update
            console.log("[LLM] no-op event:", data.type);
            break;

          default:
            console.warn("Unknown stream message type:", data.type);
            break;
        }
      },

      async loadLLMModels() {
        try {
          // Check if llm.model exists first - use correct field names
          const models = await orm.searchRead(
            "llm.model",
            [["active", "=", true]],
            ["id", "name", "provider_id", "default", "model_use"]
          );

          models.forEach((model) => {
            this.llmModels.set(model.id, model);
          });
        } catch (error) {
          console.warn(
            "LLM models not available - llm module may not be installed:",
            error.message
          );
          // Don't throw error, just log warning
        }
      },

      async loadLLMProviders() {
        try {
          // Check if llm.provider exists first - use correct field names
          const providers = await orm.searchRead(
            "llm.provider",
            [["active", "=", true]],
            ["id", "name", "service"]
          );

          providers.forEach((provider) => {
            this.llmProviders.set(provider.id, provider);
          });
        } catch (error) {
          console.warn(
            "LLM providers not available - llm module may not be installed:",
            error.message
          );
          // Don't throw error, just log warning
        }
      },

      async loadLLMTools() {
        // Load available tools with minimal fields
        const tools = await orm.searchRead(
          "llm.tool",
          [["active", "=", true]],
          ["id", "name"]
        );

        tools.forEach((tool) => {
          this.llmTools.set(tool.id, tool);
        });
      },

      // Load the current user's LLM threads via ORM and insert them into
      // mail.store. Odoo 18 populated these through init_messaging /
      // _thread_to_store (the Store API); Odoo 17 has neither, so we read the
      // records directly and Thread.insert() each one. The llmThreadList getter
      // and ensureThreadLoaded keep reading mailStore.Thread.records unchanged.
      async loadLLMThreads() {
        try {
          const threads = await orm.searchRead(
            "llm.thread",
            [],
            ["id", "name", "provider_id", "model_id", "write_date"],
            { order: "write_date desc" }
          );
          threads.forEach((rec) => {
            mailStore.Thread.insert({
              model: "llm.thread",
              id: rec.id,
              name: rec.name,
              write_date: rec.write_date,
            });
          });
        } catch (error) {
          console.warn(
            "LLM threads not available - llm module may not be installed:",
            error.message
          );
        }
      },

      // Load a thread's existing message history via ORM and insert into the
      // store. Odoo 18 did this through fetchData(["messages"]) on the Store
      // API; 17 has neither, so we read mail.message rows for the thread and
      // hand them to mailStore.insert in the same shape the streaming handler
      // uses. New threads have no history, so this is typically a no-op.
      async loadThreadMessages(threadId) {
        try {
          const messages = await orm.searchRead(
            "mail.message",
            [
              ["model", "=", "llm.thread"],
              ["res_id", "=", threadId],
            ],
            ["id", "body", "author_id", "date", "message_type", "llm_role"],
            { order: "id asc" }
          );
          if (!messages.length) {
            return;
          }
          const thread = mailStore.Thread.get({
            model: "llm.thread",
            id: threadId,
          });
          messages.forEach((msg) => {
            const rec = mailStore.Message.insert(msg, { html: true });
            if (
              thread &&
              rec &&
              !thread.messages.some((m) => m.id === rec.id)
            ) {
              thread.messages.push(rec);
            }
          });
        } catch (error) {
          console.warn(
            `Could not load messages for thread ${threadId}:`,
            error.message
          );
        }
      },

      // Thread selection using standard Odoo patterns
      async selectThread(threadId) {
        try {
          // Ensure thread is loaded using standard fetchData
          const thread = await this.ensureThreadLoaded(threadId);
          if (!thread) {
            throw new Error("Thread not found or failed to load");
          }

          // Set as active thread in discuss. Odoo 18 had
          // thread.setAsDiscussThread(); that method does not exist in 17, so
          // we set the active thread directly (same pattern chatter_patch uses)
          // and sync the URL/breadcrumb via our llm-safe setActiveURL override.
          if (!mailStore.discuss) {
            mailStore.discuss = {};
          }
          mailStore.discuss.thread = thread;
          if (typeof thread.setActiveURL === "function") {
            thread.setActiveURL();
          }
        } catch (error) {
          console.error("Error selecting thread:", error);
          notification.add(
            _t(
              "Could not load this conversation. It may have been deleted or you may not have access."
            ),
            { type: "danger" }
          );
        }
      },

      // Create new thread with default provider and model
      async createNewThread({ recordModel, recordId } = {}) {
        // Get first available provider and model
        const firstProvider = this.getFirstAvailableProvider();
        const firstModel = this.getFirstAvailableModel();

        // Check for null values and show notifications
        if (!firstProvider) {
          notification.add(
            _t(
              "No AI providers are configured. Please contact your administrator to set up an AI provider."
            ),
            { type: "danger" }
          );
          return;
        }

        if (!firstModel) {
          notification.add(
            _t(
              "No AI models are available. Please contact your administrator to configure AI models."
            ),
            { type: "danger" }
          );
          return;
        }

        // Create thread with auto-generated name
        const threadName = `Chat ${new Date().toLocaleString()}`;

        const threadData = {
          name: threadName,
          provider_id: firstProvider.id,
          model_id: firstModel.id,
        };

        // Auto-link to record if context provided (e.g., from chatter)
        if (recordModel && recordId) {
          threadData.model = recordModel;
          threadData.res_id = recordId;
        }

        const threadId = await orm.call("llm.thread", "create", [threadData]);

        // Reload user threads and select the new one
        await this.refreshThreadsAndSelect(threadId);
      },

      // Get first available provider
      getFirstAvailableProvider() {
        const providers = Array.from(this.llmProviders.values());
        return providers.length > 0 ? providers[0] : null;
      },

      // Get first available model
      getFirstAvailableModel() {
        const models = Array.from(this.llmModels.values());
        if (!models.length) {
          return null;
        }
        // Prefer the model flagged default; then any chat-capable model; then
        // fall back to the first. Avoids defaulting to a model the account
        // can't call (e.g. a restricted model that happens to sort first).
        return (
          models.find((m) => m.default) ||
          models.find((m) => m.model_use === "chat") ||
          models[0]
        );
      },

      // Refresh threads and select specific thread
      async refreshThreadsAndSelect(threadId) {
        // Reload the thread list via ORM (Odoo 17 has no mailStore.fetchData /
        // init_messaging). ensureThreadLoaded will also insert the new thread
        // on demand, but refreshing keeps the sidebar list current.
        await this.loadLLMThreads();

        // Select the newly created thread
        await this.selectThread(threadId);
      },

      // Link a record to a thread
      async linkRecordToThread(threadId, model, recordId) {
        try {
          // Update database
          await orm.write("llm.thread", [threadId], {
            model: model,
            res_id: recordId,
          });

          // Update the thread object in mailStore for immediate reactivity
          const thread = mailStore.Thread.get({
            model: "llm.thread",
            id: threadId,
          });

          if (thread) {
            Object.assign(thread, {
              res_model: model,
              res_id: recordId,
            });
          }

          notification.add(_t("Record linked to conversation successfully."), {
            type: "success",
          });
          return true;
        } catch (error) {
          console.error("Error linking record:", error);
          notification.add(
            _t(
              "Could not link the record to this conversation. Please try again."
            ),
            { type: "danger" }
          );
          return false;
        }
      },

      // Unlink record from a thread
      async unlinkRecordFromThread(threadId) {
        try {
          // Update database
          await orm.write("llm.thread", [threadId], {
            model: false,
            res_id: false,
          });

          // Update the thread object in mailStore for immediate reactivity
          const thread = mailStore.Thread.get({
            model: "llm.thread",
            id: threadId,
          });

          if (thread) {
            Object.assign(thread, {
              res_model: false,
              res_id: false,
            });
          }

          notification.add(
            _t("Record unlinked from conversation successfully."),
            {
              type: "success",
            }
          );
          return true;
        } catch (error) {
          console.error("Error unlinking record:", error);
          notification.add(
            _t(
              "Could not unlink the record from this conversation. Please try again."
            ),
            { type: "danger" }
          );
          return false;
        }
      },

      // Helper methods for components
      isStreamingThread(threadId) {
        return this.streamingThreads.has(threadId);
      },

      getStreamingStatus() {
        const activeThread = mailStore.discuss?.thread;
        if (activeThread?.model === "llm.thread") {
          return this.isStreamingThread(activeThread.id);
        }
        return false;
      },

      // Pending open methods - used by client action to bypass unreliable bus
      setPendingOpenInChatter(data) {
        this.pendingOpenInChatter = data;
      },

      consumePendingOpenInChatter(model, resId) {
        const pending = this.pendingOpenInChatter;
        if (pending && pending.model === model && pending.resId === resId) {
          this.pendingOpenInChatter = null;
          return pending;
        }
        return null;
      },

      // Get list of data loaders - can be extended by patches
      getDataLoaders() {
        return [
          this.loadLLMProviders,
          this.loadLLMModels,
          this.loadLLMTools,
          this.loadLLMThreads,
        ];
      },

      // Initialize LLM store - threads now loaded via standard init_messaging
      async initialize() {
        try {
          const loaders = this.getDataLoaders();
          await Promise.all(loaders.map((loader) => loader.call(this)));
          // NOTE: LLM threads are now loaded automatically via res.users._init_messaging()
          this.isReady.resolve();
        } catch (error) {
          console.error("Error initializing LLM store:", error);
          this.isReady.reject(error);
        }
      },

      // Cleanup
      destroy() {
        // Close all event sources
        this.eventSources.forEach((eventSource) => eventSource.close());
        this.eventSources.clear();
        this.streamingThreads.clear();
      },
    });

    // Initialize LLM data after mailStore is ready (which calls init_messaging).
    // Odoo 17's mail store may not expose `isReady`; Promise.resolve handles
    // a Promise, a Deferred, or undefined uniformly.
    Promise.resolve(mailStore.isReady).then(() => {
      llmStore.initialize();
    });

    // NOTE: No longer need thread subscription since threads load automatically via fetchData

    return llmStore;
  },
};

registry.category("services").add("llm.store", llmStoreService);
