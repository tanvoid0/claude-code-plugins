# Web

The Browser pane (`mcp__Claude_Browser__*`) is a real browser inside the app, not a
window on the desktop. Nothing to find, nothing to focus, and it keeps working while
it is hidden - every read and click in this note was made with the pane closed.

`/up` starts the dev server and `ops.js detect` prints the `url` to open. Use that
`url` verbatim: a TLS dev server answers on the same port and rejects `http://`.

```
preview_start { url }            open it (navigate if the pane is already up)
read_page                        the page as an accessibility tree with ref ids
get_page_text                    the page as plain text
computer { left_click, ref }     click by ref, no coordinates
computer { type, text }          keystrokes into whatever has focus
form_input { ref, value }        set a field directly
read_console_messages            console, filterable to errors
read_network_requests            requests, with status, filterable by url
javascript_tool                  read page state the tree does not expose
browser_batch                    several of the above in one round trip
```

## Read as text, not as pixels

`read_page` returns the whole page for a fraction of a screenshot and every line
carries a `ref` to act on:

```
button "Increment" [ref_9]
textbox "your name" [ref_11] placeholder="your name"
generic "Hello (nobody)" [ref_12]
```

`computer { left_click, ref: "ref_9" }` then needs no coordinates and survives the
page moving. Screenshot only for a visual question - layout, spacing, colour.

## Framework state is driven properly

`form_input` on a **React controlled input** updates React's state, not just the
DOM: setting the field to `Benson` re-rendered `Hello Benson`. The usual warning -
that assigning `.value` skips `onChange` and leaves the framework out of step -
does not apply here, so there is no need for a `javascript_tool` workaround.
Keystrokes through `computer { type }` work too; `form_input` is the faster one for
a long value, typing is the honest one when the app reacts per keystroke.

## Traps

- **A field's current value is in neither text read.** `read_page` shows the
  placeholder, `get_page_text` shows nothing at all for an input. Both reported an
  empty-looking field that actually held `typed by keystroke`. To assert on what is
  in a field, read the app's own echo of it, or ask for the value directly:

  ```js
  javascript_tool: ({ name: document.getElementById('rname').value })
  ```

- **Writing an HTML file opens it as a `file://` tab.** You can end up with that tab
  and the `http://localhost` one side by side, and the `file://` copy has no server,
  so its fetches fail and its API-driven content never appears. `tabs_context` lists
  origins - check which tab you are driving before concluding the app is broken.
- **A hidden pane runs pages as background pages.** Correctness is unaffected
  (everything here was done hidden), but timers and animation throttle, so do not
  trust timing or performance numbers from it. Ask the user to show the pane for
  those.
- **`resize_window` only lasts the turn.** `preset: "mobile"` emulates 375x812 and a
  touch device, but the app clears it when the turn ends or the pane resizes - set
  it again next turn. Reload after switching so load-time device checks re-run, and
  reset with `preset: "desktop"` when finished.

## Checking the app actually works

`read_console_messages { onlyErrors: true }` and `read_network_requests` are the
cheap health check, and catch what a screenshot cannot: a page that renders
perfectly while a request 404s or a handler throws. Run both after driving a flow.

`browser_batch` puts a whole flow in one round trip - click, click, focus, type,
click, read - which is the difference between one tool call and six.
