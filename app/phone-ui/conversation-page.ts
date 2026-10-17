import { ActionItem, EventData, NavigatedData, Page } from "@nativescript/core";

import { ConversationViewModel } from "./conversation-view-model";

type ConversationContext = { sessionId?: number } | undefined;

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  let model = page.bindingContext as ConversationViewModel | undefined;
  if (!model) {
    const context = args.context as ConversationContext;
    const created = new ConversationViewModel(context?.sessionId ?? 0);
    model = created;
    page.bindingContext = model;
    if (global.isIOS) {
      // OcuSmart: its page colours, and one More menu instead of three overflow items (no re-diarizer on iOS).
      page.className = "os-page";
      const items = page.actionBar.actionItems;
      for (const item of items.getItems()) items.removeItem(item);
      const more = new ActionItem();
      more.text = "More";
      more.ios.position = "right";
      more.on("tap", () => void created.onMoreTap());
      items.addItem(more);
    }
  }
  model.reload();
}

export function unloaded(args: EventData): void {
  const page = args.object as Page;
  const model = page.bindingContext as ConversationViewModel | undefined;
  // The page has no forward navigation, so unloaded means it's going away:
  // stop playback and release the MediaPlayer.
  model?.dispose();
}
