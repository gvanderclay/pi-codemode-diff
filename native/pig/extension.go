// Package pig displays codemode file diffs without adding them to model context.
package pig

import (
	"maps"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

// Extension creates a session-local factory for source and fused Go loading.
// Load either this factory or the TypeScript extension, once per Session.
func Extension() *sdk.Extension {
	ext := sdk.New("pig")
	c := newCapture()
	w := newFileTools(c)
	ext.RegisterTool(w.writeDefinition())
	ext.RegisterTool(w.editDefinition())
	ext.EntryRenderer(entryType, func(ctx sdk.Context, entry map[string]any, options sdk.EntryRenderOptions, width int) ([]string, error) {
		data := record(entry["data"])
		id, ok := data["toolCallId"].(string)
		if !ok {
			return nil, nil
		}
		return renderChanges(id, readChanges(data), options.Expanded, width, ctx.UITheme()), nil
	})
	ext.OnEvent(sdk.EventToolExecutionStart, func(ctx sdk.Context, e map[string]any) (any, error) {
		c.start(str(e, "toolCallId"), str(e, "toolName"), str(e, "parentToolCallId"))
		if name := str(e, "toolName"); name == "write" || name == "edit" {
			w.prepare(str(e, "toolCallId"), ctx.Cwd(), record(e["args"]))
		}
		return nil, nil
	})
	ext.OnEvent(sdk.EventToolResult, func(_ sdk.Context, e map[string]any) (any, error) {
		id, name := str(e, "toolCallId"), str(e, "toolName")
		if c.nested(id) {
			if name == "edit" && !flag(e, "isError") {
				if path, ok := record(e["input"])["path"].(string); ok {
					item := change{ToolCallID: id, Tool: "edit", Path: path, Kind: "edit"}
					if diff, ok := record(e["details"])["diff"].(string); ok {
						item.Diff = &diff
					} else {
						item.Note = "The edit tool did not provide a display diff."
					}
					c.add(item)
				}
			}
			if flag(e, "isError") {
				c.reportError(id)
			}
		}
		if name != "codemode" {
			return nil, nil
		}
		if details := c.details(id); details != nil {
			d := maps.Clone(record(e["details"]))
			if d == nil {
				d = map[string]any{}
			}
			d[detailsKey] = details
			return map[string]any{"details": d}, nil
		}
		return nil, nil
	})
	ext.OnEvent(sdk.EventToolExecutionEnd, func(ctx sdk.Context, e map[string]any) (any, error) {
		id := str(e, "toolCallId")
		w.finish(id)
		if flag(e, "isError") && c.nested(id) {
			c.reportError(id)
		}
		defer c.end(id)
		if str(e, "toolName") == "codemode" {
			if details := c.details(id); details != nil {
				return nil, ctx.AppendEntry(entryType, map[string]any{"toolCallId": id, detailsKey: details})
			}
		}
		return nil, nil
	})
	for _, event := range []string{sdk.EventSessionStart, sdk.EventSessionShutdown, sdk.EventAgentEnd} {
		ext.OnEvent(event, func(sdk.Context, map[string]any) (any, error) { w.clear(); c.clear(); return nil, nil })
	}
	return ext
}
