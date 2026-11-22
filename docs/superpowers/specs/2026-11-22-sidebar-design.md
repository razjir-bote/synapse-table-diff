# Sidebar — short design

Date: 2026-11-22. Status: approved by the user in conversation.

**Intent.** Let users work point-and-click from a sidebar instead of the Command Palette.

**Design (approved).**
- A Table Diff icon in the activity bar opens a view container with two native tree views:
  - **Connections** lists saved profiles (name, then auth type and database). Title-bar buttons: **New comparison** and **Add connection**. Each item has an inline **Remove** (bin) button, and Remove is also in the context menu, with a confirm step.
  - **Recent comparisons** lists recent requests (`schema.name ↔ schema.name`, with profile names). Clicking one opens the setup form pre-filled. An inline **▶** re-runs it immediately.
- Welcome content appears when a list is empty: **Add connection** and **New comparison** buttons.
- Both lists refresh after a connection is added or removed and after a comparison finishes.
- The existing Command Palette commands stay. Item-only commands are hidden from the palette.

**Approaches.** Native TreeView (chosen: native look, keyboard and theme support, reuses existing panels) vs a webview sidebar holding the whole setup form (rejected: the form is too wide for the sidebar, and it duplicates the panel).

**Builder's calls.** Change notifications are a small listener list on ProfileStore and RecentStore. Tree item contents come from pure functions so they can be unit tested. The icon is a monochrome SVG using `currentColor`. A recent entry whose connection was deleted shows "(missing connection)".
