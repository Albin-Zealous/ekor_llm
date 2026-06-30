/** @odoo-module **/

import { Thread } from "@mail/core/common/thread_model";
import { patch } from "@web/core/utils/patch";

/**
 * Patch Thread model to properly handle llm.thread URLs.
 * (Odoo 17: URL sync via @web/core/browser/router is omitted; that module
 *  is not available in this bundle. Action context is still kept in sync.)
 */
patch(Thread.prototype, {
  _updateActionContext(activeId) {
    if (
      !this.store?.action_discuss_id ||
      !this.store.env?.services?.action?.currentController?.action
    ) {
      return;
    }
    const currentAction =
      this.store.env.services.action.currentController.action;
    if (currentAction.id !== this.store.action_discuss_id) {
      return;
    }
    if (!currentAction.context) {
      currentAction.context = {};
    }
    currentAction.context.active_id = activeId;
  },

  setActiveURL() {
    if (this.model === "llm.thread") {
      try {
        const activeId = `llm.thread_${this.id}`;
        this._updateActionContext(activeId);
      } catch (error) {
        console.warn("Error updating URL for LLM thread:", error);
      }
    } else {
      super.setActiveURL();
    }
  },
});
