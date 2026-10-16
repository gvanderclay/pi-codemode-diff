package probe

import sdk "github.com/MichaelKinsy/PiG/extensions/sdk"

// Extension exercises host hooks and deeper descendants from a separate owner.
func Extension() *sdk.Extension {
	ext := sdk.New("probe")
	ext.OnEvent(sdk.EventToolCall, func(_ sdk.Context, e map[string]any) (any, error) {
		input, _ := e["input"].(map[string]any)
		if e["toolName"] == "write" && input["path"] == "redirect.txt" {
			input["path"] = "redirected.txt"
		}
		if e["toolName"] == "write" && input["path"] == "blocked.txt" {
			return map[string]any{"block": true, "reason": "verification blocked write"}, nil
		}
		return nil, nil
	})
	ext.OnEvent(sdk.EventToolResult, func(_ sdk.Context, e map[string]any) (any, error) {
		input, _ := e["input"].(map[string]any)
		if e["toolName"] == "write" && input["path"] == "reject.txt" {
			return map[string]any{"isError": true}, nil
		}
		return nil, nil
	})
	ext.Tool("helper", "Write from a deeper nested tool", sdk.Schema{"type": "object"}, func(ctx sdk.Context, _ map[string]any) (any, error) {
		outcome, err := ctx.ExecuteTool("write", map[string]any{"path": "helper.txt", "content": "deeper descendant"}, nil)
		if err != nil {
			return nil, err
		}
		return outcome.Result, nil
	})
	return ext
}
